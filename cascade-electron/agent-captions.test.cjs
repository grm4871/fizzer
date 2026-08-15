'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCaptioner, normalizeCaption } = require('./agent-captions.cjs');

test('normalizes model chatter without cutting a valid 10–16 word caption', () => {
  assert.equal(
    normalizeCaption('<think>secret</think>\nStatus: Reading AGENTS.md and inspecting Electron IPC now to repair the Orbit caption display.'),
    'Reading AGENTS md and inspecting Electron IPC now to repair the Orbit caption display',
  );
});

test('returns immediately and caches a generated caption', async () => {
  const calls = [];
  const captioner = createCaptioner({
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ response: 'Inspecting local agent logs' }) };
    },
  });
  assert.equal(captioner.getCaption('a', 'Label this', 'tool call'), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captioner.getCaption('a', 'Label this', 'tool call'), 'Inspecting local agent logs');
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Label this[\s\S]*tool call/);
});

test('publishes a completed caption while a fresher log waits', async () => {
  let release;
  const firstResponse = new Promise((resolve) => { release = resolve; });
  const captioner = createCaptioner({
    fetchImpl: async () => {
      await firstResponse;
      return { ok: true, json: async () => ({ response: 'Reading the current trace' }) };
    },
  });
  captioner.getCaption('live', 'Label', 'first log');
  captioner.getCaption('live', 'Label', 'newer log');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captioner.getCached('live'), 'Reading the current trace');
});

test('backs off when Qwen is not installed', async () => {
  let calls = 0;
  let clock = 1_000;
  const captioner = createCaptioner({
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 404 };
    },
    retryAfterMs: 60_000,
    now: () => clock,
  });
  captioner.getCaption('missing', 'Label', 'exec npm test');
  await new Promise((resolve) => setImmediate(resolve));
  captioner.getCaption('missing', 'Label', 'exec npm test again');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  clock += 60_001;
  captioner.getCaption('missing', 'Label', 'exec npm test again');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});
