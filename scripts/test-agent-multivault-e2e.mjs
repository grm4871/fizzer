#!/usr/bin/env node
/**
 * One agent, many vaults.
 *
 * An agent is a person's, not a vault's: the same identity should join channels
 * in every vault its owner works in, keeping one handle and one roster entry
 * instead of a separate copy (and a separate @handle) per vault.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const port = await pickPort();
const base = `http://127.0.0.1:${port}`;
const dbPath = `/tmp/cascade-multivault-${port}.db`;
const root = new URL('..', import.meta.url).pathname;
const CHAT_MARKER = 'cascade://chat-channel';
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
  console.log(`[multivault] ${condition ? 'OK ' : 'FAIL'} ${label}`);
  if (!condition) failures += 1;
}

try { fs.unlinkSync(dbPath); } catch {}
const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env, API_PORT: String(port), API_HOST: '127.0.0.1',
    DOCS_DB_PATH: dbPath, JWT_SECRET: 'multivault-secret', CASCADE_ALLOW_OPEN_REGISTRATION: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));

try {
  for (let i = 0; i < 200; i += 1) {
    try { if ((await request('/api/health')).ok) break; } catch {}
    await delay(100);
  }

  const me = await must('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username: `multi_${Date.now()}`, password: 'testpass12345' }),
  });
  const auth = { authorization: `Bearer ${me.token}` };

  const { vault: work } = await must('/api/vaults', {
    method: 'POST', headers: auth, body: JSON.stringify({ name: 'Work' }),
  });
  const { vault: home } = await must('/api/vaults', {
    method: 'POST', headers: auth, body: JSON.stringify({ name: 'Home' }),
  });

  // One agent, created once, in the Work vault.
  const { agent } = await must(`/api/vaults/${work.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agentId: 'claude-code', displayName: 'Claude', mention: 'claude' }),
  });
  check('agent created once', agent.mention === 'claude');

  // It shows up in the other vault's roster without being recreated.
  const homeRoster = await must(`/api/vaults/${home.id}/vault-agents`, { headers: auth });
  const inHome = homeRoster.agents.filter((a) => a.mention === 'claude');
  check('same agent listed in the second vault', inHome.length === 1 && inHome[0].id === agent.id);

  // Add it to a channel in each vault.
  const channels = {};
  for (const [name, vault] of [['work', work], ['home', home]]) {
    const { note } = await must(`/api/vaults/${vault.id}/notes`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ title: `${name}-chan`, content: CHAT_MARKER }),
    });
    channels[name] = note.id;
    const added = await request(`/api/vaults/${vault.id}/channels/${note.id}/agents/from-vault`, {
      method: 'POST', headers: auth, body: JSON.stringify({ vaultAgentId: agent.id }),
    });
    check(`added to a channel in the ${name} vault`, added.ok);
  }

  // Still exactly one agent row, now with memberships in both vaults.
  const finalRoster = await must(`/api/vaults/${work.id}/vault-agents`, { headers: auth });
  const claudes = finalRoster.agents.filter((a) => a.mention === 'claude');
  check('still a single @claude, not one per vault', claudes.length === 1);
  check('one agent, two channels', (claudes[0]?.channelIds || []).length === 2);

  // Editing it once updates it everywhere.
  await must(`/api/vaults/${home.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ id: agent.id, agentId: 'claude-code', displayName: 'Renamed', mention: 'claude' }),
  });
  const afterEdit = await must(`/api/vaults/${work.id}/vault-agents`, { headers: auth });
  const renamed = afterEdit.agents.find((a) => a.id === agent.id);
  check('an edit from either vault applies to the one agent', renamed?.displayName === 'Renamed');

  // A different agent may not squat the handle inside a vault it is joining.
  const { agent: other } = await must(`/api/vaults/${home.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agentId: 'codex', displayName: 'Codex', mention: 'codex' }),
  });
  check('a second distinct agent still creates fine', other.mention === 'codex');
} catch (error) {
  console.error('[multivault] ERROR', error);
  failures += 1;
} finally {
  server.kill('SIGTERM');
  await delay(200);
  try { fs.unlinkSync(dbPath); } catch {}
}

console.log(failures === 0 ? '[multivault] all checks passed' : `[multivault] ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
