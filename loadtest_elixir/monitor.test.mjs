import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  analyzeServerLogs,
  containerIdentityFailures,
  cpuSetCount,
  finalizationFailures,
  headroomEvaluation,
  histogramDelta,
  histogramPercentile,
  shapeFailures,
  serverLogFailures,
  validateWorkloadResults,
} from './monitor.mjs';

test('counts disjoint CPU sets including ranges', () => {
  assert.equal(cpuSetCount('0-3,8,10-12'), 8);
  assert.equal(cpuSetCount('0-7'), 8);
  assert.equal(cpuSetCount(''), 0);
});

test('computes a percentile from the observations added during the gate window', () => {
  const delta = histogramDelta(
    { 100: 20, 1_000: 2 },
    { 100: 119, 1_000: 3, infinity: 0 },
  );
  assert.deepEqual(delta, { 100: 99, 1_000: 1, infinity: 0 });
  assert.equal(histogramPercentile(delta, 0.99), 100);
});

function sample(elapsedSeconds, overrides = {}) {
  const count = elapsedSeconds === 900 ? 100 : 1_100;
  return {
    elapsedSeconds,
    normalizedCpuPct: 62,
    memoryCurrent: 8 * 1024 ** 3,
    beamOpenFiles: { count: 12_000 },
    containerState: { restartCount: 0, oomKilled: false },
    errors: [],
    beam: {
      configuration: {
        httpAcceptors: 4,
        httpMaxConnections: 32_768,
        httpBacklog: 65_535,
        networkMode: true,
        trustProxyHops: 1,
        qmdWorkerEnabled: true,
        realtimeHibernateAfterMs: 5_000,
        runnerOrphanReclaimMs: 600_000,
        sqlitePoolSize: 20,
        sqliteBusyTimeoutMs: 5_000,
      },
      pool: { utilizationPct: 60 },
      beam: {
        schedulerUtilizationPct: 70,
        schedulerMaxUtilizationPct: 78,
        schedulersOnline: 8,
        runQueue: 4,
        processCount: 31_000,
        realtimeSessions: 10_000,
        walBytes: 4 * 1024 ** 2,
      },
      deep: {
        registeredRunners: 10_000,
        realtimeMemberships: 50_000,
        etsBytes: 64 * 1024 ** 2,
        mailboxes: { max: 10 },
        banditConnections: 9_500,
        cgroup: {
          cpu: { usage_usec: elapsedSeconds * 1_000_000, throttled_usec: elapsedSeconds * 1_000 },
          memoryPeak: 9 * 1024 ** 3,
          memoryEvents: { low: 0, high: 0, max: 0, oom: 0, oom_kill: 0, oom_group_kill: 0 },
          pidsPeak: 60,
          io: '259:0 rbytes=1 wbytes=1 rios=1 wios=1 dbytes=0 dios=0',
          cpuPressure: { some: { avg10: 0.1 }, full: { avg10: 0 } },
          memoryPressure: { some: { avg10: 0 }, full: { avg10: 0 } },
          ioPressure: { some: { avg10: 0 }, full: { avg10: 0 } },
        },
      },
      metrics: {
        db_queue_us: { histogram: { 100: count } },
        db_query_us: { histogram: { 1_000: count } },
        db_write_lock_wait_us: { histogram: { 2_000: count } },
        db_write_lock_hold_us: { histogram: { 5_000: count } },
        db_write_lock_queue_depth: { count, max: 4, histogram: { 4: count } },
        db_pool_utilization_pct: { count, histogram: { 60: count } },
        db_pool_samples_above_80_pct: 0,
      },
    },
    ...overrides,
  };
}

