import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  PRODUCTION_APPLICATION_TABLES,
  compareProductionRows,
  compareCorpusTree,
  configureSnapshotScratch,
  phaseWorkloadEvidence,
  validateBaselineOrphanState,
  validateCapacityFixtureArtifact,
  validateCapacityFixtureSummary,
  validateFaultEvidence,
  validateFaultPersistence,
  validateFixturePreflight,
  validateFreezeEvidence,
  validateLoadEvidence,
  validateLoadProvenance,
  validateManifest,
  validateMonitorEvidence,
  validatePhaseTableDeltas,
  validatePhaseChronology,
  validateProductionSourceSummary,
  validateReconciliationEvidence,
  validateServerLogArtifact,
  validateSoakEvidence,
} from './certified-image.mjs';
import { loadConfiguration } from '../loadtest_elixir/load.mjs';
import {
  RETURN_THRESHOLDS,
  SOAK_PROFILE,
  SOAK_RUNTIME_CONFIGURATION,
  evaluateSoakEvidence as evaluateLongSoakEvidence,
  parseSoakJournal,
  recomputeSoakJournal,
} from '../loadtest_elixir/soak-invariants.mjs';

const deployDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(deployDirectory, '..');
const imageId = `sha256:${'a'.repeat(64)}`;
const revision = 'b'.repeat(40);
const monitorDigest = 'c'.repeat(64);
const runtimeShape = {
  nanoCpus: 2_000_000_000,
  cpusetCpus: '0-1',
  memory: 3 * 1024 ** 3,
  memorySwap: 3 * 1024 ** 3,
  pidsLimit: 100_000,
  ulimits: [{ Name: 'nofile', Soft: 200_000, Hard: 200_000 }],
};
const releaseThresholds = {
  connectSuccess: 0.999,
  connectP99Ms: 5_000,
  httpErrorRate: 0.001,
  httpReadP99Ms: 1_000,
  httpWriteP99Ms: 1_000,
  eventP99Ms: 1_000,
  reconnectWithin10Success: 0.99,
  minimumRealtimeReceiptSuccess: 0.999,
  minimumRealtimeRunCompletionSuccess: 0.999,
  minimumWorkloadScheduledRatio: 0.99,
  minimumWorkloadAttemptedRatio: 0.99,
  minimumWorkloadCompletedRatio: 0.999,
  minimumWorkloadSucceededRatio: 0.999,
};

test('direct certifier commands reject memory-backed SQLite scratch', (t) => {
  const memoryBackedParent = ['/dev/shm', os.tmpdir()].find((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    const type = BigInt.asUintN(64, BigInt(fs.statfsSync(candidate).type));
    return type === 0x01021994n || type === 0x858458f6n;
  });
  assert.ok(memoryBackedParent, 'the Linux release test requires a tmpfs or ramfs fixture');
  const scratch = fs.mkdtempSync(path.join(memoryBackedParent, 'cascade-certifier-scratch-'));
  fs.chmodSync(scratch, 0o700);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  assert.throws(
    () => configureSnapshotScratch(scratch),
    /disk-backed storage, not tmpfs or ramfs/u,
  );
});

function artifact(index) {
  return { path: `/tmp/cascade-load-${index}.json`, sha256: `${index}`.repeat(64) };
}

function faultArtifact(index) {
  return { path: `/tmp/cascade-fault-${index}.json`, sha256: `${index + 4}`.repeat(64) };
}

function faultResult(fault) {
  const common = {
    schemaVersion: 1,
    type: 'cascade-fault-recovery',
    fault,
    target: 'https://staging.example',
    containerId: 'fault-container',
    imageId,
    revision,
    fixtureSha256: 'e'.repeat(64),
    startedAt: '2026-08-11T00:42:00.000Z',
    finishedAt: '2026-08-11T00:44:00.000Z',
    evaluation: { ok: true, failures: [] },
  };
  if (fault === 'runner-restart-reclaim') {
    return {
      ...common,
      observations: {
        runId: 1_898,
        sameContainer: true,
        sameImage: true,
        containerRestarted: true,
        restartMs: 4_000,
        reclaimedActiveRun: true,
        delegations: 1,
        completedTerminalEvents: 1,
        finalStatus: 'completed',
      },
    };
  }
  return {
    ...common,
    observations: {
      blockedId: 'fault-lock-blocked-test',
      recoveryId: 'fault-lock-recovery-test',
      vaultId: 'vault-test',
      channelId: 'channel-test',
      boundedFailureStatus: 503,
      boundedFailureMs: 5_100,
      failedWriteAbsent: true,
      recoveryStatus: 201,
      recoveryMs: 80,
      recoveryWritePersisted: true,
    },
  };
}

