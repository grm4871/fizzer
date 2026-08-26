import { Histogram } from './load-inputs.mjs';
import { workloadCounters } from './load-tracker.mjs';

/**
 * Load evaluator seam: metrics construction and threshold evaluation.
 * Evidence invariant: every scheduled workload item is accounted for as attempted/completed/succeeded.
 */
export function makeMetrics() {
  return {
    startedAt: new Date().toISOString(),
    connected: 0,
    connectFailures: 0,
    unexpectedDisconnects: 0,
    unexpectedNamespaceDisconnects: { vault: 0, runs: 0, runners: 0 },
    reconnects: 0,
    forcedReconnectsExpected: 0,
    forcedReconnectsRecovered: 0,
    forcedReconnectsWithin10s: 0,
    forcedReconnectsWithin20s: 0,
    reconnectCatchupsExpected: 0,
    reconnectCatchupsVerified: 0,
    reconnectCatchupMissingMessages: 0,
    upgrades: 0,
    expectedInitialUpgrades: 0,
    initialUpgrades: 0,
    reconnectUpgrades: 0,
    expectedForcedReconnectUpgrades: 0,
    forcedReconnectUpgrades: 0,
    pollingOnly: 0,
    httpRequests: 0,
    httpErrors: 0,
    chatWrites: 0,
    chatSelfReceipts: 0,
    chatPostShapeErrors: 0,
    chatReadShapeErrors: 0,
    chatReadStaleErrors: 0,
    unexpectedBroadcasts: 0,
    realtimePeerReceiptsExpected: 0,
    realtimePeerReceipts: 0,
    missingRealtimePeerReceipts: 0,
    recoveredSelfReceipts: 0,
    missingSelfReceipts: 0,
    receiptAccountingMismatches: 0,
    duplicateCreatedEvents: 0,
    orderingViolations: 0,
    createdRuns: 0,
    delegatedRuns: 0,
    completedRuns: 0,
    recoveredRunCompletions: 0,
    duplicateRunDelegations: 0,
    runEventOrderingViolations: 0,
    workloadDrainTimeouts: 0,
    workload: {
      chat: workloadCounters(),
      read: workloadCounters(),
      run: workloadCounters(),
      receiptRecovery: workloadCounters(),
    },
    connectLatency: new Histogram(),
    httpReadLatency: new Histogram(),
    httpWriteLatency: new Histogram(),
    eventLatency: new Histogram(),
    reconnectLatency: new Histogram(),
    forcedReconnectLatency: new Histogram(),
  };
}

export function publicMetrics(metrics) {
  const result = {};
  for (const [key, value] of Object.entries(metrics)) {
    result[key] = value instanceof Histogram ? value.summary() : value;
  }
  return result;
}

