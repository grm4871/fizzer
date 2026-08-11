import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateReconciliation } from './reconcile-capacity.mjs';

function passingObserved() {
  return {
    users: 1_007,
    vaults: 52,
    memberships: 1_015,
    fixtureChannelCount: 40,
    loadMessageCount: 3_000,
    loadMessageDistinctIds: 3_000,
    loadMessageChannels: 40,
    duplicateMessageIds: 0,
    unexercisedFixtureChannels: 0,
    badMessageScope: 0,
    loadRunCount: 120,
    completedLoadRuns: 120,
    unexpectedNewRuns: 0,
    badTerminalEventCounts: 0,
    badEventSequences: 0,
    openDelegatedRuns: 0,
    foreignKeyViolations: 0,
    quickCheck: 'ok',
  };
}

const expected = {
  users: 1_007,
  vaults: 52,
  memberships: 1_015,
  channels: 40,
  successfulChatWrites: 3_000,
  successfulRuns: 120,
};

test('accepts non-uniform per-channel writes when total, uniqueness, exercise, and scope are exact', () => {
  assert.deepEqual(evaluateReconciliation(passingObserved(), expected), { ok: true, failures: [] });
});

test('fails on aggregate, uniqueness, channel exercise, or cross-scope mismatches', () => {
  const observed = passingObserved();
  Object.assign(observed, {
    loadMessageCount: 2_999,
    loadMessageDistinctIds: 2_998,
    loadMessageChannels: 39,
    duplicateMessageIds: 1,
    unexercisedFixtureChannels: 1,
    badMessageScope: 1,
  });
  const evaluation = evaluateReconciliation(observed, expected);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /load messages are 2999, expected 3000/);
  assert.match(evaluation.failures.join('\n'), /unique load message IDs are 2998, expected 3000/);
  assert.match(evaluation.failures.join('\n'), /exercised load channels are 39, expected 40/);
  assert.match(evaluation.failures.join('\n'), /duplicate load message IDs: 1/);
  assert.match(evaluation.failures.join('\n'), /unexercised fixture channels: 1/);
  assert.match(evaluation.failures.join('\n'), /cross-scope load messages: 1/);
});

test('fails on run reconciliation or database integrity mismatches', () => {
  const observed = passingObserved();
  Object.assign(observed, {
    loadRunCount: 119,
    completedLoadRuns: 118,
    unexpectedNewRuns: 1,
    badTerminalEventCounts: 1,
    badEventSequences: 1,
    openDelegatedRuns: 1,
    foreignKeyViolations: 1,
    quickCheck: '*** corrupt ***',
  });
  const evaluation = evaluateReconciliation(observed, expected);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /load runs are 119, expected 120/);
  assert.match(evaluation.failures.join('\n'), /completed load runs are 118, expected 120/);
  assert.match(evaluation.failures.join('\n'), /unexpected new runs: 1/);
  assert.match(evaluation.failures.join('\n'), /runs with non-unique terminal events: 1/);
  assert.match(evaluation.failures.join('\n'), /runs with invalid event sequences: 1/);
  assert.match(evaluation.failures.join('\n'), /open delegated runs: 1/);
  assert.match(evaluation.failures.join('\n'), /foreign-key violations: 1/);
  assert.match(evaluation.failures.join('\n'), /SQLite quick_check/);
});
