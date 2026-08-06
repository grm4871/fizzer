import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  checkpointManagedExecution,
  claimManagedExecution,
  dispatchManagedExecution,
  ensureManagedAgentSchema,
  getManagedAgentOperatorStatus,
  getManagedEntitlement,
  heartbeatManagedExecution,
  reapExpiredManagedReservations,
  reserveManagedSpend,
  setManagedEntitlement,
  settleManagedExecution,
  settleManagedSpend,
} from './managedAgents.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1);
    CREATE TABLE vaults (id TEXT PRIMARY KEY, created_by INTEGER REFERENCES users(id)); INSERT INTO vaults VALUES ('v1', 1);
    CREATE TABLE runs (id INTEGER PRIMARY KEY); INSERT INTO runs VALUES (1), (2), (3);`);
  ensureManagedAgentSchema(db);
  setManagedEntitlement(db, 'v1', {
    enabled: true, monthlyCapMicros: 1_000, perRunCapMicros: 300,
    includedMicros: 0, concurrencyLimit: 3, allowedModels: ['deepseek-v4-flash'],
  });
  return db;
}

test('an upgraded reservation table gains checkpoint accounting without losing existing rows', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1);
    CREATE TABLE vaults (id TEXT PRIMARY KEY, created_by INTEGER REFERENCES users(id)); INSERT INTO vaults VALUES ('v1', 1);
    CREATE TABLE runs (id INTEGER PRIMARY KEY); INSERT INTO runs VALUES (1);
    CREATE TABLE managed_usage_reservations (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, run_id INTEGER UNIQUE, model TEXT NOT NULL,
      estimated_micros INTEGER NOT NULL, state TEXT NOT NULL, month_key TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, settled_at TEXT
    );
    INSERT INTO managed_usage_reservations VALUES ('legacy', 'v1', 1, 'deepseek-v4-flash', 10, 'reserved', '2026-08', '2099-01-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL);`);
  ensureManagedAgentSchema(db);
  const columns = db.prepare('PRAGMA table_info(managed_usage_reservations)').all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'checkpointed_micros'));
  assert.equal((db.prepare("SELECT checkpointed_micros FROM managed_usage_reservations WHERE id = 'legacy'").get() as { checkpointed_micros: number }).checkpointed_micros, 0);
  db.close();
});

