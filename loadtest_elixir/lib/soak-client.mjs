import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { Manager } from 'socket.io-client';
import { analyzeServerLogs } from '../monitor.mjs';
import { PRODUCTION_CPUS, SOAK_FIXTURE_GROUP_SIZE, SOAK_FIXTURE_GROUPS, parseLastJson, releaseRpc, currentIdentity, containerBeamOpenFiles, certifiedShapeFailures, exactRuntimeFailures, digest, stableJson } from './soak-inputs.mjs';

/**
 * Soak client seam: socket lifecycle, HTTP requests, runtime samples, and fixture/log artifacts.
 * Failure mode: reconnect or sample errors stay attached to the affected fixture and phase.
 */
export function waitForReady(context, generation, timeoutMs) {
  const required = new Set(['vault', 'presence', 'runs', 'runners', 'runner:registered']);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (context.engineOpens >= generation && [...required].every((signal) => context.ready.has(signal))) {
        resolve(performance.now());
      } else if (Date.now() >= deadline) {
        reject(new Error(`fixture ${context.fixture.sourceIndex} did not restore all namespace/room signals`));
      } else {
        setTimeout(check, 25);
      }
    };
    check();
  });
}

export function attachClient(target, fixture, ordinal, sourceIp, metrics) {
  const manager = new Manager(target, {
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2_000,
    timeout: 20_000,
    autoConnect: false,
    ...(sourceIp ? { extraHeaders: { 'X-Forwarded-For': sourceIp } } : {}),
  });
  const auth = { token: fixture.token };
  const vault = manager.socket('/vault', { auth });
  const runs = manager.socket('/runs', { auth });
  const runner = manager.socket('/runners', { auth });
  const context = {
    fixture,
    ordinal,
    manager,
    vault,
    runs,
    runner,
    engineOpens: 0,
    ready: new Set(),
    activeRunIds: new Set(),
    closing: false,
  };

  manager.on('open', () => { context.engineOpens += 1; });
  vault.on('connect', () => {
    vault.emit('joinVault', fixture.vaultId);
    vault.emit('joinChatChannel', fixture.channelId);
    context.ready.add('vault');
  });
  vault.on('vault:chatPresence', () => context.ready.add('presence'));
  runs.on('connect', () => {
    for (const runId of context.activeRunIds) runs.emit('joinRun', runId);
    context.ready.add('runs');
  });
  runs.on('event', (event) => {
    const runId = Number(event?.run_id);
    const seq = Number(event?.seq);
    if (!Number.isFinite(runId) || !Number.isFinite(seq)) return;
    const prior = metrics.lastRunSeq.get(runId) || 0;
    const expectedSeq = prior ? prior + 1 : 2;
    if (seq !== expectedSeq) metrics.runs.orderingViolations += 1;
    metrics.lastRunSeq.set(runId, seq);
    let payload = event?.payload;
    if (!payload && typeof event?.payload_json === 'string') {
      try { payload = JSON.parse(event.payload_json); } catch { payload = {}; }
    }
    if (metrics.delegatedRunIds.has(runId)) {
      if (!metrics.liveEvents.has(runId)) metrics.liveEvents.set(runId, []);
      const kind = event.type === 'status' ? `status:${payload?.status || 'missing'}` : event.type;
      metrics.liveEvents.get(runId).push(`${seq}:${kind}`);
    }
    if (event.type === 'status' && payload?.status === 'completed' && metrics.delegatedRunIds.has(runId)) {
      if (!metrics.terminalRunIds.has(runId)) metrics.runs.completed += 1;
      metrics.terminalRunIds.add(runId);
      context.activeRunIds.delete(runId);
    }
  });
  runner.on('connect', () => {
    runner.emit('runner:register', {
      activeRunIds: [...context.activeRunIds],
      runnerInstanceId: `soak-${fixture.sourceIndex}`,
    });
    context.ready.add('runners');
  });
  runner.on('runner:registered', () => context.ready.add('runner:registered'));
  runner.on('run:delegate', (payload) => {
    const runId = Number(payload?.runId);
    if (!Number.isFinite(runId)) return;
    if (metrics.delegatedRunIds.has(runId)) metrics.runs.duplicates += 1;
    else {
      metrics.delegatedRunIds.add(runId);
      metrics.runs.delegated += 1;
    }
    context.activeRunIds.add(runId);
    runs.emit('joinRun', runId);
    setTimeout(() => {
      if (context.closing || !runner.connected) return;
      runner.emit('runner:runEvent', { runId, type: 'status', payload: { status: 'running' } });
      runner.emit('runner:runEvent', {
        runId,
        type: 'text',
        payload: { message: { content: [{ type: 'text', text: `two-hour soak event ${runId}` }] }, chatVisible: true },
      });
      runner.emit('runner:runEvent', {
        runId,
        type: 'status',
        payload: { status: 'completed', summary: `two-hour soak ${runId}`, sessionId: `soak-session-${runId}` },
      });
      context.activeRunIds.delete(runId);
    }, 25);
  });
  runner.on('run:cancel', ({ runId }, acknowledge) => {
    context.activeRunIds.delete(Number(runId));
    acknowledge?.({ success: true });
  });
  return context;
}

