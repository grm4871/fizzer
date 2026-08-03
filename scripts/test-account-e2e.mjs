#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const port = await pickPort();
const base = `http://127.0.0.1:${port}`;
const dbPath = `/tmp/cascade-account-${port}.db`;
const root = new URL('..', import.meta.url).pathname;
let failures = 0;

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return { status: response.status, ok: response.ok, data: await response.json().catch(() => ({})) };
}
async function must(path, options = {}) {
  const result = await request(path, options);
  if (!result.ok) throw new Error(`${result.status} ${path}: ${result.data.error || 'request failed'}`);
  return result.data;
}
function check(label, condition) {
  console.log(`[account-e2e] ${condition ? 'OK ' : 'FAIL'} ${label}`);
  if (!condition) failures += 1;
}
async function register(username) {
  const data = await must('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }) });
  return { ...data, auth: { authorization: `Bearer ${data.token}` } };
}

try { fs.unlinkSync(dbPath); } catch {}
{
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  legacy.close();
}
const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: { ...process.env, API_PORT: String(port), API_HOST: '127.0.0.1', DOCS_DB_PATH: dbPath, JWT_SECRET: 'account-test-secret', CASCADE_ALLOW_OPEN_REGISTRATION: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await request('/api/health')).ok) break; } catch {}
    await delay(100);
  }
  const stamp = Date.now();
  const ownerName = `owner_${stamp}`;
  const guestName = `guest_${stamp}`;
  const owner = await register(ownerName);
  const guest = await register(guestName);

  const avatarUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const profile = await must('/api/me/profile', {
    method: 'PUT', headers: owner.auth, body: JSON.stringify({ displayName: 'Owner Display', avatarUrl }),
  });
  check('self profile stores display name and avatar', profile.user.displayName === 'Owner Display' && profile.user.avatarUrl === avatarUrl);
  check('login handle stays immutable', profile.user.username === ownerName);

  const password = await must('/api/auth/password', {
    method: 'POST', headers: owner.auth, body: JSON.stringify({ currentPassword: 'testpass12345', newPassword: 'changedpass12345' }),
  });
  const newAuth = { authorization: `Bearer ${password.token}` };
  check('password change revokes the prior session', (await request('/api/me', { headers: owner.auth })).status === 401);
  check('replacement session remains valid', (await request('/api/me', { headers: newAuth })).data.user?.displayName === 'Owner Display');
  owner.auth = newAuth;

  const { vault } = await must('/api/vaults', { method: 'POST', headers: owner.auth, body: JSON.stringify({ name: 'Account permissions' }) });
  const { folder } = await must(`/api/vaults/${vault.id}/folders`, { method: 'POST', headers: owner.auth, body: JSON.stringify({ name: 'private' }) });
  check('another account cannot rename a private folder', (await request(`/api/folders/${folder.id}`, { method: 'PATCH', headers: guest.auth, body: JSON.stringify({ name: 'stolen' }) })).status === 404);
  check('another account cannot delete a private folder', (await request(`/api/folders/${folder.id}`, { method: 'DELETE', headers: guest.auth })).status === 404);

  const { note: channel } = await must(`/api/vaults/${vault.id}/notes`, { method: 'POST', headers: owner.auth, body: JSON.stringify({ title: 'shared', content: 'cascade://chat-channel' }) });
  const ownerMessage = await must(`/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: owner.auth, body: JSON.stringify({ id: `owner-${stamp}`, author: guestName, body: 'owner text' }),
  });
  check('server, not the client, owns human authorship', ownerMessage.message.author === ownerName);
  const { token: invite } = await must(`/api/vaults/${vault.id}/channels/${channel.id}/invite-link`, { method: 'POST', headers: owner.auth });
  const linked = await must(`/api/chat-invites/${encodeURIComponent(invite)}/accept`, { method: 'POST', headers: guest.auth });
  const guestPost = await must(`/api/vaults/${linked.vaultId}/channels/${linked.channelId}/messages`, {
    method: 'POST', headers: guest.auth, body: JSON.stringify({ id: `guest-${stamp}`, author: ownerName, body: 'guest text' }),
  });
  check('linked participant cannot spoof another human', guestPost.message.author === guestName);
  check('linked participant cannot edit another human message', (await request(`/api/vaults/${linked.vaultId}/channels/${linked.channelId}/messages/${ownerMessage.message.id}`, { method: 'PATCH', headers: guest.auth, body: JSON.stringify({ body: 'changed' }) })).status === 403);
  check('linked participant cannot change host execution directory', (await request(`/api/vaults/${linked.vaultId}/channels/${linked.channelId}/settings`, { method: 'PUT', headers: guest.auth, body: JSON.stringify({ cwd: '/tmp/hostile' }) })).status === 403);
  const presence = await must(`/api/vaults/${linked.vaultId}/channels/${linked.channelId}/presence`, { headers: guest.auth });
  check('multiplayer presence exposes public profile metadata', presence.profiles?.[ownerName]?.displayName === 'Owner Display' && presence.profiles?.[ownerName]?.avatarUrl === avatarUrl);

  const { token: agentToken } = await must('/api/auth/agent-token', { method: 'POST', headers: owner.auth });
  check('restricted agent token cannot mutate profile', (await request('/api/me/profile', { method: 'PUT', headers: { authorization: `Bearer ${agentToken}` }, body: JSON.stringify({ displayName: 'Nope', avatarUrl: '' }) })).status === 403);

  if (failures) throw new Error(`${failures} account checks failed`);
  console.log('[account-e2e] All account and multiplayer permission checks passed');
} finally {
  server.kill('SIGTERM');
  await delay(200);
  try { fs.unlinkSync(dbPath); } catch {}
}