function soakArtifact() {
  return { path: '/tmp/cascade-soak.json', sha256: '6'.repeat(64) };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function fakeJwt(id) {
  return `e30.${Buffer.from(JSON.stringify({ id, username: `user-${id}` })).toString('base64url')}.signature`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function productionSourceSummary() {
  const vaults = {
    sha256: 'c41f69bcf4b5126fb627c9cc7ff9c69a54d287095348cec8916f04e320223f7a',
    bytes: 4_957_069,
    files: 345,
    directories: 129,
  };
  const qmd = {
    sha256: '7ce9e36fa48416df6232544f5c9092ce3232c2d05f2b800c98d4ccd3f2c76af1',
    bytes: 90_131_797,
    files: 8_980,
    directories: 16,
  };
  return {
    schemaVersion: 1,
    type: 'cascade-production-source-snapshot',
    database: {
      sha256: '3e97b52e819d6c7f02f24ce294cdc77523753a6dee4879cd0f36a7fa54fb2b78',
      bytes: 673_656_832,
      counts: {
        users: 7,
        vaults: 12,
        memberships: 15,
        notes: 325,
        messages: 4_082,
        runs: 1_897,
        runEvents: 403_514,
        delegatedRuns: 2,
        openDelegatedRuns: 2,
        maxRunId: 1_897,
      },
      quickCheck: 'ok',
      foreignKeyViolations: 0,
    },
    corpus: {
      sha256: sha256(JSON.stringify(stable({ qmd, vaults }))),
      bytes: vaults.bytes + qmd.bytes,
      files: vaults.files + qmd.files,
      vaults,
      qmd,
    },
  };
}

function capacityFixtureArtifact(users = 10_000) {
  const fixtures = Array.from({ length: users }, (_unused, index) => ({
    token: fakeJwt(index + 10_000),
    vaultId: `fixture-vault-${Math.floor(index / 25)}`,
    channelId: `fixture-channel-${Math.floor(index / 25)}`,
    ownedChatChannels: index % 25 === 0 ? 1 : 0,
    runner: true,
    runIds: [],
  }));
  const text = `${fixtures.map((fixture) => JSON.stringify(fixture)).join('\n')}\n`;
  return { path: '/tmp/capacity-fixtures.jsonl', text, sha256: sha256(text) };
}

function soakFixtureArtifact() {
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

function soakServerLogArtifact() {
  return { path: '/tmp/cascade-soak-server.log', sha256: '9'.repeat(64), text: '[info ] ok\n' };
}

function soakDatabaseEvidence() {
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

function soakSample({ index, phase, elapsedSeconds, at, container, resources }) {
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

function soakFixtureEvidence(artifact) {
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

function soakResult() {
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

function monitor({ ok = true, id = imageId } = {}) {
  const serverLogPath = '/tmp/cascade-capacity-server.log';
  const reconnectOwnerUserIds = Array.from({ length: 40 }, (_unused, index) => index + 1);
  const presencePlan = {
    strategy: 'owner-stratified-v1',
    initialOwnedChatChannels: 400,
    forcedReconnectOwnedChatChannels: 40,
    forcedReconnectOwnerUserIds: reconnectOwnerUserIds,
  };
  const presenceDispatcher = {
    requested: 20_000,
    dispatched: 2_400,
    completed: 2_400,
    failed: 0,
    noop: 0,
    active: 0,
    pending: 0,
    queued: 0,
    refreshed: 2_400,
    startFailed: 0,
    taskFailed: 0,
  };
  const realtimeObserved = {
    realtimeAuthFull: 11_000,
    realtimeAuthCacheHits: 22_000,
    realtimeAuthConflicts: 0,
    realtimeAuthUnknown: 0,
    presenceUserChannelReads: 9_999,
    presenceChannelSourceReads: 800,
    presenceParticipantSnapshotReads: 13_840,
    presenceSnapshotInitial: 11_000,
    presenceSnapshotDirect: 440,
    presenceSnapshotDispatcher: 2_400,
    presenceSnapshotOther: 0,
    chatListRouteReads: 49_340,
    chatListRouteMessage: 46_500,
    chatListRouteDirect: 440,
    chatListRouteDispatcher: 2_400,
    chatListRouteOther: 0,
    runnerDelegatedSnapshotReads: 1,
    runnerDelegatedOwnerReads: 0,
    runnerDisconnectFlushes: 1,
    runnerDisconnectFlushOwners: 9_999,
    presenceDispatcher,
  };
  const shards = [0, 1, 2, 3].map((index) => {
    const workloadIdentity = loadShard(index).workloadIdentity;
    return {
    index,
    users: 2_500,
    sourceIp: `198.51.100.${index + 1}`,
    startedAt: '2026-08-11T00:00:00.000Z',
    soakStartedAt: '2026-08-11T00:05:00.000Z',
    workloadFinishedAt: `2026-08-11T00:36:0${index}.000Z`,
    finishedAt: `2026-08-11T00:36:0${index + 4}.000Z`,
    path: artifact(index).path,
    sha256: artifact(index).sha256,
    markerSha256: artifact(index).sha256,
    initialOwnedChatChannels: 100,
    forcedReconnectOwnedChatChannels: 10,
    forcedReconnectStrategy: 'owner-stratified-v1',
    forcedReconnectOwnerUserIds: reconnectOwnerUserIds.slice(index * 10, (index + 1) * 10),
    successfulMessageIdsCount: workloadIdentity.successfulMessageIdsCount,
    successfulMessageIdsSha256: workloadIdentity.successfulMessageIdsSha256,
    requestedRunIdsCount: workloadIdentity.requestedRunIdsCount,
    requestedRunIdsSha256: workloadIdentity.requestedRunIdsSha256,
  };
  });
  const endpoints = [
    {
      type: 'start',
      observedAt: '2026-08-11T00:00:00.000Z',
      containerId: 'container-a',
      imageId: id,
      hostConfig: runtimeShape,
      expectedShape: {
        imageId: id,
        cpus: 2,
        memoryBytes: 3 * 1024 ** 3,
        sessions: 10_000,
        runners: 10_000,
        memberships: 50_000,
        runtime: { ...SOAK_RUNTIME_CONFIGURATION },
        realtime: {
          enabled: true,
          authFull: 11_000,
          groupCount: 400,
          successfulChatWrites: 46_500,
        },
      },
      monitorConfig: {
        intervalSeconds: 5,
        durationSeconds: 2_250,
        gateWindowSeconds: 1_800,
        workloadFinishedMarker: '/tmp/workload-finished.json',
        minimumWorkloadSeconds: 2_160,
        minimumPostWorkloadSeconds: 30,
        expectedLoad: {
          target: 'https://staging.example',
          shardCount: 4,
          rampSeconds: 300,
          soakSeconds: 1_860,
          pollingPercent: 5,
          reconnectPercent: 10,
          reconnectAtSeconds: 600,
          sourceIps: [0, 1, 2, 3].map((index) => `198.51.100.${index + 1}`),
          rates: { chatRps: 6.25, readRps: 12.5, runRps: 0.25 },
        },
      },
      preflightFailures: [],
      serverLogEvidence: {
        baselineCursor: '2026-08-10T23:59:55.000Z',
        monitorStartedAt: '2026-08-11T00:00:00.000Z',
        output: serverLogPath,
        policy: 'zero fatal/error lines from container start through monitor finish',
      },
    },
    {
      type: 'finish',
      observedAt: '2026-08-11T00:37:30.000Z',
      workload: {
        finishedAt: '2026-08-11T00:36:10.000Z',
        elapsedSeconds: 2_170,
        gateStartAt: '2026-08-11T00:06:00.000Z',
        gateEndAt: '2026-08-11T00:36:00.000Z',
        gateEndSeconds: 2_160,
        users: 10_000,
        presencePlan,
        shards,
        postWorkloadSeconds: 75,
        postWorkloadSamples: 15,
      },
      evaluation: {
        ok,
        failures: ok ? [] : ['capacity failed'],
        gateStartSeconds: 360,
        gateEndSeconds: 2_160,
        gateObservedSeconds: 1_800,
        observed: {
          sessionCoverage: 0.99,
          runnerCoverage: 0.99,
          membershipCoverage: 0.99,
          sessionsEnd: 10_000,
          runnersEnd: 10_000,
          membershipsEnd: 50_000,
          ...realtimeObserved,
        },
      },
      containerState: {
        ...runtimeShape,
        containerId: 'container-a',
        imageId: id,
        startedAt: '2026-08-10T23:59:55.000Z',
        running: true,
        oomKilled: false,
        restartCount: 0,
      },
      serverLogs: {
        baselineCursor: '2026-08-10T23:59:55.000Z',
        finishCursor: '2026-08-11T00:37:29.000Z',
        output: serverLogPath,
        readError: null,
        sha256: 'e'.repeat(64),
        totalBytes: 0,
        totalLines: 0,
        matchedErrorLines: 0,
        matches: [],
        matchesTruncated: false,
      },
    },
  ];
  const sample = (observedAt) => ({
    type: 'sample',
    observedAt,
    containerState: {
      ...runtimeShape,
      containerId: 'container-a',
      imageId: id,
      startedAt: '2026-08-10T23:59:55.000Z',
      running: true,
      oomKilled: false,
      restartCount: 0,
    },
  });
  return [
    endpoints[0],
    sample('2026-08-11T00:00:05.000Z'),
    sample('2026-08-11T00:37:25.000Z'),
    endpoints[1],
  ];
}

function monitorEndpoints(options) {
  const records = monitor(options);
  return [records[0], records.at(-1)];
}

function loadShard(index, overrides = {}) {
  const successfulMessageIds = Array.from(
    { length: 11_625 },
    (_unused, id) => `load-${index}-${String(id).padStart(5, '0')}`,
  );
  const requestedRunIds = Array.from(
    { length: 465 },
    (_unused, id) => 1_898 + index * 465 + id,
  );
  return {
    target: 'https://staging.example',
    sourceIp: `198.51.100.${index + 1}`,
    shard: { index, count: 4 },
    requestedUsers: 2_500,
    rampSeconds: 300,
    soakSeconds: 1_860,
    rampCompletedAt: '2026-08-11T00:05:00.000Z',
    soakStartedAt: '2026-08-11T00:05:00.000Z',
    workloadFinishedAt: `2026-08-11T00:36:0${index}.000Z`,
    pollingPercent: 5,
    reconnectPercent: 10,
    reconnectAtSeconds: 600,
    selectionPlan: {
      forcedReconnectStrategy: 'owner-stratified-v1',
      forcedReconnectOwnerUserIds: Array.from(
        { length: 10 },
        (_unused, owner) => index * 10 + owner + 1,
      ),
    },
    presencePlan: {
      strategy: 'owner-stratified-v1',
      initialOwnedChatChannels: 100,
      forcedReconnectOwnedChatChannels: 10,
      forcedReconnectOwnerUserIds: Array.from({ length: 10 }, (_unused, owner) => index * 10 + owner + 1),
    },
    rates: { chatRps: 6.25, readRps: 12.5, runRps: 0.25 },
    thresholds: { ...releaseThresholds },
    metrics: {
      startedAt: '2026-08-11T00:00:00.000Z',
      connected: 2_500,
      connectFailures: 0,
      pollingOnly: 125,
      forcedReconnectsExpected: 250,
      forcedReconnectsRecovered: 250,
      forcedReconnectsWithin10s: 248,
      forcedReconnectsWithin20s: 250,
      workload: { chat: { succeeded: successfulMessageIds.length }, run: { succeeded: requestedRunIds.length } },
    },
    workloadIdentity: {
      successfulMessageIds,
      successfulMessageIdsCount: successfulMessageIds.length,
      successfulMessageIdsSha256: sha256(JSON.stringify(stable(successfulMessageIds))),
      requestedRunIds,
      requestedRunIdsCount: requestedRunIds.length,
      requestedRunIdsSha256: sha256(JSON.stringify(stable(requestedRunIds))),
    },
    finishedAt: `2026-08-11T00:36:0${index + 4}.000Z`,
    evaluation: { ok: true, failures: [] },
    ...overrides,
  };
}

test('accepts only complete 10k evidence for one immutable image', () => {
  const records = monitor();
  const [start, finish] = monitorEndpoints();
  assert.deepEqual(validateMonitorEvidence(records, imageId), { start, finish });
  assert.deepEqual(validateLoadEvidence(
    [0, 1, 2, 3].map(loadShard),
    start,
    finish,
    [0, 1, 2, 3].map(artifact),
  ), {
    shardCount: 4,
    users: 10_000,
    gateStartAt: '2026-08-11T00:06:00.000Z',
    gateEndAt: '2026-08-11T00:36:00.000Z',
  });
});

test('production source provenance is pinned to the exact approved DB and corpus', () => {
  const source = productionSourceSummary();
  assert.equal(validateProductionSourceSummary(source), source);
  assert.throws(() => validateProductionSourceSummary({
    ...source,
    database: { ...source.database, sha256: '0'.repeat(64) },
  }), /approved immutable snapshot/);
  assert.throws(() => validateProductionSourceSummary({
    ...source,
    database: {
      ...source.database,
      counts: { ...source.database.counts, messages: 0 },
    },
  }), /baseline differs/);
  assert.throws(() => validateProductionSourceSummary({
    ...source,
    corpus: { ...source.corpus, files: source.corpus.files - 1 },
  }), /corpus differs/);
});

test('capacity fixtures bind exact profile shape without retaining tokens', () => {
  const finalArtifact = capacityFixtureArtifact();
  const final = validateCapacityFixtureArtifact(finalArtifact);
  assert.equal(final.users, 10_000);
  assert.equal(final.groups, 400);
  assert.doesNotMatch(JSON.stringify(final), /\.signature/u);
  const diagnostic = validateCapacityFixtureArtifact(capacityFixtureArtifact(1_000), 'diagnostic1k');
  assert.equal(diagnostic.users, 1_000);
  assert.throws(
    () => validateCapacityFixtureSummary(diagnostic, 'final10k'),
    /10,?000-user\/400-group shape/,
  );
  const rows = finalArtifact.text.trim().split('\n');
  rows[1] = rows[0];
  assert.throws(() => validateCapacityFixtureArtifact({
    ...finalArtifact,
    text: `${rows.join('\n')}\n`,
  }), /reuses a token/);
});

test('load provenance binds host driver, fixture bytes, and exact shard configuration', () => {
  const fixture = validateCapacityFixtureArtifact(capacityFixtureArtifact());
  const driverPath = path.join(root, 'loadtest_elixir', 'load.mjs');
  const driverBytes = fs.readFileSync(driverPath);
  const driver = { path: driverPath, sha256: sha256(driverBytes), bytes: driverBytes.byteLength };
  const results = [0, 1, 2, 3].map((index) => {
    const result = loadShard(index);
    result.provenance = {
      schemaVersion: 1,
      loadDriverSha256: driver.sha256,
      loadDriverBytes: driver.bytes,
      fixtureSha256: fixture.sha256,
      fixtureBytes: fixture.bytes,
      configurationSha256: sha256(JSON.stringify(stable(loadConfiguration(result)))),
    };
    return result;
  });
  const evidence = validateLoadProvenance(results, driver, fixture);
  assert.equal(evidence.configurations.length, 4);
  const loose = structuredClone(results);
  loose[0].thresholds.httpErrorRate = 1;
  assert.throws(() => validateLoadProvenance(loose, driver, fixture), /configuration digest/);
  const wrongFixture = structuredClone(results);
  wrongFixture[0].provenance.fixtureSha256 = '0'.repeat(64);
  assert.throws(() => validateLoadProvenance(wrongFixture, driver, fixture), /fixture bytes/);
});

function phaseRuntimeFixture() {
  const environment = [
    'ERL_AFLAGS=+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none',
    `CASCADE_HTTP_ACCEPTORS=${SOAK_RUNTIME_CONFIGURATION.httpAcceptors}`,
    `CASCADE_HTTP_MAX_CONNECTIONS=${SOAK_RUNTIME_CONFIGURATION.httpMaxConnections}`,
    `CASCADE_HTTP_BACKLOG=${SOAK_RUNTIME_CONFIGURATION.httpBacklog}`,
    `CASCADE_NETWORK_MODE=${SOAK_RUNTIME_CONFIGURATION.networkMode}`,
    `CASCADE_TRUST_PROXY_HOPS=${SOAK_RUNTIME_CONFIGURATION.trustProxyHops}`,
    `CASCADE_QMD_WORKER_ENABLED=${SOAK_RUNTIME_CONFIGURATION.qmdWorkerEnabled}`,
    `CASCADE_REALTIME_HIBERNATE_AFTER_MS=${SOAK_RUNTIME_CONFIGURATION.realtimeHibernateAfterMs}`,
    `CASCADE_RUNNER_ORPHAN_RECLAIM_MS=${SOAK_RUNTIME_CONFIGURATION.runnerOrphanReclaimMs}`,
    `CASCADE_SQLITE_POOL_SIZE=${SOAK_RUNTIME_CONFIGURATION.sqlitePoolSize}`,
    `CASCADE_SQLITE_BUSY_TIMEOUT_MS=${SOAK_RUNTIME_CONFIGURATION.sqliteBusyTimeoutMs}`,
  ];
  const runtime = {
    envelope: {
      nanoCpus: runtimeShape.nanoCpus,
      cpusetCpus: runtimeShape.cpusetCpus,
      memory: runtimeShape.memory,
      memorySwap: runtimeShape.memorySwap,
      pidsLimit: runtimeShape.pidsLimit,
      nofileSoft: 200_000,
      nofileHard: 200_000,
    },
    configuration: { ...SOAK_RUNTIME_CONFIGURATION },
    erlAflags: '+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none',
  };
  return {
    runtime,
    inspection: {
      Id: 'container-a',
      Config: { Env: environment },
      HostConfig: {
        NanoCpus: runtimeShape.nanoCpus,
        CpusetCpus: runtimeShape.cpusetCpus,
        Memory: runtimeShape.memory,
        MemorySwap: runtimeShape.memorySwap,
        PidsLimit: runtimeShape.pidsLimit,
        Ulimits: [{ Name: 'nofile', Soft: 200_000, Hard: 200_000 }],
      },
    },
  };
}

function logicalSourceRows(overrides = {}) {
  const fixtureExtras = new Map([
    ['community_note_activity', 400], ['notes', 400], ['users', 10_000],
    ['vault_members', 10_000], ['vaults', 400],
  ]);
  const tableDeltas = PRODUCTION_APPLICATION_TABLES.map((tableName) => ({
    tableName,
    missingRows: 0,
    extraRows: fixtureExtras.get(tableName) || 0,
  }));
  const tableNames = tableDeltas.map((row) => row.tableName);
  return {
    sourceSha256: productionSourceSummary().database.sha256,
    forbiddenChanges: 0,
    missingRows: 0,
    extraRows: 21_200,
    tables: tableDeltas.length,
    tableNames,
    tableNamesSha256: sha256(JSON.stringify(stable(tableNames))),
    tableDeltas,
    tableEvidenceSha256: sha256(JSON.stringify(stable(tableDeltas))),
    schemaMigrationSha256: '2'.repeat(64),
    schemaEvidenceSha256: '3'.repeat(64),
    schemaValidation: 'pinned Elixir transform passed',
    chatTransforms: { rows: 4_082, missionJsonSemanticReencodes: 0, missionTaskBackfills: 2, sha256: '4'.repeat(64) },
    fts: { integrityCheck: 'rank=1 passed on disposable snapshot' },
    ...overrides,
  };
}

function candidateCorpusEvidence() {
  return Object.fromEntries(['vaults', 'qmd'].map((name) => [name, {
    approvedRecords: 1,
    approvedSha256: sha256(`approved-${name}`),
    missingOrChanged: 0,
    unexpectedExtras: 0,
    derivedIndexChanges: 0,
    extrasSha256: '5'.repeat(64),
    derivedIndexChangesSha256: '6'.repeat(64),
  }]));
}

test('phase preflight and freeze validators bind never-started identity, scratch, schema, corpus, and orphan policy', () => {
  const source = productionSourceSummary();
  const fixture = validateCapacityFixtureArtifact(capacityFixtureArtifact());
  const { runtime, inspection } = phaseRuntimeFixture();
  const mount = {
    inspection,
    mountDestination: '/data',
    mountSourceSha256: '7'.repeat(64),
    relativeDatabase: 'docs.db',
  };
  const scratch = {
    device: '8',
    availableBytes: 3 * 1024 ** 3,
    policy: 'private owned disk-backed scratch with at least 2 GiB free',
  };
  const result = {
    schemaVersion: 1,
    type: 'cascade-capacity-fixture-preflight',
    profile: 'final10k',
    phase: 'main10k',
    imageId,
    containerId: 'container-a',
    containerStartedAt: '0001-01-01T00:00:00Z',
    runtime,
    mountDestination: '/data',
    mountSourceSha256: mount.mountSourceSha256,
    relativeDatabase: 'docs.db',
    sourceDatabaseSha256: source.database.sha256,
    sourceCorpusSha256: source.corpus.sha256,
    fixtureSha256: fixture.sha256,
    databaseSha256: '8'.repeat(64),
    databaseBytes: source.database.bytes + 1,
    databaseDevice: '10',
    databaseInode: '11',
    baseline: {
      users: 10_007, vaults: 412, memberships: 10_015, notes: 725,
      messages: 4_082, runs: 1_897, runEvents: 403_514,
      delegatedRuns: 2, maxRunId: 1_897, quickCheck: 'ok', foreignKeyViolations: 0,
    },
    identity: {
      users: 10_000, groups: 400, userMismatches: 0, membershipMismatches: 0,
      vaultMismatches: 0, channelMismatches: 0, activityMismatches: 0,
      identitySha256: '9'.repeat(64),
    },
    sourceRows: logicalSourceRows(),
    candidateCorpus: candidateCorpusEvidence(),
    snapshotScratch: scratch,
    walPresent: false,
    shmPresent: false,
    createdAt: '2026-08-11T00:00:00.000Z',
  };
  const evidence = validateFixturePreflight(
    result, { sha256: 'a'.repeat(64) }, source, fixture, mount, imageId,
  );
  assert.equal(evidence.containerStartedAt, '0001-01-01T00:00:00Z');
  assert.throws(
    () => validateFixturePreflight({ ...result, containerStartedAt: '2026-08-11T00:00:00Z' },
      { sha256: 'a'.repeat(64) }, source, fixture, mount, imageId),
    /already been started/,
  );

  const freeze = {
    schemaVersion: 1,
    type: 'cascade-capacity-phase-freeze',
    phase: 'main10k',
    profile: 'final10k',
    imageId,
    containerId: 'container-a',
    mountSourceSha256: mount.mountSourceSha256,
    databaseSha256: 'b'.repeat(64),
    databaseBytes: result.databaseBytes + 1,
    databaseDevice: result.databaseDevice,
    databaseInode: result.databaseInode,
    runtime,
    candidateCorpus: candidateCorpusEvidence(),
    sourceRows: logicalSourceRows(),
    identity: result.identity,
    orphanState: { state: 'reclaimed' },
    phaseWorkload: { runs: 1 },
    snapshotScratch: scratch,
    containerState: { running: false, restartCount: 0, oomKilled: false },
    containerStartedAt: '2026-08-11T00:00:00.000Z',
    walPresent: false,
    shmPresent: false,
    frozenAt: '2026-08-11T01:00:00.000Z',
  };
  assert.equal(validateFreezeEvidence(freeze, { sha256: 'c'.repeat(64) }, evidence, imageId).phase,
    'main10k');
  assert.throws(
    () => validateFreezeEvidence({ ...freeze, orphanState: { state: 'preserved' } },
      { sha256: 'c'.repeat(64) }, evidence, imageId),
    /orphan state/,
  );
  assert.throws(
    () => validateFreezeEvidence({
      ...freeze,
      candidateCorpus: {
        ...freeze.candidateCorpus,
        vaults: { ...freeze.candidateCorpus.vaults, approvedRecords: 0 },
      },
    }, { sha256: 'c'.repeat(64) }, evidence, imageId),
    /candidate corpus/,
  );
  assert.throws(
    () => validateFreezeEvidence({
      ...freeze,
      identity: { ...freeze.identity, userMismatches: 1 },
    }, { sha256: 'c'.repeat(64) }, evidence, imageId),
    /identity joins/,
  );
});

test('candidate corpus accepts scoped fixture extras and rejects approved-byte drift or unexpected roots', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-corpus-proof-'));
  const source = path.join(directory, 'source');
  const candidate = path.join(directory, 'candidate');
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(candidate);
    fs.writeFileSync(path.join(source, 'approved.md'), 'approved\n');
    fs.copyFileSync(path.join(source, 'approved.md'), path.join(candidate, 'approved.md'));
    fs.mkdirSync(path.join(candidate, 'fixture-1'));
    fs.writeFileSync(path.join(candidate, 'fixture-1', 'General.md'), 'fixture\n');
    assert.equal(compareCorpusTree(source, candidate, 'test corpus', ['fixture-1']).missingOrChanged, 0);
    fs.writeFileSync(path.join(candidate, 'approved.md'), 'mutated\n');
    assert.throws(() => compareCorpusTree(source, candidate, 'test corpus', ['fixture-1']), /mutated or omitted/);
    fs.copyFileSync(path.join(source, 'approved.md'), path.join(candidate, 'approved.md'));
    fs.mkdirSync(path.join(candidate, 'unexpected'));
    assert.throws(() => compareCorpusTree(source, candidate, 'test corpus', ['fixture-1']), /not attributable/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('orphan, phase-workload, and exact table-delta evidence fail closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-phase-proof-'));
  const database = path.join(directory, 'docs.db');
  try {
    const db = new Database(database);
    db.exec(`
      CREATE TABLE runs (id INTEGER PRIMARY KEY,status TEXT,summary TEXT,prompt TEXT);
      CREATE TABLE delegated_runs (run_id INTEGER PRIMARY KEY,owner_user_id INTEGER);
      CREATE TABLE run_events (run_id INTEGER,seq INTEGER,type TEXT,payload_json TEXT);
      CREATE TABLE chat_messages (id TEXT PRIMARY KEY,vault_id TEXT,channel_id TEXT,body TEXT);
      INSERT INTO runs VALUES
        (1896,'queued',NULL,'baseline'),(1897,'queued',NULL,'baseline'),
        (1898,'completed','restart recovery passed','runner restart recovery proof');
      INSERT INTO delegated_runs VALUES(1896,1),(1897,4);
      INSERT INTO run_events VALUES
        (1896,1913,'queued','{}'),(1897,27,'queued','{}'),
        (1898,1,'status','{"status":"queued"}'),
        (1898,2,'status','{"status":"running"}'),
        (1898,3,'status','{"status":"completed","summary":"restart recovery passed","sessionId":"fault-session-1898"}');
      INSERT INTO chat_messages VALUES(
        'fault-lock-recovery-test','vault-test','channel-test','dependency recovered'
      );
    `);
    db.close();
    assert.equal(validateBaselineOrphanState(database, false).state, 'preserved');
    const workload = phaseWorkloadEvidence(database, 'faults');
    assert.deepEqual(workload.workloadMessages.map((row) => row.id), ['fault-lock-recovery-test']);
    assert.equal(workload.badRunEventSequences, 0);
    const faults = validateFaultEvidence(
      [faultResult('runner-restart-reclaim'), faultResult('sqlite-write-lock')],
      [faultArtifact(0), faultArtifact(1)], imageId, revision, 'https://staging.example',
      'e'.repeat(64),
    );
    assert.equal(validateFaultPersistence(workload, faults), true);
    for (const mutate of [
      (copy) => copy.workloadRunEvents.splice(1, 0, {
        runId: 1_898, seq: 2, type: 'text', payloadJson: '{"text":"arbitrary"}',
      }),
      (copy) => { copy.workloadRunEvents[1].payloadJson = '{"status":"queued"}'; },
      (copy) => { copy.workloadRunEvents[2].payloadJson = '{"status":"completed","summary":"restart recovery passed"}'; },
    ]) {
      const changed = structuredClone(workload);
      mutate(changed);
      assert.throws(() => validateFaultPersistence(changed, faults), /exact queued\/running\/completed|exact runner-restart/);
    }

    const reclaimed = new Database(database);
    const summary = 'Desktop agent runner did not reclaim this run after server restart.';
    reclaimed.prepare('UPDATE runs SET status=?,summary=? WHERE id IN (1896,1897)').run('failed', summary);
    reclaimed.exec('DELETE FROM delegated_runs');
    reclaimed.prepare('INSERT INTO run_events VALUES(?,?,?,?)')
      .run(1896, 1914, 'status', JSON.stringify({ status: 'failed', summary }));
    reclaimed.prepare('INSERT INTO run_events VALUES(?,?,?,?)')
      .run(1897, 28, 'status', JSON.stringify({ status: 'failed', summary }));
    reclaimed.close();
    assert.equal(validateBaselineOrphanState(database, true).state, 'reclaimed');
    const compensated = new Database(database);
    compensated.prepare('UPDATE run_events SET payload_json=? WHERE run_id=1896 AND seq=1914')
      .run(JSON.stringify({ status: 'failed', summary, sessionId: 'unexpected' }));
    compensated.close();
    assert.throws(() => validateBaselineOrphanState(database, true), /exact terminal event/);
    const restored = new Database(database);
    restored.prepare('UPDATE run_events SET payload_json=? WHERE run_id=1896 AND seq=1914')
      .run(JSON.stringify({ status: 'failed', summary }));
    restored.close();

    const phaseExtras = new Map([
      ['users', 10_000], ['vaults', 400], ['vault_members', 10_000],
      ['notes', 400], ['community_note_activity', 400], ['chat_messages', 1],
      ['runs', 1], ['run_events', 3],
    ]);
    const deltas = PRODUCTION_APPLICATION_TABLES.map((tableName) => ({
      tableName, missingRows: 0, extraRows: phaseExtras.get(tableName) || 0,
    }));
    const deltaEvidence = () => ({
      tables: deltas.length,
      tableNames: deltas.map((row) => row.tableName),
      tableNamesSha256: sha256(JSON.stringify(stable(deltas.map((row) => row.tableName)))),
      tableDeltas: deltas,
      tableEvidenceSha256: sha256(JSON.stringify(stable(deltas))),
    });
    assert.equal(validatePhaseTableDeltas(
      { phase: 'faults', orphanState: { state: 'preserved' }, sourceRows: deltaEvidence() },
      { users: 10_000, groups: 400 },
      { runEvents: 3 },
    ), true);
    deltas.find((row) => row.tableName === 'run_events').extraRows = 4;
    assert.throws(() => validatePhaseTableDeltas(
      { phase: 'faults', orphanState: { state: 'preserved' }, sourceRows: deltaEvidence() },
      { users: 10_000, groups: 400 },
      { runEvents: 3 },
    ), /unexpected rows/);
    const deleted = structuredClone(deltaEvidence());
    deleted.tableDeltas.pop();
    deleted.tables = deleted.tableDeltas.length;
    deleted.tableNames = deleted.tableDeltas.map((row) => row.tableName);
    deleted.tableNamesSha256 = sha256(JSON.stringify(stable(deleted.tableNames)));
    deleted.tableEvidenceSha256 = sha256(JSON.stringify(stable(deleted.tableDeltas)));
    assert.throws(() => validatePhaseTableDeltas(
      { phase: 'faults', orphanState: { state: 'preserved' }, sourceRows: deleted },
      { users: 10_000, groups: 400 }, { runEvents: 3 },
    ), /approved production database|duplicate, missing, or reordered/);
    const duplicate = structuredClone(deltaEvidence());
    duplicate.tableDeltas[1].tableName = duplicate.tableDeltas[0].tableName;
    duplicate.tableNames[1] = duplicate.tableNames[0];
    duplicate.tableNamesSha256 = sha256(JSON.stringify(stable(duplicate.tableNames)));
    duplicate.tableEvidenceSha256 = sha256(JSON.stringify(stable(duplicate.tableDeltas)));
    assert.throws(() => validatePhaseTableDeltas(
      { phase: 'faults', orphanState: { state: 'preserved' }, sourceRows: duplicate },
      { users: 10_000, groups: 400 }, { runEvents: 3 },
    ), /duplicate, missing, or reordered/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('real production-derived fixture passes exact logical origin without side effects', {
  skip: !(process.env.CASCADE_REAL_PRODUCTION_SOURCE_DB && process.env.CASCADE_REAL_CAPACITY_FIXTURE_DB),
}, () => {
  const source = process.env.CASCADE_REAL_PRODUCTION_SOURCE_DB;
  const candidate = process.env.CASCADE_REAL_CAPACITY_FIXTURE_DB;
  for (const database of [source, candidate]) {
    assert.equal(fs.existsSync(`${database}-wal`), false);
    assert.equal(fs.existsSync(`${database}-shm`), false);
  }
  const evidence = compareProductionRows(source, candidate, {
    profileName: 'diagnostic1k', phase: 'preflight',
  });
  assert.equal(evidence.missingRows, 0);
  assert.equal(evidence.chatTransforms.missionJsonSemanticReencodes, 0);
  assert.equal(evidence.chatTransforms.missionTaskBackfills, 2);
  assert.equal(evidence.schemaValidation, 'pinned Elixir transform passed');
  for (const database of [source, candidate]) {
    assert.equal(fs.existsSync(`${database}-wal`), false);
    assert.equal(fs.existsSync(`${database}-shm`), false);
  }
});

test('certifier independently binds exact realtime reason and dispatcher accounting', () => {
  const otherReason = monitor();
  otherReason.at(-1).evaluation.observed.presenceSnapshotOther = 1;
  assert.throws(() => validateMonitorEvidence(otherReason, imageId), /presence snapshot reason accounting/);

  const shardPlanDrift = monitor();
  shardPlanDrift.at(-1).workload.shards[0].initialOwnedChatChannels = 99;
  assert.throws(() => validateMonitorEvidence(shardPlanDrift, imageId), /invalid presence-owner plan/);

  const strategyDrift = monitor();
  strategyDrift.at(-1).workload.shards[0].forcedReconnectStrategy = 'owner-first-v1';
  assert.throws(() => validateMonitorEvidence(strategyDrift, imageId), /invalid presence-owner plan/);

  const duplicateOwner = monitor();
  duplicateOwner.at(-1).workload.shards[1].forcedReconnectOwnerUserIds[0] = 1;
  assert.throws(() => validateMonitorEvidence(duplicateOwner, imageId), /reconnect-owner IDs differ/);
});

test('rejects image drift, failed monitor evaluation, and incomplete load shards', () => {
  assert.throws(() => validateMonitorEvidence(monitor({ id: `sha256:${'c'.repeat(64)}` }), imageId),
    /exercised .* expected/);
  assert.throws(() => validateMonitorEvidence(monitor({ ok: false }), imageId), /capacity monitor failed/);
  const [start, finish] = monitorEndpoints();
  assert.throws(() => validateLoadEvidence(
    [0, 1, 2].map(loadShard), start, finish, [0, 1, 2].map(artifact),
  ), /3 load results for 4 shards/);
});

test('rejects monitor duration, concurrency window, or finish coverage below the release contract', () => {
  const tooShort = monitor();
  tooShort[0].monitorConfig.durationSeconds = 2_249;
  assert.throws(() => validateMonitorEvidence(tooShort, imageId), /shorter than 2,250 seconds/);

  const shortGate = monitor();
  shortGate[0].monitorConfig.gateWindowSeconds = 1_799;
  assert.throws(() => validateMonitorEvidence(shortGate, imageId), /shorter than 30 minutes/);

  const missingCoverage = monitor();
  delete missingCoverage.at(-1).evaluation.observed.membershipCoverage;
  assert.throws(() => validateMonitorEvidence(missingCoverage, imageId), /50,000-membership coverage/);

  const staleMarker = monitor();
  staleMarker.at(-1).workload.finishedAt = '2026-08-10T23:59:59.000Z';
  assert.throws(() => validateMonitorEvidence(staleMarker, imageId), /stale or invalid/);

  const identityDrift = monitor();
  identityDrift[1].containerState.imageId = `sha256:${'d'.repeat(64)}`;
  assert.throws(() => validateMonitorEvidence(identityDrift, imageId), /identity drifted/);

  const finishDrift = monitor();
  finishDrift.at(-1).containerState.containerId = 'replacement-container';
  assert.throws(() => validateMonitorEvidence(finishDrift, imageId), /finish container\/image identity differs/);

  const resourceDrift = monitor();
  resourceDrift[1].containerState.memory = 4 * 1024 ** 3;
  assert.throws(() => validateMonitorEvidence(resourceDrift, imageId), /runtime envelope drifted/);
});

test('rejects missing, drifted, or nonzero server-log evidence', () => {
  const missing = monitor();
  delete missing.at(-1).serverLogs;
  assert.throws(() => validateMonitorEvidence(missing, imageId), /server-log artifact path|server-log capture/);

  const drifted = monitor();
  drifted.at(-1).serverLogs.baselineCursor = '2026-08-11T00:00:01.000Z';
  assert.throws(() => validateMonitorEvidence(drifted, imageId), /server-log capture interval/);

  const errored = monitor();
  errored.at(-1).serverLogs.matchedErrorLines = 1;
  errored.at(-1).serverLogs.matches = ['[error] crash'];
  assert.throws(() => validateMonitorEvidence(errored, imageId), /contains fatal\/error lines/);
});

test('server-log certification binds one regular raw artifact snapshot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-server-log-cert-'));
  try {
    const output = path.join(directory, 'server.log');
    const raw = '2026-08-11T00:00:00Z [info] started\n';
    fs.writeFileSync(output, raw, { mode: 0o600 });
    const [start, finish] = monitorEndpoints();
    start.serverLogEvidence.output = output;
    Object.assign(finish.serverLogs, {
      output,
      sha256: createHash('sha256').update(raw).digest('hex'),
      totalBytes: Buffer.byteLength(raw),
      totalLines: 1,
    });
    assert.equal(validateServerLogArtifact(start, finish).path, output);

    fs.appendFileSync(output, 'tampered\n');
    assert.throws(() => validateServerLogArtifact(start, finish), /checksum differs/);

    fs.unlinkSync(output);
    const target = path.join(directory, 'target.log');
    fs.writeFileSync(target, raw);
    fs.symlinkSync(target, output);
    assert.throws(() => validateServerLogArtifact(start, finish), /without following symlinks/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects reconnect, ramp, or soak evidence below the release contract', () => {
  const [start, finish] = monitorEndpoints();
  const short = [0, 1, 2, 3].map(loadShard);
  short[2].soakSeconds = 1_859;
  assert.throws(() => validateLoadEvidence(short, start, finish, [0, 1, 2, 3].map(artifact)),
    /inconsistent workload configurations|differs from the monitor workload contract/);

  const incomplete = [0, 1, 2, 3].map(loadShard);
  incomplete[1].metrics.forcedReconnectsWithin20s = 249;
  assert.throws(() => validateLoadEvidence(incomplete, start, finish, [0, 1, 2, 3].map(artifact)),
    /20-second reconnect deadline/);

  const drifted = [0, 1, 2, 3].map(loadShard);
  drifted[3].target = 'https://different.example';
  assert.throws(() => validateLoadEvidence(drifted, start, finish, [0, 1, 2, 3].map(artifact)),
    /different staging endpoints/);

  const ownerIdsDrifted = [0, 1, 2, 3].map(loadShard);
  ownerIdsDrifted[0].selectionPlan.forcedReconnectOwnerUserIds.pop();
  assert.throws(() => validateLoadEvidence(
    ownerIdsDrifted,
    start,
    finish,
    [0, 1, 2, 3].map(artifact),
  ), /presence-owner plan differs/);
});

test('requires every shard artifact and ready interval to cover the exact monitor gate', () => {
  const [start, finish] = monitorEndpoints();
  const late = [0, 1, 2, 3].map(loadShard);
  late[2].soakStartedAt = '2026-08-11T00:06:01.000Z';
  assert.throws(() => validateLoadEvidence(late, start, finish, [0, 1, 2, 3].map(artifact)),
    /not ready before the monitor gate started/);

  const early = [0, 1, 2, 3].map(loadShard);
  early[0].workloadFinishedAt = '2026-08-11T00:35:59.000Z';
  assert.throws(() => validateLoadEvidence(early, start, finish, [0, 1, 2, 3].map(artifact)),
    /ended before the monitor gate finished/);

  const changedArtifact = [0, 1, 2, 3].map(artifact);
  changedArtifact[1] = { ...changedArtifact[1], sha256: 'f'.repeat(64) };
  assert.throws(() => validateLoadEvidence(
    [0, 1, 2, 3].map(loadShard), start, finish, changedArtifact,
  ), /checksum differs from the workload marker/);
});

test('fault certification binds runner restart and SQLite lock recovery to the exact image', () => {
  const results = [faultResult('runner-restart-reclaim'), faultResult('sqlite-write-lock')];
  const artifacts = [faultArtifact(0), faultArtifact(1)];
  assert.equal(
    validateFaultEvidence(results, artifacts, imageId, revision, 'https://staging.example', 'e'.repeat(64)).length,
    2,
  );
  assert.throws(
    () => validateFaultEvidence(
      [results[0], { ...results[1], imageId: `sha256:${'f'.repeat(64)}` }],
      artifacts,
      imageId,
      revision,
      'https://staging.example',
      'e'.repeat(64),
    ),
    /different image/,
  );
  assert.throws(
    () => validateFaultEvidence(
      [results[0], { ...results[1], observations: { ...results[1].observations, failedWriteAbsent: false } }],
      artifacts,
      imageId,
      revision,
      'https://staging.example',
      'e'.repeat(64),
    ),
    /phantom failure/,
  );
  const wrongFixture = structuredClone(results);
  wrongFixture[1].fixtureSha256 = '0'.repeat(64);
  assert.throws(
    () => validateFaultEvidence(
      wrongFixture, artifacts, imageId, revision, 'https://staging.example', 'e'.repeat(64),
    ),
    /different authenticated fixture cohort/,
  );
});

test('phase chronology binds each never-started preflight before its workload', () => {
  const preflights = {
    faults: { createdAt: '2026-08-11T01:01:00.000Z' },
    soak5k: { createdAt: '2026-08-11T01:02:00.000Z' },
  };
  const freezes = {
    main10k: { frozenAt: '2026-08-11T01:00:00.000Z' },
    faults: { frozenAt: '2026-08-11T01:10:00.000Z' },
    soak5k: { frozenAt: '2026-08-11T04:00:00.000Z' },
  };
  const reconciliation = { finishedAt: '2026-08-11T00:59:00.000Z' };
  const faults = [
    { startedAt: '2026-08-11T01:03:00.000Z', finishedAt: '2026-08-11T01:04:00.000Z' },
    { startedAt: '2026-08-11T01:04:00.000Z', finishedAt: '2026-08-11T01:05:00.000Z' },
  ];
  const soak = { startedAt: '2026-08-11T01:03:00.000Z', finishedAt: '2026-08-11T03:30:00.000Z' };
  assert.equal(validatePhaseChronology(preflights, freezes, reconciliation, faults, soak), true);
  assert.throws(() => validatePhaseChronology(
    { ...preflights, faults: { createdAt: '2026-08-11T01:04:30.000Z' } },
    freezes, reconciliation, faults, soak,
  ), /before its never-started preflight/);
  assert.throws(() => validatePhaseChronology(
    { ...preflights, soak5k: { createdAt: '2026-08-11T01:04:00.000Z' } },
    freezes, reconciliation, faults, soak,
  ), /before its never-started preflight/);
});

test('soak certification binds two hours, 5,000 users, churn, run events, and recovery journal', () => {
  const { result, journal, fixture, serverLog } = soakResult();
  const validated = validateSoakEvidence(
    result,
    soakArtifact(),
    journal,
    fixture,
    serverLog,
    imageId,
    revision,
    'https://staging.example',
  );
  assert.equal(validated.users, 5_000);
  assert.equal(validated.soakSeconds, 7_200);
  assert.equal(validated.evaluation, 'passed');
  assert.throws(
    () => validateSoakEvidence(
      { ...result, expectedImage: `sha256:${'f'.repeat(64)}` },
      soakArtifact(),
      journal,
      fixture,
      serverLog,
      imageId,
      revision,
      'https://staging.example',
    ),
    /different image/,
  );
  assert.throws(
    () => validateSoakEvidence(
      { ...result, workload: { ...result.workload, initialConnected: 4_999 } },
      soakArtifact(),
      journal,
      fixture,
      serverLog,
      imageId,
      revision,
      'https://staging.example',
    ),
    /5,000 authenticated runner users/,
  );
});

test('soak certifier recomputes raw journal, fixture, run-ID, log, profile, and cleanup evidence', () => {
  const validate = (result, journal, fixture, serverLog) => validateSoakEvidence(
    result,
    soakArtifact(),
    journal,
    fixture,
    serverLog,
    imageId,
    revision,
    'https://staging.example',
  );
  {
    const { result, journal, fixture, serverLog } = soakResult();
    const records = journal.text.trim().split('\n').map(JSON.parse);
    records[10].containerState.hostConfig.memory = 4 * 1024 ** 3;
    const drifted = { ...journal, text: `${records.map(JSON.stringify).join('\n')}\n` };
    assert.throws(() => validate(result, drifted, fixture, serverLog), /aggregates differ|recomputed evidence/);
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    const rows = fixture.text.trim().split('\n');
    const changed = JSON.parse(rows[0]);
    changed.vaultId = 'wrong-vault';
    rows[0] = JSON.stringify(changed);
    assert.throws(
      () => validate(result, journal, { ...fixture, text: `${rows.join('\n')}\n` }, serverLog),
      /fixture vault\/channel group .* owns 0 chat channels/,
    );
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    const rows = fixture.text.trim().split('\n');
    const changed = JSON.parse(rows[0]);
    delete changed.ownedChatChannels;
    rows[0] = JSON.stringify(changed);
    assert.throws(
      () => validate(result, journal, { ...fixture, text: `${rows.join('\n')}\n` }, serverLog),
      /fixture line 1 is incomplete/,
    );
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    const rows = fixture.text.trim().split('\n');
    const changed = JSON.parse(rows[1]);
    changed.ownedChatChannels = 1;
    rows[1] = JSON.stringify(changed);
    assert.throws(
      () => validate(result, journal, { ...fixture, text: `${rows.join('\n')}\n` }, serverLog),
      /owns 2 chat channels, expected exactly 1/,
    );
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    result.workload.runIds.terminal.pop();
    assert.throws(() => validate(result, journal, fixture, serverLog), /run-ID sets differ/);
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    assert.throws(() => validate(result, journal, fixture, { ...serverLog, text: '[error] ok\n' }), /contains errors|recomputed analysis/);
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    result.profile.sampleIntervalSeconds = 30;
    assert.throws(() => validate(result, journal, fixture, serverLog), /workload profile/);
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    result.probe.uninstallError = 'timed out';
    result.evaluation = evaluateLongSoakEvidence(result);
    assert.throws(() => validate(result, journal, fixture, serverLog), /evaluation failed|recomputed evidence/);
  }
});

test('certification manifest is bound to a canonical revision tag and all shards', () => {
  const { result: soakEvidence, journal, fixture, serverLog } = soakResult();
  const certifiedSoak = validateSoakEvidence(
    soakEvidence,
    soakArtifact(),
    journal,
    fixture,
    serverLog,
    imageId,
    revision,
    'https://staging.example',
  );
  const manifest = {
    schemaVersion: 2,
    status: 'certified',
    revision,
    image: { id: imageId, tag: `cascade:certified-${revision}` },
    certification: {
      totalUsers: 10_000,
      shardCount: 4,
      target: 'https://staging.example',
      monitor: {
        sha256: monitorDigest,
        imageId,
        containerId: 'container-a',
        containerStartedAt: '2026-08-10T23:59:55.000Z',
        serverLogs: {
          policy: 'zero fatal/error lines from container start through monitor finish',
          baselineCursor: '2026-08-10T23:59:55.000Z',
          finishCursor: '2026-08-11T00:37:29.000Z',
          readError: null,
          sha256: 'e'.repeat(64),
          totalBytes: 0,
          totalLines: 0,
          matchedErrorLines: 0,
          matchesTruncated: false,
        },
        runtimeEnvelope: {
          cpus: 2,
          cpuset: '0-1',
          memoryBytes: 3 * 1024 ** 3,
          memorySwapBytes: 3 * 1024 ** 3,
          pidsLimit: 100_000,
          nofileSoft: 200_000,
          nofileHard: 200_000,
        },
        runtimeConfiguration: { ...SOAK_RUNTIME_CONFIGURATION },
        sessions: 10_000,
        runners: 10_000,
        memberships: 50_000,
        durationSeconds: 2_250,
        gateWindowSeconds: 1_800,
        gateStartAt: '2026-08-11T00:06:00.000Z',
        gateEndAt: '2026-08-11T00:36:00.000Z',
        coverage: {
          sessions: 0.99,
          runners: 0.99,
          memberships: 0.99,
          sessionsEnd: 10_000,
          runnersEnd: 10_000,
          membershipsEnd: 50_000,
        },
        realtime: {
          expected: {
            enabled: true,
            authFull: 11_000,
            groupCount: 400,
            successfulChatWrites: 46_500,
          },
          presencePlan: {
            strategy: 'owner-stratified-v1',
            initialOwnedChatChannels: 400,
            forcedReconnectOwnedChatChannels: 40,
            forcedReconnectOwnerUserIds: Array.from({ length: 40 }, (_unused, index) => index + 1),
          },
          observed: {
            realtimeAuthFull: 11_000,
            realtimeAuthCacheHits: 22_000,
            realtimeAuthConflicts: 0,
            realtimeAuthUnknown: 0,
            presenceUserChannelReads: 9_999,
            presenceChannelSourceReads: 800,
            presenceParticipantSnapshotReads: 13_840,
            presenceSnapshotInitial: 11_000,
            presenceSnapshotDirect: 440,
            presenceSnapshotDispatcher: 2_400,
            presenceSnapshotOther: 0,
            chatListRouteReads: 49_340,
            chatListRouteMessage: 46_500,
            chatListRouteDirect: 440,
            chatListRouteDispatcher: 2_400,
            chatListRouteOther: 0,
            runnerDelegatedSnapshotReads: 1,
            runnerDelegatedOwnerReads: 0,
            runnerDisconnectFlushes: 1,
            runnerDisconnectFlushOwners: 9_999,
            presenceDispatcher: {
              requested: 20_000,
              dispatched: 2_400,
              completed: 2_400,
              failed: 0,
              noop: 0,
              active: 0,
              pending: 0,
              queued: 0,
              refreshed: 2_400,
              startFailed: 0,
              taskFailed: 0,
            },
          },
        },
        workload: {
          finishedAt: '2026-08-11T00:36:10.000Z',
          elapsedSeconds: 2_170,
          postWorkloadSeconds: 75,
          users: 10_000,
          shardCount: 4,
          presencePlan: {
            strategy: 'owner-stratified-v1',
            initialOwnedChatChannels: 400,
            forcedReconnectOwnedChatChannels: 40,
            forcedReconnectOwnerUserIds: Array.from({ length: 40 }, (_unused, index) => index + 1),
          },
          shards: [0, 1, 2, 3].map((shard) => ({
            shard,
            sha256: artifact(shard).sha256,
            initialOwnedChatChannels: 100,
            forcedReconnectOwnedChatChannels: 10,
            forcedReconnectStrategy: 'owner-stratified-v1',
            forcedReconnectOwnerUserIds: Array.from(
              { length: 10 },
              (_unused, owner) => shard * 10 + owner + 1,
            ),
          })),
        },
        evaluation: 'passed',
      },
      loads: [0, 1, 2, 3].map((shard) => ({
        shard,
        sha256: artifact(shard).sha256,
        users: 2_500,
        sourceIp: `198.51.100.${shard + 1}`,
        rampSeconds: 300,
        soakSeconds: 1_860,
        pollingPercent: 5,
        reconnectPercent: 10,
        reconnectAtSeconds: 600,
        selectionPlan: {
          forcedReconnectStrategy: 'owner-stratified-v1',
          forcedReconnectOwnerUserIds: Array.from(
            { length: 10 },
            (_unused, owner) => shard * 10 + owner + 1,
          ),
        },
        presencePlan: {
          strategy: 'owner-stratified-v1',
          initialOwnedChatChannels: 100,
          forcedReconnectOwnedChatChannels: 10,
          forcedReconnectOwnerUserIds: Array.from(
            { length: 10 },
            (_unused, owner) => shard * 10 + owner + 1,
          ),
        },
        rates: { chatRps: 6.25, readRps: 12.5, runRps: 0.25 },
        rampCompletedAt: '2026-08-11T00:05:00.000Z',
        soakStartedAt: '2026-08-11T00:05:00.000Z',
        workloadFinishedAt: `2026-08-11T00:36:0${shard}.000Z`,
        finishedAt: `2026-08-11T00:36:0${shard + 4}.000Z`,
        evaluation: 'passed',
      })),
      faults: [
        { ...faultResult('runner-restart-reclaim'), sha256: faultArtifact(0).sha256, evaluation: 'passed' },
        { ...faultResult('sqlite-write-lock'), sha256: faultArtifact(1).sha256, evaluation: 'passed' },
      ],
      soak: certifiedSoak,
    },
  };
  const sourceSnapshot = productionSourceSummary();
  const fixtureSummary = validateCapacityFixtureArtifact(capacityFixtureArtifact());
  for (const fault of manifest.certification.faults) fault.fixtureSha256 = fixtureSummary.sha256;
  manifest.certification.soak.fixtures.sha256 = fixtureSummary.sha256;
  for (const entry of manifest.certification.loads) {
    const workloadIdentity = loadShard(entry.shard).workloadIdentity;
    entry.thresholds = { ...releaseThresholds };
    entry.successfulChatWrites = 11_625;
    entry.successfulRuns = 465;
    entry.workloadIdentity = {
      successfulMessageIdsCount: workloadIdentity.successfulMessageIdsCount,
      successfulMessageIdsSha256: workloadIdentity.successfulMessageIdsSha256,
      requestedRunIdsCount: workloadIdentity.requestedRunIdsCount,
      requestedRunIdsSha256: workloadIdentity.requestedRunIdsSha256,
    };
    Object.assign(
      manifest.certification.monitor.workload.shards.find((shard) => shard.shard === entry.shard),
      entry.workloadIdentity,
    );
    entry.configurationSha256 = sha256(JSON.stringify(stable(loadConfiguration(entry))));
  }
  const configurations = manifest.certification.loads
    .map((entry) => ({ shard: entry.shard, sha256: entry.configurationSha256 }));
  const preflight = (phase, containerId, mountIndex, createdAt) => ({
    sha256: String(mountIndex).repeat(64),
    phase,
    profile: 'final10k',
    imageId,
    containerId,
    containerStartedAt: '0001-01-01T00:00:00Z',
    mountDestination: '/data',
    mountSourceSha256: sha256(`mount-${mountIndex}`),
    relativeDatabase: 'docs.db',
    sourceDatabaseSha256: sourceSnapshot.database.sha256,
    sourceCorpusSha256: sourceSnapshot.corpus.sha256,
    fixtureSha256: fixtureSummary.sha256,
    databaseSha256: sha256(`database-${mountIndex}`),
    databaseBytes: sourceSnapshot.database.bytes + 1_000_000,
    databaseDevice: String(100 + mountIndex),
    databaseInode: String(200 + mountIndex),
    createdAt,
  });
  const preflights = {
    main10k: preflight('main10k', 'container-a', 1, '2026-08-10T23:58:00.000Z'),
    faults: preflight('faults', 'fault-container', 2, '2026-08-11T00:41:00.000Z'),
    soak5k: preflight('soak5k', 'soak-container', 3, '2026-08-11T00:50:00.000Z'),
  };
  const phaseSourceRows = (phase) => {
    const sourceRows = logicalSourceRows();
    const extras = new Map(sourceRows.tableDeltas.map((row) => [row.tableName, row.extraRows]));
    if (phase === 'main10k') {
      extras.set('chat_messages', 46_500);
      extras.set('runs', 1_862);
      extras.set('run_events', 7_442);
    } else if (phase === 'faults') {
      extras.set('chat_messages', 1);
      extras.set('runs', 1);
      extras.set('run_events', 3);
    } else {
      extras.set('runs', 7_202);
      extras.set('run_events', 28_802);
    }
    sourceRows.tableDeltas = sourceRows.tableDeltas.map((row) => ({
      ...row,
      missingRows: ['main10k', 'soak5k'].includes(phase)
        && ['runs', 'delegated_runs'].includes(row.tableName) ? 2 : 0,
      extraRows: extras.get(row.tableName) || 0,
    }));
    sourceRows.tableEvidenceSha256 = sha256(JSON.stringify(stable(sourceRows.tableDeltas)));
    return sourceRows;
  };
  const phaseWorkload = (phase) => {
    if (phase === 'main10k') return {
      runs: 1_860, completedRuns: 1_860, runEvents: 7_440, messages: 46_500,
    };
    if (phase === 'soak5k') return {
      runs: 7_200, completedRuns: 7_200, runEvents: 28_800, messages: 0,
    };
    return {
      runs: 1,
      completedRuns: 1,
      runEvents: 3,
      messages: 1,
      workloadRuns: [{
        id: 1_898,
        status: 'completed',
        summary: 'restart recovery passed',
        eventCount: 3,
        completedTerminalEvents: 1,
        lastType: 'status',
        lastPayload: JSON.stringify({
          status: 'completed', summary: 'restart recovery passed', sessionId: 'fault-session-1898',
        }),
      }],
      workloadRunEvents: [
        { runId: 1_898, seq: 1, type: 'status', payloadJson: '{"status":"queued"}' },
        { runId: 1_898, seq: 2, type: 'status', payloadJson: '{"status":"running"}' },
        {
          runId: 1_898,
          seq: 3,
          type: 'status',
          payloadJson: JSON.stringify({
            status: 'completed', summary: 'restart recovery passed', sessionId: 'fault-session-1898',
          }),
        },
      ],
      workloadMessages: [{
        id: 'fault-lock-recovery-test', vaultId: 'vault-test', channelId: 'channel-test',
        body: 'dependency recovered',
      }],
    };
  };
  const freeze = (phase, frozenAt) => ({
    sha256: sha256(`freeze-${phase}`),
    phase,
    profile: 'final10k',
    imageId,
    containerId: preflights[phase].containerId,
    mountSourceSha256: preflights[phase].mountSourceSha256,
    databaseSha256: sha256(`frozen-database-${phase}`),
    databaseDevice: preflights[phase].databaseDevice,
    databaseInode: preflights[phase].databaseInode,
    sourceRows: phaseSourceRows(phase),
    orphanState: { state: ['main10k', 'soak5k'].includes(phase) ? 'reclaimed' : 'preserved' },
    phaseWorkload: phaseWorkload(phase),
    frozenAt,
  });
  const successfulChatWrites = 46_500;
  const successfulRuns = 1_860;
  const aggregateMessageIds = [0, 1, 2, 3]
    .flatMap((shard) => loadShard(shard).workloadIdentity.successfulMessageIds).sort();
  const aggregateRunIds = [0, 1, 2, 3]
    .flatMap((shard) => loadShard(shard).workloadIdentity.requestedRunIds)
    .sort((left, right) => left - right);
  const reconciliationExpected = {
    users: 10_007,
    vaults: 412,
    memberships: 10_015,
    channels: 400,
    successfulChatWrites,
    successfulRuns,
    successfulMessageIdsSha256: sha256(JSON.stringify(stable(aggregateMessageIds))),
    requestedRunIdsSha256: sha256(JSON.stringify(stable(aggregateRunIds))),
    shardWorkloadIdentities: manifest.certification.loads
      .map((entry) => ({ shard: entry.shard, ...entry.workloadIdentity })),
  };
  const reconciliationObserved = {
    users: 10_007,
    vaults: 412,
    memberships: 10_015,
    totalNotes: 725,
    totalMessages: 4_082 + successfulChatWrites,
    totalRuns: 1_897 + successfulRuns,
    totalRunEvents: 403_514 + successfulRuns * 4 + 2,
    totalDelegatedRuns: 0,
    fixtureChannelCount: 400,
    loadMessageCount: successfulChatWrites,
    loadMessageDistinctIds: successfulChatWrites,
    loadMessageChannels: 400,
    loadMessageIdsSha256: sha256(JSON.stringify(stable(aggregateMessageIds))),
    duplicateMessageIds: 0,
    unexercisedFixtureChannels: 0,
    badMessageScope: 0,
    badMessageBodies: 0,
    loadRunCount: successfulRuns,
    completedLoadRuns: successfulRuns,
    loadRunIdsSha256: sha256(JSON.stringify(stable(aggregateRunIds))),
    loadRunEventCount: successfulRuns * 4,
    unexpectedNewRuns: 0,
    badRunPrompts: 0,
    badRunRows: 0,
    badTerminalEventCounts: 0,
    badEventSequences: 0,
    badRunEventSignatures: 0,
    openDelegatedRuns: 0,
    foreignKeyViolations: 0,
    quickCheck: 'ok',
  };
  manifest.certification.provenance = {
    sourceSnapshot,
    fixture: fixtureSummary,
    loadDriver: {
      sha256: 'd'.repeat(64),
      bytes: 123_456,
      configurations,
      configurationsSha256: sha256(JSON.stringify(stable(configurations))),
    },
    runtimeProof: {
      sha256: 'a'.repeat(64),
      phase: 'main10k',
      profile: 'final10k',
      imageId,
      containerId: 'container-a',
      revision,
      executedAt: '2026-08-10T23:59:00.000Z',
      swapReady: true,
      embedded: {
        loadDriverSha256: 'd'.repeat(64),
        reconciliationDriverSha256: 'f'.repeat(64),
      },
    },
    preflights,
    freezes: {
      main10k: freeze('main10k', '2026-08-11T00:40:00.000Z'),
      faults: freeze('faults', '2026-08-11T00:45:00.000Z'),
      soak5k: freeze('soak5k', '2026-08-11T03:01:00.000Z'),
    },
    reconciliation: {
      sha256: 'b'.repeat(64),
      databaseSha256: 'c'.repeat(64),
      driverSha256: 'f'.repeat(64),
      fixturePrefixSha256: sha256('cap'),
      baselineMaxRunId: 1_897,
      expected: reconciliationExpected,
      observed: reconciliationObserved,
      finishedAt: '2026-08-11T00:39:00.000Z',
      evaluation: 'passed',
    },
  };
  assert.equal(validateManifest(manifest), manifest);
  const faultPersistenceDrift = structuredClone(manifest);
  faultPersistenceDrift.certification.provenance.freezes.faults
    .phaseWorkload.workloadRunEvents[1].payloadJson = '{"status":"running","extra":true}';
  assert.throws(() => validateManifest(faultPersistenceDrift), /queued\/running\/completed sequence/);
  const phaseDeltaDrift = structuredClone(manifest);
  const driftedRunEvents = phaseDeltaDrift.certification.provenance.freezes.main10k
    .sourceRows.tableDeltas.find((row) => row.tableName === 'run_events');
  driftedRunEvents.extraRows += 1;
  phaseDeltaDrift.certification.provenance.freezes.main10k.sourceRows.tableEvidenceSha256
    = sha256(JSON.stringify(stable(
      phaseDeltaDrift.certification.provenance.freezes.main10k.sourceRows.tableDeltas,
    )));
  assert.throws(() => validateManifest(phaseDeltaDrift), /unexpected rows/);
  const faultFixtureDrift = structuredClone(manifest);
  faultFixtureDrift.certification.faults[0].fixtureSha256 = '0'.repeat(64);
  assert.throws(() => validateManifest(faultFixtureDrift), /fault-recovery evidence/);
  const soakFixtureDrift = structuredClone(manifest);
  soakFixtureDrift.certification.soak.fixtures.sha256 = '0'.repeat(64);
  assert.throws(() => validateManifest(soakFixtureDrift), /fixture evidence/);
  const lateFaultPreflight = structuredClone(manifest);
  lateFaultPreflight.certification.provenance.preflights.faults.createdAt
    = '2026-08-11T00:43:00.000Z';
  assert.throws(() => validateManifest(lateFaultPreflight), /before its never-started preflight/);
  const lateSoakPreflight = structuredClone(manifest);
  lateSoakPreflight.certification.provenance.preflights.soak5k.createdAt
    = '2026-08-11T00:55:00.000Z';
  assert.throws(() => validateManifest(lateSoakPreflight), /before its never-started preflight/);
  assert.throws(() => validateManifest({ ...manifest, image: { ...manifest.image, tag: 'cascade:latest' } }),
    /not canonical/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: { ...manifest.certification, loads: manifest.certification.loads.slice(1) },
  }), /incomplete/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: { ...manifest.certification.soak, imageId: `sha256:${'f'.repeat(64)}` },
    },
  }), /soak image, revision, or target/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: { ...manifest.certification.soak, probeUninstalled: false },
    },
  }), /probe was not cleanly uninstalled/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: {
        ...manifest.certification.soak,
        journalHeadroom: { ...manifest.certification.soak.journalHeadroom, mailboxMax: 501 },
      },
    },
  }), /headroom evidence/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: {
        ...manifest.certification.soak,
        journalHeadroom: { ...manifest.certification.soak.journalHeadroom, cpuMaxPct: null },
      },
    },
  }), /headroom evidence/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      monitor: {
        ...manifest.certification.monitor,
        realtime: {
          ...manifest.certification.monitor.realtime,
          observed: {
            ...manifest.certification.monitor.realtime.observed,
            presenceDispatcher: {
              ...manifest.certification.monitor.realtime.observed.presenceDispatcher,
              noop: 1,
            },
          },
        },
      },
    },
  }), /presence dispatcher accounting/);
  const duplicateOwnerMonitor = structuredClone(manifest.certification.monitor);
  duplicateOwnerMonitor.workload.shards[1].forcedReconnectOwnerUserIds[0] = 1;
  assert.throws(() => validateManifest({
    ...manifest,
    certification: { ...manifest.certification, monitor: duplicateOwnerMonitor },
  }), /reconnect-owner strategy, counts, or IDs/);
  const reorderedSelectionManifest = structuredClone(manifest);
  reorderedSelectionManifest.certification.loads[0].selectionPlan.forcedReconnectOwnerUserIds.reverse();
  assert.throws(
    () => validateManifest(reorderedSelectionManifest),
    /load shard 0 reconnect-owner evidence differs/,
  );
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: {
        ...manifest.certification.soak,
        database: {
          ...manifest.certification.soak.database,
          final: { ...manifest.certification.soak.database.final, runs: 7_209 },
        },
      },
    },
  }), /SQLite counts or approved orphan transition do not reconcile/);
});

