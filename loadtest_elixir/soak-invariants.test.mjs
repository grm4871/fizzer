import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  RETURN_THRESHOLDS,
  SOAK_PROFILE,
  SOAK_RUNTIME_CONFIGURATION,
  databaseReconciliation,
  evaluateSoakEvidence,
  persistedEventFailures,
  recomputeSoakJournal,
  returnToBaselineFailures,
  teardownProbeEvidence,
} from './soak-invariants.mjs';

const image = `sha256:${'a'.repeat(64)}`;
const revision = 'b'.repeat(40);
const resources = {
  processCount: 1_000,
  etsBytes: 100_000_000,
  memoryBytes: 500_000_000,
  openFiles: 100,
  poolBusy: 0,
  poolQueue: 0,
  sessions: 0,
  runners: 0,
  memberships: 0,
};

function productionShapedDatabase() {
  const summary = 'Desktop agent runner did not reclaim this run after server restart.';
  return {
    baseline: {
      users: 5_007,
      vaults: 212,
      memberships: 5_015,
      runs: 1_897,
      runEvents: 403_514,
      delegatedRuns: 2,
      baselineOrphans: [
        { id: 1_896, status: 'queued', summary: null, ownerUserId: 1, maxSeq: 1_913 },
        { id: 1_897, status: 'queued', summary: null, ownerUserId: 4, maxSeq: 27 },
      ],
      foreignKeyViolations: 0,
      quickCheck: 'ok',
    },
    final: {
      users: 5_007,
      vaults: 212,
      memberships: 5_015,
      runs: 9_097,
      runEvents: 432_316,
      delegatedRuns: 0,
      baselineOrphans: [
        {
          id: 1_896, status: 'failed', summary, ownerUserId: null, maxSeq: 1_914,
          lastType: 'status', lastPayload: JSON.stringify({ status: 'failed', summary }),
        },
        {
          id: 1_897, status: 'failed', summary, ownerUserId: null, maxSeq: 28,
          lastType: 'status', lastPayload: JSON.stringify({ status: 'failed', summary }),
        },
      ],
      foreignKeyViolations: 0,
      quickCheck: 'ok',
    },
    failures: [],
  };
}

