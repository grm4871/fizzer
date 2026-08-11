import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  Histogram,
  WorkloadTracker,
  evaluate,
  fixtureGroupKey,
  parseArgs,
  presencePlanForFixtures,
  readFixtures,
  reclassifyPendingPeerReceiptsForReconnect,
  reconnectSelectionForFixtures,
  selectedCountForShard,
  selectedByPercent,
  unexpectedLoadBroadcast,
  validChatPostResponse,
  validChatReadResponse,
} from './load.mjs';

test('forced reconnect reclassifies only still-pending peer receipts for HTTP catch-up', () => {
  const pendingPeerReceipts = new Map([
    ['already-received', new Set([2])],
    ['boundary-a', new Set([1, 2])],
    ['boundary-b', new Set([1])],
  ]);
  const pendingPeerReceiptCounts = new Map([
    ['already-received', { expected: 2, received: 1 }],
    ['boundary-a', { expected: 2, received: 0 }],
    ['boundary-b', { expected: 1, received: 0 }],
  ]);
  const metrics = { realtimePeerReceiptsExpected: 5 };

  assert.deepEqual(reclassifyPendingPeerReceiptsForReconnect(
    1,
    pendingPeerReceipts,
    pendingPeerReceiptCounts,
    metrics,
  ), ['boundary-a', 'boundary-b']);
  assert.equal(metrics.realtimePeerReceiptsExpected, 3);
  assert.deepEqual([...pendingPeerReceipts.get('boundary-a')], [2]);
  assert.equal(pendingPeerReceipts.has('boundary-b'), false);
  assert.deepEqual(pendingPeerReceiptCounts.get('boundary-a'), { expected: 1, received: 0 });
  assert.deepEqual(pendingPeerReceiptCounts.get('boundary-b'), { expected: 0, received: 0 });
});

