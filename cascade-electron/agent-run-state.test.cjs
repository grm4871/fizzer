'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRunState, settleCancelAcknowledgement } = require('./agent-run-state.cjs');

test('keeps active ownership and replays events after a renderer reload', () => {
  const state = new AgentRunState();
  assert.equal(state.start(42), true);
  assert.equal(state.start(42), false);
  const first = state.record({ runId: 42, type: 'text', payload_json: '{"text":"hello"}' });
  assert.deepEqual(state.snapshot().activeRunIds, [42]);
  assert.deepEqual(state.snapshot(first.bridgeSeq).events, []);
  const terminal = state.record({ runId: 42, type: 'status', payload_json: '{"status":"completed"}' });
  assert.deepEqual(state.snapshot(first.bridgeSeq).events, [terminal]);
  assert.deepEqual(state.snapshot().activeRunIds, []);
});

test('bounds the replay buffer', () => {
  const state = new AgentRunState({ maxEvents: 2 });
  state.start(7);
  state.record({ runId: 7, type: 'text', payload_json: '{}' });
  state.record({ runId: 7, type: 'text', payload_json: '{}' });
  state.record({ runId: 7, type: 'text', payload_json: '{}' });
  assert.deepEqual(state.snapshot().events.map((event) => event.bridgeSeq), [2, 3]);
});

test('cancel acknowledges a child cleanup race after its owned promise settles', async () => {
  let settle;
  const running = new Promise((resolve) => { settle = resolve; });
  setImmediate(settle);
  assert.equal(await settleCancelAcknowledgement(false, running, 100), true);
});

test('cancel still refuses a missing or genuinely live untracked child', async () => {
  assert.equal(await settleCancelAcknowledgement(false, undefined, 10), false);
  assert.equal(await settleCancelAcknowledgement(false, new Promise(() => {}), 10), false);
});
