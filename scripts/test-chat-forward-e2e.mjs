#!/usr/bin/env node
/**
 * End-to-end test for forwarding a chat message into another channel.
 *
 * Covers the copy itself (body + attachments + provenance stamp), the socket
 * broadcast into the target channel, access control on the target, and the
 * refusals (same channel, unknown message).
 *
 * Uses the Elixir API via `scripts/lib/test-backend.mjs`.
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

function startServer() {
  return launchTestBackend({
    name: 'chat-forward-e2e', repoRoot: root, port: API_PORT,
    env: {
      JWT_SECRET: 'chatforward-e2e-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
  });
}

async function register(username) {
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  return { token, auth: { Authorization: `Bearer ${token}` } };
}

/** Join a vault room and record every chatMessageCreated broadcast. */
async function connectVaultSocket(token, vaultId, label) {
  const socket = io(`${API_BASE}/vault`, { auth: { token }, transports: ['websocket'] });
  const created = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} socket connect timeout`)), 10000);
    socket.on('connect', () => { clearTimeout(timer); socket.emit('joinVault', vaultId); resolve(); });
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
  socket.on('vault:chatMessageCreated', (payload) => created.push(payload));
  return { socket, created };
}

let seq = 0;
async function post(auth, vaultId, channelId, author, body, extra = {}) {
  seq += 1;
  const id = `msg-${Date.now()}-${seq}`;
  await must(`${API_BASE}/api/vaults/${vaultId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ id, channelId, author, body, createdAt: new Date().toISOString(), ...extra }),
  });
  return id;
}

async function listMessages(auth, vaultId, channelId) {
  const data = await must(`${API_BASE}/api/vaults/${vaultId}/channels/${channelId}/messages?detail=full`, { headers: auth });
  return data.messages || [];
}

async function createChannel(auth, vaultId, title) {
  const { note } = await must(`${API_BASE}/api/vaults/${vaultId}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title, content: 'cascade://chat-channel' }),
  });
  return note;
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`[e2e] OK  ${name}`); } else { console.error(`[e2e] FAIL ${name}`); failures++; }
  if (!cond && detail) console.error(`[e2e]      ${detail}`);
}

async function main() {
  const server = await startServer();

  try {
    const stamp = Date.now();
    const ownerName = `owner_${stamp}`;
    const otherName = `other_${stamp}`;
    const A = await register(ownerName);
    const B = await register(otherName);
    const { token: agentToken } = await must(`${API_BASE}/api/auth/agent-token`, { method: 'POST', headers: A.auth });
    const agentAuth = { authorization: `Bearer ${agentToken}` };

    const { vault } = await must(`${API_BASE}/api/vaults`, { method: 'POST', headers: A.auth, body: JSON.stringify({ name: 'Forward Vault' }) });
    const source = await createChannel(A.auth, vault.id, 'general');
    const target = await createChannel(A.auth, vault.id, 'design');

    const sock = await connectVaultSocket(A.token, vault.id, 'owner');
    await sleep(200);

    // ── Test 1: forward a message with an attachment into another channel.
    const attachments = [{ name: 'diagram.png', media_type: 'image/png', url: 'https://example.test/diagram.png' }];
    const original = await post(agentAuth, vault.id, source.id, 'Claude', 'the renderer stalled for ~1s', {
      agentId: 'claude', attachments,
    });
    const fwd = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/channels/${source.id}/messages/${original}/forward`, {
      method: 'POST', headers: A.auth, body: JSON.stringify({ targetChannelId: target.id }),
    });
    check('forward returns 201', fwd.status === 201);

    const copy = fwd.data.message;
    check('copy landed in the target channel', copy?.channelId === target.id);
    check('copy keeps the body', copy?.body === 'the renderer stalled for ~1s');
    check('copy keeps attachments', copy?.attachments?.[0]?.name === 'diagram.png');
    check('copy is authored by the forwarder', copy?.author === ownerName);
    check('copy is not attributed to the origin agent', !copy?.agentId);
    check('copy carries provenance', copy?.forwardedFrom?.channelName === source.title
      && copy?.forwardedFrom?.author === 'Claude'
      && copy?.forwardedFrom?.messageId === original);

    await sleep(300);
    check('target clients got chatMessageCreated', sock.created.some((p) => p.channelId === target.id && p.message.id === copy.id));

    const targetMessages = await listMessages(A.auth, vault.id, target.id);
    const persisted = targetMessages.find((m) => m.id === copy.id);
    check('copy survives a reload with provenance', persisted?.forwardedFrom?.channelName === source.title);
    check('original stays in the source channel', (await listMessages(A.auth, vault.id, source.id)).some((m) => m.id === original));

    // ── Test 2: forwarding into the same channel is refused.
    const same = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/channels/${source.id}/messages/${original}/forward`, {
      method: 'POST', headers: A.auth, body: JSON.stringify({ targetChannelId: source.id }),
    });
    check('same-channel forward is refused (400)', same.status === 400);

    // ── Test 3: unknown message id is refused, not a 500.
    const missing = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/channels/${source.id}/messages/does-not-exist/forward`, {
      method: 'POST', headers: A.auth, body: JSON.stringify({ targetChannelId: target.id }),
    });
    check('unknown message is refused (400)', missing.status === 400,
      `received ${missing.status}: ${missing.data.error || JSON.stringify(missing.data)}`);

    // ── Test 4: missing target is refused.
    const noTarget = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/channels/${source.id}/messages/${original}/forward`, {
      method: 'POST', headers: A.auth, body: JSON.stringify({}),
    });
    check('missing targetChannelId is refused (400)', noTarget.status === 400);

    // ── Test 5: a user with no access to the source channel cannot forward from it.
    const outsider = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/channels/${source.id}/messages/${original}/forward`, {
      method: 'POST', headers: B.auth, body: JSON.stringify({ targetChannelId: target.id }),
    });
    check('outsider cannot forward (400)', outsider.status === 400,
      `received ${outsider.status}: ${outsider.data.error || JSON.stringify(outsider.data)}`);
    check('outsider forward posted nothing', (await listMessages(A.auth, vault.id, target.id)).length === targetMessages.length);

    sock.socket.disconnect();

    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    console.log('[e2e] All chat message forward tests passed');
  } finally {
    await server.stop();
  }
}

main().catch((error) => { console.error('[e2e] FAILED:', error.message || error); process.exit(1); });
