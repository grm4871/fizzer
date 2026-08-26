import { headroomEvaluation } from '../monitor.mjs';
import { PRODUCTION_CPUS, PRODUCTION_MEMORY_BYTES, SOAK_MEMBERSHIPS, SOAK_FIXTURE_GROUPS, SOAK_FIXTURE_GROUP_SIZE, SOAK_PROFILE, SOAK_RUNTIME_CONFIGURATION, RAMP_TOLERANCE_SECONDS, EXPECTED_LIVE_EVENT_SIGNATURE, SERVER_LOG_POLICY, RETURN_THRESHOLDS, certifiedShapeFailures, exactProfileFailures, exactRuntimeFailures, stableJson, sameNumericSet, returnToBaselineFailures, resourceVector, referenceVector, digest } from './soak-inputs.mjs';

/**
 * Soak evaluator seam: journal ordering, sample invariants, recovery, and release gates.
 * Evidence invariant: the evaluator recomputes all claims from immutable samples and identities.
 */
function identityFailures(identity, expectedImage, expectedRevision) {
  const failures = [];
  const initial = identity?.initial;
  const final = identity?.final;
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedImage || '')) failures.push('expected image is not an immutable sha256 image ID');
  if (initial?.container?.imageId !== expectedImage) failures.push(`initial image is ${initial?.container?.imageId || 'missing'}, expected ${expectedImage || 'missing'}`);
  if (final?.container?.imageId !== expectedImage) failures.push(`final image is ${final?.container?.imageId || 'missing'}, expected ${expectedImage || 'missing'}`);
  if (!initial?.container?.id || initial.container.id !== final?.container?.id) failures.push('container identity changed during soak');
  if (!initial?.container?.startedAt || initial.container.startedAt !== final?.container?.startedAt) failures.push('container start identity changed during soak');
  if (initial?.container?.restartCount !== 0 || final?.container?.restartCount !== 0) failures.push('container restart count must remain exactly zero');
  if (!final?.container?.running) failures.push('container was not running at final inspection');
  if (final?.container?.oomKilled) failures.push('container was OOM-killed');
  failures.push(...certifiedShapeFailures(initial?.container?.hostConfig));
  if (stableJson(initial?.container?.hostConfig) !== stableJson(final?.container?.hostConfig)) {
    failures.push('container runtime envelope changed during soak');
  }
  if (!/^[a-f0-9]{40}$/u.test(initial?.image?.revision || '')) failures.push('image has no full Git revision label');
  if (initial?.image?.revision !== final?.image?.revision) failures.push('image revision changed during soak');
  if (expectedRevision && initial?.image?.revision !== expectedRevision) failures.push(`image revision is ${initial?.image?.revision || 'missing'}, expected ${expectedRevision}`);
  if (!identity?.runtimeInitial || JSON.stringify(identity.runtimeInitial) !== JSON.stringify(identity.runtimeFinal)) {
    failures.push('Elixir/OTP/application runtime identity changed during soak');
  }
  failures.push(...exactRuntimeFailures(identity?.runtimeInitial));
  return failures;
}

function sampleInvariantFailures(sample, evidence) {
  const failures = [];
  const state = sample?.containerState;
  const initial = evidence?.identity?.initial;
  if (sample?.type !== 'runtime-sample') failures.push('journal record is not a runtime sample');
  if (!['baseline', 'soak', 'post-leave'].includes(sample?.phase)) failures.push(`invalid journal phase ${sample?.phase ?? 'missing'}`);
  if (!Number.isFinite(Date.parse(sample?.observedAt))) failures.push('journal sample timestamp is invalid');
  if (state?.id !== initial?.container?.id) failures.push('container ID changed');
  if (state?.imageId !== evidence?.expectedImage) failures.push('image ID changed');
  if (state?.startedAt !== initial?.container?.startedAt) failures.push('container start changed');
  if (state?.imageRevision !== evidence?.expectedRevision) failures.push('image revision changed');
  if (state?.running !== true) failures.push('container is not running');
  if (state?.restartCount !== 0) failures.push(`container restart count is ${state?.restartCount ?? 'missing'}`);
  if (state?.oomKilled !== false) failures.push('container was OOM-killed');
  failures.push(...certifiedShapeFailures(state?.hostConfig));
  if (stableJson(state?.hostConfig) !== stableJson(initial?.container?.hostConfig)) failures.push('container runtime envelope changed');
  failures.push(...exactRuntimeFailures(sample?.beam?.configuration));
  if (sample?.beam?.beam?.error || sample?.beam?.pool?.error || sample?.beam?.deep?.error) {
    failures.push('capacity probe sample contains an error');
  }
  if (!Array.isArray(sample?.errors)) failures.push('sample error list is missing');
  else failures.push(...sample.errors);
  return [...new Set(failures)];
}

