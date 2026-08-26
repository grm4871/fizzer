// Long-soak fixture builders: deterministic runtime journal, database, and workload records.
// Inputs are none or a fixture artifact; outputs are complete soak evidence; failures remain assertion-visible.
// Ordering builds raw samples first, then derives journal aggregates and evaluation.

import { createHash } from 'node:crypto';
import * as base from './certified-test-fixtures.mjs';
import { RETURN_THRESHOLDS, SOAK_PROFILE, SOAK_RUNTIME_CONFIGURATION, evaluateSoakEvidence as evaluateLongSoakEvidence, parseSoakJournal, recomputeSoakJournal } from '../../loadtest_elixir/soak-invariants.mjs';

const { imageId, revision, runtimeShape, fakeJwt, stable } = base;

export function soakFixtureArtifact() {
  const fixtures = Array.from({ length: SOAK_PROFILE.users }, (_unused, index) => ({
    token: fakeJwt(index + 1),
    vaultId: `vault-${Math.floor(index / 25)}`,
    channelId: `channel-${Math.floor(index / 25)}`,
    ownedChatChannels: index % 25 === 0 ? 1 : 0,
    runner: true,
  }));
  const text = `${fixtures.map((fixture) => JSON.stringify(fixture)).join('\n')}\n`;
  return { path: '/tmp/cascade-soak-fixtures.jsonl', sha256: '8'.repeat(64), text, fixtures };
}

export function soakServerLogArtifact() {
  return { path: '/tmp/cascade-soak-server.log', sha256: '9'.repeat(64), text: '[info ] ok\n' };
}

