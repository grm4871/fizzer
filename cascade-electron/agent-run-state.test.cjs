'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRunState } = require('./agent-run-state.cjs');

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
