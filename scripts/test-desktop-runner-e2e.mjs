#!/usr/bin/env node
/**
 * End-to-end test for desktop agent runner delegation.
 *
 * Simulates: browser POST /runs → server delegates → desktop runner socket
 * receives run:delegate → desktop emits events → browser polls run status.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { launchTestBackend } from './lib/test-backend.mjs';
import { pickPort } from './lib/test-ports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;

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

function startServer() {
  return launchTestBackend({
    name: 'desktop-runner-e2e', repoRoot: root, port: API_PORT,
    env: {
      JWT_SECRET: 'e2e-test-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: 'true',
      // The former fail-on-disconnect path honored this. Keep it tiny so this
      // regression proves transport loss is no longer a terminal timer.
      RUNNER_DISCONNECT_GRACE_MS: '50',
    },
  });
}

async function main() {
  console.log('[e2e] Starting server on', API_BASE);
  const server = await startServer();

  try {

    const username = `runner_e2e_${Date.now()}`;
    const { token } = await fetchJson(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ username, password: 'testpass12345' }),
    });

    const auth = { Authorization: `Bearer ${token}` };

    const browserLogin = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cascade-Browser': '1' },
      body: JSON.stringify({ username, password: 'testpass12345' }),
    });
    const sessionCookie = browserLogin.headers.get('set-cookie')?.split(';', 1)[0] || '';
    if (!browserLogin.ok || !sessionCookie) throw new Error('Expected browser login cookie');
    const cookieRunner = io(`${API_BASE}/runners`, {
      transports: ['websocket'],
      extraHeaders: { cookie: sessionCookie },
      reconnection: false,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cookie runner socket connect timeout')), 10000);
      cookieRunner.once('connect', () => { clearTimeout(timer); resolve(); });
      cookieRunner.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
    });
    cookieRunner.close();
    console.log('[e2e] OK runner socket accepts HttpOnly cookie session');

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
    const canceledLocally = [];
    let cancelAckDelayMs = 0;
    runnerSocket.on('run:cancel', ({ runId }, acknowledge) => {
      canceledLocally.push(Number(runId));
      setTimeout(() => acknowledge?.({ success: true }), cancelAckDelayMs);
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Runner socket connect timeout')), 10000);
      runnerSocket.on('connect', () => {
        clearTimeout(timer);
        runnerSocket.emit('runner:register', { runnerInstanceId: 'desktop-main-a' });
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

    // ── Steering: persist the session before interrupt, then resume it ────
    let steeringFirst = null;
    let steeringSecond = null;
    runnerSocket.off('run:delegate');
    runnerSocket.on('run:delegate', (payload) => {
      if (!steeringFirst) {
        steeringFirst = payload;
        runnerSocket.emit('runner:runEvent', {
          runId: payload.runId,
          type: 'session',
          payload: { sessionId: 'desktop-steering-session' },
        });
        runnerSocket.emit('runner:runEvent', {
          runId: payload.runId,
          type: 'status',
          payload: { status: 'running' },
        });
        return;
      }
      steeringSecond = payload;
      runnerSocket.emit('runner:runEvent', {
        runId: payload.runId,
        type: 'status',
        payload: { status: 'completed', summary: 'Steering resumed.', sessionId: payload.resumeSessionId },
      });
    });

    const steeringConversation = `steering-${Date.now()}`;
    const { run: steeringRun } = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        prompt: 'Begin long task',
        agent: 'codex',
        note_id: null,
        conversation_id: steeringConversation,
      }),
    });
    await sleep(250);
    cancelAckDelayMs = 200;
    const cancelStartedAt = Date.now();
    await fetchJson(`${API_BASE}/api/runs/${steeringRun.id}/cancel`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ steering: true }),
    });
    if (!canceledLocally.includes(steeringRun.id)) {
      throw new Error('Steering continuation was released before desktop cancellation acknowledgement');
    }
    if (Date.now() - cancelStartedAt < 150) {
      throw new Error('Cancel endpoint returned before desktop process-exit acknowledgement');
    }
    cancelAckDelayMs = 0;
    const { run: steeredRun } = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        prompt: 'Mid-session steering: change direction',
        agent: 'codex',
        note_id: null,
        conversation_id: steeringConversation,
      }),
    });
    await sleep(300);
    if (!steeringSecond || steeringSecond.runId !== steeredRun.id) {
      throw new Error('Expected steering continuation to be delegated');
    }
    if (steeringSecond.resumeSessionId !== 'desktop-steering-session') {
      throw new Error(`Expected steering resume session, got ${steeringSecond.resumeSessionId || 'none'}`);
    }
    console.log('[e2e] OK steering interrupt resumed the early-persisted session');

    // ── Disconnect reclaim: transport loss must not fail a local child ──
    let midRunPayload = null;
    runnerSocket.off('run:delegate');
    runnerSocket.on('run:delegate', (payload) => {
      midRunPayload = payload;
      runnerSocket.emit('runner:runEvent', {
        runId: payload.runId,
        type: 'status',
        payload: { status: 'running' },
      });
      // Intentionally leave the run open — no completed status yet.
    });

    const { run: openRun } = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ prompt: 'Stay open across reconnect', agent: 'grok', note_id: null }),
    });
    await sleep(300);
    if (!midRunPayload || midRunPayload.runId !== openRun.id) {
      throw new Error('Expected open run to be delegated');
    }

    // Stay offline well past the old configured grace, then reconnect as the
    // same Electron-main instance and reclaim the still-running child.
    runnerSocket.disconnect();
    await sleep(200);

    const offlineOpen = await fetchJson(`${API_BASE}/api/runs/${openRun.id}`, { headers: auth });
    if (offlineOpen.run.status === 'failed') {
      throw new Error(`Transport loss incorrectly failed local run ${openRun.id}`);
    }

    const reconnected = io(`${API_BASE}/runners`, {
      auth: { token },
      transports: ['websocket'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reconnect timeout')), 10000);
      reconnected.on('connect', () => {
        clearTimeout(timer);
        reconnected.emit('runner:register', {
          runnerInstanceId: 'desktop-main-a',
          activeRunIds: [openRun.id],
        });
        resolve();
      });
      reconnected.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    await sleep(400);

    const stillOpen = await fetchJson(`${API_BASE}/api/runs/${openRun.id}`, { headers: auth });
    if (stillOpen.run.status === 'failed') {
      throw new Error(
        `Open run was failed on brief disconnect (status=${stillOpen.run.status}, summary=${stillOpen.run.summary})`,
      );
    }
    console.log('[e2e] OK open run survived brief disconnect+reconnect');

    // Finish the open run from the reconnected socket.
    reconnected.emit('runner:runEvent', {
      runId: openRun.id,
      type: 'status',
      payload: { status: 'completed', summary: 'Recovered.', sessionId: 'desktop-session-2' },
    });
    await sleep(300);
    const recovered = await fetchJson(`${API_BASE}/api/runs/${openRun.id}`, { headers: auth });
    if (recovered.run.status !== 'completed') {
      throw new Error(`Expected recovered run completed, got ${recovered.run.status}`);
    }
    console.log('[e2e] OK run completed after reconnect');

    // ── Full app restart: omitted old children must release sticky leases ──
    let restartPayload = null;
    reconnected.on('run:delegate', (payload) => {
      restartPayload = payload;
      reconnected.emit('runner:runEvent', {
        runId: payload.runId,
        type: 'status',
        payload: { status: 'running' },
      });
    });
    const { run: restartRun } = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/runs`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ prompt: 'Interrupted by full app restart', agent: 'grok', note_id: null }),
    });
    await sleep(300);
    if (!restartPayload || restartPayload.runId !== restartRun.id) {
      throw new Error('Expected restart fixture run to be delegated');
    }
    reconnected.emit('runner:register', {
      runnerInstanceId: 'desktop-main-b',
      activeRunIds: [],
    });
    await sleep(300);
    const interrupted = await fetchJson(`${API_BASE}/api/runs/${restartRun.id}`, { headers: auth });
    if (interrupted.run.status !== 'failed' || !String(interrupted.run.summary).includes('restarted')) {
      throw new Error(`Expected app-restart run to fail visibly, got ${interrupted.run.status}: ${interrupted.run.summary}`);
    }
    console.log('[e2e] OK full app restart released omitted run ownership');

    reconnected.disconnect();
    runnerSocket.disconnect();

    // Wait past waitForDesktopRunner (6s) so offline is definitive.
    await sleep(6500);

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
    await server.stop();
  }
}

main().catch((error) => {
  console.error('[e2e] FAILED:', error);
  process.exit(1);
});