test('passes the fixed 2 CPU / 3 GiB final-window headroom gates', () => {
  const evaluation = headroomEvaluation(
    [sample(900), sample(2_100)],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    {
      httpAcceptors: 4,
      httpMaxConnections: 32_768,
      httpBacklog: 65_535,
      networkMode: true,
      trustProxyHops: 1,
      qmdWorkerEnabled: true,
      realtimeHibernateAfterMs: 5_000,
      runnerOrphanReclaimMs: 600_000,
      sqlitePoolSize: 20,
      sqliteBusyTimeoutMs: 5_000,
    },
    2_100,
    600,
  );
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.failures, []);
  assert.equal(evaluation.observed.dbQueueP99Us, 100);
  assert.equal(evaluation.observed.dbQueryP99Us, 1_000);
  assert.equal(evaluation.observed.dbWriteLockWaitP99Us, 2_000);
  assert.equal(evaluation.observed.dbWriteLockHoldP99Us, 5_000);
  assert.equal(evaluation.observed.dbWriteLockQueueDepthMax, 4);
});

test('gates reconnect and teardown amplification with probe and dispatcher telemetry', () => {
  const first = sample(900);
  const last = sample(2_100);
  Object.assign(last.beam.metrics, {
    realtime_auth_full: 11_000,
    realtime_auth_cache_hits: 22_000,
    realtime_verified_token_cache_hits: 21_000,
    realtime_verified_token_cache_misses: 1_000,
    realtime_auth_conflicts: 0,
    realtime_auth_unknown: 0,
    presence_user_channel_reads: 9_999,
    presence_channel_source_reads: 800,
    presence_participant_snapshot_reads: 13_800,
    presence_snapshot_initial: 11_000,
    presence_snapshot_direct: 400,
    presence_snapshot_dispatcher: 2_400,
    presence_snapshot_other: 0,
    chat_list_route_reads: 49_300,
    chat_list_route_message: 46_500,
    chat_list_route_direct: 400,
    chat_list_route_dispatcher: 2_400,
    chat_list_route_other: 0,
    runner_delegated_snapshot_reads: 1,
    runner_delegated_owner_reads: 0,
    runner_disconnect_flushes: 1,
    runner_disconnect_flush_owners: 9_999,
  });
  last.beam.deep.presenceDispatcher = {
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

  const evaluation = headroomEvaluation(
    [first, last],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    first.beam.configuration,
    2_100,
    600,
    null,
    {
      enabled: true,
      authFull: 11_000,
      groupCount: 400,
      successfulChatWrites: 46_500,
      initialOwnedChatChannels: 400,
      forcedReconnectOwnedChatChannels: 0,
    },
  );

  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.observed.realtimeAuthFull, 11_000);
  assert.equal(evaluation.observed.realtimeVerifiedTokenCacheHits, 21_000);
  assert.equal(evaluation.observed.realtimeVerifiedTokenCacheMisses, 1_000);
  assert.equal(evaluation.observed.runnerDelegatedSnapshotReads, 1);
  assert.deepEqual(evaluation.observed.presenceDispatcher, last.beam.deep.presenceDispatcher);

  last.beam.metrics.realtime_auth_full = 11_001;
  last.beam.metrics.realtime_auth_unknown = 1;
  last.beam.metrics.presence_user_channel_reads = 10_001;
  last.beam.metrics.runner_delegated_snapshot_reads = 2;
  last.beam.metrics.runner_delegated_owner_reads = 10_000;
  last.beam.metrics.runner_disconnect_flushes = 2;
  last.beam.metrics.runner_disconnect_flush_owners = 9_899;
  last.beam.deep.presenceDispatcher.failed = 1;

  const failed = headroomEvaluation(
    [first, last],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    first.beam.configuration,
    2_100,
    600,
    null,
    {
      enabled: true,
      authFull: 11_000,
      groupCount: 400,
      successfulChatWrites: 46_500,
      initialOwnedChatChannels: 400,
      forcedReconnectOwnedChatChannels: 0,
    },
  );

  assert.equal(failed.ok, false);
  assert.match(failed.failures.join('\n'), /full auth count is 11001/);
  assert.match(failed.failures.join('\n'), /1 unknown realtime auth telemetry outcomes/);
  assert.match(failed.failures.join('\n'), /presence user-channel reads are 10001/);
  assert.match(failed.failures.join('\n'), /10000 per-owner delegated-run reads/);
  assert.match(failed.failures.join('\n'), /runner disconnect flushes are 2/);
  assert.match(failed.failures.join('\n'), /runner disconnect flush owners are 9899/);
  assert.match(failed.failures.join('\n'), /presence dispatcher did not drain cleanly/);
});