test('certification hashes the same regular-file snapshot it validates', () => {
  const source = fs.readFileSync(path.join(deployDirectory, 'certified-image.mjs'), 'utf8');
  assert.match(source, /function artifactSnapshot[\s\S]*O_NOFOLLOW[\s\S]*fs\.fstatSync[\s\S]*metadata\.isFile\(\)[\s\S]*fs\.readFileSync\(descriptor\)[\s\S]*createHash\('sha256'\)\.update\(bytes\)/);
  assert.match(source, /const monitorArtifact = artifactSnapshot[\s\S]*monitorArtifact\.text[\s\S]*sha256: monitorArtifact\.sha256/);
  assert.match(source, /function validateServerLogArtifact[\s\S]*serverLogArtifact\.sha256 === finish\.serverLogs\.sha256/);
  assert.match(source, /const loadArtifacts = options\.loadResults\.map[\s\S]*JSON\.parse\(artifact\.text\)/);
  assert.match(source, /const soakArtifact = artifactSnapshot[\s\S]*const soakJournalArtifact = artifactSnapshot[\s\S]*validateSoakEvidence/);
  assert.match(source, /const manifestDigest = createHash\('sha256'\)\.update\(manifestBytes\)/);
  assert.match(source, /mode: 0o600, flag: 'wx'/);
  assert.match(source, /checksumTemporary[\s\S]*fs\.renameSync\(checksumTemporary/);
});

test('release images pin every Dockerfile base and Compose cannot rebuild', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const fromLines = dockerfile.split(/\r?\n/u).filter((line) => line.startsWith('FROM '));
  assert.ok(fromLines.length >= 4);
  for (const line of fromLines) assert.match(line, /@sha256:[0-9a-f]{64}(?:\s+AS\s+\S+)?$/i);

  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.doesNotMatch(compose, /^\s*build:/mu);
  assert.match(compose, /image: \$\{CASCADE_IMAGE:-cascade:latest\}/);
  assert.match(compose, /^\s{4}cpus: 2$/mu);
  assert.match(compose, /^\s{4}cpuset: "0-1"$/mu);
  assert.match(compose, /^\s{4}mem_limit: 3g$/mu);
  assert.match(compose, /^\s{4}memswap_limit: 3g$/mu);
  assert.match(compose, /^\s{4}pids_limit: 100000$/mu);
});

