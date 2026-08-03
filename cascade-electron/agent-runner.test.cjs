const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { chatTriggeringMessageId, helperAllowedTools, normalizeClaudeEffort, startLocalAgentRun } = require('./agent-runner.cjs');

test('chat triggering message id follows the mission root through runner payload shapes', () => {
  assert.equal(chatTriggeringMessageId({ chatTriggeringMessageId: 'root-top' }), 'root-top');
  assert.equal(chatTriggeringMessageId({ chat: { triggeringMessageId: 'root-nested' } }), 'root-nested');
  assert.equal(chatTriggeringMessageId({ chatMessageId: 'worker-placeholder' }), '');
});

test('Cascade helpers are pre-authorized by command name and discovered paths', () => {
  const rules = helperAllowedTools();
  assert.ok(rules.includes('Bash(cascade-note *)'));
  assert.ok(rules.includes(`Bash(${path.join(__dirname, '..', 'cli-agents', 'cascade-note')} *)`));
  assert.ok(rules.includes(`Bash(${path.join(os.homedir(), '.local', 'bin', 'cascade-note')} *)`));
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
});