function passingEvidence() {
  const soakStartedAt = '2026-08-11T00:00:00.000Z';
  const soakFinishedAt = '2026-08-11T02:00:00.000Z';
  const runIds = Array.from({ length: 7_200 }, (_unused, index) => index + 1);
  const liveEvents = runIds.map((runId) => ({
    runId,
    signature: ['2:status:running', '3:text', '4:status:completed'],
  }));
  const churnCohortDigests = Array.from({ length: 10 }, (_unused, index) => `${index}`.repeat(64));
  const churnCycles = Array.from({ length: 23 }, (_unused, index) => ({
    index,
    cohort: index % 10,
    selectedIdentitySha256: churnCohortDigests[index % 10],
    selected: 500,
    recovered: 500,
    within10: 500,
    within20: 500,
    failures: [],
  }));
  const state = {
    container: {
      id: 'container-1',
      imageId: image,
      startedAt: '2026-08-11T00:00:00.000Z',
      running: true,
      restartCount: 0,
      oomKilled: false,
      hostConfig: {
        nanoCpus: 2_000_000_000,
        cpusetCpus: '0-1',
        memory: 3 * 1024 ** 3,
        memorySwap: 3 * 1024 ** 3,
        pidsLimit: 100_000,
        ulimits: [{ Name: 'nofile', Soft: 200_000, Hard: 200_000 }],
      },
    },
    image: { id: image, revision },
  };
  const runtime = {
    elixir: '1.18.4',
    otpRelease: '27',
    ertsVersion: '15.2',
    cascadeVersion: '0.1.0',
    ...SOAK_RUNTIME_CONFIGURATION,
  };
  return {
    expectedImage: image,
    expectedRevision: revision,
    profile: { ...SOAK_PROFILE },
    soakStartedAt,
    soakFinishedAt,
    observed: { soakSeconds: 7_200 },
    identity: {
      initial: structuredClone(state),
      final: structuredClone(state),
      runtimeInitial: structuredClone(runtime),
      runtimeFinal: structuredClone(runtime),
    },
    fixtures: {
      sha256: 'd'.repeat(64),
      selectedIdentitySha256: 'e'.repeat(64),
      users: 5_000,
      groups: 200,
      groupSize: 25,
      groupIdentities: Array.from({ length: 200 }, (_unused, index) => ({
        vaultId: `vault-${index}`,
        channelId: `channel-${index}`,
        users: 25,
        owners: 1,
      })),
      churnCohortDigests,
    },
    journal: {
      sha256: 'c'.repeat(64),
      samples: 1_450,
      validation: { failures: [], headroom: { ok: true } },
    },
    baseline: { reference: { ...resources } },
    workload: {
      rampStartedAt: '2026-08-10T23:55:00.000Z',
      rampCompletedAt: '2026-08-11T00:00:00.000Z',
      initialConnected: 5_000,
      initialConnectionFailures: 0,
      churnCycles,
      runtimeCoverage: {
        samples: 1_440,
        sessionsAtCapacityRatio: 0.94,
        runnersAtCapacityRatio: 0.94,
        membershipsAtCapacityRatio: 0.94,
      },
      runs: {
        scheduled: 7_200,
        created: 7_200,
        delegated: 7_200,
        completed: 7_200,
        duplicates: 0,
        orderingViolations: 0,
        requestErrors: 0,
      },
      runIds: {
        requested: runIds,
        delegated: runIds,
        liveComplete: runIds,
        terminal: runIds,
      },
      liveEvents,
      liveEventDigest: createHash('sha256').update(JSON.stringify(liveEvents)).digest('hex'),
    },
    postDb: {
      runs: 7_200,
      completed: 7_200,
      eventsReconciled: 7_200,
      runIds,
      eventDigest: 'f'.repeat(64),
      failures: [],
    },
    database: productionShapedDatabase(),
    recovery: { final: { ...resources }, consecutivePassing: 3 },
    returnThresholds: { ...RETURN_THRESHOLDS },
    probe: {
      owned: true,
      uninstallError: null,
      postUninstall: { error: 'capacity probe is not installed' },
      summary: {
        metrics: {
          db_errors: 0,
          db_busy_or_locked_errors: 0,
          db_write_lock_owner_deaths: 0,
          probe_pool_errors: 0,
          probe_beam_errors: 0,
          probe_deep_errors: 0,
        },
        snapshot: { deep: { writeCoordinator: { locked: false, queue_depth: 0, owner_deaths: 0 } } },
      },
    },
    teardown: {
      runnerDisconnectFlushes: 1,
      runnerDisconnectFlushOwners: 5_000,
      runnerDelegatedSnapshotReads: 1,
      runnerDelegatedOwnerReads: 0,
      presenceDispatcher: {
        requested: 5_000,
        dispatched: 200,
        completed: 200,
        refreshed: 200,
        failed: 0,
        noop: 0,
        startFailed: 0,
        taskFailed: 0,
        active: 0,
        pending: 0,
        queued: 0,
      },
    },
    serverLogs: {
      policy: 'zero fatal/error lines from container start through soak finish',
      baselineCursor: state.container.startedAt,
      readError: null,
      matchedErrorLines: 0,
      matchesTruncated: false,
      sha256: '1'.repeat(64),
    },
    preflightFailures: [],
  };
}

test('accepts exact-image two-hour soak with periodic churn, run events, and baseline recovery', () => {
  assert.deepEqual(evaluateSoakEvidence(passingEvidence()), { ok: true, failures: [] });
});

