import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateWorkloadResults } from './monitor.mjs';

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

