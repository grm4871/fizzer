import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'cascade-chat');

test('coordinator helper starts and delegates a mission with structured API calls', async (t) => {
  const requests: Array<{ method: string; path: string; runId: string; body: Record<string, unknown> | null }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({
      method: req.method || '',
      path: req.url || '',
      runId: String(req.headers['x-cascade-run-id'] || ''),
      body: raw ? JSON.parse(raw) : null,
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/vaults/vault-1/channels/channel-1/messages') {
      const body = raw ? JSON.parse(raw) : {};
      res.statusCode = 201;
      res.end(JSON.stringify({ message: { id: body.id || 'sys-mission-root', body: body.body || '' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/vaults/vault-1/channels/channel-1/missions?coordinator=reg-sol') {
      res.end(JSON.stringify({ missions: [{ id: 'mission-1', title: 'Release', status: 'attention', tasks: [{ id: 'task-1' }] }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/vaults/vault-1/channels/channel-1/missions/mission-1/history') {
      res.end(JSON.stringify({ events: [{ id: 1, kind: 'task_retried', title: 'Verify browser', fromStatus: 'failed', toStatus: 'pending', summary: '', attempt: 1, createdAt: '2026-08-08T12:00:00.000Z' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/vaults/vault-1/channels/channel-1/missions') {
      res.statusCode = 201;
      res.end(JSON.stringify({ mission: { id: 'mission-1', title: 'Release', status: 'active', tasks: [] } }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/mission-1/tasks') {
      res.statusCode = 201;
      res.end(JSON.stringify({
        mission: { id: 'mission-1', title: 'Release', status: 'active' },
        task: { id: 'task-1', title: 'Verify browser', assigneeMention: 'sol·sub' },
        scheduled: true,
      }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/mission-1?coordinator=reg-sol') {
      res.end(JSON.stringify({
        mission: { id: 'mission-1', title: 'Release', status: 'reviewing', tasks: [] },
      }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/tasks/task-1') {
      res.end(JSON.stringify({ mission: { id: 'mission-1', title: 'Release', status: 'blocked', tasks: [] } }));
      return;
    }
    if (req.url === '/api/vaults/vault-1/channels/channel-1/missions/mission-1/finish') {
      res.end(JSON.stringify({ mission: { id: 'mission-1', title: 'Release', status: 'completed', tasks: [] } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const common = [
    '--url', `http://127.0.0.1:${address.port}`,
    '--token', 'token',
    '--vault', 'vault-1',
    '--channel', 'channel-1',
  ];
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chat-test-'));
  const config = path.join(fixtureDir, 'helper.json');
  fs.writeFileSync(config, JSON.stringify({
    registrationId: 'reg-sol',
    chatTriggeringMessageId: 'root-message',
  }));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const withCoordinator = { ...process.env, CASCADE_HELPER_CONFIG: config, CASCADE_RUN_ID: '777' };

  const started = await execFileAsync(process.execPath, [
    cli, 'mission', 'start', '--title', 'Release', '--objective', 'Ship safely',
    ...common,
  ], { env: withCoordinator });
  assert.match(started.stdout, /mission mission-1 started/);
  const delegated = await execFileAsync(process.execPath, [
    cli, 'mission', 'delegate', '--mission', 'mission-1', '--to', '@sol', '--anonymous',
    '--task', 'Verify browser', '--message', 'Exercise reload and reconnect.',
    '--after', 'task-a,task-b', '--priority', '7', '--effort', 'high', ...common,
  ], { env: withCoordinator });
  assert.match(delegated.stdout, /dispatched task-1 to @sol·sub/);
  const status = await execFileAsync(process.execPath, [
    cli, 'mission', 'status', '--mission', 'mission-1', ...common,
  ], { env: withCoordinator });
  assert.match(status.stdout, /reviewing\s+mission-1/);
  const listed = await execFileAsync(process.execPath, [
    cli, 'mission', 'list', ...common,
  ], { env: withCoordinator });
  assert.match(listed.stdout, /attention\s+mission-1/);
  const history = await execFileAsync(process.execPath, [
    cli, 'mission', 'history', '--mission', 'mission-1', ...common,
  ], { env: withCoordinator });
  assert.match(history.stdout, /failed → pending · attempt 2/);
  await execFileAsync(process.execPath, [
    cli, 'mission', 'update', '--task', 'task-1', '--status', 'blocked',
    '--summary', 'Needs a credential', ...common,
  ], { env: withCoordinator });
  await execFileAsync(process.execPath, [
    cli, 'mission', 'retry', '--task', 'task-1', '--summary', 'Try again', ...common,
  ], { env: withCoordinator });
  await execFileAsync(process.execPath, [
    cli, 'mission', 'finish', '--mission', 'mission-1', '--summary', 'Integrated', ...common,
  ], { env: withCoordinator });
  assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), [
    'POST /api/vaults/vault-1/channels/channel-1/messages',
    'POST /api/vaults/vault-1/channels/channel-1/missions',
    'POST /api/vaults/vault-1/channels/channel-1/missions/mission-1/tasks',
    'GET /api/vaults/vault-1/channels/channel-1/missions/mission-1?coordinator=reg-sol',
    'GET /api/vaults/vault-1/channels/channel-1/missions?coordinator=reg-sol',
    'GET /api/vaults/vault-1/channels/channel-1/missions/mission-1/history',
    'PATCH /api/vaults/vault-1/channels/channel-1/missions/tasks/task-1',
    'PATCH /api/vaults/vault-1/channels/channel-1/missions/tasks/task-1',
    'POST /api/vaults/vault-1/channels/channel-1/missions/mission-1/finish',
  ]);
  assert.ok(requests.every((request) => request.runId === '777'));
  assert.equal(requests[0]?.body?.registrationId, 'reg-sol');
  assert.equal(requests[1]?.body?.rootMessageId, requests[0]?.body?.id);
  assert.deepEqual(requests[1]?.body, {
    rootMessageId: requests[0]?.body?.id,
    coordinatorRegistrationId: 'reg-sol',
    title: 'Release',
    objective: 'Ship safely',
    controlPlane: false,
  });
  assert.deepEqual(requests[2]?.body, {
    coordinatorRegistrationId: 'reg-sol',
    title: 'Verify browser',
    assignee: '@sol',
    prompt: 'Exercise reload and reconnect.',
    dependsOn: ['task-a', 'task-b'],
    priority: 7,
    reasoningEffort: 'high',
    anonymous: true,
    workspaceMode: 'shared',
  });
  assert.deepEqual(requests[6]?.body, { status: 'blocked', summary: 'Needs a credential' });
  assert.deepEqual(requests[7]?.body, { status: 'pending', summary: 'Try again' });
  assert.deepEqual(requests[8]?.body, {
    coordinatorRegistrationId: 'reg-sol',
    status: 'completed',
    summary: 'Integrated',
  });
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).usedChatSend, undefined);
});

test('mission start always posts a coordinator shell as the mission root', async (t) => {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> | null; runId?: string }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method || '', path: req.url || '', body: raw ? JSON.parse(raw) : null, runId:req.headers['x-cascade-run-id'] as string | undefined });
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/messages')) return res.end(JSON.stringify({ message: { id: 'sys-mission-root-new' } }));
    if (req.url?.endsWith('/missions')) return res.end(JSON.stringify({ mission: { id: 'second', title: 'Second task' } }));
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert(address && typeof address === 'object');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chat-multi-mission-'));
  const config = path.join(dir, 'helper.json');
  fs.writeFileSync(config, JSON.stringify({ registrationId: 'reg-sol', chatTriggeringMessageId: 'root-message', displayName: 'Sol' }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await execFileAsync(process.execPath, [cli, 'mission', 'start', '--title', 'Second task', '--objective', 'Do it too', '--url', `http://127.0.0.1:${address.port}`, '--token', 'token', '--vault', 'vault-1', '--channel', 'channel-1'], { env: { ...process.env, CASCADE_HELPER_CONFIG: config } });
  assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), [
    'POST /api/vaults/vault-1/channels/channel-1/messages',
    'POST /api/vaults/vault-1/channels/channel-1/missions',
  ]);
  assert.equal(requests[0].body?.registrationId, 'reg-sol');
  assert.equal(requests[0].body?.author, 'Sol');
  assert.equal(requests[1].body?.rootMessageId, 'sys-mission-root-new');
});

test('control-plane mission start explicitly asks the server not to bind a primary task', async (t) => {
  const runHeaders: Array<string | undefined> = [];
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    runHeaders.push(req.headers['x-cascade-run-id'] as string | undefined);
    bodies.push(raw ? JSON.parse(raw) : {});
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/messages')) return res.end(JSON.stringify({ message:{ id:'control-root' } }));
    if (req.url?.endsWith('/missions')) return res.end(JSON.stringify({ mission:{ id:'control-mission', title:'Control' } }));
    res.statusCode = 404; res.end(JSON.stringify({ error:'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert(address && typeof address === 'object');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chat-control-plane-'));
  const config = path.join(dir, 'helper.json');
  fs.writeFileSync(config, JSON.stringify({ registrationId:'reg-sol', displayName:'Sol' }));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  await execFileAsync(process.execPath, [cli, 'mission', 'start', '--control-plane', '--title', 'Control', '--url', `http://127.0.0.1:${address.port}`, '--token', 'token', '--vault', 'vault-1', '--channel', 'channel-1'], {
    env:{ ...process.env, CASCADE_HELPER_CONFIG:config, CASCADE_RUN_ID:'4242' },
  });
  assert.equal(runHeaders[0], '4242');
  assert.equal(runHeaders[1], '4242');
  assert.equal(bodies[1]?.controlPlane, true);
});

test('send creates a typed single-agent handoff without suppressing the caller reply', async (t) => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url || '', body: raw ? JSON.parse(raw) : {} });
    res.setHeader('content-type', 'application/json');
    res.statusCode = 201;
    res.end(JSON.stringify({ message: { id: 'collab-1' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chat-handoff-'));
  const config = path.join(dir, 'helper.json');
  fs.writeFileSync(config, JSON.stringify({ registrationId: 'reg-sol', agentId: 'codex' }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = await execFileAsync(process.execPath, [
    cli, 'send', '--to', '@terra', '--reply-to', 'source/message', '--relation', 'review_request',
    '--message', 'Check this result.', '--url', `http://127.0.0.1:${address.port}`,
    '--token', 'token', '--vault', 'vault-1', '--channel', 'channel-1',
  ], { env: { ...process.env, CASCADE_HELPER_CONFIG: config, CASCADE_RUN_ID: '88' } });

  assert.match(result.stdout, /asked @terra via review_request \(collab-1\)/);
  assert.equal(requests[0]?.path, '/api/vaults/vault-1/channels/channel-1/messages/source%2Fmessage/collaborate');
  assert.deepEqual(requests[0]?.body, {
    target: '@terra',
    relationship: 'review_request',
    instruction: 'Check this result.',
    requestId: requests[0]?.body.requestId,
    registrationId: 'reg-sol',
  });
  assert.match(String(requests[0]?.body.requestId), /^collab-codex-/);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).usedChatSend, undefined);
});
