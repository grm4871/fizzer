#!/usr/bin/env node
import Database from 'better-sqlite3';
import { io } from 'socket.io-client';
import { launchTestBackend } from './lib/test-backend.mjs';
import { pickPort } from './lib/test-ports.mjs';

const port = await pickPort();
const base = `http://127.0.0.1:${port}`;
let failures = 0;

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return {
    status: response.status,
    ok: response.ok,
    data: await response.json().catch(() => ({})),
    headers: response.headers,
  };
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
async function register(username, inviteToken = '') {
  const data = await must('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'testpass12345', ...(inviteToken ? { inviteToken } : {}) }),
  });
  return { ...data, auth: { authorization: `Bearer ${data.token}` } };
}

const server = await launchTestBackend({
  name: 'account-e2e',
  port,
  env: {
    JWT_SECRET: 'account-test-secret',
    CASCADE_REQUIRE_INVITE_REGISTRATION: 'true',
  },
  prepare({ databasePath }) {
    const legacy = new Database(databasePath);
    legacy.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    legacy.close();
  },
});

try {
  const download = await fetch(`${base}/download`);
  const downloadHtml = await download.text();
  check('desktop handoff route serves the installer chooser', download.ok
    && downloadHtml.includes('id="download"')
    && downloadHtml.includes('/download/linux'));
  const stamp = Date.now();
  const ownerName = `owner_${stamp}`;
  const guestName = `guest_${stamp}`;
  const owner = await register(ownerName);
  const uninvited = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: `uninvited_${stamp}`, password: 'testpass12345' }),
  });
  check('registration closes after the bootstrap account', uninvited.status === 403);

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

  const { note: channel } = await must(`/api/vaults/${vault.id}/notes`, { method: 'POST', headers: owner.auth, body: JSON.stringify({ title: 'shared', content: 'cascade://chat-channel' }) });
  const { note: embeddedNote } = await must(`/api/vaults/${vault.id}/notes`, { method: 'POST', headers: owner.auth, body: JSON.stringify({ title: 'Release plan', content: '# Launch\nShip the shared vault flow.' }) });
  const ownerMessage = await must(`/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: owner.auth, body: JSON.stringify({ id: `owner-${stamp}`, author: guestName, body: 'owner text ![[Release plan|launch notes]]' }),
  });
  check('server, not the client, owns human authorship', ownerMessage.message.author === ownerName);
  const embeds = await must(`/api/vaults/${vault.id}/channels/${channel.id}/messages/${ownerMessage.message.id}/embeds`, { headers: owner.auth });
  check('chat embeds snapshot aliased note targets', embeds.notes?.length === 1 && embeds.notes[0].title === 'Release plan' && embeds.notes[0].content.includes('shared vault'));
  const { token: invite } = await must(`/api/vaults/${vault.id}/invite-link`, {
    method: 'POST', headers: owner.auth, body: JSON.stringify({ role: 'editor' }),
  });
  const guest = await register(guestName, invite);
  check('a new friend can register with the invitation', guest.user.username === guestName);
  check('a registration invitation is single-use', (await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: `reused_${stamp}`, password: 'testpass12345', inviteToken: invite }),
  })).status === 403);
  check('another account cannot rename a private folder', (await request(`/api/folders/${folder.id}`, { method: 'PATCH', headers: guest.auth, body: JSON.stringify({ name: 'stolen' }) })).status === 404);
  check('another account cannot delete a private folder', (await request(`/api/folders/${folder.id}`, { method: 'DELETE', headers: guest.auth })).status === 404);

  // ── Shared vault membership (what the account UI drives) ──────────
  const ownerVaults = await must('/api/vaults', { headers: owner.auth });
  const listed = ownerVaults.vaults.find((v) => v.id === vault.id);
  check('vault list reports the caller role', listed?.role === 'owner');
  check('vault list reports a member count', listed?.memberCount === 1);
  check('a private vault is invisible to non-members', !(await must('/api/vaults', { headers: guest.auth })).vaults.some((v) => v.id === vault.id));

  const invited = await must(`/api/vaults/${vault.id}/members`, {
    method: 'POST', headers: owner.auth, body: JSON.stringify({ username: guestName, role: 'editor' }),
  });
  check('owner invites a member by handle', invited.member.username === guestName && invited.member.role === 'editor');
  check('invite rejects an unknown handle', (await request(`/api/vaults/${vault.id}/members`, { method: 'POST', headers: owner.auth, body: JSON.stringify({ username: 'nobody_here', role: 'editor' }) })).status === 404);
  check('invite rejects the owner role', (await request(`/api/vaults/${vault.id}/members`, { method: 'POST', headers: owner.auth, body: JSON.stringify({ username: guestName, role: 'owner' }) })).status === 400);
  check('shared vault appears in the invitee vault list with their role', (await must('/api/vaults', { headers: guest.auth })).vaults.some((v) => v.id === vault.id && v.role === 'editor' && v.memberCount === 2));

  const guestMembers = await must(`/api/vaults/${vault.id}/members`, { headers: guest.auth });
  check('members can see the roster and their own role', guestMembers.members.length === 2 && guestMembers.role === 'editor');
  check('editors cannot invite other members', (await request(`/api/vaults/${vault.id}/members`, { method: 'POST', headers: guest.auth, body: JSON.stringify({ username: ownerName, role: 'viewer' }) })).status === 403);
  check('editors cannot demote the owner', (await request(`/api/vaults/${vault.id}/members/${owner.user.id}`, { method: 'PATCH', headers: guest.auth, body: JSON.stringify({ role: 'viewer' }) })).status === 403);

  const demoted = await must(`/api/vaults/${vault.id}/members/${guest.user.id}`, {
    method: 'PATCH', headers: owner.auth, body: JSON.stringify({ role: 'viewer' }),
  });
  check('owner changes a member role', demoted.member.role === 'viewer');
  check('viewers cannot write to the shared vault', (await request(`/api/vaults/${vault.id}/folders`, { method: 'POST', headers: guest.auth, body: JSON.stringify({ name: 'viewer folder' }) })).status >= 400);
  check('the vault owner cannot be removed', (await request(`/api/vaults/${vault.id}/members/${owner.user.id}`, { method: 'DELETE', headers: owner.auth })).status === 400);

  await must(`/api/vaults/${vault.id}/members/${guest.user.id}`, { method: 'DELETE', headers: guest.auth });
  check('a member can leave the vault themselves', !(await must('/api/vaults', { headers: guest.auth })).vaults.some((v) => v.id === vault.id));
  check('leaving revokes vault reads', (await request(`/api/vaults/${vault.id}/members`, { headers: guest.auth })).status === 404);

  const { token: agentToken } = await must('/api/auth/agent-token', { method: 'POST', headers: owner.auth });
  check('restricted agent token cannot mutate profile', (await request('/api/me/profile', { method: 'PUT', headers: { authorization: `Bearer ${agentToken}` }, body: JSON.stringify({ displayName: 'Nope', avatarUrl: '' }) })).status === 403);

  const browserLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'x-cascade-browser': '1' },
    body: JSON.stringify({ username: ownerName, password: 'changedpass12345' }),
  });
  const sessionCookie = browserLogin.headers.get('set-cookie')?.split(';', 1)[0] || '';
  check('browser login returns an HttpOnly cookie without a readable bearer',
    browserLogin.ok && !('token' in browserLogin.data) && /cascade_session=/.test(sessionCookie)
      && /HttpOnly/i.test(browserLogin.headers.get('set-cookie') || ''));
  check('cookie session authenticates reads', (await request('/api/me', {
    headers: { cookie: sessionCookie },
  })).data.user?.username === ownerName);
  check('a stale migration bearer falls back to the valid cookie', (await request('/api/me', {
    headers: { cookie: sessionCookie, authorization: 'Bearer stale.legacy.token' },
  })).data.user?.username === ownerName);
  check('cookie mutations reject requests without the browser CSRF header', (await request('/api/auth/agent-token', {
    method: 'POST', headers: { cookie: sessionCookie }, body: '{}',
  })).status === 403);
  check('cookie mutations accept the protected browser request', (await request('/api/auth/agent-token', {
    method: 'POST', headers: { cookie: sessionCookie, 'x-cascade-browser': '1' }, body: '{}',
  })).ok);
  const cookieSocket = io(`${base}/vault`, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { cookie: sessionCookie },
  });
  const socketConnected = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 3_000);
    cookieSocket.once('connect', () => { clearTimeout(timeout); resolve(true); });
    cookieSocket.once('connect_error', () => { clearTimeout(timeout); resolve(false); });
  });
  check('Socket.IO accepts the HttpOnly cookie session', socketConnected);
  cookieSocket.close();

  if (failures) throw new Error(`${failures} account checks failed`);
  console.log('[account-e2e] All account and multiplayer permission checks passed');
} finally {
  await server.stop();
}
