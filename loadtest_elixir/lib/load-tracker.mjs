import { Histogram } from './load-inputs.mjs';

/**
 * Load tracker seam: socket helpers, workload accounting, and deterministic reconnect/presence plans.
 * Failure mode: skipped, failed, and incomplete work remain distinct so evaluation cannot hide loss.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function workloadCounters() {
  return {
    scheduled: 0,
    attempted: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
}

export class WorkloadTracker {
  constructor(metrics) {
    this.metrics = metrics;
    this.inFlight = new Set();
  }

  schedule(kind, operation) {
    const counters = this.metrics.workload[kind] ||= workloadCounters();
    counters.scheduled += 1;
    let attempted = false;
    const markAttempted = () => {
      if (attempted) return;
      attempted = true;
      counters.attempted += 1;
    };
    const task = Promise.resolve()
      .then(() => operation(markAttempted))
      .then((succeeded) => {
        if (!attempted) counters.skipped += 1;
        else if (succeeded === false) counters.failed += 1;
        else counters.succeeded += 1;
      })
      .catch(() => {
        if (!attempted) counters.skipped += 1;
        else counters.failed += 1;
      })
      .finally(() => {
        counters.completed += 1;
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
    return task;
  }

  async drain(timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (this.inFlight.size > 0) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      const settled = Promise.allSettled([...this.inFlight]);
      const timedOut = await Promise.race([
        settled.then(() => false),
        sleep(remaining).then(() => true),
      ]);
      if (timedOut) return false;
    }
    return true;
  }
}

export function waitForSocket(socket, timeoutMs) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${socket.nsp} connect timeout`));
    }, timeoutMs);
    const onConnect = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
  });
}

export function bearer(token, sourceIp = '') {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(sourceIp ? { 'X-Forwarded-For': sourceIp } : {}),
  };
}

export function fixtureGroupKey(fixture) {
  return `${fixture.vaultId}\u0000${fixture.channelId}`;
}

export function validChatPostResponse(data, expectedId) {
  return String(data?.message?.id || '') === expectedId;
}

export function validChatReadResponse(data, expectedId = '') {
  if (!Array.isArray(data?.messages)) return false;
  return !expectedId || data.messages.some((message) => String(message?.id || '') === expectedId);
}

export function unexpectedLoadBroadcast(id, recipientGroup, localShardIndex, expectedGroup) {
  const match = /^load-(\d+)-/.exec(id);
  if (!match) return false;
  if (Number(match[1]) !== localShardIndex) return true;
  return expectedGroup != null && recipientGroup !== expectedGroup;
}

export function reclassifyPendingPeerReceiptsForReconnect(
  ordinal,
  pendingPeerReceipts,
  pendingPeerReceiptCounts,
  metrics,
) {
  const catchupIds = [];
  for (const [messageId, peers] of pendingPeerReceipts) {
    if (!peers.delete(ordinal)) continue;
    catchupIds.push(messageId);
    metrics.realtimePeerReceiptsExpected -= 1;
    const counts = pendingPeerReceiptCounts.get(messageId);
    if (counts) counts.expected -= 1;
    if (peers.size === 0) pendingPeerReceipts.delete(messageId);
  }
  return catchupIds;
}

export function selectedCountForShard(percent, shardUsers, shardIndex = 0, shardCount = 1) {
  if (!Number.isInteger(shardUsers) || shardUsers <= 0
      || !Number.isInteger(shardIndex) || !Number.isInteger(shardCount)
      || shardCount <= 0 || shardIndex < 0 || shardIndex >= shardCount) return 0;
  const totalSelected = Math.round(shardUsers * shardCount * percent / 100);
  return Math.floor(totalSelected / shardCount) + (shardIndex < totalSelected % shardCount ? 1 : 0);
}

export function selectedByPercent(localOrdinal, percent, shardUsers, shardIndex = 0, shardCount = 1) {
  if (!Number.isInteger(localOrdinal) || localOrdinal < 0 || localOrdinal >= shardUsers) return false;
  const selected = selectedCountForShard(percent, shardUsers, shardIndex, shardCount);
  if (selected <= 0) return false;
  if (selected >= shardUsers) return true;
  return Math.floor((localOrdinal + 1) * selected / shardUsers)
    > Math.floor(localOrdinal * selected / shardUsers);
}

const reconnectSelectionStrategy = 'owner-stratified-v1';

function spreadSelection(ordinals, count) {
  if (count <= 0) return [];
  if (count >= ordinals.length) return [...ordinals];
  return ordinals.filter((_ordinal, index) => (
    Math.floor((index + 1) * count / ordinals.length)
      > Math.floor(index * count / ordinals.length)
  ));
}

export function reconnectSelectionForFixtures(
  fixtures,
  reconnectPercent,
  shardIndex = 0,
  shardCount = 1,
) {
  const target = selectedCountForShard(
    reconnectPercent,
    fixtures.length,
    shardIndex,
    shardCount,
  );
  const ownerOrdinals = [];
  const nonOwnerOrdinals = [];
  fixtures.forEach((fixture, ordinal) => {
    (fixture.ownedChatChannels > 0 ? ownerOrdinals : nonOwnerOrdinals).push(ordinal);
  });
  const selectedOwnerCount = Math.min(
    target,
    Math.round(ownerOrdinals.length * reconnectPercent / 100),
  );
  const selectedOwnerOrdinals = spreadSelection(ownerOrdinals, selectedOwnerCount);
  const selectedNonOwnerOrdinals = spreadSelection(
    nonOwnerOrdinals,
    target - selectedOwnerOrdinals.length,
  );
  const selectedOrdinals = [...selectedOwnerOrdinals, ...selectedNonOwnerOrdinals]
    .sort((left, right) => left - right);
  const selectedOwnerUserIds = selectedOwnerOrdinals.map((ordinal) => {
    const userId = fixtures[ordinal]?.authenticatedUserId;
    if (!Number.isInteger(userId)) {
      throw new Error(`Reconnect owner fixture at local ordinal ${ordinal} has no authenticated user ID`);
    }
    return userId;
  });
  return {
    strategy: reconnectSelectionStrategy,
    selectedOrdinals,
    selectedOwnerUserIds,
  };
}

export function presencePlanForFixtures(fixtures, reconnectSelection) {
  if (reconnectSelection?.strategy !== reconnectSelectionStrategy
      || !Array.isArray(reconnectSelection.selectedOrdinals)
      || !Array.isArray(reconnectSelection.selectedOwnerUserIds)) {
    throw new Error(`Reconnect selection must use ${reconnectSelectionStrategy}`);
  }
  const initialOwnedChatChannels = fixtures.reduce(
    (sum, fixture) => sum + fixture.ownedChatChannels,
    0,
  );
  const forcedReconnectOwnedChatChannels = reconnectSelection.selectedOrdinals.reduce(
    (sum, ordinal) => sum + fixtures[ordinal].ownedChatChannels,
    0,
  );
  return {
    strategy: reconnectSelection.strategy,
    initialOwnedChatChannels,
    forcedReconnectOwnedChatChannels,
    forcedReconnectOwnerUserIds: [...reconnectSelection.selectedOwnerUserIds],
  };
}