export function soakDatabaseEvidence() {
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

export function soakSample({ index, phase, elapsedSeconds, at, container, resources }) {
  const atCapacity = phase === 'soak';
  const metricCount = Math.max(index, 1);
  const cgroup = {
    cpu: { usage_usec: metricCount * 10_000, throttled_usec: 0 },
    memoryPeak: 600_000_000,
    pidsPeak: 1_500,
    memoryEvents: { low: 0, high: 0, max: 0, oom: 0, oom_kill: 0, oom_group_kill: 0 },
    cpuPressure: { some: { avg10: 0 }, full: { avg10: 0 } },
    memoryPressure: { some: { avg10: 0 }, full: { avg10: 0 } },
    ioPressure: { some: { avg10: 0 }, full: { avg10: 0 } },
    io: {},
  };
  const histogram = { 1_000: metricCount };
  return {
    type: 'runtime-sample',
    phase,
    observedAt: at,
    elapsedSeconds,
    normalizedCpuPct: 20,
    memoryCurrent: 600_000_000,
    beamOpenFiles: { count: resources.openFiles },
    containerState: {
      id: container.id,
      imageId: container.imageId,
      imageRevision: revision,
      startedAt: container.startedAt,
      running: true,
      restartCount: 0,
      oomKilled: false,
      hostConfig: structuredClone(container.hostConfig),
    },
    beam: {
      configuration: { ...SOAK_RUNTIME_CONFIGURATION },
      beam: {
        processCount: resources.processCount,
        memory: { total: resources.memoryBytes },
        realtimeSessions: atCapacity ? SOAK_PROFILE.users : resources.sessions,
        schedulerUtilizationPct: 25,
        schedulerMaxUtilizationPct: 35,
        runQueue: 0,
        schedulersOnline: 2,
        walBytes: 1_000_000,
      },
      pool: { busy: resources.poolBusy, queue: resources.poolQueue, utilizationPct: 10 },
      deep: {
        etsBytes: resources.etsBytes,
        registeredRunners: atCapacity ? SOAK_PROFILE.users : resources.runners,
        realtimeMemberships: atCapacity ? SOAK_PROFILE.users * 5 : resources.memberships,
        banditConnections: atCapacity ? SOAK_PROFILE.users : 0,
        cgroup,
        mailboxes: { max: 5 },
        writeCoordinator: { locked: false, queue_depth: 0, owner_deaths: 0 },
      },
      metrics: {
        db_queue_us: { histogram },
        db_query_us: { histogram },
        db_write_lock_wait_us: { histogram },
        db_write_lock_hold_us: { histogram },
        db_write_lock_queue_depth: { max: 0 },
        db_pool_utilization_pct: { count: metricCount },
        db_pool_samples_above_80_pct: { count: 0 },
        db_write_lock_owner_deaths: { count: 0 },
        db_errors: { count: 0 },
        db_busy_or_locked_errors: { count: 0 },
        realtime_auth_unknown: { count: 0 },
        probe_pool_errors: { count: 0 },
        probe_beam_errors: { count: 0 },
        probe_deep_errors: { count: 0 },
      },
    },
    errors: [],
  };
}

export function soakFixtureEvidence(artifact) {
  const selectedIdentity = artifact.fixtures.map((fixture, sourceIndex) => ({
    authenticatedUserId: sourceIndex + 1,
    sourceIndex,
    vaultId: fixture.vaultId,
    channelId: fixture.channelId,
    ownedChatChannels: fixture.ownedChatChannels,
    runner: true,
  }));
  const groupIdentities = Array.from({ length: SOAK_PROFILE.users / 25 }, (_unused, index) => ({
    vaultId: `vault-${index}`,
    channelId: `channel-${index}`,
    users: 25,
    owners: 1,
  })).sort((left, right) => `${left.vaultId}\u0000${left.channelId}`.localeCompare(`${right.vaultId}\u0000${right.channelId}`));
  const churnCohortDigests = Array.from({ length: 10 }, (_unused, cohort) => createHash('sha256')
    .update(JSON.stringify(stable(selectedIdentity.filter((_fixture, ordinal) => ordinal % 10 === cohort).map((fixture) => ({
      authenticatedUserId: fixture.authenticatedUserId,
      sourceIndex: fixture.sourceIndex,
    })))))
    .digest('hex'));
  return {
    path: artifact.path,
    sha256: artifact.sha256,
    bytes: Buffer.byteLength(artifact.text),
    lines: artifact.fixtures.length,
    users: SOAK_PROFILE.users,
    groups: groupIdentities.length,
    groupSize: 25,
    groupIdentities,
    selectedIdentitySha256: createHash('sha256')
      .update(JSON.stringify(stable(selectedIdentity)))
      .digest('hex'),
    churnCohortDigests,
  };
}

export function soakResult() {
  const fixture = soakFixtureArtifact();
  const fixtureIdentityEvidence = soakFixtureEvidence(fixture);
  const serverLog = soakServerLogArtifact();
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
  const container = {
    id: 'soak-container',
    imageId,
    startedAt: '2026-08-11T00:54:30.000Z',
    running: true,
    restartCount: 0,
    oomKilled: false,
    hostConfig: structuredClone(runtimeShape),
  };
  const image = { id: imageId, revision };
  const runtime = {
    elixir: '1.18.4',
    otpRelease: '27',
    ertsVersion: '15.2',
    cascadeVersion: '0.1.0',
    ...SOAK_RUNTIME_CONFIGURATION,
  };
  const runIds = Array.from({ length: SOAK_PROFILE.soakSeconds }, (_unused, index) => index + 1);
  const liveEvents = runIds.map((runId) => ({
    runId,
    signature: ['2:status:running', '3:text', '4:status:completed'],
  }));
  const baseAt = Date.parse('2026-08-11T00:54:40.000Z');
  const records = [
    ...Array.from({ length: 3 }, (_unused, index) => soakSample({
      index,
      phase: 'baseline',
      elapsedSeconds: -15 + index * 5,
      at: new Date(baseAt + index * 5_000).toISOString(),
      container,
      resources,
    })),
    ...Array.from({ length: SOAK_PROFILE.soakSeconds / SOAK_PROFILE.sampleIntervalSeconds }, (_unused, index) => soakSample({
      index: index + 3,
      phase: 'soak',
      elapsedSeconds: index * SOAK_PROFILE.sampleIntervalSeconds,
      at: new Date(Date.parse('2026-08-11T01:00:00.000Z') + index * SOAK_PROFILE.sampleIntervalSeconds * 1_000).toISOString(),
      container,
      resources,
    })),
    ...Array.from({ length: SOAK_PROFILE.recoveryConsecutiveSamples }, (_unused, index) => soakSample({
      index: index + 1_443,
      phase: 'post-leave',
      elapsedSeconds: SOAK_PROFILE.soakSeconds + (index + 1) * 5,
      at: new Date(Date.parse('2026-08-11T03:00:00.000Z') + (index + 1) * 5_000).toISOString(),
      container,
      resources,
    })),
  ];
  const journalText = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const journal = {
    path: '/tmp/cascade-soak.samples.jsonl',
    sha256: '7'.repeat(64),
    text: journalText,
  };
  const result = {
    schemaVersion: 1,
    type: 'cascade-elixir-two-hour-soak-invariants',
    expectedImage: imageId,
    expectedRevision: revision,
    target: 'https://staging.example',
    profile: { ...SOAK_PROFILE },
    fixtures: fixtureIdentityEvidence,
    returnThresholds: { ...RETURN_THRESHOLDS },
    identity: {
      initial: { container: structuredClone(container), image: structuredClone(image) },
      final: { container: structuredClone(container), image: structuredClone(image) },
      runtimeInitial: structuredClone(runtime),
      runtimeFinal: structuredClone(runtime),
    },
    startedAt: '2026-08-11T00:54:40.000Z',
    soakStartedAt: '2026-08-11T01:00:00.000Z',
    soakFinishedAt: '2026-08-11T03:00:00.000Z',
    finishedAt: '2026-08-11T03:00:15.000Z',
    observed: { soakSeconds: 7_200 },
    journal: {
      path: journal.path,
      sha256: journal.sha256,
      bytes: Buffer.byteLength(journal.text),
      samples: records.length,
    },
    baseline: null,
    workload: {
      rampStartedAt: '2026-08-11T00:55:00.000Z',
      rampCompletedAt: '2026-08-11T01:00:00.000Z',
      initialConnected: 5_000,
      initialConnectionFailures: 0,
      churnCycles: Array.from({ length: 23 }, (_unused, index) => ({
        index,
        cohort: index % 10,
        selectedIdentitySha256: fixtureIdentityEvidence.churnCohortDigests[index % 10],
        selected: 500,
        recovered: 500,
        within10: 500,
        within20: 500,
        failures: [],
      })),
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
        terminal: runIds,
        liveComplete: runIds,
      },
      liveEvents,
      liveEventDigest: createHash('sha256')
        .update(JSON.stringify(stable(liveEvents)))
        .digest('hex'),
      runtimeCoverage: null,
    },
    postDb: {
      runs: 7_200,
      completed: 7_200,
      eventsReconciled: 7_200,
      totalEvents: 28_800,
      runIds,
      eventDigest: 'f'.repeat(64),
      failures: [],
    },
    database: soakDatabaseEvidence(),
    recovery: null,
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
      output: serverLog.path,
      policy: 'zero fatal/error lines from container start through soak finish',
      baselineCursor: container.startedAt,
      finishCursor: '2026-08-11T03:00:15.000Z',
      readError: null,
      matchedErrorLines: 0,
      matches: [],
      matchesTruncated: false,
      sha256: serverLog.sha256,
      totalBytes: Buffer.byteLength(serverLog.text),
      totalLines: serverLog.text.split(/\r?\n/u).filter(Boolean).length,
    },
    preflightFailures: [],
  };
  const recomputed = recomputeSoakJournal(result, parseSoakJournal(journal.text));
  result.baseline = recomputed.baseline;
  result.workload.runtimeCoverage = recomputed.runtimeCoverage;
  result.recovery = recomputed.recovery;
  result.journal.validation = {
    records: recomputed.records,
    phases: recomputed.phases,
    headroom: recomputed.headroom,
    failures: recomputed.failures,
  };
  result.evaluation = evaluateLongSoakEvidence(result);
  return { result, journal, fixture, serverLog };
}