test('fails at dispatcher cap plus one even when read accounting identities hold', () => {
  const first = sample(900);
  const last = sample(2_100);
  Object.assign(last.beam.metrics, {
    realtime_auth_full: 11_000,
    realtime_auth_cache_hits: 22_000,
    realtime_verified_token_cache_hits: 21_000,
    realtime_verified_token_cache_misses: 1_000,
    realtime_auth_conflicts: 0,
    realtime_auth_unknown: 0,
    presence_user_channel_reads: 10_000,
    presence_channel_source_reads: 800,
    presence_participant_snapshot_reads: 13_801,
    presence_snapshot_initial: 11_000,
    presence_snapshot_direct: 400,
    presence_snapshot_dispatcher: 2_401,
    presence_snapshot_other: 0,
    chat_list_route_reads: 49_301,
    chat_list_route_message: 46_500,
    chat_list_route_direct: 400,
    chat_list_route_dispatcher: 2_401,
    chat_list_route_other: 0,
    runner_delegated_snapshot_reads: 1,
    runner_delegated_owner_reads: 0,
    runner_disconnect_flushes: 1,
    runner_disconnect_flush_owners: 10_000,
  });
  last.beam.deep.presenceDispatcher = {
    requested: 20_000,
    dispatched: 2_401,
    completed: 2_401,
    failed: 0,
    noop: 0,
    active: 0,
    pending: 0,
    queued: 0,
    refreshed: 2_401,
    startFailed: 0,
    taskFailed: 0,
  };

  const evaluation = headroomEvaluation(
    [first, last],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    first.beam.configuration,
    2_100,
    600,
    null,
    {
      enabled: true,
      authFull: 11_000,
      groupCount: 400,
      successfulChatWrites: 46_500,
      initialOwnedChatChannels: 400,
      forcedReconnectOwnedChatChannels: 0,
    },
  );

  assert.equal(evaluation.ok, false);
  assert.deepEqual(
    evaluation.failures.filter((failure) => failure.includes('presence dispatcher dispatches')),
    ['presence dispatcher dispatches are 2401, expected <=2400'],
  );
  assert.equal(evaluation.failures.some((failure) => failure.includes('presence participant snapshots')), false);
  assert.equal(evaluation.failures.some((failure) => failure.includes('chat list-route reads')), false);
});