test('release build binds a clean full revision to one canonical image tag and label', () => {
  const build = fs.readFileSync(path.join(deployDirectory, 'build-release-image.sh'), 'utf8');
  assert.match(build, /REVISION="\$\(git rev-parse HEAD\)"/);
  assert.match(build, /git status --porcelain --untracked-files=all/);
  assert.match(build, /git archive --format=tar "\$REVISION" \| DOCKER_BUILDKIT=1 docker build/);
  assert.match(build, /--provenance=false/);
  assert.match(build, /IMAGE="cascade:certified-\$REVISION"/);
  assert.match(build, /--build-arg "CASCADE_REVISION=\$REVISION"/);
  assert.match(build, /IMAGE_ID="\$\(docker image inspect/);
  assert.match(build, /Descriptor\.Annotations "config\.digest"/);
  assert.match(build, /org\.opencontainers\.image\.revision/);
  assert.match(build, /--tag "\$IMAGE" -/);
  assert.doesNotMatch(build, /cascade:latest/);
});

test('staging transfers a Docker archive and records the exact loaded image without starting it', () => {
  const stage = fs.readFileSync(path.join(deployDirectory, 'stage-certified-image.sh'), 'utf8');
  assert.match(stage, /docker image save "\$IMAGE_TAG"/);
  assert.match(stage, /docker image load/);
  assert.match(stage, /BatchMode=yes/);
  assert.match(stage, /StrictHostKeyChecking=yes/);
  assert.match(stage, /ServerAliveInterval=20/);
  assert.match(stage, /REMOTE_ID.*docker image inspect/);
  assert.doesNotMatch(stage, /docker (?:compose )?(?:up|run)/);
  assert.match(stage, /mktemp '\/tmp\/cascade-certified-\$REVISION\.XXXXXX\.json'/);
  assert.match(stage, /\/var\/lib\/cascade-release\/certified-images\/\$REVISION\.json/);
  assert.match(stage, /stat -c '%u:%g:%a:%F'/);
});

test('routine staging transfers only the exact revision-labelled image', () => {
  const stage = fs.readFileSync(path.join(deployDirectory, 'stage-release-image.sh'), 'utf8');
  assert.match(stage, /git status --porcelain --untracked-files=all/);
  assert.match(stage, /IMAGE_TAG="cascade:certified-\$REVISION"/);
  assert.match(stage, /Descriptor\.Annotations "config\.digest"/);
  assert.match(stage, /org\.opencontainers\.image\.revision/);
  assert.match(stage, /docker image save "\$IMAGE_TAG"/);
  assert.match(stage, /docker image load/);
  assert.match(stage, /BatchMode=yes/);
  assert.match(stage, /StrictHostKeyChecking=yes/);
  assert.match(stage, /REMOTE_ID.*docker image inspect/);
  assert.match(stage, /REMOTE_REVISION.*docker image inspect/);
  assert.doesNotMatch(stage, /capacity|waiver|manifest/iu);
  assert.doesNotMatch(stage, /docker (?:compose )?(?:up|run)/);
});

test('first-time deployment starts only the verified staged image without rebuilding', () => {
  const deploy = fs.readFileSync(path.join(deployDirectory, 'deploy.sh'), 'utf8');
  const finishHttps = fs.readFileSync(path.join(deployDirectory, 'finish-https.sh'), 'utf8');
  assert.match(deploy, /certified-image\.mjs verify --manifest "\$CERTIFIED_MANIFEST"/);
  assert.match(deploy, /docker compose up -d --no-build/);
  assert.match(deploy, /RUNNING_IMAGE_ID="\$\(docker inspect --format '\{\{\.Image\}\}' cascade\)"/);
  assert.match(deploy, /RUNNING_IMAGE_ID" != "\$CERTIFIED_IMAGE_ID/);
  assert.match(deploy, /acquire_cascade_deploy_lock "\$ROOT"/);
  assert.match(deploy, /deploy\.sh is bootstrap-only and refuses to replace an existing Cascade container/);
  assert.match(deploy, /install -d -m 0750 -o 1000 -g 1000 "\$DATA_DIR"/);
  assert.match(deploy, /CERTIFIED_RELEASE_DIR="\/var\/lib\/cascade-release"/);
  assert.doesNotMatch(deploy, /chown -R 1000:1000 "\$DATA_DIR"/);
  assert.match(deploy, /chmod 0600 \.env/);
  assert.match(deploy, /-L "\$CERTIFICATE_FILE"/);
  assert.match(deploy, /RUNNING_SHAPE=.*HostConfig\.NanoCpus/);
  assert.match(deploy, /EXPECTED_SHAPE="2000000000 0-1 3221225472 3221225472 100000 nofile 200000 200000"/);
  for (const renderer of [deploy, finishHttps]) {
    assert.match(renderer, /s\/CASCADE_PRIMARY_PORT\/3000\/g/);
    assert.match(renderer, /server 127\.0\.0\.1:39001 backup max_fails=1 fail_timeout=2s/);
  }
  assert.doesNotMatch(deploy, /^\s*docker (?:compose )?build(?:\s|$)/mu);
});

test('public source does not contain a production deployment workflow', () => {
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/deploy.yml')), false);

  const contributorDocs = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(contributorDocs, /does not contain or operate a production deployment/u);
});
