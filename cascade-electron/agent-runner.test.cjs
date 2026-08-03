const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { chatTriggeringMessageId, helperAllowedTools, normalizeClaudeEffort } = require('./agent-runner.cjs');

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
