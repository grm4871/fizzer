import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-codex-app-server-'));
const fakeBin = path.join(scratch, 'codex');
const launchLog = path.join(scratch, 'launches');

fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
fs.appendFileSync(${JSON.stringify(launchLog)}, '1\\n');
let thread = 0;
let turn = 0;
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'thread-' + (++thread) } } });
  if (message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === 'turn/start') {
    const id = 'turn-' + (++turn);
    send({ id: message.id, result: { turn: { id } } });
    setImmediate(() => {
      send({ method: 'item/completed', params: { turnId: id, item: { id: 'answer-' + id, type: 'agentMessage', text: 'answer ' + turn } } });
      send({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
    });
  }
});
`);
fs.chmodSync(fakeBin, 0o755);
process.env.CODEX_BIN = fakeBin;
process.env.RUNNER_CODEX_PERSISTENT = '1';

const { runCliAgent, shutdownPersistentCliAgents } = await import('./cli-agent.js');

test('Codex app-server is reused across sequential turns', async () => {
  const sessions: string[] = [];
  const first = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'first', cwd: scratch,
    emit(type, payload: any) { if (type === 'session') sessions.push(payload.sessionId); },
  });
  const second = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'second', cwd: scratch,
    resumeSessionId: first.sessionId, emit() {},
  });

  assert.equal(first.summary, 'answer 1');
  assert.equal(second.summary, 'answer 2');
  assert.deepEqual(sessions, ['thread-1']);
  assert.equal(fs.readFileSync(launchLog, 'utf8').trim().split('\n').length, 1);
  shutdownPersistentCliAgents();
});

test.after(() => {
  shutdownPersistentCliAgents();
  fs.rmSync(scratch, { recursive: true, force: true });
});
