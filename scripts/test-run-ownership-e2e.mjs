#!/usr/bin/env node

/** Owner-only run/session privacy contract, exercised against either backend. */
import Database from 'better-sqlite3';

import { launchTestBackend } from './lib/test-backend.mjs';
import { pickPort } from './lib/test-ports.mjs';

const port = await pickPort();
const server = await launchTestBackend({
  name: 'run-ownership-e2e',
  port,
  env: {
    JWT_SECRET: 'run-ownership-secret',
    CASCADE_ALLOW_OPEN_REGISTRATION: '1',
  },
});

let failures = 0;

async function request(path, options = {}) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return {
    status: response.status,
    data: await response.json().catch(() => ({})),
  };
}

async function must(path, options = {}) {
  const response = await request(path, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${response.status} ${path}: ${response.data.error || 'request failed'}`);
  }
  return response.data;
}

function check(label, condition) {
  console.log(`[run-ownership] ${condition ? 'OK ' : 'FAIL'} ${label}`);
  if (!condition) failures += 1;
}

try {
  const stamp = Date.now();
  const alice = await must('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: `run_alice_${stamp}`, password: 'testpass12345' }),
  });
  const bob = await must('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: `run_bob_${stamp}`, password: 'testpass12345' }),
  });
  const aliceAuth = { authorization: `Bearer ${alice.token}` };
  const bobAuth = { authorization: `Bearer ${bob.token}` };

  const { vault: work } = await must('/api/vaults', {
    method: 'POST', headers: aliceAuth, body: JSON.stringify({ name: 'Work' }),
  });
  const { vault: home } = await must('/api/vaults', {
    method: 'POST', headers: aliceAuth, body: JSON.stringify({ name: 'Home' }),
  });

  const db = new Database(server.databasePath);
  db.pragma('busy_timeout = 5000');
  try {
    db.prepare(`
      INSERT INTO vault_members (vault_id,user_id,role,invited_by)
      VALUES (?,?,?,?)
    `).run(work.id, bob.user.id, 'editor', alice.user.id);

    const insertRun = db.prepare(`
      INSERT INTO runs
        (vault_id,owner_user_id,prompt,agent,conversation_id,status,started_at)
      VALUES (?,?,?,'codex',?,'running',?)
    `);
    const aliceWork = Number(insertRun.run(
      work.id, alice.user.id, 'alice work', 'alice-work', '2026-08-12 01:00:00',
    ).lastInsertRowid);
    const aliceHome = Number(insertRun.run(
      home.id, alice.user.id, 'alice home', 'alice-home', '2026-08-12 02:00:00',
    ).lastInsertRowid);
    const bobShared = Number(insertRun.run(
      work.id, bob.user.id, 'bob private trace', 'bob-shared', '2026-08-12 03:00:00',
    ).lastInsertRowid);
    db.prepare(`
      INSERT INTO run_events (run_id,seq,type,payload_json)
      VALUES (?,1,'harness','{"data":"private"}')
    `).run(bobShared);

    const aliceSessions = await must('/api/me/active-sessions', { headers: aliceAuth });
    check(
      'owner sees their active runs across both vaults',
      JSON.stringify(aliceSessions.sessions.map((run) => run.id))
        === JSON.stringify([aliceHome, aliceWork]),
    );
    check(
      'cross-vault sessions include their vault labels',
      JSON.stringify(aliceSessions.sessions.map((run) => run.vault_name))
        === JSON.stringify(['Home', 'Work']),
    );

    const bobSessions = await must('/api/me/active-sessions', { headers: bobAuth });
    check('other user sees only their own run', bobSessions.sessions.length === 1
      && bobSessions.sessions[0].id === bobShared);

    const scoped = await must(`/api/vaults/${work.id}/active-sessions`, { headers: aliceAuth });
    check('shared-vault session list excludes another member run', scoped.sessions.length === 1
      && scoped.sessions[0].id === aliceWork);

    const history = await must(`/api/vaults/${work.id}/runs`, { headers: aliceAuth });
    check('shared-vault run history excludes another member run', history.runs.length === 1
      && history.runs[0].id === aliceWork);

    check('foreign run detail is hidden', (await request(`/api/runs/${bobShared}`, {
      headers: aliceAuth,
    })).status === 404);
    check('foreign raw trace is hidden', (await request(`/api/runs/${bobShared}/events`, {
      headers: aliceAuth,
    })).status === 404);
    check('foreign run cannot be canceled', (await request(`/api/runs/${bobShared}/cancel`, {
      method: 'POST', headers: aliceAuth, body: '{}',
    })).status === 404);
    check('owner can still read their trace', (await request(`/api/runs/${bobShared}/events`, {
      headers: bobAuth,
    })).status === 200);
    check('denied cancel left the other user run active', db.prepare(
      'SELECT status FROM runs WHERE id=?',
    ).get(bobShared)?.status === 'running');
  } finally {
    db.close();
  }
} catch (error) {
  console.error('[run-ownership] ERROR', error);
  failures += 1;
} finally {
  await server.stop();
}

console.log(failures === 0
  ? '[run-ownership] all checks passed'
  : `[run-ownership] ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
