#!/usr/bin/env node
/**
 * End-to-end test for cross-user agent pinging + runner routing.
 *
 * Verifies the "pingable by other users" toggle and, crucially, that a ping
 * from another user is delegated to the *agent owner's* desktop runner — never
 * the pinger's ("don't confuse my desktop runner for theirs"). Also checks that
 * the pinger's request body can't override the agent's yolo/cwd/model.
 *
 * Reuses the real server (dist/index.js) with two simulated desktop runner
 * sockets (owner A + pinger B). Build first: `npm run build`.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const API_PORT = Number(process.env.TEST_API_PORT || 3098);
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const DB_PATH = `/tmp/cascade-crossping-e2e-${API_PORT}.db`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function must(url, options) {
  const { ok, status, data } = await fetchJson(url, options);
  if (!ok) throw new Error(`${status} ${url}: ${data.error || 'request failed'}`);
  return data;
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { ok, data } = await fetchJson(`${API_BASE}/api/health`);
      if (ok && data.status === 'ok') return;
    } catch {
      // Server socket is not listening yet.
    }
    await sleep(200);
  }
  throw new Error('Server did not become healthy in time');
}

function startServer() {
  return spawn('node', ['dist/index.js'], {
    cwd: root,
    env: { ...process.env, API_PORT: String(API_PORT), API_HOST: '127.0.0.1', DOCS_DB_PATH: DB_PATH, JWT_SECRET: 'crossping-e2e-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Connect a simulated desktop runner; records every run:delegate it receives
 * and auto-completes runs so the server-side flow settles. */
async function connectRunner(token, label) {
  const socket = io(`${API_BASE}/runners`, { auth: { token }, transports: ['websocket'] });
  const delegated = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} runner connect timeout`)), 10000);
    socket.on('connect', () => { clearTimeout(timer); socket.emit('runner:register'); resolve(); });
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
  socket.on('run:delegate', (payload) => {
    delegated.push(payload);
    socket.emit('runner:runEvent', { runId: payload.runId, type: 'status', payload: { status: 'completed', summary: 'Done.', sessionId: `${label}-sess` } });
  });
  return { socket, delegated };
}

async function register(username) {
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  return { token, auth: { Authorization: `Bearer ${token}` } };
}

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`[e2e] OK  ${name}`); } else { console.error(`[e2e] FAIL ${name}`); failures++; }
}

async function main() {
  const server = startServer();
  server.stdout.on('data', (c) => process.stdout.write(`[server] ${c}`));
  server.stderr.on('data', (c) => process.stderr.write(`[server-err] ${c}`));

  try {
    await waitForHealth();
    const stamp = Date.now();
    const A = await register(`owner_${stamp}`);
    const B = await register(`pinger_${stamp}`);

    // A: vault + chat channel + agent (pingable ON), then invite B.
    const { vault: aVault } = await must(`${API_BASE}/api/vaults`, { method: 'POST', headers: A.auth, body: JSON.stringify({ name: 'A Vault' }) });
    const { note: aChannel } = await must(`${API_BASE}/api/vaults/${aVault.id}/notes`, {
      method: 'POST', headers: A.auth, body: JSON.stringify({ title: 'roboport', content: 'cascade://chat-channel' }),
    });
    const REG_ID = `reg-${stamp}`;
    await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/agents`, {
      method: 'PUT', headers: A.auth,
      body: JSON.stringify({ id: REG_ID, agentId: 'grok', displayName: 'Devopus', mention: 'devopus', model: 'grok-code', cwd: '', pingableByOthers: true, yolo: false }),
    });
    const { token: inviteToken } = await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/invite-link`, { method: 'POST', headers: A.auth });
    const bLink = await must(`${API_BASE}/api/chat-invites/${encodeURIComponent(inviteToken)}/accept`, { method: 'POST', headers: B.auth });
    check('B linked A\'s channel', Boolean(bLink.vaultId && bLink.channelId));

    const aRunner = await connectRunner(A.token, 'A');
    const bRunner = await connectRunner(B.token, 'B');
    await sleep(200);

    // ── Test 1: B pings with toggle ON → routes to A's runner, not B's.
    // B also tries to override yolo/cwd/model; the server must ignore them.
    const ping1 = await fetchJson(`${API_BASE}/api/vaults/${bLink.vaultId}/runs`, {
      method: 'POST', headers: B.auth,
      body: JSON.stringify({
        prompt: 'hey devopus', registrationId: REG_ID,
        yolo: true, model: 'evil-model', cwd: '/tmp/evil',
        chat: { channelId: bLink.channelId, messageId: `msg-${stamp}-1` },
      }),
    });
    check('B ping accepted (200) with toggle ON', ping1.ok);
    await sleep(600);
    const d = aRunner.delegated.find((p) => p.runId === ping1.data?.run?.id);
    check('run delegated to OWNER (A) runner', Boolean(d));
    check('run NOT delegated to pinger (B) runner', bRunner.delegated.length === 0);
    check('owner yolo=false enforced (pinger yolo:true ignored)', d && d.yolo === false);
    check('pinger cwd ignored (not /tmp/evil)', d && d.cwd !== '/tmp/evil');
    check('run uses OWNER vault', d && d.vaultId === aVault.id);
    check('agent resolved from registration', d && d.agent === 'grok');

    // ── Test 2: toggle OFF → B's ping is rejected 403, no delegation.
    await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/agents`, {
      method: 'PUT', headers: A.auth,
      body: JSON.stringify({ id: REG_ID, agentId: 'grok', displayName: 'Devopus', mention: 'devopus', model: 'grok-code', cwd: '', pingableByOthers: false, yolo: false }),
    });
    const aBefore = aRunner.delegated.length;
    const ping2 = await fetchJson(`${API_BASE}/api/vaults/${bLink.vaultId}/runs`, {
      method: 'POST', headers: B.auth,
      body: JSON.stringify({ prompt: 'hey again', registrationId: REG_ID, chat: { channelId: bLink.channelId, messageId: `msg-${stamp}-2` } }),
    });
    check('B ping rejected 403 with toggle OFF', ping2.status === 403);
    await sleep(400);
    check('no run delegated when toggle OFF', aRunner.delegated.length === aBefore);

    // ── Test 3: owner can always ping its own agent (toggle OFF).
    const ping3 = await fetchJson(`${API_BASE}/api/vaults/${aVault.id}/runs`, {
      method: 'POST', headers: A.auth,
      body: JSON.stringify({ prompt: 'self ping', registrationId: REG_ID, chat: { channelId: aChannel.id, messageId: `msg-${stamp}-3` } }),
    });
    check('owner self-ping accepted despite toggle OFF', ping3.ok);
    await sleep(500);
    check('owner self-ping delegated to A runner', aRunner.delegated.some((p) => p.runId === ping3.data?.run?.id));

    aRunner.socket.disconnect();
    bRunner.socket.disconnect();

    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    console.log('[e2e] All cross-user ping routing tests passed');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
  }
}

main().catch((error) => { console.error('[e2e] FAILED:', error.message || error); process.exit(1); });