test('requires the exact production orphan reclaim transition during the two-hour soak', () => {
  const database = productionShapedDatabase();
  assert.deepEqual(databaseReconciliation(
    database.baseline, database.final, 7_200, 28_800,
  ).failures, []);
  for (const mutate of [
    (copy) => { copy.final.delegatedRuns = 2; },
    (copy) => { copy.final.runEvents -= 2; },
    (copy) => { copy.final.baselineOrphans[0].maxSeq = 1_915; },
    (copy) => { copy.final.baselineOrphans[1].summary = 'different'; },
    (copy) => { copy.final.baselineOrphans[0].lastPayload = '{"status":"failed"}'; },
    (copy) => {
      const summary = copy.final.baselineOrphans[0].summary;
      copy.final.baselineOrphans[0].lastPayload = JSON.stringify({
        status: 'failed', summary, sessionId: 'unexpected',
      });
    },
  ]) {
    const copy = structuredClone(database);
    mutate(copy);
    assert.notEqual(databaseReconciliation(
      copy.baseline, copy.final, 7_200, 28_800,
    ).failures.length, 0);
  }
});

test('fails closed on a short or undersized soak and incomplete churn', () => {
  const evidence = passingEvidence();
  evidence.profile.users = 4_999;
  evidence.profile.soakSeconds = 7_199;
  evidence.observed.soakSeconds = 7_100;
  evidence.workload.initialConnected = 4_999;
  evidence.workload.churnCycles.pop();
  const result = evaluateSoakEvidence(evidence);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /soak users/);
  assert.match(result.failures.join('\n'), /soak duration/);
  assert.match(result.failures.join('\n'), /churn cycles/);
});

test('binds the evidence to one immutable image, revision, container, and start identity', () => {
  const evidence = passingEvidence();
  evidence.identity.final.container.id = 'container-2';
  evidence.identity.final.container.imageId = `sha256:${'d'.repeat(64)}`;
  evidence.identity.final.image.revision = 'e'.repeat(40);
  const result = evaluateSoakEvidence(evidence);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /final image/);
  assert.match(result.failures.join('\n'), /container identity changed/);
  assert.match(result.failures.join('\n'), /image revision changed/);
});

test('requires every run to be created, delegated, completed, ordered, and unique', () => {
  const evidence = passingEvidence();
  Object.assign(evidence.workload.runs, {
    created: 7_199,
    delegated: 7_198,
    completed: 7_197,
    duplicates: 1,
    orderingViolations: 1,
  });
  const result = evaluateSoakEvidence(evidence);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /runs created/);
  assert.match(result.failures.join('\n'), /runs delegated/);
  assert.match(result.failures.join('\n'), /runs completed/);
  assert.match(result.failures.join('\n'), /duplicate run delegations/);
  assert.match(result.failures.join('\n'), /ordering violations/);
});

test('binds exact live seq 2/3/4 evidence and the observed 300-second ramp', () => {
  const gapped = passingEvidence();
  gapped.workload.liveEvents[0].signature = ['2:status:running', '4:text', '5:status:completed'];
  gapped.workload.liveEventDigest = createHash('sha256')
    .update(JSON.stringify(gapped.workload.liveEvents))
    .digest('hex');
  assert.match(evaluateSoakEvidence(gapped).failures.join('\n'), /exactly seq 2\/3\/4/);

  const slowRamp = passingEvidence();
  slowRamp.workload.rampCompletedAt = '2026-08-11T00:00:11.000Z';
  assert.match(evaluateSoakEvidence(slowRamp).failures.join('\n'), /connection ramp/);
});

test('teardown probe deltas preserve counter regressions instead of clamping them to zero', () => {
  const before = { metrics: { runner_delegated_owner_reads: { count: 4 } } };
  const summary = {
    snapshot: {
      metrics: { runner_delegated_owner_reads: { count: 3 } },
      deep: { presenceDispatcher: {} },
    },
  };
  assert.equal(teardownProbeEvidence(before, summary).runnerDelegatedOwnerReads, -1);
});

