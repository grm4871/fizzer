#!/usr/bin/env node
/**
 * End-to-end test for the agent scratchpad (journal + agent-driven consolidation).
 *
 * Simulates the harness loop with a fake desktop runner:
 *   1. run boot → delegated prompt carries the scratchpad injection (jot docs,
 *      POLICIES, journal state) and the POLICIES note is minted;
 *   2. journal below threshold → no consolidation nudge in the prompt;
 *   3. journal past threshold → next run's prompt carries the "consolidation is
 *      due" nudge (consolidation is agent-driven; the server never spawns runs);
 *   4. the server spawns no runs of its own — only client-requested runs are
 *      ever delegated;
 *   5. consolidating via the API (as the agent's `cascade-scratchpad done`
 *      would) zeroes the journal and clears the nudge on the next boot.
 *
 * Requires a built server (npm run build); pass --build to build first.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const API_PORT = Number(process.env.TEST_API_PORT || 3098);
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const DB_PATH = `/tmp/cascade-scratchpad-e2e-${API_PORT}.db`;
// Non-chat runs fall back to the agent id as memory key, so journal entries
// must use the same key for the boot-injection counts to line up.
const AGENT_KEY = 'grok';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${url}`);
  return data;
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = await fetchJson(`${API_BASE}/api/health`);
      if (data.status === 'ok') return;
    } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('Server did not become healthy in time');
}

async function waitFor(predicate, label, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  if (process.argv.includes('--build')) {
    console.log('[e2e] Building server...');
    const build = spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
    await new Promise((resolve, reject) => {
      build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))));
    });
  }
  if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
    throw new Error('dist/index.js missing — run with --build or npm run build first');
  }

  try { fs.unlinkSync(DB_PATH); } catch { /* fresh anyway */ }
  console.log('[e2e] Starting server on', API_BASE);
  const server = spawn('node', ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      API_HOST: '127.0.0.1',
      DOCS_DB_PATH: DB_PATH,
      JWT_SECRET: 'e2e-test-secret',
      // Low threshold so the due-nudge fires within the test window.
      SCRATCHPAD_DUE_ENTRIES: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[server-err] ${chunk}`));

  const runnerSockets = [];
  try {
    await waitForHealth();

    const username = `scratchpad_e2e_${Date.now()}`;
    const { token } = await fetchJson(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ username, password: 'testpass12345' }),
    });
    const auth = { Authorization: `Bearer ${token}` };

    const { vault } = await fetchJson(`${API_BASE}/api/vaults`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Scratchpad E2E' }),
    });

    // Fake desktop runner: auto-complete every delegated run, record payloads.
    const delegations = [];
    const runnerSocket = io(`${API_BASE}/runners`, { auth: { token }, transports: ['websocket'] });
    runnerSockets.push(runnerSocket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Runner socket connect timeout')), 10000);
      runnerSocket.on('connect', () => {
        clearTimeout(timer);
        runnerSocket.emit('runner:register');
        resolve();
      });
      runnerSocket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    runnerSocket.on('run:delegate', (payload) => {
      delegations.push(payload);
      console.log(`[e2e] delegated run ${payload.runId} (agent=${payload.agent}, memoryKey=${payload.agentMemoryKey || '-'})`);
      runnerSocket.emit('runner:runEvent', { runId: payload.runId, type: 'status', payload: { status: 'running' } });
      runnerSocket.emit('runner:runEvent', {
        runId: payload.runId,
        type: 'status',
        payload: { status: 'completed', summary: 'Done.', sessionId: `sess-${payload.runId}` },
      });
    });
    console.log('[e2e] OK fake desktop runner connected');

    // ── 1. Boot injection on a normal run ────────────────────────────
    await fetchJson(`${API_BASE}/api/vaults/${vault.id}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ prompt: 'First run', agent: 'grok', note_id: null }),
    });
    const first = await waitFor(() => delegations[0], 'first delegation');
    if (!first.prompt.includes('cascade-scratchpad jot')) {
      throw new Error('Delegated prompt missing scratchpad jot instructions');
    }
    if (!first.prompt.includes('0 unconsolidated entries')) {
      throw new Error('Delegated prompt missing journal status line');
    }
    if (first.prompt.includes('Consolidation is due')) {
      throw new Error('Due nudge present with an empty journal');
    }
    console.log('[e2e] OK boot injection present, no premature due nudge');

    const { notes } = await fetchJson(`${API_BASE}/api/vaults/${vault.id}/notes`, { headers: auth });
    const policies = (notes || []).find((n) => n.title === 'POLICIES');
    if (!policies) throw new Error('POLICIES note was not created at run boot');
    console.log('[e2e] OK POLICIES note minted');

    // ── 2. Fill journal past threshold → due nudge on next boot ──────
    for (let i = 0; i < 6; i++) {
      await fetchJson(`${API_BASE}/api/vaults/${vault.id}/scratchpad/journal`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          body: i === 0 ? 'tried X, failed because Y' : `observed fact ${i}`,
          kind: i === 0 ? 'dead-end' : 'observation',
          agentKey: AGENT_KEY,
        }),
      });
    }
    await fetchJson(`${API_BASE}/api/vaults/${vault.id}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ prompt: 'Second run', agent: 'grok', note_id: null }),
    });
    const second = await waitFor(
      () => delegations.find((d) => d.prompt.includes('Second run')),
      'second delegation',
    );
    if (!second.prompt.includes('6 unconsolidated entries')) {
      throw new Error('Second run prompt missing updated journal count');
    }
    if (!second.prompt.includes('Consolidation is due')) {
      throw new Error('Second run prompt missing the consolidation-due nudge');
    }
    console.log('[e2e] OK due nudge surfaced in boot injection');

    // ── 3. Server must never spawn runs of its own ───────────────────
    await sleep(4000);
    if (delegations.length !== 2) {
      throw new Error(`Expected exactly 2 delegated runs (client-requested), saw ${delegations.length}`);
    }
    console.log('[e2e] OK server spawned no runs of its own');

    // ── 4. Agent-driven consolidation (as `cascade-scratchpad done` would) ──
    const { entries } = await fetchJson(
      `${API_BASE}/api/vaults/${vault.id}/scratchpad/journal?unconsolidated=1&agent=${AGENT_KEY}`,
      { headers: auth },
    );
    if (entries.length !== 6) throw new Error(`Expected 6 unconsolidated entries, got ${entries.length}`);
    const maxId = Math.max(...entries.map((e) => e.id));
    await fetchJson(`${API_BASE}/api/vaults/${vault.id}/scratchpad/consolidate`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ throughId: maxId, agentKey: AGENT_KEY }),
    });
    const { status } = await fetchJson(
      `${API_BASE}/api/vaults/${vault.id}/scratchpad/status?agent=${AGENT_KEY}`,
      { headers: auth },
    );
    if (status.unconsolidated !== 0) throw new Error(`Expected 0 unconsolidated after done, got ${status.unconsolidated}`);
    console.log('[e2e] OK consolidation zeroed the journal');

    // ── 5. Nudge clears on the next boot ─────────────────────────────
    await fetchJson(`${API_BASE}/api/vaults/${vault.id}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ prompt: 'Third run', agent: 'grok', note_id: null }),
    });
    const third = await waitFor(
      () => delegations.find((d) => d.prompt.includes('Third run')),
      'third delegation',
    );
    if (!third.prompt.includes('0 unconsolidated entries')) {
      throw new Error('Third run prompt missing reset journal count');
    }
    if (third.prompt.includes('Consolidation is due')) {
      throw new Error('Due nudge still present after consolidation');
    }
    console.log('[e2e] OK due nudge cleared after consolidation');

    console.log('[e2e] All scratchpad tests passed');
  } finally {
    for (const socket of runnerSockets) {
      try { socket.disconnect(); } catch { /* ignore */ }
    }
    server.kill('SIGTERM');
    await sleep(300);
  }
}

main().catch((error) => {
  console.error('[e2e] FAILED:', error);
  process.exit(1);
});