test('rejects cross-reason compensation and dispatcher noops', () => {
  const first = sample(900);
  const last = sample(2_100);
  Object.assign(last.beam.metrics, {
    realtime_auth_full: 11_000,
    realtime_auth_cache_hits: 22_000,
    realtime_verified_token_cache_hits: 21_000,
    realtime_verified_token_cache_misses: 1_000,
    realtime_auth_conflicts: 0,
    realtime_auth_unknown: 0,
    presence_user_channel_reads: 10_000,
    presence_channel_source_reads: 800,
    presence_participant_snapshot_reads: 13_800,
    presence_snapshot_initial: 10_999,
    presence_snapshot_direct: 401,
    presence_snapshot_dispatcher: 2_400,
    presence_snapshot_other: 0,
    chat_list_route_reads: 49_300,
    chat_list_route_message: 46_499,
    chat_list_route_direct: 401,
    chat_list_route_dispatcher: 2_400,
    chat_list_route_other: 0,
    runner_delegated_snapshot_reads: 1,
    runner_delegated_owner_reads: 0,
    runner_disconnect_flushes: 1,
    runner_disconnect_flush_owners: 10_000,
  });
  last.beam.deep.presenceDispatcher = {
    requested: 20_000,
    dispatched: 2_400,
    completed: 2_400,
    failed: 0,
    noop: 1,
    active: 0,
    pending: 0,
    queued: 0,
    refreshed: 2_399,
    startFailed: 0,
    taskFailed: 0,
  };

  const evaluation = headroomEvaluation(
    [first, last],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    first.beam.configuration,
    2_100,
    600,
    null,
    {
      enabled: true,
      authFull: 11_000,
      groupCount: 400,
      successfulChatWrites: 46_500,
      initialOwnedChatChannels: 400,
      forcedReconnectOwnedChatChannels: 0,
    },
  );

  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /presence dispatcher noops are 1, expected 0/);
  assert.match(evaluation.failures.join('\n'), /initial presence snapshots are 10999/);
  assert.match(evaluation.failures.join('\n'), /direct presence snapshots are 401/);
  assert.match(evaluation.failures.join('\n'), /dispatcher presence snapshots are 2400, expected refreshed jobs 2399/);
  assert.match(evaluation.failures.join('\n'), /message list-route reads are 46499/);
  assert.match(evaluation.failures.join('\n'), /dispatcher list-route reads are 2400, expected refreshed jobs\/snapshots 2399\/2400/);
  assert.equal(
    evaluation.failures.some((failure) => failure.includes('expected exact reason sum')),
    false,
  );
});

test('fails when raw query classifiers do not equal exact reason sums', () => {
  const first = sample(900);
  const last = sample(2_100);
  Object.assign(last.beam.metrics, {
    realtime_auth_full: 11_000,
    realtime_auth_cache_hits: 22_000,
    realtime_verified_token_cache_hits: 21_000,
    realtime_verified_token_cache_misses: 1_000,
    realtime_auth_conflicts: 0,
    realtime_auth_unknown: 0,
    presence_user_channel_reads: 10_000,
    presence_channel_source_reads: 800,
    presence_participant_snapshot_reads: 13_799,
    presence_snapshot_initial: 11_000,
    presence_snapshot_direct: 400,
    presence_snapshot_dispatcher: 2_400,
    presence_snapshot_other: 0,
    chat_list_route_reads: 49_299,
    chat_list_route_message: 46_500,
    chat_list_route_direct: 400,
    chat_list_route_dispatcher: 2_400,
    chat_list_route_other: 0,
    runner_delegated_snapshot_reads: 1,
    runner_delegated_owner_reads: 0,
    runner_disconnect_flushes: 1,
    runner_disconnect_flush_owners: 10_000,
  });
  last.beam.deep.presenceDispatcher = {
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

  const evaluation = headroomEvaluation(
    [first, last],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    first.beam.configuration,
    2_100,
    600,
    null,
    {
      enabled: true,
      authFull: 11_000,
      groupCount: 400,
      successfulChatWrites: 46_500,
      initialOwnedChatChannels: 400,
      forcedReconnectOwnedChatChannels: 0,
    },
  );

  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /presence participant snapshots are 13799, expected exact reason sum 13800/);
  assert.match(evaluation.failures.join('\n'), /chat list-route reads are 49299, expected exact reason sum 49300/);
});

test('fails closed on missing or unbounded write-coordinator telemetry', () => {
  const first = sample(900);
  const last = sample(2_100);
  delete first.beam.metrics.db_write_lock_wait_us;
  delete last.beam.metrics.db_write_lock_wait_us;
  last.beam.metrics.db_write_lock_hold_us = { histogram: { 200_000: 1_100 } };
  last.beam.metrics.db_write_lock_queue_depth.max = 65;
  last.beam.metrics.db_write_lock_owner_deaths = 1;

  const evaluation = headroomEvaluation(
    [first, last],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    first.beam.configuration,
    2_100,
    600,
  );

  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /write-lock wait p99 is missing/);
  assert.match(evaluation.failures.join('\n'), /write-lock hold p99 is 200000us/);
  assert.match(evaluation.failures.join('\n'), /queue depth max is 65/);
  assert.match(evaluation.failures.join('\n'), /1 DB write-lock owner deaths/);
});