export function evaluate(metrics, expectedUsers, thresholds, expectedWorkload = {}) {
  const failures = [];
  const attempted = metrics.connected + metrics.connectFailures;
  const connectSuccess = attempted ? metrics.connected / attempted : 0;
  const httpErrorRate = metrics.httpRequests ? metrics.httpErrors / metrics.httpRequests : 0;
  if (metrics.connected < expectedUsers) failures.push(`connected ${metrics.connected}/${expectedUsers}`);
  if (connectSuccess < thresholds.connectSuccess) failures.push(`connect success ${(connectSuccess * 100).toFixed(3)}%`);
  if (metrics.connectLatency.percentile(0.99) > thresholds.connectP99Ms) failures.push(`connect p99 ${metrics.connectLatency.percentile(0.99)}ms`);
  if (httpErrorRate > thresholds.httpErrorRate) failures.push(`HTTP error rate ${(httpErrorRate * 100).toFixed(3)}%`);
  if (metrics.httpReadLatency.percentile(0.99) > thresholds.httpReadP99Ms) failures.push(`HTTP read p99 ${metrics.httpReadLatency.percentile(0.99)}ms`);
  if (metrics.httpWriteLatency.percentile(0.99) > thresholds.httpWriteP99Ms) failures.push(`HTTP write p99 ${metrics.httpWriteLatency.percentile(0.99)}ms`);
  if (metrics.eventLatency.percentile(0.99) > thresholds.eventP99Ms) failures.push(`event p99 ${metrics.eventLatency.percentile(0.99)}ms`);
  if (metrics.missingSelfReceipts > 0) failures.push(`${metrics.missingSelfReceipts} missing sender receipts`);
  if ((metrics.receiptAccountingMismatches || 0) > 0) failures.push(`${metrics.receiptAccountingMismatches} sender receipt accounting mismatches`);
  const successfulChats = metrics.workload?.chat?.succeeded || 0;
  if (successfulChats > 0) {
    const realtimeReceiptRate = (metrics.chatSelfReceipts || 0) / successfulChats;
    if (realtimeReceiptRate < thresholds.minimumRealtimeReceiptSuccess) {
      failures.push(`realtime sender receipts ${(realtimeReceiptRate * 100).toFixed(3)}%`);
    }
  }
  if ((metrics.missingRealtimePeerReceipts || 0) > 0) {
    failures.push(`${metrics.missingRealtimePeerReceipts} missing realtime peer receipts`);
  }
  if ((metrics.realtimePeerReceiptsExpected || 0) > 0 &&
      (metrics.realtimePeerReceipts || 0) !== metrics.realtimePeerReceiptsExpected) {
    failures.push(`realtime peer receipts ${metrics.realtimePeerReceipts || 0}/${metrics.realtimePeerReceiptsExpected}`);
  }
  if (metrics.duplicateCreatedEvents > 0) failures.push(`${metrics.duplicateCreatedEvents} duplicate created events`);
  if (metrics.orderingViolations > 0) failures.push(`${metrics.orderingViolations} chat ordering violations`);
  if (metrics.runEventOrderingViolations > 0) failures.push(`${metrics.runEventOrderingViolations} run event ordering violations`);
  if ((metrics.unexpectedDisconnects || 0) > 0) failures.push(`${metrics.unexpectedDisconnects} unexpected disconnects`);
  const confirmedRunCompletions = (metrics.completedRuns || 0) + (metrics.recoveredRunCompletions || 0);
  if ((metrics.delegatedRuns || 0) !== confirmedRunCompletions) {
    failures.push(`runner completions ${confirmedRunCompletions}/${metrics.delegatedRuns || 0}`);
  }
  if ((metrics.createdRuns || 0) !== (metrics.delegatedRuns || 0)) {
    failures.push(`runner delegations ${metrics.delegatedRuns || 0}/${metrics.createdRuns || 0}`);
  }
  if ((metrics.duplicateRunDelegations || 0) > 0) {
    failures.push(`${metrics.duplicateRunDelegations} duplicate run delegations`);
  }
  if ((metrics.createdRuns || 0) > 0) {
    const realtimeRunRate = (metrics.completedRuns || 0) / metrics.createdRuns;
    if (realtimeRunRate < thresholds.minimumRealtimeRunCompletionSuccess) {
      failures.push(`realtime run completions ${(realtimeRunRate * 100).toFixed(3)}%`);
    }
  }
  if ((metrics.initialUpgrades || 0) !== (metrics.expectedInitialUpgrades || 0)) {
    failures.push(`initial WebSocket upgrades ${metrics.initialUpgrades || 0}/${metrics.expectedInitialUpgrades || 0}`);
  }
  if ((metrics.forcedReconnectUpgrades || 0) !== (metrics.expectedForcedReconnectUpgrades || 0)) {
    failures.push(`forced reconnect WebSocket upgrades ${metrics.forcedReconnectUpgrades || 0}/${metrics.expectedForcedReconnectUpgrades || 0}`);
  }
  if ((metrics.chatPostShapeErrors || 0) > 0) failures.push(`${metrics.chatPostShapeErrors} invalid chat POST responses`);
  if ((metrics.chatReadShapeErrors || 0) > 0) failures.push(`${metrics.chatReadShapeErrors} invalid chat read responses`);
  if ((metrics.chatReadStaleErrors || 0) > 0) failures.push(`${metrics.chatReadStaleErrors} stale chat read responses`);
  if ((metrics.unexpectedBroadcasts || 0) > 0) failures.push(`${metrics.unexpectedBroadcasts} cross-channel chat broadcasts`);
  if ((metrics.reconnectCatchupsVerified || 0) !== (metrics.reconnectCatchupsExpected || 0)) {
    failures.push(`reconnect HTTP catch-up ${metrics.reconnectCatchupsVerified || 0}/${metrics.reconnectCatchupsExpected || 0}`);
  }
  if ((metrics.reconnectCatchupMissingMessages || 0) > 0) {
    failures.push(`${metrics.reconnectCatchupMissingMessages} messages missing after reconnect catch-up`);
  }
  if ((metrics.workloadDrainTimeouts || 0) > 0) {
    failures.push(`${metrics.workloadDrainTimeouts} workload drain timeouts`);
  }
  const minimumScheduledRatio = thresholds.minimumWorkloadScheduledRatio ?? 0.99;
  const minimumAttemptedRatio = thresholds.minimumWorkloadAttemptedRatio ?? 0.99;
  const minimumCompletedRatio = thresholds.minimumWorkloadCompletedRatio ?? 0.999;
  const minimumSucceededRatio = thresholds.minimumWorkloadSucceededRatio ?? (1 - thresholds.httpErrorRate);
  for (const [kind, expected] of Object.entries(expectedWorkload)) {
    if (!(expected > 0)) continue;
    const counters = metrics.workload?.[kind] || workloadCounters();
    const scheduledRatio = counters.scheduled / expected;
    const attemptedRatio = counters.scheduled ? counters.attempted / counters.scheduled : 0;
    const completedRatio = counters.scheduled ? counters.completed / counters.scheduled : 0;
    const succeededRatio = counters.attempted ? counters.succeeded / counters.attempted : 0;
    if (scheduledRatio < minimumScheduledRatio) {
      failures.push(`${kind} scheduled ${counters.scheduled}/${expected}`);
    }
    if (attemptedRatio < minimumAttemptedRatio) {
      failures.push(`${kind} attempted ${counters.attempted}/${counters.scheduled}`);
    }
    if (completedRatio < minimumCompletedRatio) {
      failures.push(`${kind} completed ${counters.completed}/${counters.scheduled}`);
    }
    if (succeededRatio < minimumSucceededRatio) {
      failures.push(`${kind} succeeded ${counters.succeeded}/${counters.attempted}`);
    }
  }
  const forced = metrics.forcedReconnectsExpected || 0;
  if (forced > 0) {
    const within10 = (metrics.forcedReconnectsWithin10s || 0) / forced;
    if (within10 < thresholds.reconnectWithin10Success) {
      failures.push(`reconnect within 10s ${(within10 * 100).toFixed(3)}%`);
    }
    if ((metrics.forcedReconnectsWithin20s || 0) !== forced) {
      failures.push(`reconnect within 20s ${metrics.forcedReconnectsWithin20s || 0}/${forced}`);
    }
  }
  return { ok: failures.length === 0, failures };
}