test('post-leave comparison covers processes, ETS, memory, files, and DB pool state', () => {
  for (const key of ['processCount', 'etsBytes', 'memoryBytes', 'openFiles', 'poolBusy', 'poolQueue']) {
    const observed = { ...resources, [key]: Number.MAX_SAFE_INTEGER };
    assert.match(returnToBaselineFailures(resources, observed).join('\n'), new RegExp(key === 'etsBytes' ? 'ETS' : key === 'poolBusy' || key === 'poolQueue' ? 'DB pool' : key === 'memoryBytes' ? 'BEAM memory' : key === 'openFiles' ? 'BEAM open files' : 'BEAM process'));
  }
});

test('requires multiple consecutive post-leave samples at baseline', () => {
  const evidence = passingEvidence();
  evidence.recovery.consecutivePassing = 2;
  const result = evaluateSoakEvidence(evidence);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /baseline held for 2\/3 samples/);
});

test('does not allow an artifact to weaken post-leave resource thresholds', () => {
  const evidence = passingEvidence();
  evidence.returnThresholds.memoryBytesRatio = 100;
  const result = evaluateSoakEvidence(evidence);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /thresholds differ from the certified policy/);
});

test('release soak policy cannot shorten ramp, duration, cadence, churn, runs, or recovery proof', () => {
  for (const [key, value] of [
    ['rampSeconds', 0],
    ['soakSeconds', 7_199],
    ['sampleIntervalSeconds', 10],
    ['churnIntervalSeconds', 600],
    ['churnPercent', 5],
    ['runRps', 0.5],
    ['recoveryConsecutiveSamples', 1],
  ]) {
    const evidence = passingEvidence();
    evidence.profile[key] = value;
    assert.match(evaluateSoakEvidence(evidence).failures.join('\n'), new RegExp(key));
  }
});

test('fails closed on run-ID drift, fixture drift, DB reconciliation, probe uninstall, or server logs', () => {
  const mutations = [
    [(evidence) => evidence.workload.runIds.terminal.pop(), /run-ID sets/],
    [(evidence) => { evidence.fixtures.groups = 199; }, /fixture artifact/],
    [(evidence) => evidence.database.failures.push('foreign key violation'), /SQLite count\/integrity/],
    [(evidence) => { evidence.probe.uninstallError = 'timeout'; }, /probe ownership/],
    [(evidence) => { evidence.serverLogs.matchedErrorLines = 1; }, /server-log evidence/],
    [(evidence) => { evidence.workload.churnCycles[1] = { ...evidence.workload.churnCycles[0], index: 1 }; }, /identity\/cohort/],
    [(evidence) => { evidence.teardown.runnerDisconnectFlushes = 2; }, /runner teardown/],
    [(evidence) => { evidence.teardown.runnerDelegatedSnapshotReads = 2; }, /runner teardown/],
    [(evidence) => { evidence.teardown.presenceDispatcher.noop = 1; }, /dispatcher/],
    [(evidence) => { evidence.probe.postUninstall = { ok: true }; }, /probe ownership/],
  ];
  for (const [mutate, pattern] of mutations) {
    const evidence = passingEvidence();
    mutate(evidence);
    assert.match(evaluateSoakEvidence(evidence).failures.join('\n'), pattern);
  }
});

