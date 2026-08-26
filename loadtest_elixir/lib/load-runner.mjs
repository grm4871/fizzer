import fs from 'node:fs';
import net from 'node:net';
import { Manager } from 'socket.io-client';
import { parseArgs, parseFixtures, numberOption, boolOption, loadConfiguration, sha256, stableJson } from './load-inputs.mjs';
import { WorkloadTracker, waitForSocket, bearer, fixtureGroupKey, validChatPostResponse, validChatReadResponse, unexpectedLoadBroadcast, reclassifyPendingPeerReceiptsForReconnect, selectedCountForShard, selectedByPercent, reconnectSelectionForFixtures, presencePlanForFixtures, sleep } from './load-tracker.mjs';
import { makeMetrics, publicMetrics, evaluate } from './load-evaluator.mjs';

/**
 * Load run driver seam. It owns socket lifecycle, workload timing, and artifact emission;
 * helper seams above contain no process-global side effects.
 */
export async function run(loadDriverBytes, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const target = String(args.target || process.env.CASCADE_LOAD_TARGET || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const fixturesFile = String(args.fixtures || process.env.CASCADE_LOAD_FIXTURES || '');
  if (!fixturesFile) throw new Error('--fixtures is required (JSONL; see fixtures.example.jsonl)');
  const users = numberOption(args, 'users', Infinity, { min: 1 });
  const shardCount = numberOption(args, 'shardCount', 1, { min: 1 });
  const shardIndex = numberOption(args, 'shardIndex', 0, { min: 0 });
  if (!Number.isInteger(shardCount) || !Number.isInteger(shardIndex) || shardIndex >= shardCount) {
    throw new Error('Shard index/count must be integers with 0 <= index < count');
  }
  const fixtureBytes = fs.readFileSync(fixturesFile);
  const fixtures = parseFixtures(fixtureBytes.toString('utf8'), { users, shardIndex, shardCount });
  if (!fixtures.length) throw new Error('No fixtures selected for this shard');

  const rampSeconds = numberOption(args, 'rampSeconds', 300);
  const soakSeconds = numberOption(args, 'soakSeconds', 1800);
  const chatRps = numberOption(args, 'chatRps', 25);
  const readRps = numberOption(args, 'readRps', 50);
  const runRps = numberOption(args, 'runRps', 1);
  const pollingPercent = Math.min(100, numberOption(args, 'pollingPercent', 5));
  const reconnectPercent = Math.min(100, numberOption(args, 'reconnectPercent', 5));
  const reconnectSelection = reconnectSelectionForFixtures(
    fixtures,
    reconnectPercent,
    shardIndex,
    shardCount,
  );
  const selectionPlan = {
    pollingOnly: selectedCountForShard(pollingPercent, fixtures.length, shardIndex, shardCount),
    forcedReconnects: reconnectSelection.selectedOrdinals.length,
    forcedReconnectStrategy: reconnectSelection.strategy,
    forcedReconnectOwnerUserIds: [...reconnectSelection.selectedOwnerUserIds],
  };
  const presencePlan = presencePlanForFixtures(fixtures, reconnectSelection);
  const reconnectAtSeconds = numberOption(args, 'reconnectAtSeconds', Math.max(30, soakSeconds / 3));
  const connectTimeoutMs = numberOption(args, 'connectTimeoutMs', 20_000, { min: 100 });
  const receiptTimeoutMs = numberOption(args, 'receiptTimeoutMs', 10_000, { min: 100 });
  const requestTimeoutMs = numberOption(args, 'requestTimeoutMs', 10_000, { min: 100 });
  const workloadDrainTimeoutMs = numberOption(args, 'workloadDrainTimeoutMs', requestTimeoutMs + 5_000, { min: 100 });
  const runnerCompletionTimeoutMs = numberOption(args, 'runnerCompletionTimeoutMs', 10_000, { min: 100 });
  const outputFile = args.output ? String(args.output) : '';
  const verbose = boolOption(args.verbose);
  const sourceIp = String(args.sourceIp || '').trim();
  if (sourceIp && net.isIP(sourceIp) === 0) throw new Error('--source-ip must be an IPv4 or IPv6 address');
  if (reconnectPercent > 0 && reconnectAtSeconds + 20 > soakSeconds) {
    throw new Error('--soak-seconds must continue for at least 20 seconds after forced reconnect');
  }

  const thresholds = {
    connectSuccess: numberOption(args, 'minConnectSuccess', 0.999),
    connectP99Ms: numberOption(args, 'connectP99Ms', 5_000),
    httpErrorRate: numberOption(args, 'maxHttpErrorRate', 0.001),
    httpReadP99Ms: numberOption(args, 'httpReadP99Ms', 1_000),
    httpWriteP99Ms: numberOption(args, 'httpWriteP99Ms', 1_000),
    eventP99Ms: numberOption(args, 'eventP99Ms', 1_000),
    reconnectWithin10Success: numberOption(args, 'minReconnectWithin10Success', 0.99),
    minimumRealtimeReceiptSuccess: numberOption(args, 'minRealtimeReceiptSuccess', 0.999),
    minimumRealtimeRunCompletionSuccess: numberOption(args, 'minRealtimeRunCompletionSuccess', 0.999),
    minimumWorkloadScheduledRatio: numberOption(args, 'minWorkloadScheduledRatio', 0.99),
    minimumWorkloadAttemptedRatio: numberOption(args, 'minWorkloadAttemptedRatio', 0.99),
    minimumWorkloadCompletedRatio: numberOption(args, 'minWorkloadCompletedRatio', 0.999),
    minimumWorkloadSucceededRatio: numberOption(args, 'minWorkloadSucceededRatio', 0.999),
  };

  const metrics = makeMetrics();
  const contexts = [];
  const pendingReceipts = new Map();
  const pendingPeerReceipts = new Map();
  const pendingPeerReceiptCounts = new Map();
  const expectedMessageGroups = new Map();
  const latestMessageByGroup = new Map();
  const sentAt = new Map();
  const managers = new Set();
  const receiptTimers = new Set();
  const workload = new WorkloadTracker(metrics);
  const requestedRuns = new Map();
  const delegatedRunIds = new Set();
  const terminalRunIds = new Set();
  const successfulMessages = [];
  let stopping = false;
  let nextContext = 0;

  const measuredFetch = async (url, options, histogram) => {
    const started = performance.now();
    metrics.httpRequests += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`request timeout after ${requestTimeoutMs}ms`)), requestTimeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `${response.status} ${url}`);
      return data;
    } catch (error) {
      metrics.httpErrors += 1;
      if (verbose) console.error('[load] request failed:', error?.message || error);
      throw error;
    } finally {
      clearTimeout(timeout);
      histogram.observe(performance.now() - started);
    }
  };

  const connectFixture = async (fixture, ordinal) => {
    const started = performance.now();
    const pollingOnly = selectedByPercent(
      ordinal,
      pollingPercent,
      fixtures.length,
      shardIndex,
      shardCount,
    );
    if (!pollingOnly) metrics.expectedInitialUpgrades += 1;
    const manager = new Manager(target, {
      transports: pollingOnly ? ['polling'] : ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2_000,
      reconnectionDelayMax: 10_000,
      timeout: connectTimeoutMs,
      autoConnect: false,
      ...(sourceIp ? { extraHeaders: { 'X-Forwarded-For': sourceIp } } : {}),
    });
    managers.add(manager);
    if (pollingOnly) metrics.pollingOnly += 1;
    const auth = { token: fixture.token };
    const vault = manager.socket('/vault', { auth });
    const runs = manager.socket('/runs', { auth });
    const runner = fixture.runner ? manager.socket('/runners', { auth }) : null;
    const context = {
      fixture,
      ordinal,
      manager,
      vault,
      runs,
      runner,
      closing: false,
      connectedOnce: false,
      reconnectStarted: 0,
      reconnectReady: new Set(),
      reconnectCompleted: false,
      unexpectedDisconnectActive: false,
      engineOpens: 0,
      injectingReconnect: false,
      forcedReconnectAt: 0,
      forcedReconnectRecovered: false,
      forcedReconnectRecoveredAt: 0,
      forcedReconnectUpgradeExpected: false,
      forcedReconnectUpgradeObserved: false,
      forcedReconnectEngineOpen: 0,
      forcedReconnectCatchupMessageIds: new Set(),
      pollingOnly,
      seenMessages: new Set(),
      lastMessageSeq: 0,
      lastRunSeq: new Map(),
      activeRunIds: new Set((fixture.runIds || []).map(Number).filter(Number.isFinite)),
    };

    const requiredReconnectSignals = new Set(['vault', 'presence', 'runs', ...(runner ? ['runners', 'runner:registered'] : [])]);
    const markReconnectReady = (signal) => {
      if (!context.reconnectStarted || context.reconnectCompleted) return;
      context.reconnectReady.add(signal);
      if ([...requiredReconnectSignals].some((required) => !context.reconnectReady.has(required))) return;
      const elapsed = performance.now() - context.reconnectStarted;
      context.reconnectCompleted = true;
      context.unexpectedDisconnectActive = false;
      metrics.reconnects += 1;
      metrics.reconnectLatency.observe(elapsed);
      if (context.forcedReconnectAt && !context.forcedReconnectRecovered) {
        context.forcedReconnectRecovered = true;
        context.forcedReconnectRecoveredAt = performance.now();
        metrics.forcedReconnectsRecovered += 1;
        metrics.forcedReconnectLatency.observe(elapsed);
        if (elapsed <= 10_000) metrics.forcedReconnectsWithin10s += 1;
        if (elapsed <= 20_000) metrics.forcedReconnectsWithin20s += 1;
      }
      context.reconnectStarted = 0;
      context.injectingReconnect = false;
    };
    const noteUnexpectedDisconnect = (namespace) => {
      if (!context.connectedOnce || context.closing || context.injectingReconnect || stopping) return;
      metrics.unexpectedNamespaceDisconnects[namespace] += 1;
      if (!context.unexpectedDisconnectActive) {
        context.unexpectedDisconnectActive = true;
        metrics.unexpectedDisconnects += 1;
      }
    };

    manager.on('open', () => {
      context.engineOpens += 1;
      const engineGeneration = context.engineOpens;
      const initialEngine = context.engineOpens === 1;
      manager.engine?.once('upgrade', () => {
        metrics.upgrades += 1;
        if (initialEngine) metrics.initialUpgrades += 1;
        else {
          metrics.reconnectUpgrades += 1;
          if (context.forcedReconnectUpgradeExpected &&
              !context.forcedReconnectUpgradeObserved &&
              context.forcedReconnectEngineOpen === engineGeneration) {
            context.forcedReconnectUpgradeObserved = true;
            metrics.forcedReconnectUpgrades += 1;
          }
        }
      });
    });
    manager.on('reconnect_attempt', () => {
      if (!context.reconnectStarted) {
        context.reconnectStarted = performance.now();
        context.reconnectReady.clear();
        context.reconnectCompleted = false;
      }
    });

    vault.on('connect', () => {
      vault.emit('joinVault', fixture.vaultId);
      vault.emit('joinChatChannel', fixture.channelId);
      markReconnectReady('vault');
    });
    vault.on('disconnect', () => noteUnexpectedDisconnect('vault'));
    vault.on('vault:chatPresence', () => {
      markReconnectReady('presence');
    });
    vault.on('vault:chatMessageCreated', (event) => {
      const message = event?.message || {};
      const id = String(message.id || '');
      const seq = Number(message.seq);
      const recipientGroup = fixtureGroupKey(context.fixture);
      if (unexpectedLoadBroadcast(id, recipientGroup, shardIndex, expectedMessageGroups.get(id))) {
        metrics.unexpectedBroadcasts += 1;
      }
      if (id) {
        if (context.seenMessages.has(id)) metrics.duplicateCreatedEvents += 1;
        context.seenMessages.add(id);
        if (context.seenMessages.size > 20_000) context.seenMessages.clear();
      }
      if (Number.isFinite(seq)) {
        if (context.lastMessageSeq && seq <= context.lastMessageSeq) metrics.orderingViolations += 1;
        context.lastMessageSeq = Math.max(context.lastMessageSeq, seq);
      }
      const timestamp = sentAt.get(id);
      if (timestamp != null) metrics.eventLatency.observe(performance.now() - timestamp);
      if (pendingReceipts.get(id) === ordinal) {
        pendingReceipts.delete(id);
        metrics.chatSelfReceipts += 1;
      }
      const peers = pendingPeerReceipts.get(id);
      if (peers?.delete(ordinal)) {
        metrics.realtimePeerReceipts += 1;
        const counts = pendingPeerReceiptCounts.get(id);
        if (counts) counts.received += 1;
        if (peers.size === 0) {
          pendingPeerReceipts.delete(id);
        }
      }
    });

    runs.on('connect', () => {
      for (const runId of context.activeRunIds) runs.emit('joinRun', runId);
      markReconnectReady('runs');
    });
    runs.on('disconnect', () => noteUnexpectedDisconnect('runs'));
    runs.on('event', (event) => {
      const runId = Number(event?.run_id);
      const seq = Number(event?.seq);
      if (!Number.isFinite(runId) || !Number.isFinite(seq)) return;
      const prior = context.lastRunSeq.get(runId) || 0;
      if (prior && seq <= prior) metrics.runEventOrderingViolations += 1;
      context.lastRunSeq.set(runId, Math.max(prior, seq));
      let payload = event?.payload;
      if (!payload && typeof event?.payload_json === 'string') {
        try { payload = JSON.parse(event.payload_json); } catch { payload = {}; }
      }
      if (event?.type === 'status' && payload?.status === 'completed' && requestedRuns.has(runId) && !terminalRunIds.has(runId)) {
        terminalRunIds.add(runId);
        metrics.completedRuns += 1;
      }
    });

    if (runner) {
      runner.on('connect', () => {
        runner.emit('runner:register', {
          activeRunIds: [...context.activeRunIds],
          runnerInstanceId: `load-${shardIndex}-${fixture.sourceIndex}`,
        });
        markReconnectReady('runners');
      });
      runner.on('disconnect', () => noteUnexpectedDisconnect('runners'));
      runner.on('runner:registered', () => markReconnectReady('runner:registered'));
      runner.on('run:delegate', (payload) => {
        const runId = Number(payload?.runId);
        if (!Number.isFinite(runId)) return;
        if (delegatedRunIds.has(runId)) metrics.duplicateRunDelegations += 1;
        else delegatedRunIds.add(runId);
        metrics.delegatedRuns += 1;
        context.activeRunIds.add(runId);
        runs.emit('joinRun', runId);
        setTimeout(() => {
          runner.emit('runner:runEvent', { runId, type: 'status', payload: { status: 'running' } });
          runner.emit('runner:runEvent', {
            runId,
            type: 'text',
            payload: { message: { content: [{ type: 'text', text: `capacity event ${runId}` }] }, chatVisible: true },
          });
          runner.emit('runner:runEvent', {
            runId,
            type: 'status',
            payload: { status: 'completed', summary: `capacity run ${runId}`, sessionId: `load-session-${runId}` },
          });
          context.activeRunIds.delete(runId);
        }, 25);
      });
      runner.on('run:cancel', ({ runId }, acknowledge) => {
        context.activeRunIds.delete(Number(runId));
        acknowledge?.({ success: true });
      });
    }

    vault.connect();
    runs.connect();
    runner?.connect();
    try {
      await Promise.all([waitForSocket(vault, connectTimeoutMs), waitForSocket(runs, connectTimeoutMs), ...(runner ? [waitForSocket(runner, connectTimeoutMs)] : [])]);
      context.connectedOnce = true;
      metrics.connected += 1;
      metrics.connectLatency.observe(performance.now() - started);
      contexts.push(context);
    } catch (error) {
      metrics.connectFailures += 1;
      context.closing = true;
      manager.disconnect();
      managers.delete(manager);
      if (verbose) console.error(`[load] fixture ${fixture.sourceIndex} failed:`, error?.message || error);
    }
  };

  const rampDelayMs = fixtures.length > 1 ? (rampSeconds * 1_000) / (fixtures.length - 1) : 0;
  for (let i = 0; i < fixtures.length; i += 1) {
    const scheduled = performance.now();
    await connectFixture(fixtures[i], i);
    const remaining = rampDelayMs - (performance.now() - scheduled);
    if (remaining > 0) await sleep(remaining);
  }

  if (!contexts.length) throw new Error('No users connected');
  const rampCompletedAt = new Date().toISOString();
  const soakStartedAt = rampCompletedAt;
  console.log(`[load] ramp complete: ${metrics.connected}/${fixtures.length} users connected`);

  const periodic = (kind, rate, fn) => {
    if (rate <= 0) return null;
    const interval = Math.max(1, 1_000 / rate);
    let nextAt = performance.now();
    const timer = setInterval(() => {
      if (stopping) return;
      const now = performance.now();
      let allowed = 0;
      while (nextAt <= now && allowed < Math.ceil(rate * 2)) {
        nextAt += interval;
        allowed += 1;
        workload.schedule(kind, fn);
      }
    }, Math.min(100, interval));
    return timer;
  };

  const pick = (predicate = () => true) => {
    for (let i = 0; i < contexts.length; i += 1) {
      const context = contexts[nextContext++ % contexts.length];
      if (predicate(context)) return context;
    }
    return null;
  };

  const chatTimer = periodic('chat', chatRps, async (markAttempted) => {
    const context = pick((candidate) => candidate.vault.connected);
    if (!context) return false;
    const id = `load-${shardIndex}-${context.fixture.sourceIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = performance.now();
    const group = fixtureGroupKey(context.fixture);
    sentAt.set(id, now);
    expectedMessageGroups.set(id, group);
    pendingReceipts.set(id, context.ordinal);
    const peers = new Set(
      contexts
        .filter((candidate) => candidate.vault.connected && candidate.fixture.channelId === context.fixture.channelId && candidate.fixture.vaultId === context.fixture.vaultId)
        .map((candidate) => candidate.ordinal),
    );
    pendingPeerReceipts.set(id, peers);
    pendingPeerReceiptCounts.set(id, { expected: peers.size, received: 0 });
    metrics.realtimePeerReceiptsExpected += peers.size;
    metrics.chatWrites += 1;
    markAttempted();
    try {
      const data = await measuredFetch(
        `${target}/api/vaults/${encodeURIComponent(context.fixture.vaultId)}/channels/${encodeURIComponent(context.fixture.channelId)}/messages`,
        {
          method: 'POST',
          headers: bearer(context.fixture.token, sourceIp),
          body: JSON.stringify({ id, channelId: context.fixture.channelId, body: `capacity ${id}`, createdAt: new Date().toISOString() }),
        },
        metrics.httpWriteLatency,
      );
      if (!validChatPostResponse(data, id)) {
        metrics.chatPostShapeErrors += 1;
        throw new Error(`chat POST did not return message ${id}`);
      }
      latestMessageByGroup.set(group, id);
      successfulMessages.push({ id, group, sentAt: now });
      const receiptTimer = setTimeout(() => {
        receiptTimers.delete(receiptTimer);
        workload.schedule('receiptRecovery', async (markReceiptAttempted) => {
          const senderPending = pendingReceipts.has(id);
          const peersPending = pendingPeerReceipts.has(id);
          if (!senderPending && !peersPending) {
            pendingPeerReceiptCounts.delete(id);
            sentAt.delete(id);
            return true;
          }
          // A socket can legitimately miss a broadcast while reconnecting. The
          // shipped client reconciles from the authoritative HTTP list, so count
          // that as recovered delivery rather than data loss.
          let recovered = false;
          if (senderPending) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(new Error(`receipt timeout after ${requestTimeoutMs}ms`)), requestTimeoutMs);
            try {
              markReceiptAttempted();
              const response = await fetch(
                `${target}/api/vaults/${encodeURIComponent(context.fixture.vaultId)}/channels/${encodeURIComponent(context.fixture.channelId)}/messages?detail=list&limit=120`,
                { headers: bearer(context.fixture.token, sourceIp), signal: controller.signal },
              );
              const data = await response.json().catch(() => ({}));
              recovered = response.ok && data.messages?.some((message) => message.id === id);
              if (recovered) {
                pendingReceipts.delete(id);
                metrics.recoveredSelfReceipts += 1;
              }
            } catch { /* count below */ }
            finally { clearTimeout(timeout); }
          }
          if (pendingReceipts.delete(id)) metrics.missingSelfReceipts += 1;
          const missingPeers = pendingPeerReceipts.get(id)?.size || 0;
          metrics.missingRealtimePeerReceipts += missingPeers;
          pendingPeerReceipts.delete(id);
          pendingPeerReceiptCounts.delete(id);
          sentAt.delete(id);
          return recovered;
        });
      }, receiptTimeoutMs);
      receiptTimers.add(receiptTimer);
      receiptTimer.unref?.();
      return true;
    } catch {
      pendingReceipts.delete(id);
      const counts = pendingPeerReceiptCounts.get(id);
      if (counts) {
        metrics.realtimePeerReceiptsExpected -= counts.expected;
        metrics.realtimePeerReceipts -= counts.received;
      }
      pendingPeerReceipts.delete(id);
      pendingPeerReceiptCounts.delete(id);
      sentAt.delete(id);
      return false;
    }
  });

  const readTimer = periodic('read', readRps, async (markAttempted) => {
    const context = pick();
    if (!context) return false;
    const expectedId = latestMessageByGroup.get(fixtureGroupKey(context.fixture)) || '';
    markAttempted();
    try {
      const data = await measuredFetch(
        `${target}/api/vaults/${encodeURIComponent(context.fixture.vaultId)}/channels/${encodeURIComponent(context.fixture.channelId)}/messages?detail=list&limit=120`,
        { headers: bearer(context.fixture.token, sourceIp) },
        metrics.httpReadLatency,
      );
      if (!Array.isArray(data?.messages)) {
        metrics.chatReadShapeErrors += 1;
        return false;
      }
      if (!validChatReadResponse(data, expectedId)) {
        metrics.chatReadStaleErrors += 1;
        return false;
      }
      return true;
    } catch { return false; }
  });

  const runTimer = periodic('run', runRps, async (markAttempted) => {
    const context = pick((candidate) => Boolean(candidate.runner?.connected) && candidate.runs.connected && candidate.activeRunIds.size === 0);
    if (!context) return false;
    markAttempted();
    try {
      const data = await measuredFetch(
        `${target}/api/vaults/${encodeURIComponent(context.fixture.vaultId)}/runs`,
        {
          method: 'POST',
          headers: bearer(context.fixture.token, sourceIp),
          body: JSON.stringify({ prompt: 'capacity proof', agent: 'grok', note_id: null }),
        },
        metrics.httpWriteLatency,
      );
      const runId = Number(data?.run?.id);
      if (Number.isFinite(runId)) {
        requestedRuns.set(runId, context);
        metrics.createdRuns += 1;
        context.activeRunIds.add(runId);
        context.runs.emit('joinRun', runId);
        return true;
      }
      return false;
    } catch { return false; }
  });

  const reconnectTimer = setTimeout(() => {
    const reconnectOrdinals = new Set(reconnectSelection.selectedOrdinals);
    const selected = contexts.filter((context) => reconnectOrdinals.has(context.ordinal));
    metrics.forcedReconnectsExpected = selected.length;
    metrics.expectedForcedReconnectUpgrades = selected.filter((context) => !context.pollingOnly).length;
    console.log(`[load] forcing Engine.IO reconnect for ${selected.length} users`);
    for (const context of selected) {
      for (const messageId of reclassifyPendingPeerReceiptsForReconnect(
        context.ordinal,
        pendingPeerReceipts,
        pendingPeerReceiptCounts,
        metrics,
      )) {
        context.forcedReconnectCatchupMessageIds.add(messageId);
      }
      context.injectingReconnect = true;
      context.reconnectStarted = performance.now();
      context.reconnectReady.clear();
      context.reconnectCompleted = false;
      context.forcedReconnectAt = context.reconnectStarted;
      context.forcedReconnectRecovered = false;
      context.forcedReconnectUpgradeExpected = !context.pollingOnly;
      context.forcedReconnectUpgradeObserved = false;
      context.forcedReconnectEngineOpen = context.engineOpens + 1;
      context.manager.engine?.close();
    }
  }, reconnectAtSeconds * 1_000);

  const progress = setInterval(() => {
    const snapshot = publicMetrics(metrics);
    console.log(`[load] users=${snapshot.connected} http=${snapshot.httpRequests} errors=${snapshot.httpErrors} event_p99=${snapshot.eventLatency.p99Ms}ms reconnects=${snapshot.reconnects}`);
  }, 10_000);

  await sleep(soakSeconds * 1_000);
  const workloadFinishedAt = new Date().toISOString();
  stopping = true;
  for (const timer of [chatTimer, readTimer, runTimer, reconnectTimer, progress]) if (timer) clearInterval(timer);
  if (!await workload.drain(workloadDrainTimeoutMs)) metrics.workloadDrainTimeouts += 1;
  const runnerDeadline = performance.now() + runnerCompletionTimeoutMs;
  while (metrics.completedRuns < metrics.createdRuns && performance.now() < runnerDeadline) await sleep(25);
  const missingRuns = [...requestedRuns].filter(([runId]) => !terminalRunIds.has(runId));
  for (let offset = 0; offset < missingRuns.length; offset += 25) {
    await Promise.all(missingRuns.slice(offset, offset + 25).map(async ([runId, context]) => {
      try {
        const data = await measuredFetch(
          `${target}/api/runs/${runId}`,
          { headers: bearer(context.fixture.token, sourceIp) },
          metrics.httpReadLatency,
        );
      if (data?.run?.status === 'completed') {
        terminalRunIds.add(runId);
        metrics.recoveredRunCompletions += 1;
        }
      } catch { /* evaluation fails below */ }
    }));
  }
  const successfulMessageIds = new Set(successfulMessages.map((message) => message.id));
  const catchupChecks = contexts.flatMap((context) => {
    if (!context.forcedReconnectAt || !context.forcedReconnectRecoveredAt) return [];
    const group = fixtureGroupKey(context.fixture);
    const ids = new Set(successfulMessages
      .filter((message) =>
        message.group === group &&
        message.sentAt >= context.forcedReconnectAt &&
        message.sentAt <= context.forcedReconnectRecoveredAt)
      .map((message) => message.id));
    for (const messageId of context.forcedReconnectCatchupMessageIds) {
      if (successfulMessageIds.has(messageId)) ids.add(messageId);
    }
    return ids.size ? [{ context, ids: [...ids] }] : [];
  });
  metrics.reconnectCatchupsExpected = catchupChecks.length;
  for (let offset = 0; offset < catchupChecks.length; offset += 25) {
    await Promise.all(catchupChecks.slice(offset, offset + 25).map(async ({ context, ids }) => {
      try {
        const data = await measuredFetch(
          `${target}/api/vaults/${encodeURIComponent(context.fixture.vaultId)}/channels/${encodeURIComponent(context.fixture.channelId)}/messages?detail=list&limit=120`,
          { headers: bearer(context.fixture.token, sourceIp) },
          metrics.httpReadLatency,
        );
        const observed = new Set(Array.isArray(data?.messages) ? data.messages.map((message) => String(message?.id || '')) : []);
        const missing = ids.filter((id) => !observed.has(id)).length;
        if (missing === 0) metrics.reconnectCatchupsVerified += 1;
        else metrics.reconnectCatchupMissingMessages += missing;
      } catch {
        metrics.reconnectCatchupMissingMessages += ids.length;
      }
    }));
  }
  await sleep(receiptTimeoutMs + 100);
  if (!await workload.drain(workloadDrainTimeoutMs)) metrics.workloadDrainTimeouts += 1;
  for (const timer of receiptTimers) clearTimeout(timer);
  for (const id of pendingReceipts.keys()) {
    pendingReceipts.delete(id);
    metrics.missingSelfReceipts += 1;
  }
  for (const peers of pendingPeerReceipts.values()) metrics.missingRealtimePeerReceipts += peers.size;
  pendingPeerReceipts.clear();
  pendingPeerReceiptCounts.clear();
  const deliveredChats = metrics.chatSelfReceipts + metrics.recoveredSelfReceipts;
  const successfulChats = metrics.workload.chat.succeeded;
  if (deliveredChats !== successfulChats) {
    metrics.receiptAccountingMismatches = Math.abs(successfulChats - deliveredChats);
    metrics.missingSelfReceipts = Math.max(metrics.missingSelfReceipts, successfulChats - deliveredChats);
  }
  for (const context of contexts) context.closing = true;
  for (const manager of managers) manager.disconnect();

  const successfulMessageIdList = [...successfulMessageIds].sort();
  const requestedRunIdList = [...requestedRuns.keys()].sort((left, right) => left - right);
  const workloadIdentity = {
    successfulMessageIds: successfulMessageIdList,
    successfulMessageIdsCount: successfulMessageIdList.length,
    successfulMessageIdsSha256: sha256(stableJson(successfulMessageIdList)),
    requestedRunIds: requestedRunIdList,
    requestedRunIdsCount: requestedRunIdList.length,
    requestedRunIdsSha256: sha256(stableJson(requestedRunIdList)),
  };

  const result = {
    target,
    ...(sourceIp ? { sourceIp } : {}),
    shard: { index: shardIndex, count: shardCount },
    requestedUsers: fixtures.length,
    rampSeconds,
    soakSeconds,
    rampCompletedAt,
    soakStartedAt,
    workloadFinishedAt,
    pollingPercent,
    reconnectPercent,
    reconnectAtSeconds,
    selectionPlan,
    presencePlan,
    rates: { chatRps, readRps, runRps },
    thresholds,
    metrics: publicMetrics(metrics),
    expectedWorkload: {
      chat: chatRps > 0 ? Math.max(1, Math.floor(chatRps * soakSeconds)) : 0,
      read: readRps > 0 ? Math.max(1, Math.floor(readRps * soakSeconds)) : 0,
      run: runRps > 0 ? Math.max(1, Math.floor(runRps * soakSeconds)) : 0,
    },
    workloadIdentity,
    finishedAt: new Date().toISOString(),
  };
  result.provenance = {
    schemaVersion: 1,
    loadDriverSha256: sha256(loadDriverBytes),
    loadDriverBytes: loadDriverBytes.byteLength,
    fixtureSha256: sha256(fixtureBytes),
    fixtureBytes: fixtureBytes.byteLength,
    configurationSha256: sha256(stableJson(loadConfiguration(result))),
  };
  result.evaluation = evaluate(metrics, fixtures.length, thresholds, result.expectedWorkload);
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (outputFile) fs.writeFileSync(outputFile, rendered);
  process.stdout.write(rendered);
  if (!result.evaluation.ok) process.exitCode = 1;
}