test('fails closed on an absent immutable image proof and missing user coverage', () => {
  const underCapacity = sample(2_100);
  underCapacity.beam.beam.realtimeSessions = 9_000;
  underCapacity.beam.deep.registeredRunners = 9_000;
  const evaluation = headroomEvaluation(
    [sample(900), underCapacity],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    ['--expected-image is required'],
    {
      httpAcceptors: 4,
      httpMaxConnections: 32_768,
      httpBacklog: 65_535,
      networkMode: true,
      trustProxyHops: 1,
      qmdWorkerEnabled: true,
      realtimeHibernateAfterMs: 5_000,
      runnerOrphanReclaimMs: 600_000,
      sqlitePoolSize: 20,
      sqliteBusyTimeoutMs: 5_000,
    },
    2_100,
    600,
  );
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /expected-image/);
  assert.match(evaluation.failures.join('\n'), /10k-session coverage/);
  assert.match(evaluation.failures.join('\n'), /runner coverage/);
});

test('fails closed when monitoring ends before the requested certification duration', () => {
  const evaluation = headroomEvaluation(
    [sample(0), sample(600)],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    {
      httpAcceptors: 4,
      httpMaxConnections: 32_768,
      httpBacklog: 65_535,
      networkMode: true,
      trustProxyHops: 1,
      qmdWorkerEnabled: true,
      realtimeHibernateAfterMs: 5_000,
      runnerOrphanReclaimMs: 600_000,
      sqlitePoolSize: 20,
      sqliteBusyTimeoutMs: 5_000,
    },
    2_100,
    5,
  );
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /monitor ended/);
  assert.match(evaluation.failures.join('\n'), /headroom window covers/);
  assert.match(evaluation.failures.join('\n'), /headroom window has/);
});

test('ends capacity coverage at workload completion but keeps global teardown failures', () => {
  const afterDisconnect = sample(2_200);
  afterDisconnect.beam.beam.realtimeSessions = 0;
  afterDisconnect.beam.deep.registeredRunners = 0;
  afterDisconnect.beam.deep.realtimeMemberships = 0;
  afterDisconnect.beam.metrics.db_errors = 1;

  const evaluation = headroomEvaluation(
    [sample(900), sample(2_100), afterDisconnect],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    sample(0).beam.configuration,
    2_200,
    100,
    2_100,
  );

  assert.equal(evaluation.gateEndSeconds, 2_100);
  assert.equal(evaluation.observed.sessionCoverage, 1);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /1 DB query errors/);
});

