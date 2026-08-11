#!/usr/bin/env node
/**
 * Release-parity transcript: run the same Node-initialized fixture and flows
 * directly against Node and backend_elixir, then fail closed on any drift.
 *
 * Intentional normalization is documented in NORMALIZATION_RULES. No backend
 * is proxied and no assertion is downgraded when the Elixir side differs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { io } from 'socket.io-client';

import {
  clusterBackendDifferences,
  compareBackendResults,
  databaseInvariantSnapshot,
  normalizeHeaders,
  NORMALIZATION_RULES,
  vaultFileTreeSnapshot,
} from './lib/backend-differential.mjs';
import { launchTestBackend } from './lib/test-backend.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_ARTIFACTS = process.env.CASCADE_KEEP_TEST_ARTIFACTS === '1';
const REPORT_PATH = path.resolve(
  repoRoot,
  process.env.CASCADE_DIFFERENTIAL_REPORT || 'scripts/artifacts/backend-differential-latest.json',
);

function writeComparisonReport(comparison) {
  const clusters = clusterBackendDifferences(comparison.diffs, comparison.node.transcript);
  const report = {
    schemaVersion: 1,
    pass: comparison.ok,
    normalizationRules: NORMALIZATION_RULES,
    normalizationReview: {
      fixedBeforeCapture: [
        'URL-encoded loopback origins and public slugs now use the existing opaque origin/token markers.',
      ],
      remainingKnownNormalizationDefects: [],
      note: 'Every reported item remains fail-closed as a contract gap; clustering never removes a diff.',
    },
    summary: {
      httpSteps: comparison.node.transcript.map(({ label }) => label),
      differenceCount: comparison.diffs.length,
      clusters: Object.fromEntries(clusters.map(({ id, count }) => [id, count])),
    },
    clusters,
    diffs: comparison.diffs,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  return REPORT_PATH;
}

function diagnosticExcerpt(output) {
  const text = String(output || '').trim();
  const marker = Math.max(text.lastIndexOf('[error]'), text.lastIndexOf('** ('));
  return (marker >= 0 ? text.slice(marker) : text.slice(-2_000)).slice(-3_000);
}

async function eventually(label, probe, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) { last = error; }
    await delay(50);
  }
  throw new Error(`${label} timed out${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function connectSocket(baseUrl, namespace, token, onAny) {
  const socket = io(`${baseUrl}${namespace}`, {
    auth: { token }, transports: ['websocket'], reconnection: false,
  });
  if (onAny) socket.onAny(onAny);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${namespace} socket connect timed out`)), 10_000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function executeTranscript(backend) {
  const transcript = [];
  const vaultSocketEvents = [];
  const runnerSocketEvents = [];
  const base = backend.baseUrl;

  async function request(label, route, options = {}) {
    const response = await fetch(`${base}${route}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    transcript.push({ label, status: response.status, headers: normalizeHeaders(response.headers), body });
    if (!response.ok) {
      throw new Error(`${label}: ${response.status} ${route}: ${typeof body === 'object' ? body?.error || JSON.stringify(body) : body}`);
    }
    return { body, response };
  }

  let vaultSocket;
  let runnerSocket;
  try {
    await request('health', '/api/health');
    const registration = await request('auth.register', '/api/auth/register', {
      method: 'POST', body: JSON.stringify({ username: 'differential_owner', password: 'testpass12345' }),
    });
    const token = registration.body.token;
    if (!token) throw new Error('auth.register: response did not include a bearer token');
    const auth = { authorization: `Bearer ${token}` };

    await request('auth.browser-login', '/api/auth/login', {
      method: 'POST', headers: { 'x-cascade-browser': '1' },
      body: JSON.stringify({ username: 'differential_owner', password: 'testpass12345' }),
    });
    await request('account.me', '/api/me', { headers: auth });
    await request('account.profile', '/api/me/profile', {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ displayName: 'Differential Owner', avatarUrl: '' }),
    });

    const createdVault = await request('vault.create', '/api/vaults', {
      method: 'POST', headers: auth, body: JSON.stringify({ name: 'Differential Vault' }),
    });
    const vaultId = createdVault.body.vault?.id;
    if (!vaultId) throw new Error('vault.create: response did not include vault.id');
    await request('vault.list', '/api/vaults', { headers: auth });

    vaultSocket = await connectSocket(base, '/vault', token, (event, payload) => {
      if (event.startsWith('vault:')) vaultSocketEvents.push({ event, payload });
    });
    vaultSocket.emit('joinVault', vaultId);
    await delay(100);

    const folder = await request('content.folder-create', `/api/vaults/${vaultId}/folders`, {
      method: 'POST', headers: auth, body: JSON.stringify({ name: 'release' }),
    });
    const folderId = folder.body.folder?.id;
    const note = await request('content.note-create', `/api/vaults/${vaultId}/notes`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        title: 'Parity note',
        content: '# Parity\nUnique differential search phrase.',
        folder_id: folderId,
      }),
    });
    const noteId = note.body.note?.id;
    if (!noteId) throw new Error('content.note-create: response did not include note.id');
    await request('content.note-update', `/api/notes/${noteId}`, {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ content: '# Parity\nUnique differential search phrase.\n\nUpdated once.' }),
    });
    await request('content.note-get', `/api/notes/${noteId}`, { headers: auth });

    const channel = await request('chat.channel-create', `/api/vaults/${vaultId}/notes`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ title: 'release-chat', content: 'cascade://chat-channel' }),
    });
    const channelId = channel.body.note?.id;
    if (!channelId) throw new Error('chat.channel-create: response did not include note.id');
    await request('chat.message-create', `/api/vaults/${vaultId}/channels/${channelId}/messages`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        id: 'differential-message-1', channelId, author: 'spoofed',
        body: 'Release parity socket transcript.', createdAt: '2026-01-02T03:04:05.000Z',
      }),
    });
    await request('chat.message-list', `/api/vaults/${vaultId}/channels/${channelId}/messages?detail=full`, { headers: auth });

    const published = await request('publish.create', `/api/notes/${noteId}/publish`, {
      method: 'POST', headers: auth, body: JSON.stringify({}),
    });
    const slug = published.body.slug;
    if (!slug) throw new Error('publish.create: response did not include slug');
    await request('publish.get', `/api/notes/${noteId}/publish`, { headers: auth });
    await request('publish.public-page', `/p/${encodeURIComponent(slug)}`);
    await request('search.lexical', `/api/vaults/${vaultId}/search?q=${encodeURIComponent('Unique differential search phrase')}&scope=notes&limit=10`, { headers: auth });

    runnerSocket = await connectSocket(base, '/runners', token);
    runnerSocket.onAny((event, payload) => {
      if (event === 'runner:registered' || event === 'run:delegate') runnerSocketEvents.push({ event, payload });
    });
    runnerSocket.on('run:delegate', (payload) => {
      runnerSocket.emit('runner:runEvent', {
        runId: payload.runId, type: 'status', payload: { status: 'running' },
      });
      runnerSocket.emit('runner:runEvent', {
        runId: payload.runId, type: 'text',
        payload: { message: { content: [{ type: 'text', text: 'Differential runner output' }] } },
      });
      runnerSocket.emit('runner:runEvent', {
        runId: payload.runId, type: 'status',
        payload: { status: 'completed', summary: 'Differential complete.', sessionId: 'differential-session' },
      });
    });
    runnerSocket.emit('runner:register', { runnerInstanceId: 'differential-runner', activeRunIds: [] });
    await eventually('runner registration', () => runnerSocketEvents.some((event) => event.event === 'runner:registered'));
    await request('run.runner-status', '/api/me/desktop-runner', { headers: auth });
    const createdRun = await request('run.create', `/api/vaults/${vaultId}/runs`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ prompt: 'Exercise release parity', agent: 'codex', note_id: noteId }),
    });
    const runId = createdRun.body.run?.id;
    if (!runId) throw new Error('run.create: response did not include run.id');
    await eventually('delegated run completion', async () => {
      const response = await fetch(`${base}/api/runs/${runId}`, { headers: auth });
      const body = await response.json();
      return body.run?.status === 'completed';
    });
    await request('run.get-completed', `/api/runs/${runId}`, { headers: auth });
    await request('run.events', `/api/runs/${runId}/events`, { headers: auth });

    await delay(300);
    return { transcript, socketEvents: { vault: vaultSocketEvents, runners: runnerSocketEvents } };
  } finally {
    vaultSocket?.close();
    runnerSocket?.close();
  }
}

async function initializeNodeFixture() {
  const fixture = await launchTestBackend({
    backend: 'node', name: 'differential-fixture', repoRoot, pipeOutput: false,
    env: {
      JWT_SECRET: 'differential-release-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
      CASCADE_QMD_SEMANTIC: 'false',
    },
  });
  await fixture.stop({ cleanup: false });
  return fixture;
}

async function runBackend(kind, fixture) {
  console.log(`[differential] running ${kind} transcript`);
  const runRoot = path.join(fixture.tempRoot, 'active-run');
  fs.rmSync(runRoot, { recursive: true, force: true });
  const backend = await launchTestBackend({
    backend: kind, name: 'differential-release', repoRoot,
    tempRoot: runRoot,
    fixtureDatabasePath: fixture.databasePath,
    fixtureVaultsRoot: fixture.vaultsRoot,
    env: {
      JWT_SECRET: 'differential-release-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
      CASCADE_QMD_SEMANTIC: 'false',
    },
  });
  try {
    const result = await executeTranscript(backend);
    await backend.stop({ cleanup: false });
    return {
      ...result,
      database: databaseInvariantSnapshot(backend.databasePath),
      vaultFiles: vaultFileTreeSnapshot(backend.vaultsRoot),
    };
  } catch (error) {
    await backend.stop({ cleanup: false });
    const diagnostic = diagnosticExcerpt(
      backend.stdout.includes('[error]') || backend.stdout.includes('** (')
        ? backend.stdout
        : (backend.stderr || backend.stdout),
    );
    error.message = [
      `${kind} transcript failed: ${error.message}`,
      diagnostic ? `${kind} process diagnostic:\n${diagnostic}` : '',
      KEEP_ARTIFACTS ? `artifacts: ${backend.tempRoot}` : '',
    ].filter(Boolean).join('\n');
    throw error;
  } finally {
    if (!KEEP_ARTIFACTS) fs.rmSync(runRoot, { recursive: true, force: true });
    else console.log(`[differential] kept ${kind} artifacts at ${backend.tempRoot}`);
  }
}

async function main() {
  console.log('[differential] normalization contract:');
  for (const rule of NORMALIZATION_RULES) console.log(`  - ${rule}`);
  const fixture = await initializeNodeFixture();
  try {
    const node = await runBackend('node', fixture);
    console.log(`[differential] Node baseline passed (${node.transcript.length} HTTP steps)`);
    const elixir = await runBackend('elixir', fixture);
    const comparison = compareBackendResults(node, elixir);
    const reportPath = writeComparisonReport(comparison);
    console.log(`[differential] wrote comparison artifact: ${reportPath}`);
    if (!comparison.ok) {
      console.error(`[differential] parity failed with ${comparison.diffs.length} reported difference(s):`);
      for (const diff of comparison.diffs) console.error(`  - ${diff}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[differential] PASS: ${node.transcript.length} HTTP steps, ${node.socketEvents.vault.length + node.socketEvents.runners.length} ordered socket events, database invariants, and vault file trees match.`);
  } finally {
    if (!KEEP_ARTIFACTS) fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    else console.log(`[differential] kept fixture at ${fixture.tempRoot}`);
  }
}

main().catch((error) => {
  console.error(`[differential] FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});
