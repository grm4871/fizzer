// Long-soak evidence: recompute fixture, journal, runtime, and database invariants.
// Inputs are soak result/artifact snapshots and image/revision identity; output is manifest-ready evidence.
// Ordering recomputes raw journal/fixture/log bytes before accepting declared aggregates.

import { createHash } from 'node:crypto';
import * as p from './certified-primitives.mjs';
import * as monitor from './certified-monitor-evidence.mjs';
import { analyzeServerLogs } from '../../loadtest_elixir/monitor.mjs';
import { SOAK_PROFILE, evaluateSoakEvidence as evaluateLongSoakEvidence, databaseReconciliation as reconcileLongSoakDatabase, parseSoakJournal, recomputeSoakJournal } from '../../loadtest_elixir/soak-invariants.mjs';

const { stableJson, invariant, DIGEST_PATTERN, REQUIRED_LONG_SOAK_USERS, REQUIRED_LONG_SOAK_SECONDS, artifactSnapshot } = p;

function selectedFixtureEvidence(artifact) {
  const fixtures = artifact.text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let fixture;
    try { fixture = JSON.parse(line); } catch (error) {
      throw new Error(`two-hour soak fixture line ${index + 1} is invalid JSON: ${error.message}`);
    }
    invariant(typeof fixture.token === 'string' && fixture.token
      && typeof fixture.vaultId === 'string' && fixture.vaultId
      && typeof fixture.channelId === 'string' && fixture.channelId
      && Number.isInteger(fixture.ownedChatChannels) && fixture.ownedChatChannels >= 0
      && fixture.runner === true,
    `two-hour soak fixture line ${index + 1} is incomplete`);
    let claims;
    try { claims = JSON.parse(Buffer.from(fixture.token.split('.')[1], 'base64url').toString('utf8')); } catch {
      throw new Error(`two-hour soak fixture line ${index + 1} has no JWT identity`);
    }
    invariant(Number.isInteger(claims?.id)
      && typeof claims?.username === 'string' && claims.username,
    `two-hour soak fixture line ${index + 1} has no valid user identity`);
    return { ...fixture, authenticatedUserId: claims.id, sourceIndex: index };
  });
  const tokenSet = new Set(fixtures.map((fixture) => fixture.token));
  const userSet = new Set(fixtures.map((fixture) => fixture.authenticatedUserId));
  invariant(tokenSet.size === fixtures.length && userSet.size === fixtures.length,
    'two-hour soak fixture artifact reuses a token or authenticated user');
  const groups = new Map();
  for (const fixture of fixtures) {
    const key = `${fixture.vaultId}\u0000${fixture.channelId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fixture);
  }
  for (const [key, group] of groups) {
    const owners = group.reduce((total, fixture) => total + fixture.ownedChatChannels, 0);
    invariant(owners === 1,
      `two-hour soak fixture vault/channel group ${key} owns ${owners} chat channels, expected exactly 1`);
  }
  const selected = [];
  for (const group of groups.values()) {
    if (selected.length >= REQUIRED_LONG_SOAK_USERS) break;
    invariant(selected.length + group.length <= REQUIRED_LONG_SOAK_USERS,
      'two-hour soak fixture selection splits a vault/channel group');
    selected.push(...group);
  }
  invariant(selected.length === REQUIRED_LONG_SOAK_USERS,
    'two-hour soak fixture artifact does not select exactly 5,000 users');
  const selectedGroups = new Map();
  for (const fixture of selected) {
    const key = `${fixture.vaultId}\u0000${fixture.channelId}`;
    const group = selectedGroups.get(key) || { users: 0, owners: 0 };
    group.users += 1;
    group.owners += fixture.ownedChatChannels;
    selectedGroups.set(key, group);
  }
  const groupIdentities = [...selectedGroups.entries()].map(([key, group]) => {
    const [vaultId, channelId] = key.split('\u0000');
    return { vaultId, channelId, users: group.users, owners: group.owners };
  }).sort((left, right) => `${left.vaultId}\u0000${left.channelId}`.localeCompare(`${right.vaultId}\u0000${right.channelId}`));
  invariant(groupIdentities.length === REQUIRED_LONG_SOAK_USERS / 25
    && groupIdentities.every((group) => group.users === 25 && group.owners === 1),
  'two-hour soak fixture artifact must contain exactly 200 complete 25-user groups');
  const selectedIdentity = selected.map((fixture) => ({
    authenticatedUserId: fixture.authenticatedUserId,
    sourceIndex: fixture.sourceIndex,
    vaultId: fixture.vaultId,
    channelId: fixture.channelId,
    ownedChatChannels: fixture.ownedChatChannels,
    runner: fixture.runner,
  }));
  const churnCohortDigests = Array.from({ length: 10 }, (_unused, cohort) => createHash('sha256')
    .update(stableJson(selected.filter((_fixture, ordinal) => ordinal % 10 === cohort).map((fixture) => ({
      authenticatedUserId: fixture.authenticatedUserId,
      sourceIndex: fixture.sourceIndex,
    }))))
    .digest('hex'));
  return {
    sha256: artifact.sha256,
    bytes: Buffer.byteLength(artifact.text),
    lines: fixtures.length,
    users: selected.length,
    groups: groupIdentities.length,
    groupSize: 25,
    groupIdentities,
    selectedIdentitySha256: createHash('sha256').update(stableJson(selectedIdentity)).digest('hex'),
    churnCohortDigests,
  };
}

function validateSoakServerLogArtifact(result, artifact) {
  invariant(artifact.sha256 === result.serverLogs?.sha256,
    'two-hour soak server-log artifact checksum differs from the evaluated bytes');
  invariant(Buffer.byteLength(artifact.text) === result.serverLogs?.totalBytes
    && artifact.text.split(/\r?\n/u).filter(Boolean).length === result.serverLogs?.totalLines,
  'two-hour soak server-log artifact size differs from the evaluated bytes');
  const recomputed = analyzeServerLogs(artifact.text);
  invariant(recomputed.matchedErrorLines === 0
    && recomputed.matches.length === 0
    && recomputed.matchesTruncated === false
    && stableJson({
      totalBytes: result.serverLogs.totalBytes,
      totalLines: result.serverLogs.totalLines,
      matchedErrorLines: result.serverLogs.matchedErrorLines,
      matches: result.serverLogs.matches,
      matchesTruncated: result.serverLogs.matchesTruncated,
    }) === stableJson(recomputed),
  'two-hour soak server-log artifact contains errors or differs from recomputed analysis');
}

export function validateSoakEvidence(
  result,
  artifact,
  journalArtifact,
  fixtureArtifact,
  serverLogArtifact,
  imageId,
  revision,
  target,
) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'two-hour soak artifact checksum is invalid');
  invariant(result.schemaVersion === 1 && result.type === 'cascade-elixir-two-hour-soak-invariants',
    'two-hour soak artifact schema is invalid');
  invariant(result.expectedImage === imageId, 'two-hour soak exercised a different image');
  invariant(result.expectedRevision === revision, 'two-hour soak exercised a different revision');
  invariant(result.target === target, 'two-hour soak exercised a different target');
  invariant(result.evaluation?.ok === true
    && Array.isArray(result.evaluation.failures)
    && result.evaluation.failures.length === 0
    && Array.isArray(result.preflightFailures)
    && result.preflightFailures.length === 0,
  `two-hour soak evaluation failed: ${[
    ...(result.preflightFailures || []),
    ...(result.evaluation?.failures || []),
  ].join('; ') || 'missing passing evaluation'}`);

  const profile = result.profile || {};
  invariant(Object.entries(SOAK_PROFILE).every(([key, expected]) => profile[key] === expected),
  'two-hour soak workload profile differs from the release contract');
  invariant(result.observed?.soakSeconds >= REQUIRED_LONG_SOAK_SECONDS - 2
    && Math.abs((Date.parse(result.soakFinishedAt) - Date.parse(result.soakStartedAt)) / 1_000
      - result.observed.soakSeconds) <= 0.001,
  'two-hour soak observed duration is incomplete');
  const rampStartedAt = Date.parse(result.workload?.rampStartedAt);
  const rampCompletedAt = Date.parse(result.workload?.rampCompletedAt);
  invariant(Number.isFinite(rampStartedAt) && Number.isFinite(rampCompletedAt)
    && rampCompletedAt <= Date.parse(result.soakStartedAt)
    && rampCompletedAt - rampStartedAt >= SOAK_PROFILE.rampSeconds * 1_000
    && rampCompletedAt - rampStartedAt <= (SOAK_PROFILE.rampSeconds + 10) * 1_000,
  'two-hour soak did not observe the exact bounded 300-second connection ramp');

  const initial = result.identity?.initial;
  const final = result.identity?.final;
  invariant(initial?.container?.imageId === imageId && final?.container?.imageId === imageId,
    'two-hour soak container image identity drifted');
  invariant(typeof initial?.container?.id === 'string' && initial.container.id !== ''
    && initial.container.id === final?.container?.id
    && initial.container.startedAt === final?.container?.startedAt,
  'two-hour soak container/start identity drifted');
  invariant(initial?.image?.revision === revision && final?.image?.revision === revision,
    'two-hour soak image revision drifted');
  invariant(initial?.container?.restartCount === 0
    && final?.container?.running === true && final?.container?.oomKilled === false
    && final?.container?.restartCount === 0,
  'two-hour soak container restarted, stopped, or was OOM-killed');
  invariant(JSON.stringify(result.identity?.runtimeInitial) === JSON.stringify(result.identity?.runtimeFinal),
    'two-hour soak Elixir/OTP/application runtime identity drifted');

  const workload = result.workload || {};
  invariant(workload.initialConnected === REQUIRED_LONG_SOAK_USERS
    && workload.initialConnectionFailures === 0,
  'two-hour soak did not connect exactly 5,000 authenticated runner users');
  const expectedCycles = Math.floor(
    (profile.soakSeconds - 20) / profile.churnIntervalSeconds,
  );
  invariant(Array.isArray(workload.churnCycles) && workload.churnCycles.length >= expectedCycles,
    'two-hour soak did not execute every periodic churn cycle');
  for (const cycle of workload.churnCycles) {
    const expectedSelected = Math.round(profile.users * profile.churnPercent / 100);
    invariant(cycle.selected === expectedSelected
      && cycle.recovered === expectedSelected
      && cycle.within20 === expectedSelected
      && cycle.within10 / Math.max(expectedSelected, 1) >= 0.99
      && Array.isArray(cycle.failures) && cycle.failures.length === 0,
    `two-hour soak churn cycle ${cycle.index ?? '?'} did not recover cleanly`);
  }
  const runs = workload.runs || {};
  const minimumRuns = Math.floor(profile.runRps * profile.soakSeconds * 0.99);
  invariant(runs.scheduled >= minimumRuns
    && runs.created === runs.scheduled
    && runs.delegated === runs.created
    && runs.completed === runs.created
    && runs.duplicates === 0
    && runs.orderingViolations === 0
    && runs.requestErrors / Math.max(runs.scheduled, 1) <= 0.001,
  'two-hour soak run-event workload is incomplete, duplicated, unordered, or over its error budget');
  const runIds = workload.runIds || {};
  const normalizedSet = (values) => [...(values || [])].map(Number).sort((left, right) => left - right);
  const requested = normalizedSet(runIds.requested);
  invariant(requested.length === runs.created
    && [runIds.delegated, runIds.terminal, runIds.liveComplete, result.postDb?.runIds]
      .every((values) => stableJson(normalizedSet(values)) === stableJson(requested)),
  'two-hour soak requested/delegated/live/terminal/persisted run-ID sets differ');
  invariant(result.postDb?.runs === runs.created
    && result.postDb?.completed === runs.created
    && result.postDb?.eventsReconciled === runs.created
    && Array.isArray(result.postDb?.failures) && result.postDb.failures.length === 0
    && DIGEST_PATTERN.test(result.postDb?.eventDigest || ''),
  'two-hour soak post-DB reconciliation is incomplete');
  invariant(result.database?.baseline && result.database?.final
    && Array.isArray(result.database?.failures) && result.database.failures.length === 0,
  'two-hour soak SQLite count/integrity reconciliation is incomplete');
  const recomputedDatabase = reconcileLongSoakDatabase(
    result.database.baseline,
    result.database.final,
    runs.created,
    result.postDb.totalEvents,
  );
  invariant(stableJson(result.database) === stableJson(recomputedDatabase)
    && recomputedDatabase.failures.length === 0,
  'two-hour soak SQLite orphan transition or workload reconciliation differs from recomputed evidence');

  invariant(Number.isInteger(result.recovery?.consecutivePassing)
    && result.recovery.consecutivePassing >= profile.recoveryConsecutiveSamples
    && result.recovery?.final,
  'two-hour soak resources did not return to baseline');
  invariant(DIGEST_PATTERN.test(result.journal?.sha256 || '')
    && result.journal.sha256 === journalArtifact?.sha256,
  'two-hour soak runtime journal checksum is missing or different');
  invariant(Number.isInteger(result.journal?.bytes)
    && result.journal.bytes === Buffer.byteLength(journalArtifact.text)
    && Number.isInteger(result.journal?.samples)
    && result.journal.samples === journalArtifact.text.split(/\r?\n/u).filter(Boolean).length
    && result.journal.samples >= 10,
  'two-hour soak runtime journal size or sample count is invalid');
  const recomputedJournal = recomputeSoakJournal(result, parseSoakJournal(journalArtifact.text));
  const declaredJournalValidation = {
    records: recomputedJournal.records,
    phases: recomputedJournal.phases,
    headroom: recomputedJournal.headroom,
    failures: recomputedJournal.failures,
  };
  invariant(stableJson(result.baseline) === stableJson(recomputedJournal.baseline)
    && stableJson(result.workload.runtimeCoverage) === stableJson(recomputedJournal.runtimeCoverage)
    && stableJson(result.recovery) === stableJson(recomputedJournal.recovery)
    && stableJson(result.journal.validation) === stableJson(declaredJournalValidation),
  'two-hour soak aggregates differ from recomputed runtime journal evidence');
  const recomputedResult = structuredClone(result);
  recomputedResult.baseline = recomputedJournal.baseline;
  recomputedResult.workload.runtimeCoverage = recomputedJournal.runtimeCoverage;
  recomputedResult.recovery = recomputedJournal.recovery;
  recomputedResult.journal.validation = declaredJournalValidation;
  const recomputedEvaluation = evaluateLongSoakEvidence(recomputedResult);
  invariant(recomputedEvaluation.ok && recomputedEvaluation.failures.length === 0
    && stableJson(result.evaluation) === stableJson(recomputedEvaluation),
  'two-hour soak evaluation does not match independently recomputed evidence');

  const recomputedFixtures = selectedFixtureEvidence(fixtureArtifact);
  invariant(stableJson({ ...result.fixtures, path: undefined })
    === stableJson({ ...recomputedFixtures, path: undefined }),
  'two-hour soak fixture artifact identity differs from the evaluated fixture evidence');
  validateSoakServerLogArtifact(result, serverLogArtifact);

  return {
    sha256: artifact.sha256,
    imageId,
    revision,
    target,
    journal: {
      sha256: journalArtifact.sha256,
      bytes: result.journal.bytes,
      samples: result.journal.samples,
    },
    fixtures: {
      sha256: fixtureArtifact.sha256,
      bytes: recomputedFixtures.bytes,
      users: recomputedFixtures.users,
      groups: recomputedFixtures.groups,
      selectedIdentitySha256: recomputedFixtures.selectedIdentitySha256,
    },
    serverLogs: {
      policy: result.serverLogs.policy,
      baselineCursor: result.serverLogs.baselineCursor,
      finishCursor: result.serverLogs.finishCursor,
      readError: result.serverLogs.readError,
      sha256: serverLogArtifact.sha256,
      totalBytes: result.serverLogs.totalBytes,
      totalLines: result.serverLogs.totalLines,
      matchedErrorLines: result.serverLogs.matchedErrorLines,
      matchesTruncated: result.serverLogs.matchesTruncated,
    },
    users: profile.users,
    rampSeconds: profile.rampSeconds,
    rampStartedAt: result.workload.rampStartedAt,
    rampCompletedAt: result.workload.rampCompletedAt,
    soakSeconds: profile.soakSeconds,
    sampleIntervalSeconds: profile.sampleIntervalSeconds,
    recoveryConsecutiveSamples: profile.recoveryConsecutiveSamples,
    churnPercent: profile.churnPercent,
    churnIntervalSeconds: profile.churnIntervalSeconds,
    runRps: profile.runRps,
    containerId: initial.container.id,
    containerStartedAt: initial.container.startedAt,
    startedAt: result.startedAt,
    soakStartedAt: result.soakStartedAt,
    finishedAt: result.finishedAt,
    postDbEventDigest: result.postDb.eventDigest,
    liveEventDigest: result.workload.liveEventDigest,
    runCount: runs.created,
    persistedEventCount: result.postDb.totalEvents,
    probeUninstalled: result.probe.owned === true
      && result.probe.uninstallError === null
      && result.probe.postUninstall?.error === 'capacity probe is not installed',
    teardown: result.teardown,
    database: result.database,
    journalHeadroom: recomputedJournal.headroom.observed,
    evaluation: 'passed',
  };
}