function journalSample(evidence, phase, elapsedSeconds) {
  return {
    type: 'runtime-sample',
    phase,
    observedAt: new Date(Date.parse(evidence.soakStartedAt) + elapsedSeconds * 1_000).toISOString(),
    elapsedSeconds,
    normalizedCpuPct: 20,
    memoryCurrent: 500_000_000,
    cgroup: {
      cpu: { usage_usec: elapsedSeconds * 100_000 },
      memoryPeak: 500_000_000,
      pidsPeak: 2_000,
      memoryEvents: { low: 0, high: 0, max: 0, oom: 0, oom_kill: 0, oom_group_kill: 0 },
      cpuPressure: { some: { avg10: 0 }, full: { avg10: 0 } },
      memoryPressure: { some: { avg10: 0 }, full: { avg10: 0 } },
      ioPressure: { some: { avg10: 0 }, full: { avg10: 0 } },
      io: '',
    },
    containerState: {
      ...structuredClone(evidence.identity.initial.container),
      imageRevision: revision,
    },
    beamOpenFiles: { pid: 1, count: 100 },
    beam: {
      configuration: { ...SOAK_RUNTIME_CONFIGURATION },
      pool: { busy: 0, queue: 0, utilizationPct: 10 },
      beam: {
        processCount: 1_000,
        realtimeSessions: phase === 'soak' ? 5_000 : 0,
        schedulersOnline: 2,
        schedulerUtilizationPct: 20,
        schedulerMaxUtilizationPct: 30,
        runQueue: 0,
        memory: { total: 500_000_000 },
        walBytes: 1_000_000,
      },
      deep: {
        etsBytes: 100_000_000,
        registeredRunners: phase === 'soak' ? 5_000 : 0,
        realtimeMemberships: phase === 'soak' ? 25_000 : 0,
        mailboxes: { max: 10 },
        writeCoordinator: { locked: false, queue_depth: 0, owner_deaths: 0 },
        cgroup: null,
      },
      metrics: {
        db_queue_us: { histogram: { 1000: elapsedSeconds + 20 } },
        db_query_us: { histogram: { 1000: elapsedSeconds + 20 } },
        db_write_lock_wait_us: { histogram: { 1000: elapsedSeconds + 20 } },
        db_write_lock_hold_us: { histogram: { 1000: elapsedSeconds + 20 } },
        db_write_lock_queue_depth: { max: 0 },
        db_pool_utilization_pct: { count: elapsedSeconds + 20 },
        db_pool_samples_above_80_pct: { count: 0 },
      },
    },
    errors: [],
  };
}

test('journal recomputation catches per-sample identity, shape, config, probe, mailbox, and WAL false passes', () => {
  const evidence = passingEvidence();
  const records = [
    journalSample(evidence, 'baseline', -15),
    journalSample(evidence, 'baseline', -10),
    journalSample(evidence, 'baseline', -5),
    journalSample(evidence, 'soak', 0),
    journalSample(evidence, 'soak', 7_200),
    journalSample(evidence, 'post-leave', 7_210),
    journalSample(evidence, 'post-leave', 7_220),
    journalSample(evidence, 'post-leave', 7_230),
  ];
  records[4].containerState.running = false;
  records[4].containerState.restartCount = 1;
  records[4].containerState.oomKilled = true;
  records[4].containerState.hostConfig.memory = 4 * 1024 ** 3;
  records[4].beam.configuration.sqlitePoolSize = 1;
  records[4].beam.metrics.db_busy_or_locked_errors = { count: 1 };
  records[4].beam.deep.mailboxes.max = 501;
  records[4].beam.beam.walBytes = 129 * 1024 ** 2;
  records[4].elapsedSeconds = 1;
  const failures = recomputeSoakJournal(evidence, records).failures.join('\n');
  assert.match(failures, /container is not running/);
  assert.match(failures, /restart count/);
  assert.match(failures, /OOM-killed/);
  assert.match(failures, /runtime envelope/);
  assert.match(failures, /sqlitePoolSize/);
  assert.match(failures, /busy\/locked/);
  assert.match(failures, /mailbox peak/);
  assert.match(failures, /WAL peak/);
  assert.match(failures, /elapsedSeconds is not bound/);
});

test('persisted run proof requires exactly queued, running, text, completed once and in order', () => {
  const events = [
    { seq: 1, type: 'status', payload: { status: 'queued' } },
    { seq: 2, type: 'status', payload: { status: 'running' } },
    { seq: 3, type: 'text', payload: {} },
    { seq: 4, type: 'status', payload: { status: 'completed' } },
  ];
  assert.deepEqual(persistedEventFailures(1, events).failures, []);
  const duplicate = [...events.slice(0, 3), { seq: 4, type: 'text', payload: {} }, { ...events[3], seq: 5 }];
  assert.match(persistedEventFailures(1, duplicate).failures.join('\n'), /event signature/);
});