function fixtureToken(id, nonce = id) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ id, username: `user-${id}` })}.signature-${nonce}`;
}

test('Histogram returns bounded percentiles without retaining samples', () => {
  const histogram = new Histogram([10, 20, 50]);
  for (const value of [1, 5, 10, 11, 19, 45, 100]) histogram.observe(value);
  assert.equal(histogram.count, 7);
  assert.equal(histogram.percentile(0.5), 20);
  assert.equal(histogram.percentile(0.99), 100);
  assert.deepEqual(histogram.summary(), {
    count: 7,
    meanMs: 27.3,
    p50Ms: 20,
    p95Ms: 100,
    p99Ms: 100,
    maxMs: 100,
  });
});

test('parseArgs supports split and inline values', () => {
  assert.deepEqual(parseArgs(['--users', '10', '--chat-rps=4', '--verbose']), {
    users: '10',
    chatRps: '4',
    verbose: true,
  });
});

test('readFixtures validates and deterministically shards JSONL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-load-test-'));
  const file = path.join(dir, 'fixtures.jsonl');
  fs.writeFileSync(file, [0, 1, 2, 3].map((i) => JSON.stringify({
    token: fixtureToken(i),
    vaultId: `vault-${i}`,
    channelId: `channel-${i}`,
    ownedChatChannels: 1,
  })).join('\n'));
  try {
    const fixtures = readFixtures(file, { shardIndex: 1, shardCount: 2 });
    assert.deepEqual(fixtures.map((fixture) => fixture.sourceIndex), [1, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFixtures rejects duplicate authenticated users before sharding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-load-duplicate-'));
  const file = path.join(dir, 'fixtures.jsonl');
  fs.writeFileSync(file, [0, 1].map((i) => JSON.stringify({
    token: fixtureToken(1),
    vaultId: `vault-${i}`,
    channelId: `channel-${i}`,
    ownedChatChannels: 1,
  })).join('\n'));
  try {
    assert.throws(() => readFixtures(file, { shardIndex: 0, shardCount: 2 }), /reuse one token/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFixtures rejects distinct tokens for the same authenticated user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-load-duplicate-user-'));
  const file = path.join(dir, 'fixtures.jsonl');
  fs.writeFileSync(file, [0, 1].map((i) => JSON.stringify({
    token: fixtureToken(7, i),
    vaultId: `vault-${i}`,
    channelId: `channel-${i}`,
    ownedChatChannels: 1,
  })).join('\n'));
  try {
    assert.throws(() => readFixtures(file), /reuse one authenticated user/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFixtures requires one explicit owned chat channel per fixture group', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-load-owner-plan-'));
  const file = path.join(dir, 'fixtures.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    token: fixtureToken(1),
    vaultId: 'vault',
    channelId: 'channel',
  }));
  try {
    assert.throws(() => readFixtures(file), /no exact ownedChatChannels count/);
    fs.writeFileSync(file, [1, 1].map((ownedChatChannels, index) => JSON.stringify({
      token: fixtureToken(index + 1),
      vaultId: 'vault',
      channelId: 'channel',
      ownedChatChannels,
    })).join('\n'));
    assert.throws(() => readFixtures(file), /owns 2 chat channels, expected exactly 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFixtures keeps every vault/channel peer group on one shard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-load-groups-'));
  const file = path.join(dir, 'fixtures.jsonl');
  fs.writeFileSync(file, Array.from({ length: 8 }, (_unused, index) => {
    const group = Math.floor(index / 2);
    return JSON.stringify({
      token: fixtureToken(index),
      vaultId: `vault-${group}`,
      channelId: `channel-${group}`,
      ownedChatChannels: index % 2 === 0 ? 1 : 0,
    });
  }).join('\n'));
  try {
    assert.deepEqual(
      readFixtures(file, { users: 4, shardIndex: 0, shardCount: 2 }).map((fixture) => fixture.sourceIndex),
      [0, 1, 4, 5],
    );
    assert.deepEqual(
      readFixtures(file, { users: 4, shardIndex: 1, shardCount: 2 }).map((fixture) => fixture.sourceIndex),
      [2, 3, 6, 7],
    );
    assert.throws(
      () => readFixtures(file, { users: 3, shardIndex: 0, shardCount: 2 }),
      /would split a 2-user vault\/channel peer group/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chat response and room validators fail closed on empty, stale, and cross-room data', () => {
  const group = fixtureGroupKey({ vaultId: 'vault-a', channelId: 'channel-a' });
  assert.equal(validChatPostResponse({ message: { id: 'load-0-1' } }, 'load-0-1'), true);
  assert.equal(validChatPostResponse({ message: {} }, 'load-0-1'), false);
  assert.equal(validChatReadResponse({ messages: [{ id: 'load-0-1' }] }, 'load-0-1'), true);
  assert.equal(validChatReadResponse({ messages: [] }, 'load-0-1'), false);
  assert.equal(validChatReadResponse({}, ''), false);
  assert.equal(unexpectedLoadBroadcast('ordinary-message', group, 0, group), false);
  assert.equal(unexpectedLoadBroadcast('load-0-1-now-id', group, 0, group), false);
  assert.equal(unexpectedLoadBroadcast('load-0-1-now-id', group, 0, 'vault-b\u0000channel-b'), true);
  assert.equal(unexpectedLoadBroadcast('load-1-1-now-id', group, 0, undefined), true);
});

test('transport and reconnect percentages are balanced independently within every shard', () => {
  const counts = (users, percent) => Array.from({ length: 4 }, (_unused, shard) => {
    const ordinals = Array.from({ length: users }, (_none, index) => index);
    const selected = ordinals.filter((ordinal) =>
      selectedByPercent(ordinal, percent, users, shard, 4)).length;
    assert.equal(selected, selectedCountForShard(percent, users, shard, 4));
    return selected;
  });

  assert.deepEqual(counts(2_500, 5), [125, 125, 125, 125]);
  assert.deepEqual(counts(2_500, 10), [250, 250, 250, 250]);
  assert.deepEqual(counts(250, 5), [13, 13, 12, 12]);
  assert.deepEqual(counts(250, 10), [25, 25, 25, 25]);
});

test('owner-stratified reconnect selection is exact and balanced at 4x250 and 4x2500', () => {
  const plans = (users) => Array.from({ length: 4 }, (_unused, shardIndex) => {
    const fixtures = Array.from({ length: users }, (_none, ordinal) => ({
      authenticatedUserId: shardIndex * 10_000 + ordinal + 1,
      ownedChatChannels: ordinal % 25 === 0 ? 1 : 0,
    }));
    const selection = reconnectSelectionForFixtures(fixtures, 10, shardIndex, 4);
    const presence = presencePlanForFixtures(fixtures, selection);
    assert.equal(selection.selectedOrdinals.length, selectedCountForShard(10, users, shardIndex, 4));
    assert.equal(new Set(selection.selectedOrdinals).size, selection.selectedOrdinals.length);
    assert.equal(presence.strategy, 'owner-stratified-v1');
    return presence;
  });

  const small = plans(250);
  assert.deepEqual(small.map((plan) => plan.initialOwnedChatChannels), [10, 10, 10, 10]);
  assert.deepEqual(small.map((plan) => plan.forcedReconnectOwnedChatChannels), [1, 1, 1, 1]);
  assert.deepEqual(small.map((plan) => plan.forcedReconnectOwnerUserIds.length), [1, 1, 1, 1]);

  const full = plans(2_500);
  assert.deepEqual(full.map((plan) => plan.initialOwnedChatChannels), [100, 100, 100, 100]);
  assert.deepEqual(full.map((plan) => plan.forcedReconnectOwnedChatChannels), [10, 10, 10, 10]);
  assert.deepEqual(full.map((plan) => plan.forcedReconnectOwnerUserIds.length), [10, 10, 10, 10]);
});

test('owner-stratified reconnect selection preserves the exact total at small percentages', () => {
  const fixtures = Array.from({ length: 250 }, (_none, ordinal) => ({
    authenticatedUserId: ordinal + 1,
    ownedChatChannels: ordinal % 25 === 0 ? 1 : 0,
  }));
  const selection = reconnectSelectionForFixtures(fixtures, 2, 0, 4);
  const presence = presencePlanForFixtures(fixtures, selection);
  assert.equal(selection.selectedOrdinals.length, 5);
  assert.equal(presence.forcedReconnectOwnedChatChannels, 0);
  assert.equal(presence.forcedReconnectOwnerUserIds.length, 0);
  assert.deepEqual(selection.selectedOrdinals, [49, 99, 149, 199, 249]);
});

test('evaluate hard-fails loss, duplication, ordering, and latency regressions', () => {
  const metrics = {
    connected: 10,
    connectFailures: 0,
    httpRequests: 100,
    httpErrors: 0,
    missingSelfReceipts: 1,
    duplicateCreatedEvents: 1,
    orderingViolations: 1,
    runEventOrderingViolations: 1,
    unexpectedDisconnects: 0,
    delegatedRuns: 0,
    completedRuns: 0,
    forcedReconnectsExpected: 0,
    connectLatency: new Histogram(),
    httpReadLatency: new Histogram(),
    httpWriteLatency: new Histogram(),
    eventLatency: new Histogram(),
  };
  for (const histogram of [metrics.connectLatency, metrics.httpReadLatency, metrics.httpWriteLatency, metrics.eventLatency]) histogram.observe(10);
  const result = evaluate(metrics, 10, {
    connectSuccess: 0.999,
    connectP99Ms: 5_000,
    httpErrorRate: 0.001,
    httpReadP99Ms: 1_000,
    httpWriteP99Ms: 1_000,
    eventP99Ms: 1_000,
    reconnectWithin10Success: 0.99,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 4);
});

test('evaluate enforces reconnect deadlines and runner completion parity', () => {
  const metrics = {
    connected: 100,
    connectFailures: 0,
    httpRequests: 1,
    httpErrors: 0,
    missingSelfReceipts: 0,
    duplicateCreatedEvents: 0,
    orderingViolations: 0,
    runEventOrderingViolations: 0,
    unexpectedDisconnects: 0,
    delegatedRuns: 2,
    completedRuns: 1,
    forcedReconnectsExpected: 100,
    forcedReconnectsWithin10s: 98,
    forcedReconnectsWithin20s: 99,
    connectLatency: new Histogram(),
    httpReadLatency: new Histogram(),
    httpWriteLatency: new Histogram(),
    eventLatency: new Histogram(),
  };
  const result = evaluate(metrics, 100, {
    connectSuccess: 0.999,
    connectP99Ms: 5_000,
    httpErrorRate: 0.001,
    httpReadP99Ms: 1_000,
    httpWriteP99Ms: 1_000,
    eventP99Ms: 1_000,
    reconnectWithin10Success: 0.99,
  });
  assert.deepEqual(result.failures, [
    'runner completions 1/2',
    'runner delegations 2/0',
    'reconnect within 10s 98.000%',
    'reconnect within 20s 99/100',
  ]);
});

test('WorkloadTracker accounts for scheduled work and waits for in-flight completion', async () => {
  const metrics = { workload: {} };
  const tracker = new WorkloadTracker(metrics);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });

  tracker.schedule('read', async (markAttempted) => {
    markAttempted();
    await blocked;
    return true;
  });
  tracker.schedule('read', async () => false);

  assert.equal(await tracker.drain(5), false);
  release();
  assert.equal(await tracker.drain(100), true);
  assert.deepEqual(metrics.workload.read, {
    scheduled: 2,
    attempted: 1,
    completed: 2,
    succeeded: 1,
    failed: 0,
    skipped: 1,
  });
});

test('evaluate fails closed when configured work is not scheduled, attempted, or completed', () => {
  const metrics = {
    connected: 10,
    connectFailures: 0,
    httpRequests: 0,
    httpErrors: 0,
    missingSelfReceipts: 0,
    duplicateCreatedEvents: 0,
    orderingViolations: 0,
    runEventOrderingViolations: 0,
    unexpectedDisconnects: 0,
    createdRuns: 0,
    delegatedRuns: 0,
    completedRuns: 0,
    forcedReconnectsExpected: 0,
    workload: {
      chat: { scheduled: 0, attempted: 0, completed: 0, succeeded: 0, failed: 0, skipped: 0 },
    },
    connectLatency: new Histogram(),
    httpReadLatency: new Histogram(),
    httpWriteLatency: new Histogram(),
    eventLatency: new Histogram(),
  };
  const result = evaluate(metrics, 10, {
    connectSuccess: 0.999,
    connectP99Ms: 5_000,
    httpErrorRate: 0.001,
    httpReadP99Ms: 1_000,
    httpWriteP99Ms: 1_000,
    eventP99Ms: 1_000,
    reconnectWithin10Success: 0.99,
    minimumWorkloadScheduledRatio: 0.99,
    minimumWorkloadAttemptedRatio: 0.99,
    minimumWorkloadCompletedRatio: 0.999,
    minimumWorkloadSucceededRatio: 0.999,
  }, { chat: 100 });

  assert.deepEqual(result.failures, [
    'chat scheduled 0/100',
    'chat attempted 0/0',
    'chat completed 0/0',
    'chat succeeded 0/0',
  ]);
});

test('evaluate does not mistake HTTP recovery for realtime or upgrade parity', () => {
  const metrics = {
    connected: 100,
    connectFailures: 0,
    httpRequests: 100,
    httpErrors: 0,
    chatSelfReceipts: 99,
    recoveredSelfReceipts: 1,
    missingSelfReceipts: 0,
    receiptAccountingMismatches: 0,
    realtimePeerReceiptsExpected: 100,
    realtimePeerReceipts: 99,
    missingRealtimePeerReceipts: 1,
    duplicateCreatedEvents: 0,
    orderingViolations: 0,
    runEventOrderingViolations: 0,
    unexpectedDisconnects: 0,
    createdRuns: 1,
    delegatedRuns: 1,
    completedRuns: 0,
    recoveredRunCompletions: 1,
    duplicateRunDelegations: 0,
    expectedInitialUpgrades: 95,
    initialUpgrades: 94,
    expectedForcedReconnectUpgrades: 10,
    forcedReconnectUpgrades: 9,
    chatPostShapeErrors: 1,
    chatReadShapeErrors: 1,
    chatReadStaleErrors: 1,
    unexpectedBroadcasts: 1,
    reconnectCatchupsExpected: 2,
    reconnectCatchupsVerified: 1,
    reconnectCatchupMissingMessages: 1,
    forcedReconnectsExpected: 0,
    workload: {
      chat: { scheduled: 100, attempted: 100, completed: 100, succeeded: 100, failed: 0, skipped: 0 },
    },
    connectLatency: new Histogram(),
    httpReadLatency: new Histogram(),
    httpWriteLatency: new Histogram(),
    eventLatency: new Histogram(),
  };
  const result = evaluate(metrics, 100, {
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
  }, { chat: 100 });

  assert.deepEqual(result.failures, [
    'realtime sender receipts 99.000%',
    '1 missing realtime peer receipts',
    'realtime peer receipts 99/100',
    'realtime run completions 0.000%',
    'initial WebSocket upgrades 94/95',
    'forced reconnect WebSocket upgrades 9/10',
    '1 invalid chat POST responses',
    '1 invalid chat read responses',
    '1 stale chat read responses',
    '1 cross-channel chat broadcasts',
    'reconnect HTTP catch-up 1/2',
    '1 messages missing after reconnect catch-up',
  ]);
});