export function parseSoakJournal(raw) {
  const lines = String(raw || '').split(/\r?\n/u).filter(Boolean);
  if (!lines.length) throw new Error('two-hour soak runtime journal is empty');
  return lines.map((line, index) => {
    try { return JSON.parse(line); } catch (error) {
      throw new Error(`invalid two-hour soak journal JSON on line ${index + 1}: ${error.message}`);
    }
  });
}

function phaseOrderFailures(records) {
  const failures = [];
  const order = { baseline: 0, soak: 1, 'post-leave': 2 };
  let priorPhase = 0;
  let priorAt = -Infinity;
  for (const [index, record] of records.entries()) {
    const phase = order[record?.phase];
    const observedAt = Date.parse(record?.observedAt);
    if (!Number.isInteger(phase) || phase < priorPhase) failures.push(`journal phase order changed at sample ${index}`);
    if (!Number.isFinite(observedAt) || observedAt <= priorAt) failures.push(`journal timestamps are not strictly increasing at sample ${index}`);
    if (Number.isInteger(phase)) priorPhase = phase;
    if (Number.isFinite(observedAt)) priorAt = observedAt;
  }
  return failures;
}

function runtimeCoverage(samples, profile) {
  return {
    samples: samples.length,
    sessionsAtCapacityRatio: samples.filter((sample) => sample.beam?.beam?.realtimeSessions >= profile.users).length / Math.max(samples.length, 1),
    runnersAtCapacityRatio: samples.filter((sample) => sample.beam?.deep?.registeredRunners >= profile.users).length / Math.max(samples.length, 1),
    membershipsAtCapacityRatio: samples.filter((sample) => sample.beam?.deep?.realtimeMemberships >= SOAK_MEMBERSHIPS).length / Math.max(samples.length, 1),
    maxima: referenceVector(samples),
  };
}