export async function jsonRequest(url, options, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `${response.status} ${url}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function captureSample(container, identity, phase, elapsedSeconds = 0, priorCpu = null) {
  const current = currentIdentity(container);
  const beam = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()'));
  const cgroup = beam?.deep?.cgroup;
  const cpuUsageUsec = cgroup?.cpu?.usage_usec;
  const observedAt = new Date().toISOString();
  const observedMs = Date.parse(observedAt);
  const normalizedCpuPct = Number.isFinite(cpuUsageUsec) && Number.isFinite(priorCpu?.usageUsec)
    && observedMs > priorCpu.observedMs
    ? (cpuUsageUsec - priorCpu.usageUsec) / ((observedMs - priorCpu.observedMs) * 1_000) / PRODUCTION_CPUS * 100
    : 0;
  const sample = {
    type: 'runtime-sample',
    phase,
    observedAt,
    elapsedSeconds,
    normalizedCpuPct,
    memoryCurrent: cgroup?.memoryCurrent,
    cgroup,
    containerState: {
      id: current.container.id,
      imageId: current.container.imageId,
      startedAt: current.container.startedAt,
      imageRevision: current.image.revision,
      hostConfig: current.container.hostConfig,
      running: current.container.running,
      restartCount: current.container.restartCount,
      oomKilled: current.container.oomKilled,
    },
    beamOpenFiles: containerBeamOpenFiles(container),
    beam,
    errors: [],
  };
  if (sample.containerState.id !== identity.container.id) sample.errors.push('container ID changed');
  if (sample.containerState.imageId !== identity.container.imageId) sample.errors.push('image ID changed');
  if (sample.containerState.startedAt !== identity.container.startedAt) sample.errors.push('container start changed');
  if (sample.containerState.imageRevision !== identity.image.revision) sample.errors.push('image revision changed');
  if (!sample.containerState.running) sample.errors.push('container stopped');
  if (sample.containerState.restartCount !== 0) sample.errors.push(`container restart count is ${sample.containerState.restartCount}`);
  if (sample.containerState.oomKilled) sample.errors.push('container was OOM-killed');
  sample.errors.push(...certifiedShapeFailures(current.rawHostConfig));
  sample.errors.push(...exactRuntimeFailures(beam?.configuration));
  return { sample, cpu: { usageUsec: cpuUsageUsec, observedMs } };
}

export function fixtureEvidence(fixturesFile, fixtures) {
  const raw = fs.readFileSync(fixturesFile);
  const groups = new Map();
  for (const fixture of fixtures) {
    const key = `${fixture.vaultId}\u0000${fixture.channelId}`;
    if (!Number.isInteger(fixture.ownedChatChannels) || fixture.ownedChatChannels < 0) {
      throw new Error(`fixture ${fixture.sourceIndex} has invalid ownedChatChannels`);
    }
    const group = groups.get(key) || { users: 0, owners: 0 };
    group.users += 1;
    group.owners += fixture.ownedChatChannels;
    groups.set(key, group);
  }
  const groupIdentities = [...groups.entries()]
    .map(([key, group]) => {
      const [vaultId, channelId] = key.split('\u0000');
      return { vaultId, channelId, users: group.users, owners: group.owners };
    })
    .sort((left, right) => `${left.vaultId}\u0000${left.channelId}`.localeCompare(`${right.vaultId}\u0000${right.channelId}`));
  const selectedIdentity = fixtures.map((fixture) => ({
    authenticatedUserId: fixture.authenticatedUserId,
    sourceIndex: fixture.sourceIndex,
    vaultId: fixture.vaultId,
    channelId: fixture.channelId,
    ownedChatChannels: fixture.ownedChatChannels,
    runner: fixture.runner,
  }));
  const churnCohortDigests = Array.from({ length: 10 }, (_unused, cohort) => digest(stableJson(
    fixtures.filter((_fixture, ordinal) => ordinal % 10 === cohort).map((fixture) => ({
      authenticatedUserId: fixture.authenticatedUserId,
      sourceIndex: fixture.sourceIndex,
    })),
  )));
  return {
    path: fixturesFile,
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: raw.length,
    lines: raw.toString('utf8').split(/\r?\n/u).filter(Boolean).length,
    users: fixtures.length,
    groups: groupIdentities.length,
    groupSize: SOAK_FIXTURE_GROUP_SIZE,
    groupIdentities,
    selectedIdentitySha256: digest(stableJson(selectedIdentity)),
    churnCohortDigests,
  };
}

export function captureServerLogs(container, baselineCursor, finishCursor, output) {
  const result = spawnSync(
    'docker',
    ['logs', '--timestamps', '--since', baselineCursor, '--until', finishCursor, container],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  const raw = `${result.stdout || ''}${result.stderr || ''}`;
  const evidence = {
    policy: SERVER_LOG_POLICY,
    baselineCursor,
    finishCursor,
    output,
    readError: null,
    sha256: digest(raw),
    ...analyzeServerLogs(raw),
  };
  if (result.error || result.status !== 0) {
    evidence.readError = result.error?.message || `docker logs exited ${result.status}`;
    return evidence;
  }
  try { fs.writeFileSync(output, raw, { flag: 'wx', mode: 0o600 }); } catch (error) {
    evidence.readError = `could not create bound server-log artifact: ${error.message}`;
  }
  return evidence;
}

export async function mapConcurrent(values, concurrency, task) {
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await task(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function persistedEventFailures(runId, events) {
  const failures = [];
  let prior = 0;
  const signature = [];
  for (const event of events || []) {
    const seq = Number(event?.seq);
    if (!Number.isInteger(seq) || seq !== prior + 1) failures.push(`run ${runId} has non-contiguous persisted event sequence`);
    prior = seq;
    let payload = event?.payload;
    if (!payload && typeof event?.payload_json === 'string') {
      try { payload = JSON.parse(event.payload_json); } catch { payload = {}; }
    }
    signature.push(event?.type === 'status' ? `status:${payload?.status || 'missing'}` : event?.type || 'missing');
  }
  const expected = ['status:queued', 'status:running', 'text', 'status:completed'];
  if (stableJson(signature) !== stableJson(expected)) {
    failures.push(`run ${runId} persisted event signature is ${stableJson(signature)}, expected ${stableJson(expected)}`);
  }
  return { failures, signature, eventCount: events?.length || 0 };
}
