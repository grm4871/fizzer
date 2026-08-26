import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeServerLogs,
  containerIdentityFailures,
  finalizationFailures,
  headroomEvaluation,
  serverLogFailures,
  shapeFailures,
} from './monitor.mjs';

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
