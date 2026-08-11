import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateRunnerRestart } from './runner-restart-recovery.mjs';
import { evaluateSqliteLock } from './sqlite-lock-recovery.mjs';

test('SQLite lock proof requires bounded shedding, no phantom write, and persisted recovery', () => {
  const passing = {
    boundedFailureStatus: 503,
    boundedFailureMs: 5_100,
    failedWriteAbsent: true,
    recoveryStatus: 201,
    recoveryMs: 80,
    recoveryWritePersisted: true,
  };
  assert.deepEqual(evaluateSqliteLock(passing), { ok: true, failures: [] });
  assert.equal(evaluateSqliteLock({ ...passing, boundedFailureStatus: 500 }).ok, false);
  assert.equal(evaluateSqliteLock({ ...passing, failedWriteAbsent: false }).ok, false);
  assert.equal(evaluateSqliteLock({ ...passing, recoveryWritePersisted: false }).ok, false);
});

test('runner restart proof requires same-image reclaim and exactly one delegation and terminal event', () => {
  const passing = {
    sameContainer: true,
    sameImage: true,
    restartMs: 4_000,
    reclaimedActiveRun: true,
    delegations: 1,
    completedTerminalEvents: 1,
    finalStatus: 'completed',
  };
  assert.deepEqual(evaluateRunnerRestart(passing), { ok: true, failures: [] });
  assert.equal(evaluateRunnerRestart({ ...passing, reclaimedActiveRun: false }).ok, false);
  assert.equal(evaluateRunnerRestart({ ...passing, delegations: 2 }).ok, false);
  assert.equal(evaluateRunnerRestart({ ...passing, completedTerminalEvents: 0 }).ok, false);
});
