// Shared certification fixtures: deterministic artifacts and evidence builders for contract families.
// Inputs are optional fixture overrides; outputs are test-only evidence records; failures surface through assertions.
// Ordering keeps identity builders before phase/workload builders so each contract family reuses one vocabulary.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOAK_RUNTIME_CONFIGURATION } from '../../loadtest_elixir/soak-invariants.mjs';


export const deployDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const root = path.resolve(deployDirectory, '..');
export const imageId = `sha256:${'a'.repeat(64)}`;
export const revision = 'b'.repeat(40);
export const monitorDigest = 'c'.repeat(64);
export const runtimeShape = {
  nanoCpus: 2_000_000_000,
  cpusetCpus: '0-1',
  memory: 3 * 1024 ** 3,
  memorySwap: 3 * 1024 ** 3,
  pidsLimit: 100_000,
  ulimits: [{ Name: 'nofile', Soft: 200_000, Hard: 200_000 }],
};
export const releaseThresholds = {
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

export function artifact(index) {
  return { path: `/tmp/cascade-load-${index}.json`, sha256: `${index}`.repeat(64) };
}

export function faultArtifact(index) {
  return { path: `/tmp/cascade-fault-${index}.json`, sha256: `${index + 4}`.repeat(64) };
}

export function faultResult(fault) {
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

export function soakArtifact() {
  return { path: '/tmp/cascade-soak.json', sha256: '6'.repeat(64) };
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function fakeJwt(id) {
  return `e30.${Buffer.from(JSON.stringify({ id, username: `user-${id}` })).toString('base64url')}.signature`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function productionSourceSummary() {
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

export function capacityFixtureArtifact(users = 10_000) {
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

export function monitor({ ok = true, id = imageId } = {}) {
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

export function monitorEndpoints(options) {
  const records = monitor(options);
  return [records[0], records.at(-1)];
}

export function loadShard(index, overrides = {}) {
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

