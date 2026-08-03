/**
 * Codex resume behaviour, driven against a fake `codex` binary.
 *
 * The case that matters: the session id we hand to `codex exec resume` lives in
 * Codex's local rollout store, so it can be gone. When it is, the resume fails
 * and — without the fallback — takes the whole turn with it, for a reason that
 * has nothing to do with what was asked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-codex-'));
const fakeBin = path.join(scratch, 'fake-codex');
const fakeAkronBin = path.join(scratch, 'fake-akron');
const argLog = path.join(scratch, 'args.jsonl');
const akronChildPid = path.join(scratch, 'akron-child.pid');
const akronAttemptLog = path.join(scratch, 'akron-attempts.txt');
const agentProcessLeaseDir = path.join(scratch, 'agent-processes');

fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify(args) + '\\n');
if (process.env.FAKE_CODEX_BROKEN) {
  process.stderr.write('Error: disk on fire\\n');
  process.exit(1);
}
if (args.includes('resume') && !process.env.FAKE_CODEX_RESUME_OK) {
  // What codex does for a pruned session: the complaint on stderr, no stdout.
  // Real codex exits 1; FAKE_CODEX_QUIET_FAIL covers the zero-exit variant.
  process.stderr.write('Error: thread/resume: thread/resume failed: no rollout found for thread id gone (code -32600)\\n');
  process.exit(process.env.FAKE_CODEX_QUIET_FAIL ? 0 : 1);
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fresh-session-1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answered' } }) + '\\n');
process.exit(0);
`);
fs.chmodSync(fakeBin, 0o755);
fs.writeFileSync(fakeAkronBin, `#!/usr/bin/env node
const fs = require('fs');
const { spawn } = require('child_process');
if (process.env.FAKE_AKRON_RETRY) {
  let attempts = 0;
  try { attempts = Number(fs.readFileSync(${JSON.stringify(akronAttemptLog)}, 'utf8')) || 0; } catch {}
  attempts += 1;
  fs.writeFileSync(${JSON.stringify(akronAttemptLog)}, String(attempts));
  if (attempts > 1) {
    process.stdout.write('recovered answer\\n');
    process.exit(0);
  }
}
if (process.env.FAKE_AKRON_EVENTS) {
  if (process.env.HERMES_CASCADE_EVENTS !== '1') {
    process.stderr.write('cascade events disabled\\n');
    process.exit(13);
  }
  process.stderr.write(JSON.stringify({ type: 'reasoning.delta', text: 'mapping the harness' }) + '\\n');
  process.stdout.write('native answer\\n');
  process.exit(0);
}
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(akronChildPid)}, String(child.pid));
setInterval(() => {}, 1000);
`);
fs.chmodSync(fakeAkronBin, 0o755);
process.env.CODEX_BIN = fakeBin;
process.env.AKRON_BIN = fakeAkronBin;
process.env.RUNNER_CLI_HEARTBEAT_MS = '25';
process.env.RUNNER_AKRON_IDLE_TIMEOUT_MS = '1000';
process.env.CASCADE_AGENT_PROCESS_DIR = agentProcessLeaseDir;

const { cancelCliAgentRun, reapOrphanedCliAgentProcesses, runCliAgent } = await import('./cli-agent.js');

function readArgs(): string[][] {
  return fs.readFileSync(argLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function resetArgs() {
  fs.writeFileSync(argLog, '');
}

const emit = () => {};

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition did not become true');
}

test('Akron emits silent-work heartbeats and cancellation kills its process tree', async () => {
  fs.rmSync(akronChildPid, { force: true });
  const harness: string[] = [];
  const run = runCliAgent({
    agent: 'akron-grok', context: '', userPrompt: 'work silently', cwd: scratch, runId: 8080,
    emit: (type, payload: any) => {
      if (type === 'harness') harness.push(String(payload?.data || ''));
    },
  });
  await waitFor(() => fs.existsSync(akronChildPid));
  const descendantPid = Number(fs.readFileSync(akronChildPid, 'utf8'));
  await waitFor(() => harness.some((line) => line.includes('still working')));

  assert.equal(cancelCliAgentRun(8080), true);
  await assert.rejects(run, /exited with code/);
  await waitFor(() => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test('Akron provider silence times out and releases its process tree', async () => {
  fs.rmSync(akronChildPid, { force: true });
  const started = Date.now();
  const run = runCliAgent({
    agent: 'akron-grok', context: '', userPrompt: 'provider never answers', cwd: scratch, runId: 8081,
    emit,
  });
  await waitFor(() => fs.existsSync(akronChildPid));
  const descendantPid = Number(fs.readFileSync(akronChildPid, 'utf8'));
  await assert.rejects(run, /produced no output for 1000ms and was stopped/);
  assert.ok(Date.now() - started < 3_000);
  await waitFor(() => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test('Akron retries one byte-silent provider request with a fresh bridge', async () => {
  fs.rmSync(akronAttemptLog, { force: true });
  process.env.FAKE_AKRON_RETRY = '1';
  const harness: string[] = [];
  try {
    const result = await runCliAgent({
      agent: 'akron-grok', context: '', userPrompt: 'recover once', cwd: scratch, runId: 8082,
      emit: (type, payload: any) => {
        if (type === 'harness') harness.push(String(payload?.data || ''));
      },
    });
    assert.equal(result.summary, 'recovered answer');
  } finally {
    delete process.env.FAKE_AKRON_RETRY;
  }
  assert.equal(fs.readFileSync(akronAttemptLog, 'utf8'), '2');
  assert.match(harness.join(''), /retrying Akron once with a fresh bridge/);
});

test('a crashed desktop owner leaves a real Akron group that the next coordinator reaps', async () => {
  fs.rmSync(agentProcessLeaseDir, { recursive: true, force: true });
  fs.rmSync(akronChildPid, { force: true });
  const hostScript = `
    import fs from 'node:fs';
    import { runCliAgent } from ${JSON.stringify(new URL('./cli-agent.ts', import.meta.url).href)};
    void runCliAgent({ agent: 'akron-grok', context: '', userPrompt: 'orchestrate until crash', cwd: ${JSON.stringify(scratch)}, runId: 9090, emit() {} });
    const lease = ${JSON.stringify(path.join(agentProcessLeaseDir, '9090.json'))};
    const timer = setInterval(() => {
      if (fs.existsSync(lease)) {
        clearInterval(timer);
        process.exit(77);
      }
    }, 10);
  `;
  const crashedHost = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', hostScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AKRON_BIN: fakeAkronBin,
      CASCADE_AGENT_PROCESS_DIR: agentProcessLeaseDir,
      RUNNER_AKRON_IDLE_TIMEOUT_MS: '30000',
    },
    stdio: 'ignore',
  });
  const exitCode = await new Promise<number | null>((resolve) => crashedHost.once('exit', resolve));
  assert.equal(exitCode, 77, 'simulated Electron owner should crash abruptly');

  const lease = JSON.parse(fs.readFileSync(path.join(agentProcessLeaseDir, '9090.json'), 'utf8'));
  assert.doesNotThrow(() => process.kill(lease.processGroupId, 0), 'detached Akron should reproduce the orphan');

  assert.deepEqual(await reapOrphanedCliAgentProcesses(), [9090]);
  await waitFor(() => {
    try { process.kill(lease.processGroupId, 0); return false; } catch { return true; }
  });

  process.env.FAKE_AKRON_EVENTS = '1';
  try {
    const next = await runCliAgent({
      agent: 'akron-grok', context: '', userPrompt: 'next coordinator turn', cwd: scratch, runId: 9091, emit,
    });
    assert.equal(next.summary, 'native answer');
  } finally {
    delete process.env.FAKE_AKRON_EVENTS;
  }
});

test('Akron emits launch metadata and native reasoning events through the harness bridge', async () => {
  process.env.FAKE_AKRON_EVENTS = '1';
  const events: Array<{ type: string; payload: any }> = [];
  try {
    const result = await runCliAgent({
      agent: 'akron-grok', context: '', userPrompt: 'exercise the bridge', cwd: scratch, runId: 8081,
      emit: (type, payload) => events.push({ type, payload }),
    });
    assert.equal(result.summary, 'native answer');
  } finally {
    delete process.env.FAKE_AKRON_EVENTS;
  }

  const harness = events
    .filter((event) => event.type === 'harness')
    .map((event) => String(event.payload?.data || ''))
    .join('');
  assert.match(harness, /launching Akron --grok harness/);
  assert.match(harness, /\$ .*fake-akron --grok/);
  assert.match(harness, /# cwd /);
  assert.ok(events.some((event) => event.type === 'text'
    && event.payload?.message?.content?.[0]?.type === 'thinking'
    && event.payload.message.content[0].thinking === 'mapping the harness'));
});

test('resume passes the session id positionally, right before the prompt', async () => {
  resetArgs();
  process.env.FAKE_CODEX_RESUME_OK = '1';
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'hello there', cwd: scratch, emit,
    resumeSessionId: 'sess-abc123',
  });
  delete process.env.FAKE_CODEX_RESUME_OK;

  const [args] = readArgs();
  assert.deepEqual(args.slice(0, 2), ['exec', 'resume']);
  assert.equal(args[args.indexOf('sess-abc123') + 1], 'hello there', 'prompt must follow the session id');
  assert.equal(result.summary, 'answered');
});

test('a session Codex no longer has falls back to a fresh one instead of a silent empty turn', async () => {
  resetArgs();
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'still there?', cwd: scratch, emit,
    resumeSessionId: 'sess-long-gone',
  });

  const attempts = readArgs();
  assert.equal(attempts.length, 2, 'should retry once');
  assert.ok(attempts[0].includes('resume'));
  assert.ok(!attempts[1].includes('resume'), 'retry must not resume anything');
  assert.equal(attempts[1][attempts[1].length - 1], 'still there?');
  assert.equal(result.summary, 'answered');
  // The new session must be handed back, or the next turn resumes the dead id.
  assert.equal(result.sessionId, 'fresh-session-1');
});

test('the zero-exit variant of a dead session also falls back', async () => {
  resetArgs();
  process.env.FAKE_CODEX_QUIET_FAIL = '1';
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'quiet failure', cwd: scratch, emit,
    resumeSessionId: 'sess-long-gone',
  });
  delete process.env.FAKE_CODEX_QUIET_FAIL;

  const attempts = readArgs();
  assert.equal(attempts.length, 2);
  assert.ok(!attempts[1].includes('resume'));
  assert.equal(result.summary, 'answered');
  assert.equal(result.sessionId, 'fresh-session-1');
});

test('an unrelated Codex failure still fails, rather than silently rerunning', async () => {
  resetArgs();
  process.env.FAKE_CODEX_BROKEN = '1';
  await assert.rejects(
    runCliAgent({ agent: 'codex', context: '', userPrompt: 'x', cwd: scratch, emit, resumeSessionId: 'sess-abc' }),
    /disk on fire/,
  );
  delete process.env.FAKE_CODEX_BROKEN;
  assert.equal(readArgs().length, 1, 'must not retry a failure that is not a dead session');
});

test('a fresh run is never retried and never mentions resume', async () => {
  resetArgs();
  const events: Array<{ type: string; payload: any }> = [];
  const result = await runCliAgent({
    agent: 'codex', context: '', userPrompt: 'new', cwd: scratch,
    emit: (type, payload) => events.push({ type, payload }),
  });
  const attempts = readArgs();
  assert.equal(attempts.length, 1);
  assert.ok(!attempts[0].includes('resume'));
  assert.equal(result.sessionId, 'fresh-session-1');
  const answer = events.find((event) => event.type === 'text' && event.payload?.chatVisible === true);
  assert.equal(answer?.payload.message.content[0].text, 'answered');
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
