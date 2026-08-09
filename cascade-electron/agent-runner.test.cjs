const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const runnerLeaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-runner-leases-'));
const runnerStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-runner-state-'));
const runnerBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-runner-bin-'));
process.env.CASCADE_AGENT_PROCESS_DIR = runnerLeaseDir;
process.env.CASCADE_AGENT_STATE_DIR = runnerStateDir;
process.env.CASCADE_AGENT_BIN_DIR = runnerBinDir;
const {
  buildRunHelperEnv,
  chatTriggeringMessageId,
  cleanupRunHelperConfig,
  helperAllowedTools,
  isMissingClaudeSession,
  normalizeClaudeEffort,
  resolveClaudePermission,
  requestClaudePermission,
  startLocalAgentRun,
} = require('./agent-runner.cjs');

test('recognizes a Claude session that belongs to another machine', () => {
  assert.equal(isMissingClaudeSession(new Error('No conversation found with session ID: abc')), true);
  assert.equal(isMissingClaudeSession(new Error('Claude rate limited')), false);
});

test('stale Claude permission responses are rejected', () => {
  assert.equal(resolveClaudePermission('missing-request', 'allow'), false);
});

test('Claude permission requests pause until the desktop answers', async () => {
  const events = [];
  const decision = requestClaudePermission(17, 'Bash', { command: 'systemctl status demo' }, {
    toolUseID: 'tool-1',
    title: 'Run a system command?',
    description: 'Reads service state outside the workspace.',
  }, (type, payload) => events.push({ type, payload }));
  assert.equal(events[0].type, 'permission');
  assert.equal(events[0].payload.title, 'Run a system command?');
  assert.equal(resolveClaudePermission(events[0].payload.requestId, 'allow'), true);
  assert.deepEqual(await decision, {
    behavior: 'allow',
    toolUseID: 'tool-1',
    decisionClassification: 'user_temporary',
  });
});

test('chat triggering message id follows the mission root through runner payload shapes', () => {
  assert.equal(chatTriggeringMessageId({ chatTriggeringMessageId: 'root-top' }), 'root-top');
  assert.equal(chatTriggeringMessageId({ chat: { triggeringMessageId: 'root-nested' } }), 'root-nested');
  assert.equal(chatTriggeringMessageId({ chatMessageId: 'worker-placeholder' }), '');
});

test('durable work item identity reaches both the provider env and helper context', () => {
  const runId = 91991;
  const env = buildRunHelperEnv({
    runId,
    vaultId: 'vault-1',
    chatChannelId: 'channel-1',
    workItemId: 'work-item-1',
  });
  try {
    assert.equal(env.CASCADE_WORK_ITEM_ID, 'work-item-1');
    const helper = JSON.parse(fs.readFileSync(env.CASCADE_HELPER_CONFIG, 'utf8'));
    assert.equal(helper.workItemId, 'work-item-1');
  } finally {
    cleanupRunHelperConfig(runId);
  }
});

test('Cascade helpers are pre-authorized by command name and discovered paths', () => {
  const rules = helperAllowedTools();
  assert.ok(rules.includes('Bash(cascade-note *)'));
  assert.ok(rules.includes(`Bash(${path.join(__dirname, '..', 'cli-agents', 'cascade-note')} *)`));
  assert.ok(rules.includes(`Bash(${path.join(runnerBinDir, 'cascade-note')} *)`));
});

test('Claude effort overrides support every Agent SDK level and reject ultra', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeClaudeEffort(effort), effort);
  }
  assert.equal(normalizeClaudeEffort('ultra', 'medium'), 'medium');
});

test('Claude chat uses adaptive effort with no fixed thinking budget', () => {
  const source = fs.readFileSync(path.join(__dirname, 'agent-runner.cjs'), 'utf8');
  assert.match(source, /const CLAUDE_CHAT_EFFORT = process\.env\.RUNNER_CHAT_EFFORT \|\| CLAUDE_EFFORT/);
  assert.match(source, /\n\s+effort,\n/);
  assert.doesNotMatch(source, /CLAUDE_CHAT_THINKING_TOKENS/);
  assert.doesNotMatch(source, /budgetTokens: thinkingTokens/);
});