export function recomputeSoakJournal(evidence, records) {
  const failures = [...phaseOrderFailures(records)];
  for (const [index, record] of records.entries()) {
    failures.push(...sampleInvariantFailures(record, evidence).map((failure) => `journal sample ${index}: ${failure}`));
  }
  const baselineRecords = records.filter((record) => record.phase === 'baseline');
  const soakRecords = records.filter((record) => record.phase === 'soak');
  const recoveryRecords = records.filter((record) => record.phase === 'post-leave');
  if (baselineRecords.length !== 3) failures.push(`baseline journal samples are ${baselineRecords.length}/3`);
  if (recoveryRecords.length < SOAK_PROFILE.recoveryConsecutiveSamples) {
    failures.push(`post-leave journal samples are ${recoveryRecords.length}/${SOAK_PROFILE.recoveryConsecutiveSamples}`);
  }
  const soakStartedMs = Date.parse(evidence.soakStartedAt);
  for (const [index, record] of [...soakRecords, ...recoveryRecords].entries()) {
    const wallElapsed = (Date.parse(record.observedAt) - soakStartedMs) / 1_000;
    if (!Number.isFinite(record.elapsedSeconds) || !Number.isFinite(wallElapsed)
        || Math.abs(record.elapsedSeconds - wallElapsed) > 2) {
      failures.push(`journal sample elapsedSeconds is not bound to observedAt at record ${index}`);
    }
  }
  for (let index = 1; index < soakRecords.length; index += 1) {
    const elapsedGap = soakRecords[index].elapsedSeconds - soakRecords[index - 1].elapsedSeconds;
    const wallGap = (Date.parse(soakRecords[index].observedAt) - Date.parse(soakRecords[index - 1].observedAt)) / 1_000;
    if (!(elapsedGap > 0 && elapsedGap <= SOAK_PROFILE.sampleIntervalSeconds * 3)
        || !(wallGap > 0 && wallGap <= SOAK_PROFILE.sampleIntervalSeconds * 3)) {
      failures.push(`soak journal sampling gap at record ${index} exceeds the fixed five-second cadence tolerance`);
    }
  }
  const baselineReference = referenceVector(baselineRecords);
  let consecutivePassing = 0;
  for (const record of recoveryRecords) {
    consecutivePassing = returnToBaselineFailures(baselineReference, resourceVector(record)).length === 0
      ? consecutivePassing + 1
      : 0;
  }
  const coverage = runtimeCoverage(soakRecords, SOAK_PROFILE);
  const finalSoak = soakRecords.at(-1);
  if (finalSoak?.beam?.beam?.realtimeSessions !== SOAK_PROFILE.users
      || finalSoak?.beam?.deep?.registeredRunners !== SOAK_PROFILE.users
      || finalSoak?.beam?.deep?.realtimeMemberships < SOAK_MEMBERSHIPS) {
    failures.push('final pre-leave sample does not hold exactly 5,000 sessions/runners and at least 25,000 memberships');
  }
  const headroom = headroomEvaluation(
    soakRecords,
    SOAK_PROFILE.soakSeconds,
    PRODUCTION_MEMORY_BYTES,
    PRODUCTION_CPUS,
    SOAK_PROFILE.users,
    SOAK_PROFILE.users,
    SOAK_MEMBERSHIPS,
    failures,
    SOAK_RUNTIME_CONFIGURATION,
    SOAK_PROFILE.soakSeconds,
    SOAK_PROFILE.sampleIntervalSeconds,
    SOAK_PROFILE.soakSeconds,
    null,
  );
  return {
    records: records.length,
    phases: { baseline: baselineRecords.length, soak: soakRecords.length, postLeave: recoveryRecords.length },
    baseline: { samples: baselineRecords.map(resourceVector), reference: baselineReference },
    runtimeCoverage: coverage,
    recovery: {
      samples: recoveryRecords.map(resourceVector),
      final: recoveryRecords.length ? resourceVector(recoveryRecords.at(-1)) : null,
      consecutivePassing,
    },
    headroom,
    failures: headroom.failures,
  };
}

