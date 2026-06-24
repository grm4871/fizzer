#!/usr/bin/env node
/**
 * End-to-end test for desktop agent runner delegation.
 *
 * Simulates: browser POST /runs → server delegates → desktop runner socket
 * receives run:delegate → desktop emits events → browser polls run status.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const API_PORT = Number(process.env.TEST_API_PORT || 3097);
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const DB_PATH = `/tmp/cascade-runner-e2e-${API_PORT}.db`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `${res.status} ${url}`);
  }
  return data;
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = await fetchJson(`${API_BASE}/api/health`);
      if (data.status === 'ok') return;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error('Server did not become healthy in time');
}

function startServer() {
  const child = spawn('node', ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      API_HOST: '127.0.0.1',
      DOCS_DB_PATH: DB_PATH,
      JWT_SECRET: 'e2e-test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function main() {
  console.log('[e2e] Building server...');
  const build = spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
  await new Promise((resolve, reject) => {
    build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))));
  });

  console.log('[e2e] Starting server on', API_BASE);
  const server = startServer();
  server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[server-err] ${chunk}`));

  try {
    await waitForHealth();

    const username = `runner_e2e_${Date.now()}`;
    const { token } = await fetchJson(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ username, password: 'testpass12345' }),
    });

    const auth = { Authorization: `Bearer ${token}` };

    const offline = await fetchJson(`${API_BASE}/api/me/desktop-runner`, { headers: auth });
    if (offline.online) throw new Error('Expected desktop runner offline before connect');
    console.log('[e2e] OK runner offline before connect');

    const { vault } = await fetchJson(`${API_BASE}/api/vaults`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'E2E Vault' }),
    });

    let delegatedPayload = null;
    const runnerSocket = io(`${API_BASE}/runners`, {
      auth: { token },
      transports: ['websocket'],
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Runner socket connect timeout')), 10000);
      runnerSocket.on('connect', () => {
        clearTimeout(timer);
        runnerSocket.emit('runner:register');
        resolve();
      });
      runnerSocket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    console.log('[e2e] OK runner socket connected');

    const online = await fetchJson(`${API_BASE}/api/me/desktop-runner`, { headers: auth });
    if (!online.online) throw new Error('Expected desktop runner online after connect');
    console.log('[e2e] OK runner reported online');

    runnerSocket.on('run:delegate', (payload) => {
      delegatedPayload = payload;
      console.log('[e2e] OK received run:delegate for run', payload.runId);
      runnerSocket.emit('runner:runEvent', {
        runId: payload.runId,
        type: 'status',
        payload: { status: 'running' },
      });
      runnerSocket.emit('runner:runEvent', {
        runId: payload.runId,
        type: 'text',
        payload: { message: { content: [{ type: 'text', text: 'Hello from desktop runner' }] } },
      });
      runnerSocket.emit('runner:runEvent', {
        runId: payload.runId,
        type: 'status',
        payload: { status: 'completed', summary: 'Done.', sessionId: 'desktop-session-1' },
      });
    });

    const { run } = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        prompt: 'Say hello',
        agent: 'grok',
        note_id: null,
      }),
    });

    await sleep(500);

    if (!delegatedPayload) throw new Error('Server did not delegate run to desktop runner');
    if (delegatedPayload.runId !== run.id) throw new Error('Delegated run id mismatch');

    const completed = await fetchJson(`${API_BASE}/api/runs/${run.id}`, { headers: auth });
    if (completed.run.status !== 'completed') {
      throw new Error(`Expected completed run, got ${completed.run.status}`);
    }
    console.log('[e2e] OK run completed via desktop delegation');

    const events = await fetchJson(`${API_BASE}/api/runs/${run.id}/events`, { headers: auth });
    const textEvent = events.events.find((event) => event.type === 'text');
    if (!textEvent?.payload_json?.includes('Hello from desktop runner')) {
      throw new Error('Expected delegated text event in run history');
    }
    console.log('[e2e] OK run events persisted');

    runnerSocket.disconnect();

    let rejected = false;
    try {
      await fetchJson(`${API_BASE}/api/vaults/${vault.id}/runs`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ prompt: 'Should fail', agent: 'grok', note_id: null }),
      });
    } catch (error) {
      rejected = String(error.message).includes('desktop agent runner');
    }
    if (!rejected) throw new Error('Expected 503 when desktop runner offline');
    console.log('[e2e] OK 503 when runner offline');

    console.log('[e2e] All desktop runner tests passed');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
  }
}

main().catch((error) => {
  console.error('[e2e] FAILED:', error);
  process.exit(1);
});