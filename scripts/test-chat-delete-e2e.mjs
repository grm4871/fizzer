#!/usr/bin/env node
/**
 * End-to-end test for deleting chat messages.
 *
 * Covers the permission rule (own message always; anyone's when you host the
 * channel's source vault), the socket broadcast that removes it from every
 * linked participant's client, and that restricted agent tokens can't delete.
 *
 * Uses the real backend selected by CASCADE_TEST_BACKEND (node by default).
 * Build Node first with `npm run build`.
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
    name: 'chat-delete-e2e', repoRoot: root, port: API_PORT,
    env: {
      JWT_SECRET: 'chatdelete-e2e-secret',
      // The test needs two accounts; skip the invite-link gate on this throwaway db.
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
  const server = await startServer();

  try {
    const stamp = Date.now();
    const hostName = `host_${stamp}`;
    const guestName = `guest_${stamp}`;
    const A = await register(hostName);
    const B = await register(guestName);

    const { vault: aVault } = await must(`${API_BASE}/api/vaults`, { method: 'POST', headers: A.auth, body: JSON.stringify({ name: 'A Vault' }) });
    const { note: aChannel } = await must(`${API_BASE}/api/vaults/${aVault.id}/notes`, {
      method: 'POST', headers: A.auth, body: JSON.stringify({ title: 'general', content: 'cascade://chat-channel' }),
    });
    await must(`${API_BASE}/api/vaults/${aVault.id}/members`, {
      method: 'POST', headers: A.auth, body: JSON.stringify({ username: guestName, role: 'editor' }),
    });

    const aSock = await connectVaultSocket(A.token, aVault.id, 'host');
    const bSock = await connectVaultSocket(B.token, aVault.id, 'guest');
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
    const guestList = await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages?detail=list`, { headers: B.auth });
    const hostSlim = hostList.messages.find((message) => message.id === mediaId);
    const guestSlim = guestList.messages.find((message) => message.id === mediaId);
    check('host reload keeps a media hydration marker', hostSlim?.hasImages === true && !hostSlim.images);
    check('guest reload keeps a media hydration marker', guestSlim?.hasImages === true && !guestSlim.images);
    const hostFull = await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages/${mediaId}`, { headers: A.auth });
    const guestFull = await must(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages/${mediaId}`, { headers: B.auth });
    check('host can hydrate persisted media', hostFull.message.images?.[0] === image && hostFull.message.channelId === aChannel.id);
    check('guest can hydrate persisted media in the shared vault', guestFull.message.images?.[0] === image && guestFull.message.channelId === aChannel.id);

    // ── Test 2: author deletes their own message; both clients are told.
    const own = await post(B.auth, aVault.id, aChannel.id, guestName, 'guest message');
    const del1 = await fetchJson(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages/${own}`, { method: 'DELETE', headers: B.auth });
    check('author can delete their own message', del1.ok);
    await sleep(300);
    check('message is gone from the channel', !(await listMessageIds(A.auth, aVault.id, aChannel.id)).includes(own));
    check('host client got chatMessageDeleted', aSock.deleted.some((p) => p.messageId === own && p.channelId === aChannel.id));
    check('guest client got chatMessageDeleted', bSock.deleted.some((p) => p.messageId === own && p.channelId === aChannel.id));

    // ── Test 3: a non-author, non-host participant is refused.
    const hostMsg = await post(A.auth, aVault.id, aChannel.id, hostName, 'host message');
    const del2 = await fetchJson(`${API_BASE}/api/vaults/${aVault.id}/channels/${aChannel.id}/messages/${hostMsg}`, { method: 'DELETE', headers: B.auth });
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
    await server.stop();
  }
}

main().catch((error) => { console.error('[e2e] FAILED:', error.message || error); process.exit(1); });