export function evaluateSoakEvidence(evidence) {
  const failures = [...(evidence.preflightFailures || [])];
  const profile = evidence.profile || {};
  failures.push(...exactProfileFailures(profile));
  if (!(evidence.observed?.soakSeconds >= SOAK_PROFILE.soakSeconds - 2)) failures.push(`observed soak is ${evidence.observed?.soakSeconds ?? 'missing'}s, expected >=${SOAK_PROFILE.soakSeconds - 2}s`);
  const soakStartedAt = Date.parse(evidence.soakStartedAt);
  const soakFinishedAt = Date.parse(evidence.soakFinishedAt);
  if (!Number.isFinite(soakStartedAt) || !Number.isFinite(soakFinishedAt)
      || Math.abs((soakFinishedAt - soakStartedAt) / 1_000 - evidence.observed?.soakSeconds) > 0.001) {
    failures.push('observed soak duration is not bound to its start/finish timestamps');
  }
  const rampStartedAt = Date.parse(evidence.workload?.rampStartedAt);
  const rampCompletedAt = Date.parse(evidence.workload?.rampCompletedAt);
  const observedRampSeconds = (rampCompletedAt - rampStartedAt) / 1_000;
  if (!Number.isFinite(rampStartedAt) || !Number.isFinite(rampCompletedAt)
      || rampCompletedAt > soakStartedAt
      || observedRampSeconds < SOAK_PROFILE.rampSeconds
      || observedRampSeconds > SOAK_PROFILE.rampSeconds + RAMP_TOLERANCE_SECONDS) {
    failures.push(`observed connection ramp is ${Number.isFinite(observedRampSeconds) ? observedRampSeconds : 'missing'}s, expected ${SOAK_PROFILE.rampSeconds}-${SOAK_PROFILE.rampSeconds + RAMP_TOLERANCE_SECONDS}s before soak start`);
  }

  failures.push(...identityFailures(evidence.identity, evidence.expectedImage, evidence.expectedRevision));

  const fixtures = evidence.fixtures || {};
  if (!/^[a-f0-9]{64}$/u.test(fixtures.sha256 || '')
      || !/^[a-f0-9]{64}$/u.test(fixtures.selectedIdentitySha256 || '')
      || fixtures.users !== SOAK_PROFILE.users
      || fixtures.groups !== SOAK_FIXTURE_GROUPS
      || fixtures.groupSize !== SOAK_FIXTURE_GROUP_SIZE
      || !Array.isArray(fixtures.groupIdentities)
      || fixtures.groupIdentities.length !== SOAK_FIXTURE_GROUPS
      || fixtures.groupIdentities.some((group) => group?.users !== SOAK_FIXTURE_GROUP_SIZE
        || group?.owners !== 1)
      || !Array.isArray(fixtures.churnCohortDigests)
      || fixtures.churnCohortDigests.length !== 10
      || fixtures.churnCohortDigests.some((value) => !/^[a-f0-9]{64}$/u.test(value))) {
    failures.push('fixture artifact/hash/user/group identity is incomplete or differs from the release contract');
  }

  const workload = evidence.workload || {};
  if (workload.initialConnected !== SOAK_PROFILE.users) failures.push(`initial connections are ${workload.initialConnected ?? 'missing'}/${SOAK_PROFILE.users}`);
  if (workload.initialConnectionFailures !== 0) failures.push(`${workload.initialConnectionFailures ?? 'missing'} initial connection failures`);
  const expectedChurnCycles = Math.floor((profile.soakSeconds - 20) / profile.churnIntervalSeconds);
  if ((workload.churnCycles?.length || 0) !== expectedChurnCycles) failures.push(`churn cycles are ${workload.churnCycles?.length || 0}/${expectedChurnCycles}`);
  const cohortCounts = Array(10).fill(0);
  for (const [cycleIndex, cycle] of (workload.churnCycles || []).entries()) {
    const expectedSelected = Math.round(profile.users * profile.churnPercent / 100);
    const expectedCohort = cycleIndex % 10;
    cohortCounts[expectedCohort] += 1;
    if (cycle.index !== cycleIndex || cycle.cohort !== expectedCohort
        || cycle.selectedIdentitySha256 !== evidence.fixtures?.churnCohortDigests?.[expectedCohort]) {
      failures.push(`churn cycle ${cycleIndex} identity/cohort evidence differs from deterministic cohort ${expectedCohort}`);
    }
    if (cycle.selected !== expectedSelected) failures.push(`churn cycle ${cycle.index} selected ${cycle.selected}/${expectedSelected}`);
    if (cycle.recovered !== cycle.selected) failures.push(`churn cycle ${cycle.index} recovered ${cycle.recovered}/${cycle.selected}`);
    if ((cycle.within10 || 0) / Math.max(cycle.selected, 1) < 0.99) failures.push(`churn cycle ${cycle.index} recovered <99% within 10s`);
    if (cycle.within20 !== cycle.selected) failures.push(`churn cycle ${cycle.index} did not fully recover within 20s`);
    if ((cycle.failures || []).length) failures.push(`churn cycle ${cycle.index} reported ${cycle.failures.length} failures`);
  }
  const expectedCohortCounts = Array.from({ length: 10 }, (_unused, cohort) => (
    Math.floor(expectedChurnCycles / 10) + (cohort < expectedChurnCycles % 10 ? 1 : 0)
  ));
  if (stableJson(cohortCounts) !== stableJson(expectedCohortCounts)) {
    failures.push(`churn cohort coverage is ${stableJson(cohortCounts)}, expected ${stableJson(expectedCohortCounts)}`);
  }

  const coverage = workload.runtimeCoverage || {};
  const minimumRuntimeSamples = Math.floor(profile.soakSeconds / profile.sampleIntervalSeconds * 0.99);
  if ((coverage.samples || 0) < minimumRuntimeSamples) failures.push(`soak runtime samples are ${coverage.samples || 0}/${minimumRuntimeSamples}`);
  if ((coverage.sessionsAtCapacityRatio || 0) < 0.9) failures.push(`realtime sessions held capacity for ${((coverage.sessionsAtCapacityRatio || 0) * 100).toFixed(2)}% of soak samples`);
  if ((coverage.runnersAtCapacityRatio || 0) < 0.9) failures.push(`registered runners held capacity for ${((coverage.runnersAtCapacityRatio || 0) * 100).toFixed(2)}% of soak samples`);
  if ((coverage.membershipsAtCapacityRatio || 0) < 0.9) failures.push(`realtime memberships held capacity for ${((coverage.membershipsAtCapacityRatio || 0) * 100).toFixed(2)}% of soak samples`);

  const runs = workload.runs || {};
  const minimumRuns = Math.floor(profile.runRps * profile.soakSeconds * 0.99);
  if ((runs.scheduled || 0) < minimumRuns) failures.push(`runs scheduled ${runs.scheduled || 0}/${minimumRuns}`);
  if (runs.created !== runs.scheduled) failures.push(`runs created ${runs.created || 0}/${runs.scheduled || 0}`);
  if (runs.delegated !== runs.created) failures.push(`runs delegated ${runs.delegated || 0}/${runs.created || 0}`);
  if (runs.completed !== runs.created) failures.push(`runs completed ${runs.completed || 0}/${runs.created || 0}`);
  if ((runs.duplicates || 0) > 0) failures.push(`${runs.duplicates} duplicate run delegations`);
  if ((runs.orderingViolations || 0) > 0) failures.push(`${runs.orderingViolations} run-event ordering violations`);
  if ((runs.requestErrors || 0) / Math.max(runs.scheduled || 0, 1) > 0.001) failures.push('run request error rate exceeds 0.1%');
  const runIds = workload.runIds || {};
  if (!sameNumericSet(runIds.requested, runIds.delegated)
      || !sameNumericSet(runIds.requested, runIds.terminal)
      || !sameNumericSet(runIds.requested, runIds.liveComplete)
      || !sameNumericSet(runIds.requested, evidence.postDb?.runIds)
      || runIds.requested?.length !== runs.created) {
    failures.push('requested, delegated, live-complete, terminal, and persisted run-ID sets are not exactly equal');
  }
  const liveEvents = workload.liveEvents || [];
  if (liveEvents.length !== runs.created
      || !sameNumericSet(liveEvents.map((entry) => entry.runId), runIds.requested)
      || liveEvents.some((entry) => stableJson(entry.signature) !== stableJson(EXPECTED_LIVE_EVENT_SIGNATURE))
      || workload.liveEventDigest !== digest(stableJson(liveEvents))) {
    failures.push('live run-event evidence is missing, duplicated, gapped, unordered, or not exactly seq 2/3/4');
  }
  if (evidence.postDb?.failures?.length || evidence.postDb?.runs !== runs.created
      || evidence.postDb?.completed !== runs.created
      || evidence.postDb?.eventsReconciled !== runs.created
      || !/^[a-f0-9]{64}$/u.test(evidence.postDb?.eventDigest || '')) {
    failures.push('post-soak DB run/event reconciliation is incomplete or failed');
  }
  if (!evidence.database?.baseline || !evidence.database?.final || evidence.database?.failures?.length) {
    failures.push('post-soak SQLite count/integrity reconciliation is incomplete or failed');
  }

  if (!evidence.journal?.sha256 || !Number.isInteger(evidence.journal?.samples) || evidence.journal.samples < 10) failures.push('bound runtime sample journal is missing or too short');
  if (evidence.journal?.validation?.failures?.length
      || evidence.journal?.validation?.headroom?.ok !== true) {
    failures.push('runtime journal recomputation or full capacity headroom gate failed');
  }
  if (JSON.stringify(evidence.returnThresholds) !== JSON.stringify(RETURN_THRESHOLDS)) failures.push('post-leave return thresholds differ from the certified policy');
  if (!evidence.baseline?.reference) failures.push('baseline resource sample is missing');
  if (!evidence.recovery?.final) failures.push('post-leave resource sample is missing');
  if ((evidence.recovery?.consecutivePassing || 0) < (profile.recoveryConsecutiveSamples || SOAK_PROFILE.recoveryConsecutiveSamples)) {
    failures.push(`post-leave baseline held for ${evidence.recovery?.consecutivePassing || 0}/${profile.recoveryConsecutiveSamples || SOAK_PROFILE.recoveryConsecutiveSamples} samples`);
  }
  if (evidence.baseline?.reference && evidence.recovery?.final) {
    failures.push(...returnToBaselineFailures(evidence.baseline.reference, evidence.recovery.final, RETURN_THRESHOLDS));
  }
  if (evidence.probe?.owned !== true || evidence.probe?.uninstallError !== null
      || evidence.probe?.postUninstall?.error !== 'capacity probe is not installed'
      || !evidence.probe?.summary?.metrics) {
    failures.push('capacity probe ownership, final summary, or uninstall evidence is invalid');
  }
  const metricCount = (name) => {
    const metric = evidence.probe?.summary?.metrics?.[name];
    return typeof metric === 'number' ? metric : metric?.count || 0;
  };
  for (const name of ['db_errors', 'db_busy_or_locked_errors', 'db_write_lock_owner_deaths', 'probe_pool_errors', 'probe_beam_errors', 'probe_deep_errors']) {
    if (metricCount(name) !== 0) failures.push(`final capacity-probe metric ${name} is ${metricCount(name)}, expected zero`);
  }
  const finalWrite = evidence.probe?.summary?.snapshot?.deep?.writeCoordinator;
  if (finalWrite?.locked !== false || finalWrite?.queue_depth !== 0 || (finalWrite?.owner_deaths || 0) !== 0) {
    failures.push('final DB write coordinator is locked, queued, or recorded owner deaths');
  }
  const teardown = evidence.teardown;
  if (teardown?.runnerDisconnectFlushes !== 1
      || teardown?.runnerDisconnectFlushOwners < Math.floor(SOAK_PROFILE.users * 0.99)
      || teardown?.runnerDisconnectFlushOwners > SOAK_PROFILE.users
      || teardown?.runnerDelegatedSnapshotReads !== 1
      || teardown?.runnerDelegatedOwnerReads !== 0) {
    failures.push('runner teardown did not use one batched flush with 99-100% owners and bounded delegated snapshots');
  }
  const dispatcher = teardown?.presenceDispatcher;
  if (!dispatcher || dispatcher.completed !== dispatcher.dispatched
      || dispatcher.completed !== dispatcher.refreshed
      || dispatcher.failed !== 0 || dispatcher.noop !== 0
      || dispatcher.startFailed !== 0 || dispatcher.taskFailed !== 0
      || dispatcher.active !== 0 || dispatcher.pending !== 0 || dispatcher.queued !== 0) {
    failures.push('presence dispatcher did not drain cleanly after simultaneous teardown');
  }
  if (evidence.serverLogs?.policy !== SERVER_LOG_POLICY
      || evidence.serverLogs?.baselineCursor !== evidence.identity?.initial?.container?.startedAt
      || evidence.serverLogs?.readError !== null
      || evidence.serverLogs?.matchedErrorLines !== 0
      || evidence.serverLogs?.matchesTruncated !== false
      || !/^[a-f0-9]{64}$/u.test(evidence.serverLogs?.sha256 || '')) {
    failures.push('two-hour server-log evidence is incomplete, unbound, or contains fatal/error lines');
  }
  return { ok: failures.length === 0, failures };
}
