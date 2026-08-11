#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Manager } from 'socket.io-client';

import { parseArgs, readFixtures } from './load.mjs';

const execFileAsync = promisify(execFile);

function numberOption(args, key, fallback, minimum = 1) {
  const value = args[key] == null ? fallback : Number(args[key]);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`--${key} must be >= ${minimum}`);
  return value;
}

function inspectContainer(container) {
  const [inspection] = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }));
  if (container === 'cascade' || (inspection.Mounts || []).some((mount) => (
    mount.Source === '/var/lib/cascade' || mount.Source.startsWith('/var/lib/cascade/')
  ))) {
    throw new Error('refusing to restart the production Cascade container or data mount');
  }
  const [image] = JSON.parse(execFileSync('docker', ['image', 'inspect', inspection.Image], { encoding: 'utf8' }));
  return {
    containerId: inspection.Id,
    containerStartedAt: inspection.State.StartedAt,
    imageId: inspection.Image,
    revision: image.Config?.Labels?.['org.opencontainers.image.revision'] || '',
    running: inspection.State.Running,
  };
}

function waitForSocket(socket, timeoutMs) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error(`${socket.nsp} connect timeout`)), timeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timer);
      socket.off('connect', connected);
      socket.off('connect_error', failed);
      callback(value);
    };
    const connected = () => finish(resolve);
    const failed = (error) => finish(reject, error);
    socket.on('connect', connected);
    socket.on('connect_error', failed);
  });
}

function deferred(timeoutMs, label) {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
  return {
    promise: promise.finally(() => clearTimeout(timer)),
    resolve,
  };
}