function workloadResult(index, overrides = {}) {
  const successfulMessageIds = [`load-${index}-a`, `load-${index}-b`, `load-${index}-c`];
  const requestedRunIds = [1_898 + index * 2, 1_899 + index * 2];
  return {
    target: 'http://127.0.0.1:3000',
    sourceIp: `192.0.2.${40 + index}`,
    shard: { index, count: 2 },
    requestedUsers: 250,
    rampSeconds: 300,
    soakSeconds: 330,
    pollingPercent: 5,
    reconnectPercent: 10,
    reconnectAtSeconds: 120,
    selectionPlan: {
      pollingOnly: index === 0 ? 13 : 12,
      forcedReconnects: 25,
      forcedReconnectStrategy: 'owner-stratified-v1',
      forcedReconnectOwnerUserIds: [1_000 + index],
    },
    presencePlan: {
      strategy: 'owner-stratified-v1',
      initialOwnedChatChannels: 10,
      forcedReconnectOwnedChatChannels: 1,
      forcedReconnectOwnerUserIds: [1_000 + index],
    },
    rates: { chatRps: 6.25, readRps: 12.5, runRps: 0.25 },
    metrics: {
      startedAt: `2026-01-01T00:00:0${index + 1}.000Z`,
      connected: 250,
      connectFailures: 0,
      pollingOnly: index === 0 ? 13 : 12,
      forcedReconnectsExpected: 25,
      workload: { chat: { succeeded: 3 }, run: { succeeded: 2 } },
    },
    workloadIdentity: {
      successfulMessageIds,
      successfulMessageIdsCount: successfulMessageIds.length,
      successfulMessageIdsSha256: createHash('sha256')
        .update(JSON.stringify(successfulMessageIds)).digest('hex'),
      requestedRunIds,
      requestedRunIdsCount: requestedRunIds.length,
      requestedRunIdsSha256: createHash('sha256')
        .update(JSON.stringify(requestedRunIds)).digest('hex'),
    },
    rampCompletedAt: `2026-01-01T00:05:0${index + 1}.000Z`,
    soakStartedAt: `2026-01-01T00:05:0${index + 1}.000Z`,
    workloadFinishedAt: `2026-01-01T00:10:3${index + 1}.000Z`,
    finishedAt: '2026-01-01T00:10:42.000Z',
    evaluation: { ok: true, failures: [] },
    ...overrides,
  };
}

function workloadValidation(results) {
  const marker = {
    status: 'passed',
    finishedAt: '2026-01-01T00:10:45.000Z',
    shards: results.map((_result, index) => ({ path: `/tmp/shard-${index}.json`, sha256: `hash-${index}` })),
  };
  const artifacts = results.map((result, index) => ({
    entry: marker.shards[index],
    result,
    filename: marker.shards[index].path,
    digest: marker.shards[index].sha256,
  }));
  return validateWorkloadResults(
    marker,
    artifacts,
    '2026-01-01T00:00:00.000Z',
    500,
    600,
    {
      target: 'http://127.0.0.1:3000',
      shardCount: 2,
      rampSeconds: 300,
      soakSeconds: 330,
      pollingPercent: 5,
      reconnectPercent: 10,
      reconnectAtSeconds: 120,
      sourceIps: ['192.0.2.40', '192.0.2.41'],
      gateWindowSeconds: 300,
      rates: { chatRps: 6.25, readRps: 12.5, runRps: 0.25 },
    },
  );
}

test('binds the workload marker to fresh exact-config shards with a concurrent gate', () => {
  const workload = workloadValidation([workloadResult(0), workloadResult(1)]);
  assert.equal(workload.users, 500);
  assert.deepEqual(workload.presencePlan, {
    strategy: 'owner-stratified-v1',
    initialOwnedChatChannels: 20,
    forcedReconnectOwnedChatChannels: 2,
    forcedReconnectOwnerUserIds: [1_000, 1_001],
  });
  assert.equal(workload.gateStartAt, '2026-01-01T00:05:31.000Z');
  assert.equal(workload.gateEndAt, '2026-01-01T00:10:31.000Z');
});

