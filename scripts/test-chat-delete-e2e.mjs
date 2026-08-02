#!/usr/bin/env node
/**
 * End-to-end test for deleting chat messages.
 *
 * Covers the permission rule (own message always; anyone's when you host the
 * channel's source vault), the socket broadcast that removes it from every
 * linked participant's client, and that restricted agent tokens can't delete.
 *
 * Reuses the real server (dist/index.js). Build first: `npm run build`.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const API_PORT = Number(process.env.TEST_API_PORT || 3097);
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const DB_PATH = `/tmp/cascade-chatdelete-e2e-${API_PORT}.db`;

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
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      API_HOST: '127.0.0.1',
      DOCS_DB_PATH: DB_PATH,
      JWT_SECRET: 'chatdelete-e2e-secret',
      // The test needs two accounts; skip the invite-link gate on this throwaway db.
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function register(username) {
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  return { token, auth: { Authorization: `Bearer ${token}` } };
}

/** Join a vault room and record every chatMessageDeleted broadcast. */
async function connectVaultSocket(token, vaultId, label) {
  const socket = io(`${API_BASE}/vault`, { auth: { token }, transports: ['websocket'] });
  const deleted = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} socket connect timeout`)), 10000);
    socket.on('connect', () => { clearTimeout(timer); socket.emit('joinVault', vaultId); resolve(); });
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
  socket.on('vault:chatMessageDeleted', (payload) => deleted.push(payload));
  return { socket, deleted };
}

let seq = 0;
async function post(auth, vaultId, channelId, author, body) {
  seq += 1;
  const id = `msg-${Date.now()}-${seq}`;
  await must(`${API_BASE}/api/vaults/${vaultId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ id, channelId, author, body, createdAt: new Date().toISOString() }),
  });
  return id;
}

async function listMessageIds(auth, vaultId, channelId) {
  const data = await must(`${API_BASE}/api/vaults/${vaultId}/channels/${channelId}/messages?detail=list`, { headers: auth });
  return (data.messages || []).map((m) => m.id);
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
    const hostName = `host_${stamp}`;
    const guestName = `guest_${stamp}`;
    const A = await register(hostName);
    const B = await register(guestName);

    const { vault: aVault } = await must(`${API_BASE}/api/vaults`, { method: 'POST', headers: A.auth, body: JSON.stringify({ name: 'A Vault' }) });
    const { note: aChannel } = await must(`${API_BASE}/api/vaults/${aVault.id}/notes`, {
      method: 'POST', headers: A.auth, body: JSON.stringify({ title: 'general', content: 'cascade://chat-channel' }),
    });
    const { token: inviteToken } = await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/invite-link`, { method: 'POST', headers: A.auth });
    const bLink = await must(`${API_BASE}/api/chat-invites/${encodeURIComponent(inviteToken)}/accept`, { method: 'POST', headers: B.auth });

    const aSock = await connectVaultSocket(A.token, aVault.id, 'host');
    const bSock = await connectVaultSocket(B.token, bLink.vaultId, 'guest');
    await sleep(200);

    // ── Test 1: media survives the slim reload path for both sides of a
    // linked multiplayer channel, and either side can hydrate the full image.
    const mediaId = `msg-${Date.now()}-media`;
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwFJAAAAAElFTkSuQmCC';
    await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages`, {
      method: 'POST', headers: A.auth,
      body: JSON.stringify({
        id: mediaId,
        channelId: aChannel.id,
        author: hostName,
        body: '',
        images: [image],
        createdAt: new Date().toISOString(),
      }),
    });
    const hostList = await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages?detail=list`, { headers: A.auth });
    const guestList = await must(`${API_BASE}/api/vaults/${bLink.vaultId}/channels/${bLink.channelId}/messages?detail=list`, { headers: B.auth });
    const hostSlim = hostList.messages.find((message) => message.id === mediaId);
    const guestSlim = guestList.messages.find((message) => message.id === mediaId);
    check('host reload keeps a media hydration marker', hostSlim?.hasImages === true && !hostSlim.images);
    check('guest reload keeps a media hydration marker', guestSlim?.hasImages === true && !guestSlim.images);
    const hostFull = await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages/${mediaId}`, { headers: A.auth });
    const guestFull = await must(`${API_BASE}/api/vaults/${bLink.vaultId}/channels/${bLink.channelId}/messages/${mediaId}`, { headers: B.auth });
    check('host can hydrate persisted media', hostFull.message.images?.[0] === image && hostFull.message.channelId === aChannel.id);
    check('guest can hydrate persisted media through linked ids', guestFull.message.images?.[0] === image && guestFull.message.channelId === bLink.channelId);

    // ── Test 2: author deletes their own message; both clients are told.
    const own = await post(B.auth, bLink.vaultId, bLink.channelId, guestName, 'guest message');
    const del1 = await fetchJson(`${API_BASE}/api/vaults/${bLink.vaultId}/channels/${bLink.channelId}/messages/${own}`, { method: 'DELETE', headers: B.auth });
    check('author can delete their own message', del1.ok);
    await sleep(300);
    check('message is gone from the channel', !(await listMessageIds(A.auth, aVault.id, aChannel.id)).includes(own));
    check('host client got chatMessageDeleted', aSock.deleted.some((p) => p.messageId === own && p.channelId === aChannel.id));
    check('guest client got chatMessageDeleted (linked ids)', bSock.deleted.some((p) => p.messageId === own && p.channelId === bLink.channelId));

    // ── Test 3: a non-author, non-host participant is refused.
    const hostMsg = await post(A.auth, aVault.id, aChannel.id, hostName, 'host message');
    const del2 = await fetchJson(`${API_BASE}/api/vaults/${bLink.vaultId}/channels/${bLink.channelId}/messages/${hostMsg}`, { method: 'DELETE', headers: B.auth });
    check('guest cannot delete the host\'s message (403)', del2.status === 403);
    check('refused message survives', (await listMessageIds(A.auth, aVault.id, aChannel.id)).includes(hostMsg));

    // ── Test 4: the host may delete anyone's message, including agent posts.
    const agentMsg = await post(A.auth, aVault.id, aChannel.id, 'Claude', 'Claude Code process exited with code 1');
    const del3 = await fetchJson(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages/${agentMsg}`, { method: 'DELETE', headers: A.auth });
    check('host can delete an agent message', del3.ok);
    await sleep(200);
    check('agent message is gone', !(await listMessageIds(A.auth, aVault.id, aChannel.id)).includes(agentMsg));

    // ── Test 5: restricted agent tokens cannot delete at all.
    const { token: agentToken } = await must(`${API_BASE}/api/auth/agent-token`, { method: 'POST', headers: A.auth });
    const del4 = await fetchJson(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages/${hostMsg}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${agentToken}` },
    });
    check('agent token is refused (403)', del4.status === 403);
    check('host message still there after agent attempt', (await listMessageIds(A.auth, aVault.id, aChannel.id)).includes(hostMsg));

    // ── Test 6: unknown message id is a clean 404, not a 500.
    const del5 = await fetchJson(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages/does-not-exist`, { method: 'DELETE', headers: A.auth });
    check('missing message returns 404', del5.status === 404);

    aSock.socket.disconnect();
    bSock.socket.disconnect();

    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    console.log('[e2e] All chat message delete tests passed');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
  }
}

main().catch((error) => { console.error('[e2e] FAILED:', error.message || error); process.exit(1); });