async function jsonRequest(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `${response.status} ${url}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${target}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`candidate health did not recover within ${timeoutMs}ms`);
}

function bearer(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export function evaluateRunnerRestart(observations, maximumRestartMs = 120_000) {
  const failures = [];
  if (!observations.sameContainer) failures.push('container identity changed during restart');
  if (!observations.sameImage) failures.push('image identity changed during restart');
  if (!(observations.restartMs <= maximumRestartMs)) failures.push(`restart took ${observations.restartMs}ms`);
  if (!observations.reclaimedActiveRun) failures.push('active run was not reclaimed');
  if (observations.delegations !== 1) failures.push(`run was delegated ${observations.delegations} times`);
  if (observations.completedTerminalEvents !== 1) {
    failures.push(`observed ${observations.completedTerminalEvents} completed terminal events`);
  }
  if (observations.finalStatus !== 'completed') failures.push(`final run status is ${observations.finalStatus}`);
  return { ok: failures.length === 0, failures };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const target = String(args.target || '').replace(/\/$/u, '');
  const fixturesFile = String(args.fixtures || '');
  const container = String(args.container || '');
  const output = path.resolve(String(args.output || ''));
  if (!target || !fixturesFile || !container || !args.output) {
    throw new Error('--target, --fixtures, --container, and --output are required');
  }
  if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
  const timeoutMs = numberOption(args, 'timeoutMs', 120_000);
  const settleMs = numberOption(args, 'settleMs', 2_000);
  const [fixture] = readFixtures(fixturesFile, { users: 1 });
  const before = inspectContainer(container);
  if (!before.running) throw new Error('candidate container is not running');
  const startedAt = new Date().toISOString();
  const manager = new Manager(target, {
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2_000,
    timeout: 10_000,
    autoConnect: false,
  });
  const auth = { token: fixture.token };
  const runs = manager.socket('/runs', { auth });
  const runner = manager.socket('/runners', { auth });
  const activeRunIds = new Set();
  const initialRegistration = deferred(15_000, 'initial runner registration');
  const recoveryRegistration = deferred(timeoutMs, 'runner reclaim registration');
  const delegated = deferred(15_000, 'run delegation');
  let restartStarted = false;
  let delegations = 0;
  let completedTerminalEvents = 0;
  let reclaimedActiveRun = false;
  let runId = null;
  const runnerInstanceId = `fault-restart-${Date.now()}-${process.pid}`;

  runs.on('connect', () => {
    for (const id of activeRunIds) runs.emit('joinRun', id);
  });
  runs.on('event', (event) => {
    if (Number(event?.run_id) !== runId || event?.type !== 'status') return;
    let payload = event.payload;
    if (!payload && typeof event.payload_json === 'string') {
      try { payload = JSON.parse(event.payload_json); } catch { payload = {}; }
    }
    if (payload?.status === 'completed') completedTerminalEvents += 1;
  });
  runner.on('connect', () => {
    runner.emit('runner:register', { activeRunIds: [...activeRunIds], runnerInstanceId });
  });
  runner.on('runner:registered', (payload) => {
    if (!restartStarted) {
      initialRegistration.resolve(payload);
      return;
    }
    const reclaimed = Array.isArray(payload?.reclaimed) ? payload.reclaimed.map(Number) : [];
    if (runId != null && reclaimed.includes(runId)) reclaimedActiveRun = true;
    recoveryRegistration.resolve(payload);
  });
  runner.on('run:delegate', (payload) => {
    if (Number(payload?.runId) !== runId) return;
    delegations += 1;
    activeRunIds.add(runId);
    runs.emit('joinRun', runId);
    delegated.resolve(payload);
  });

  try {
    runs.connect();
    runner.connect();
    await Promise.all([waitForSocket(runs, 15_000), waitForSocket(runner, 15_000)]);
    await initialRegistration.promise;
    const created = await jsonRequest(
      `${target}/api/vaults/${encodeURIComponent(fixture.vaultId)}/runs`,
      {
        method: 'POST',
        headers: bearer(fixture.token),
        body: JSON.stringify({ prompt: 'runner restart recovery proof', agent: 'grok', note_id: null }),
      },
      15_000,
    );
    runId = Number(created?.run?.id);
    if (!Number.isInteger(runId)) throw new Error('run creation returned no numeric run ID');
    await delegated.promise;

    restartStarted = true;
    const restartAt = performance.now();
    await execFileAsync('docker', ['restart', '--time', '10', container], { timeout: timeoutMs });
    await waitForHealth(target, timeoutMs);
    await recoveryRegistration.promise;
    const restartMs = performance.now() - restartAt;
    await new Promise((resolve) => setTimeout(resolve, settleMs));

    runner.emit('runner:runEvent', { runId, type: 'status', payload: { status: 'running' } });
    runner.emit('runner:runEvent', {
      runId,
      type: 'status',
      payload: { status: 'completed', summary: 'restart recovery passed', sessionId: `fault-session-${runId}` },
    });
    activeRunIds.delete(runId);

    const finalDeadline = Date.now() + 15_000;
    let finalStatus = '';
    while (Date.now() < finalDeadline) {
      const data = await jsonRequest(`${target}/api/runs/${runId}`, { headers: bearer(fixture.token) }, 5_000);
      finalStatus = String(data?.run?.status || '');
      if (finalStatus === 'completed' && completedTerminalEvents >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const after = inspectContainer(container);
    const observations = {
      runId,
      sameContainer: before.containerId === after.containerId,
      sameImage: before.imageId === after.imageId,
      containerRestarted: before.containerStartedAt !== after.containerStartedAt,
      restartMs: Math.round(restartMs * 10) / 10,
      reclaimedActiveRun,
      delegations,
      completedTerminalEvents,
      finalStatus,
    };
    const evaluation = evaluateRunnerRestart(observations, timeoutMs);
    if (!observations.containerRestarted) {
      evaluation.ok = false;
      evaluation.failures.push('container start timestamp did not change');
    }
    const result = {
      schemaVersion: 1,
      type: 'cascade-fault-recovery',
      fault: 'runner-restart-reclaim',
      target,
      containerId: before.containerId,
      imageId: before.imageId,
      revision: before.revision,
      fixtureSha256: createHash('sha256').update(fs.readFileSync(fixturesFile)).digest('hex'),
      startedAt,
      finishedAt: new Date().toISOString(),
      observations,
      evaluation,
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!evaluation.ok) process.exitCode = 1;
  } finally {
    manager.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[runner-restart-recovery] fatal: ${error.stack || error}`);
    process.exitCode = 1;
  });
}