test('rejects stale workload artifacts and inconsistent shard counts', () => {
  assert.throws(
    () => workloadValidation([
      workloadResult(0, { metrics: { ...workloadResult(0).metrics, startedAt: '2025-12-31T23:59:59.000Z' } }),
      workloadResult(1),
    ]),
    /started before this monitor/,
  );
  assert.throws(
    () => workloadValidation([
      workloadResult(0),
      workloadResult(1, { shard: { index: 1, count: 3 } }),
    ]),
    /count differs from expected/,
  );
  assert.throws(
    () => workloadValidation([
      workloadResult(0, {
        selectionPlan: { pollingOnly: 3, forcedReconnects: 5 },
        metrics: { ...workloadResult(0).metrics, pollingOnly: 3, forcedReconnectsExpected: 5 },
      }),
      workloadResult(1, {
        selectionPlan: { pollingOnly: 0, forcedReconnects: 0 },
        metrics: { ...workloadResult(1).metrics, pollingOnly: 0, forcedReconnectsExpected: 0 },
      }),
    ]),
    /selection plan differs from expected/,
  );
  assert.throws(
    () => workloadValidation([
      workloadResult(0, {
        presencePlan: { initialOwnedChatChannels: 1, forcedReconnectOwnedChatChannels: 2 },
      }),
      workloadResult(1),
    ]),
    /invalid explicit presence-owner plan/,
  );
  assert.throws(
    () => workloadValidation([
      workloadResult(0, {
        presencePlan: { initialOwnedChatChannels: 0, forcedReconnectOwnedChatChannels: 0 },
      }),
      workloadResult(1),
    ]),
    /invalid explicit presence-owner plan/,
  );
  assert.throws(
    () => workloadValidation([
      workloadResult(0, {
        selectionPlan: {
          ...workloadResult(0).selectionPlan,
          forcedReconnectStrategy: 'owner-first-v1',
        },
      }),
      workloadResult(1),
    ]),
    /selection plan differs from expected/,
  );
  assert.throws(
    () => workloadValidation([
      workloadResult(0),
      workloadResult(1, {
        selectionPlan: {
          ...workloadResult(1).selectionPlan,
          forcedReconnectOwnerUserIds: [1_000],
        },
        presencePlan: {
          ...workloadResult(1).presencePlan,
          forcedReconnectOwnerUserIds: [1_000],
        },
      }),
    ]),
    /appears in multiple shards/,
  );
  assert.throws(
    () => workloadValidation([
      workloadResult(0, {
        selectionPlan: {
          ...workloadResult(0).selectionPlan,
          forcedReconnectOwnerUserIds: [9_999],
        },
      }),
      workloadResult(1),
    ]),
    /invalid explicit presence-owner plan/,
  );
  assert.throws(
    () => workloadValidation([
      workloadResult(0, {
        presencePlan: {
          ...workloadResult(0).presencePlan,
          initialOwnedChatChannels: 9,
        },
      }),
      workloadResult(1, {
        presencePlan: {
          ...workloadResult(1).presencePlan,
          initialOwnedChatChannels: 11,
        },
      }),
    ]),
    /invalid explicit presence-owner plan/,
  );
  assert.throws(
    () => workloadValidation([
      workloadResult(0, {
        presencePlan: {
          ...workloadResult(0).presencePlan,
          strategy: 'owner-first-v1',
        },
      }),
      workloadResult(1),
    ]),
    /invalid explicit presence-owner plan/,
  );
});

test('fails finalization on missing probe teardown or a bad final container state', () => {
  const failures = finalizationFailures(
    { metrics: { db_errors: 1, db_write_lock_owner_deaths: 1 } },
    'detach failed',
    { running: false, restartCount: 1, oomKilled: true },
  );
  assert.match(failures.join('\n'), /uninstall failed/);
  assert.match(failures.join('\n'), /not running/);
  assert.match(failures.join('\n'), /1 final container restarts/);
  assert.match(failures.join('\n'), /OOM-killed/);
  assert.match(failures.join('\n'), /1 final DB query errors/);
  assert.match(failures.join('\n'), /1 final DB write-lock owner deaths/);
});

test('binds every monitored container state to the original ID and immutable image', () => {
  const expected = {
    containerId: 'original-container',
    imageId: 'sha256:expected',
    startedAt: '2026-08-11T05:00:00Z',
  };
  assert.deepEqual(
    containerIdentityFailures(
      {
        containerId: 'original-container',
        imageId: 'sha256:expected',
        startedAt: '2026-08-11T05:00:00Z',
      },
      expected,
    ),
    [],
  );
  assert.deepEqual(
    containerIdentityFailures(
      {
        containerId: 'replacement-container',
        imageId: 'sha256:other',
        startedAt: '2026-08-11T05:01:00Z',
      },
      expected,
    ),
    [
      'container ID drifted to replacement-container, expected original-container',
      'container image drifted to sha256:other, expected sha256:expected',
      'container start time drifted to 2026-08-11T05:01:00Z, expected 2026-08-11T05:00:00Z',
    ],
  );
  const failures = finalizationFailures(
    { metrics: {} },
    null,
    {
      containerId: 'replacement-container',
      imageId: 'sha256:expected',
      startedAt: '2026-08-11T05:00:00Z',
      running: true,
      restartCount: 0,
      oomKilled: false,
    },
    expected,
  );
  assert.match(failures.join('\n'), /container ID drifted/);
});

