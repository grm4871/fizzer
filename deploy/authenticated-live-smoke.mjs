#!/usr/bin/env node

import { Manager } from 'socket.io-client';

const origin = String(process.argv[2] || '').replace(/\/$/, '');
if (!origin) throw new Error('candidate origin is required');

let token = '';
for await (const chunk of process.stdin) token += chunk;
token = token.trim();
if (!token) throw new Error('authenticated smoke token is required on stdin');

const authHeaders = { Authorization: `Bearer ${token}` };

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text}`);
  return body;
}

function connected(socket, namespace) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${namespace} connect timeout`)), 15_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${namespace} connect failed: ${error?.message || error}`));
    });
  });
}

function nextEvent(socket, event, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const me = await request('/api/me');
if (!Number.isInteger(me.user?.id) || !me.user?.username) {
  throw new Error('authenticated identity response is incomplete');
}

const vaults = (await request('/api/vaults')).vaults || [];
let target = null;
for (const vault of vaults) {
  const notes = (await request(`/api/vaults/${encodeURIComponent(vault.id)}/notes`)).notes || [];
  const channel = notes.find((note) => note.content_preview === 'cascade://chat-channel');
  if (channel) {
    target = { vaultId: String(vault.id), channelId: String(channel.id) };
    break;
  }
}
if (!target) throw new Error('authenticated production account has no accessible chat channel');

await request(`/api/vaults/${encodeURIComponent(target.vaultId)}/runs`);
await request(`/api/vaults/${encodeURIComponent(target.vaultId)}/channels/${encodeURIComponent(target.channelId)}/messages?limit=1`);

const manager = new Manager(origin, {
  transports: ['websocket'],
  reconnection: false,
  timeout: 10_000,
  autoConnect: false,
});
const auth = { token };
const vault = manager.socket('/vault', { auth });
const runs = manager.socket('/runs', { auth });
const runners = manager.socket('/runners', { auth });

try {
  const namespaceConnections = [
    connected(vault, '/vault'),
    connected(runs, '/runs'),
    connected(runners, '/runners'),
  ];
  vault.connect();
  runs.connect();
  runners.connect();
  await Promise.all(namespaceConnections);

  const presence = nextEvent(vault, 'vault:chatPresence');
  vault.emit('joinVault', target.vaultId);
  vault.emit('joinChatChannel', target.channelId);
  const payload = await presence;
  if (!Array.isArray(payload?.participants) || payload.channelId !== target.channelId) {
    throw new Error('chat presence projection is incomplete');
  }
} finally {
  manager.disconnect();
}

console.log(JSON.stringify({
  ok: true,
  authenticatedUser: me.user.username,
  vaultRead: true,
  chatRead: true,
  namespaces: 3,
  presence: true,
}));