test('managed agents fail closed until an owner configures a bounded entitlement', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1);
    CREATE TABLE vaults (id TEXT PRIMARY KEY, created_by INTEGER REFERENCES users(id)); INSERT INTO vaults VALUES ('v1', 1);
    CREATE TABLE runs (id INTEGER PRIMARY KEY);`);
  ensureManagedAgentSchema(db);
  assert.equal(getManagedEntitlement(db, 'v1').enabled, false);
  assert.throws(() => reserveManagedSpend(db, { vaultId: 'v1', model: 'deepseek-v4-flash', estimatedMicros: 10 }), /not enabled/);
  setManagedEntitlement(db, 'v1', { enabled: true, monthlyCapMicros: 100, perRunCapMicros: 60, includedMicros: 0, concurrencyLimit: 1, allowedModels: ['deepseek-v4-flash'] });
  assert.throws(() => reserveManagedSpend(db, { vaultId: 'v1', model: 'other-model', estimatedMicros: 10 }), /not allowed/);
  assert.throws(() => reserveManagedSpend(db, { vaultId: 'v1', model: 'deepseek-v4-flash', estimatedMicros: 61 }), /per-run/);
  db.close();
});

test('reservations serialize spend, hard-cap settlement, and idempotent receipts', () => {
  const db = fixture();
  const first = reserveManagedSpend(db, { vaultId: 'v1', runId: 1, model: 'deepseek-v4-flash', estimatedMicros: 200 });
  assert.equal(reserveManagedSpend(db, { vaultId: 'v1', runId: 1, model: 'deepseek-v4-flash', estimatedMicros: 200 }).id, first.id);
  assert.throws(() => settleManagedSpend(db, { reservationId: first.id, provider: 'deepseek', settledMicros: 201, outcome: 'completed' }), /hard cap/);
  const settled = settleManagedSpend(db, { reservationId: first.id, provider: 'deepseek', settledMicros: 120, outcome: 'completed', providerRequestId: 'req-1', inputTokens: 10, outputTokens: 5 });
  const retry = settleManagedSpend(db, { reservationId: first.id, provider: 'deepseek', settledMicros: 120, outcome: 'completed', providerRequestId: 'req-1' });
  assert.equal(retry.id, settled.id);
  assert.equal(retry.reused, true);
  assert.throws(() => settleManagedSpend(db, { reservationId: first.id, provider: 'deepseek', settledMicros: 121, outcome: 'completed', providerRequestId: 'req-1' }), /different receipt/);
  const ledger = db.prepare('SELECT input_tokens, output_tokens, settled_micros FROM managed_usage_ledger').get() as { input_tokens: number; output_tokens: number; settled_micros: number };
  assert.deepEqual(ledger, { input_tokens: 10, output_tokens: 5, settled_micros: 120 });
  db.close();
});

test('selected owner claim, heartbeat, checkpoints, and settlement never persist capabilities', () => {
  const db = fixture();
  const dispatched = dispatchManagedExecution(db, {
    vaultId: 'v1', runId: 1, model: 'deepseek-v4-flash', estimatedMicros: 200,
    executionOwner: 'managed-us-east-1', provider: 'deepseek',
  });
  const stored = db.prepare('SELECT dispatch_secret_hash FROM managed_agent_executions WHERE id = ?').get(dispatched.executionId) as { dispatch_secret_hash: string };
  assert.notEqual(stored.dispatch_secret_hash, dispatched.dispatchSecret);
  const leakedAuditRows = db.prepare("SELECT COUNT(*) AS n FROM managed_agent_audit WHERE detail_json LIKE ?")
    .get(`%${dispatched.dispatchSecret}%`) as { n: number };
  assert.equal(leakedAuditRows.n, 0);
  assert.throws(() => claimManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'wrong-owner', dispatchSecret: dispatched.dispatchSecret }), /denied/);
  const claim = claimManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', dispatchSecret: dispatched.dispatchSecret, leaseMs: 15_000 });
  assert.equal(claim.hardCapMicros, 200);
  assert.throws(() => checkpointManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', claimToken: claim.claimToken, observedMicros: 201 }), /hard cap/);
  assert.deepEqual(checkpointManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', claimToken: claim.claimToken, observedMicros: 100, providerRequestId: 'provider-1' }), { hardCapMicros: 200, checkpointedMicros: 100 });
  assert.ok(heartbeatManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', claimToken: claim.claimToken }).claimExpiresAt);
  const receipt = settleManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', claimToken: claim.claimToken, settledMicros: 150, outcome: 'completed', providerRequestId: 'provider-1' });
  assert.equal(receipt.settledMicros, 150);
  const operator = getManagedAgentOperatorStatus(db, 'v1');
  assert.equal(operator.budget.settledMicros, 150);
  assert.equal(operator.executions[0]?.state, 'completed');
  assert.equal(JSON.stringify(operator).includes(claim.claimToken), false);
  assert.equal(JSON.stringify(operator).includes(dispatched.dispatchSecret), false);
  db.close();
});

test('a lapsed session can reclaim the same provider idempotency key and an old claim cannot settle', () => {
  const db = fixture();
  const dispatched = dispatchManagedExecution(db, {
    vaultId: 'v1', runId: 2, model: 'deepseek-v4-flash', estimatedMicros: 200,
    executionOwner: 'managed-us-east-1', provider: 'deepseek',
  });
  const first = claimManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', dispatchSecret: dispatched.dispatchSecret, leaseMs: 15_000 });
  db.prepare("UPDATE managed_agent_executions SET claim_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(dispatched.executionId);
  const reclaimed = claimManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', dispatchSecret: dispatched.dispatchSecret });
  assert.equal(reclaimed.providerIdempotencyKey, first.providerIdempotencyKey);
  assert.throws(() => settleManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', claimToken: first.claimToken, settledMicros: 1, outcome: 'completed' }), /denied/);
  assert.equal(settleManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', claimToken: reclaimed.claimToken, settledMicros: 180, outcome: 'completed' }).settledMicros, 180);
  db.close();
});

test('expired reservations free capacity and leave an auditable terminal execution instead of silently retrying', () => {
  const db = fixture();
  const dispatched = dispatchManagedExecution(db, {
    vaultId: 'v1', runId: 3, model: 'deepseek-v4-flash', estimatedMicros: 200,
    executionOwner: 'managed-us-east-1', provider: 'deepseek',
  });
  db.prepare("UPDATE managed_usage_reservations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(dispatched.reservationId);
  assert.equal(reapExpiredManagedReservations(db), 1);
  assert.throws(() => claimManagedExecution(db, { executionId: dispatched.executionId, executionOwner: 'managed-us-east-1', dispatchSecret: dispatched.dispatchSecret }), /terminal/);
  assert.equal((db.prepare('SELECT state FROM managed_agent_executions WHERE id = ?').get(dispatched.executionId) as { state: string }).state, 'expired');
  db.close();
});
