import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ensureManagedAgentSchema, getManagedEntitlement, reserveManagedSpend, setManagedEntitlement, settleManagedSpend } from './managedAgents.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1);
    CREATE TABLE vaults (id TEXT PRIMARY KEY, created_by INTEGER REFERENCES users(id)); INSERT INTO vaults VALUES ('v1', 1);
    CREATE TABLE runs (id INTEGER PRIMARY KEY);`);
  ensureManagedAgentSchema(db);
  return db;
}

test('managed agents fail closed until an owner configures a bounded entitlement', () => {
  const db = fixture();
  assert.equal(getManagedEntitlement(db, 'v1').enabled, false);
  assert.throws(() => reserveManagedSpend(db, { vaultId: 'v1', model: 'deepseek-v4-flash', estimatedMicros: 10 }), /not enabled/);
  setManagedEntitlement(db, 'v1', { enabled: true, monthlyCapMicros: 100, perRunCapMicros: 60, includedMicros: 0, concurrencyLimit: 1, allowedModels: ['deepseek-v4-flash'] });
  assert.throws(() => reserveManagedSpend(db, { vaultId: 'v1', model: 'other-model', estimatedMicros: 10 }), /not allowed/);
  assert.throws(() => reserveManagedSpend(db, { vaultId: 'v1', model: 'deepseek-v4-flash', estimatedMicros: 61 }), /per-run/);
  db.close();
});

test('reservations serialize concurrent spend and ledger settlement is immutable', () => {
  const db = fixture();
  setManagedEntitlement(db, 'v1', { enabled: true, monthlyCapMicros: 100, perRunCapMicros: 80, concurrencyLimit: 2 });
  const first = reserveManagedSpend(db, { vaultId: 'v1', model: 'deepseek-v4-flash', estimatedMicros: 60 });
  assert.throws(() => reserveManagedSpend(db, { vaultId: 'v1', model: 'deepseek-v4-flash', estimatedMicros: 50 }), /budget exhausted/);
  const settled = settleManagedSpend(db, { reservationId: first.id, provider: 'deepseek', settledMicros: 40, outcome: 'completed', inputTokens: 10, outputTokens: 5 });
  assert.equal(settled.settledMicros, 40);
  assert.throws(() => settleManagedSpend(db, { reservationId: first.id, provider: 'deepseek', settledMicros: 40, outcome: 'completed' }), /already settled/);
  const ledger = db.prepare('SELECT input_tokens, output_tokens, settled_micros FROM managed_usage_ledger').get() as { input_tokens: number; output_tokens: number; settled_micros: number };
  assert.deepEqual(ledger, { input_tokens: 10, output_tokens: 5, settled_micros: 40 });
  db.close();
});