test('Claude exposes assistant text for live chat while keeping reasoning separate', () => {
  const source = fs.readFileSync(path.join(__dirname, 'agent-runner.cjs'), 'utf8');
  assert.match(source, /thinking_delta[\s\S]*emit\('text', \{ message: \{ content: \[\{ type: 'thinking'/);
  assert.match(source, /text_delta[\s\S]*emit\('text', \{ chatVisible: true/);
});

test('Akron reaches the Electron event bridge with launch, reasoning, and terminal events', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-akron-bridge-'));
  const bin = path.join(dir, 'fake-akron');
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.env.HERMES_CASCADE_EVENTS !== '1') process.exit(13);
if (process.env.FAKE_AKRON_CRASH_LOOP === '1') setInterval(() => {}, 1000);
process.stderr.write(JSON.stringify({ type: 'reasoning.delta', text: 'bridged thought' }) + '\\n');
process.stdout.write('bridged answer\\n');
`);
  fs.chmodSync(bin, 0o755);
  const previous = process.env.AKRON_BIN;
  process.env.AKRON_BIN = bin;
  t.after(() => {
    if (previous === undefined) delete process.env.AKRON_BIN;
    else process.env.AKRON_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const events = [];
  await startLocalAgentRun({
    runId: 92001,
    agent: 'akron-grok',
    prompt: 'exercise bridge',
    cwd: dir,
    vaultRoot: dir,
  }, (event) => events.push(event));

  assert.equal(JSON.parse(events[0].payload_json).status, 'running');
  const harness = events
    .filter((event) => event.type === 'harness')
    .map((event) => JSON.parse(event.payload_json).data)
    .join('');
  assert.match(harness, /launching Akron --grok harness/);
  assert.match(harness, /\$ .*fake-akron --grok/);
  assert.match(harness, /# cwd /);
  assert.ok(events.some((event) => event.type === 'text'
    && JSON.parse(event.payload_json).message?.content?.[0]?.thinking === 'bridged thought'));
  const terminal = events.at(-1);
  assert.equal(terminal.type, 'status');
  assert.equal(JSON.parse(terminal.payload_json).status, 'completed');

  // Reproduce a hard Electron-main crash: the detached Akron process group is
  // adopted by PID 1, while its durable lease survives on disk.
  const crashedRunId = 92002;
  const crashHost = `
    import fs from 'node:fs';
    import { runCliAgent } from ${JSON.stringify(pathToFileURL(path.join(__dirname, '..', 'dist', 'cli-agents', 'cli-agent.js')).href)};
    void runCliAgent({ agent: 'akron-grok', context: '', userPrompt: 'long orchestrator work', cwd: ${JSON.stringify(dir)}, runId: ${crashedRunId}, emit() {} });
    const lease = ${JSON.stringify(path.join(runnerLeaseDir, `${crashedRunId}.json`))};
    const timer = setInterval(() => {
      if (fs.existsSync(lease)) { clearInterval(timer); process.exit(77); }
    }, 10);
  `;
  const crashedOwner = spawn(process.execPath, ['--input-type=module', '-e', crashHost], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      AKRON_BIN: bin,
      FAKE_AKRON_CRASH_LOOP: '1',
      CASCADE_AGENT_PROCESS_DIR: runnerLeaseDir,
    },
    stdio: 'ignore',
  });
  const crashCode = await new Promise((resolve) => crashedOwner.once('exit', resolve));
  assert.equal(crashCode, 77);
  const orphanLease = JSON.parse(fs.readFileSync(path.join(runnerLeaseDir, `${crashedRunId}.json`), 'utf8'));
  assert.doesNotThrow(() => process.kill(orphanLease.processGroupId, 0));

  // Starting the next real coordinator turn goes through loadCliAgentModule,
  // which must reap the orphan before launching the replacement Akron run.
  const recoveredEvents = [];
  await startLocalAgentRun({
    runId: 92003,
    agent: 'akron-grok',
    prompt: 'coordinator after crash',
    cwd: dir,
    vaultRoot: dir,
  }, (event) => recoveredEvents.push(event));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(orphanLease.processGroupId, 0));
  assert.equal(JSON.parse(recoveredEvents.at(-1).payload_json).status, 'completed');
});
