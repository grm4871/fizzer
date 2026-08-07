#!/usr/bin/env node
/**
 * Vault share links, end to end.
 *
 * Inviting by username only works if you know it and the person already has an
 * account. A share link covers the other case: sign up, open the link, land
 * inside the vault at the role the owner picked — and bring your own agents.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const port = await pickPort();
const base = `http://127.0.0.1:${port}`;
const dbPath = `/tmp/cascade-vault-invite-${port}.db`;
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
  const r = await request(path, options);
  if (!r.ok) throw new Error(`${r.status} ${path}: ${r.data.error || 'request failed'}`);
  return r.data;
}
function check(label, condition) {
  console.log(`[vault-invite] ${condition ? 'OK ' : 'FAIL'} ${label}`);
  if (!condition) failures += 1;
}
async function register(username) {
  const data = await must('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  return { ...data, auth: { authorization: `Bearer ${data.token}` } };
}

try { fs.unlinkSync(dbPath); } catch {}
const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env, API_PORT: String(port), API_HOST: '127.0.0.1',
    DOCS_DB_PATH: dbPath, JWT_SECRET: 'vault-invite-secret', CASCADE_ALLOW_OPEN_REGISTRATION: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));

try {
  for (let i = 0; i < 200; i += 1) {
    try { if ((await request('/api/health')).ok) break; } catch {}
    await delay(100);
  }

  const owner = await register(`owner_${Date.now()}`);
  const { vault } = await must('/api/vaults', {
    method: 'POST', headers: owner.auth, body: JSON.stringify({ name: 'Shared' }),
  });

  // Owner mints an editor link.
  const link = await must(`/api/vaults/${vault.id}/invite-link`, {
    method: 'POST', headers: owner.auth, body: JSON.stringify({ role: 'editor' }),
  });
  check('invite link is issued with a url', typeof link.url === 'string' && link.url.includes('/vault-invite/'));

  // Anyone can preview it before signing up.
  const preview = await must(`/api/vault-invites/${encodeURIComponent(link.token)}`);
  check('preview names the vault and role', preview.invite.vaultName === 'Shared' && preview.invite.role === 'editor');

  // A brand-new account redeems it.
  const guest = await register(`guest_${Date.now()}`);
  const before = await must('/api/vaults', { headers: guest.auth });
  check('guest cannot see the vault beforehand', !before.vaults.some((v) => v.id === vault.id));

  const accepted = await must(`/api/vault-invites/${encodeURIComponent(link.token)}/accept`, {
    method: 'POST', headers: guest.auth,
  });
  check('accept reports the granted role', accepted.role === 'editor' && accepted.vaultId === vault.id);

  const after = await must('/api/vaults', { headers: guest.auth });
  check('vault now appears for the guest', after.vaults.some((v) => v.id === vault.id));

  // Redeeming twice must not demote or duplicate.
  const again = await must(`/api/vault-invites/${encodeURIComponent(link.token)}/accept`, {
    method: 'POST', headers: guest.auth,
  });
  check('second redemption is a no-op', again.alreadyMember === true);
  const members = await must(`/api/vaults/${vault.id}/members`, { headers: owner.auth });
  check('exactly two members', members.members.length === 2);

  // An editor can write; that is the point of the role.
  const note = await must(`/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: guest.auth, body: JSON.stringify({ title: 'Guest note', content: 'hello' }),
  });
  check('editor can create a note in the shared vault', Boolean(note.note?.id));

  // Agents follow the person, so the guest's own roster shows up here.
  await must(`/api/vaults/${vault.id}/vault-agents`, {
    method: 'PUT', headers: guest.auth,
    body: JSON.stringify({ agentId: 'claude-code', displayName: 'Guest Claude', mention: 'guestclaude' }),
  });
  const ownerVaults = await must('/api/vaults', { headers: owner.auth });
  const ownerOwn = ownerVaults.vaults.find((v) => v.id !== vault.id) || { id: vault.id };
  const guestElsewhere = await must(`/api/vaults/${vault.id}/vault-agents`, { headers: guest.auth });
  check('guest sees their own agent in the shared vault',
    guestElsewhere.agents.some((a) => a.mention === 'guestclaude'));
  void ownerOwn;

  // A viewer link must not grant writes.
  const viewerLink = await must(`/api/vaults/${vault.id}/invite-link`, {
    method: 'POST', headers: owner.auth, body: JSON.stringify({ role: 'viewer' }),
  });
  const viewer = await register(`viewer_${Date.now()}`);
  await must(`/api/vault-invites/${encodeURIComponent(viewerLink.token)}/accept`, {
    method: 'POST', headers: viewer.auth,
  });
  const denied = await request(`/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: viewer.auth, body: JSON.stringify({ title: 'nope', content: 'x' }),
  });
  check('viewer cannot write', denied.status === 403);

  // Non-owners cannot mint links.
  const notOwner = await request(`/api/vaults/${vault.id}/invite-link`, {
    method: 'POST', headers: guest.auth, body: JSON.stringify({ role: 'editor' }),
  });
  check('editor cannot mint invite links', notOwner.status === 403);

  // A tampered token is rejected.
  const bad = await request(`/api/vault-invites/${encodeURIComponent(link.token.slice(0, -3))}xyz/accept`, {
    method: 'POST', headers: guest.auth,
  });
  check('tampered token rejected', !bad.ok);
} catch (error) {
  console.error('[vault-invite] ERROR', error);
  failures += 1;
} finally {
  server.kill('SIGTERM');
  await delay(200);
  try { fs.unlinkSync(dbPath); } catch {}
}

console.log(failures === 0 ? '[vault-invite] all checks passed' : `[vault-invite] ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