test('fails closed when the exact container resource envelope changes in place', () => {
  const exact = {
    NanoCpus: 2_000_000_000,
    CpusetCpus: '0-1',
    Memory: 3 * 1024 ** 3,
    MemorySwap: 3 * 1024 ** 3,
    PidsLimit: 100_000,
    Ulimits: [{ Name: 'nofile', Soft: 200_000, Hard: 200_000 }],
  };
  assert.deepEqual(shapeFailures(exact, 2, 3 * 1024 ** 3), []);
  assert.match(
    shapeFailures({ ...exact, NanoCpus: 4_000_000_000 }, 2, 3 * 1024 ** 3).join('\n'),
    /CPU quota is 4, expected 2/,
  );
  assert.match(
    shapeFailures({ ...exact, Memory: 4 * 1024 ** 3 }, 2, 3 * 1024 ** 3).join('\n'),
    /memory limit is 4294967296/,
  );
});

test('binds complete server logs and fails on application errors or unreadable evidence', () => {
  const clean = analyzeServerLogs(
    '2026-08-11T06:00:00Z 06:00:00.000 [info] server started\n' +
      '2026-08-11T06:01:00Z request errors=0\n',
  );
  assert.equal(clean.totalLines, 2);
  assert.equal(clean.matchedErrorLines, 0);
  assert.deepEqual(serverLogFailures({ ...clean, readError: null }), []);

  const failed = analyzeServerLogs(
    '2026-08-11T06:02:00Z [error] GenServer crashed\n' +
      '2026-08-11T06:02:00Z ** (DBConnection.ConnectionError) unavailable\n',
  );
  assert.equal(failed.matchedErrorLines, 1);
  assert.match(serverLogFailures({ ...failed, readError: null }).join('\n'), /1 fatal\/error/);
  assert.match(serverLogFailures({ readError: 'permission denied' }).join('\n'), /permission denied/);
  assert.match(serverLogFailures(null).join('\n'), /missing evidence/);
});

test('allows a transient full DB pool but rejects sustained saturation', () => {
  const first = sample(900);
  const transient = sample(2_100);
  first.beam.pool.utilizationPct = 100;
  transient.beam.pool.utilizationPct = 100;
  first.beam.metrics.db_pool_utilization_pct = { count: 100, histogram: { 100: 100 } };
  first.beam.metrics.db_pool_samples_above_80_pct = 100;
  transient.beam.metrics.db_pool_utilization_pct = { count: 1_100, histogram: { 0: 990, 100: 110 } };
  transient.beam.metrics.db_pool_samples_above_80_pct = 110;

  const brief = headroomEvaluation(
    [first, transient],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    first.beam.configuration,
    2_100,
    600,
  );
  assert.equal(brief.ok, true);
  assert.equal(brief.observed.poolMaxPct, 100);
  assert.equal(brief.observed.poolSaturationRatio, 0.01);

  transient.beam.metrics.db_pool_samples_above_80_pct = 200;
  const sustained = headroomEvaluation(
    [first, transient],
    1_200,
    16 * 1024 ** 3,
    8,
    10_000,
    10_000,
    50_000,
    [],
    first.beam.configuration,
    2_100,
    600,
  );
  assert.equal(sustained.ok, false);
  assert.match(sustained.failures.join('\n'), /DB pool saturation is 10.00%/);
});
