/**
 * Managed-agent billing control plane. Amounts are integer micro-USD so budget
 * decisions never depend on float rounding. This module deliberately contains
 * no provider credentials or browser-facing secrets.
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

type Db = Database.Database;
export type ManagedEntitlement = {
  vaultId: string; enabled: boolean; monthlyCapMicros: number; perRunCapMicros: number;
  includedMicros: number; concurrencyLimit: number; allowedModels: string[];
};

const DEFAULT: ManagedEntitlement = {
  vaultId: '', enabled: false, monthlyCapMicros: 0, perRunCapMicros: 0,
  includedMicros: 0, concurrencyLimit: 1, allowedModels: ['deepseek-v4-flash'],
};
const monthStart = () => new Date().toISOString().slice(0, 7);
const cleanMicros = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
};
const cleanModels = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[a-z0-9._-]{1,120}$/i.test(item)))].slice(0, 20)
  : DEFAULT.allowedModels;

export function ensureManagedAgentSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_agent_entitlements (
      vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      monthly_cap_micros INTEGER NOT NULL DEFAULT 0,
      per_run_cap_micros INTEGER NOT NULL DEFAULT 0,
      included_micros INTEGER NOT NULL DEFAULT 0,
      concurrency_limit INTEGER NOT NULL DEFAULT 1,
      allowed_models_json TEXT NOT NULL DEFAULT '["deepseek-v4-flash"]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS managed_usage_reservations (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      run_id INTEGER UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
      model TEXT NOT NULL,
      estimated_micros INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','settled','released','expired')),
      month_key TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS managed_usage_reservations_budget_idx
      ON managed_usage_reservations(vault_id, month_key, state);
    CREATE TABLE IF NOT EXISTS managed_usage_ledger (
      id TEXT PRIMARY KEY,
      reservation_id TEXT UNIQUE REFERENCES managed_usage_reservations(id),
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_micros INTEGER NOT NULL,
      settled_micros INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      provider_request_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS managed_usage_ledger_vault_idx ON managed_usage_ledger(vault_id, created_at);
  `);
}

export function getManagedEntitlement(db: Db, vaultId: string): ManagedEntitlement {
  const row = db.prepare('SELECT * FROM managed_agent_entitlements WHERE vault_id = ?').get(vaultId) as Record<string, unknown> | undefined;
  if (!row) return { ...DEFAULT, vaultId };
  let models: unknown = DEFAULT.allowedModels;
  try { models = JSON.parse(String(row.allowed_models_json || '[]')); } catch { /* safe default below */ }
  return {
    vaultId, enabled: Number(row.enabled) !== 0,
    monthlyCapMicros: cleanMicros(row.monthly_cap_micros, 0),
    perRunCapMicros: cleanMicros(row.per_run_cap_micros, 0),
    includedMicros: cleanMicros(row.included_micros, 0),
    concurrencyLimit: Math.max(1, Math.min(32, cleanMicros(row.concurrency_limit, 1))),
    allowedModels: cleanModels(models),
  };
}

export function setManagedEntitlement(db: Db, vaultId: string, input: Partial<ManagedEntitlement>): ManagedEntitlement {
  const prior = getManagedEntitlement(db, vaultId);
  const next: ManagedEntitlement = {
    vaultId,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : prior.enabled,
    monthlyCapMicros: cleanMicros(input.monthlyCapMicros, prior.monthlyCapMicros),
    perRunCapMicros: cleanMicros(input.perRunCapMicros, prior.perRunCapMicros),
    includedMicros: cleanMicros(input.includedMicros, prior.includedMicros),
    concurrencyLimit: Math.max(1, Math.min(32, cleanMicros(input.concurrencyLimit, prior.concurrencyLimit))),
    allowedModels: input.allowedModels === undefined ? prior.allowedModels : cleanModels(input.allowedModels),
  };
  db.prepare(`INSERT INTO managed_agent_entitlements
    (vault_id, enabled, monthly_cap_micros, per_run_cap_micros, included_micros, concurrency_limit, allowed_models_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(vault_id) DO UPDATE SET enabled=excluded.enabled, monthly_cap_micros=excluded.monthly_cap_micros,
      per_run_cap_micros=excluded.per_run_cap_micros, included_micros=excluded.included_micros,
      concurrency_limit=excluded.concurrency_limit, allowed_models_json=excluded.allowed_models_json, updated_at=datetime('now')
  `).run(vaultId, Number(next.enabled), next.monthlyCapMicros, next.perRunCapMicros, next.includedMicros, next.concurrencyLimit, JSON.stringify(next.allowedModels));
  return next;
}

/** Reserve before a billable request. Throws before provider work begins. */
export function reserveManagedSpend(db: Db, input: { vaultId: string; runId?: number; model: string; estimatedMicros: number; ttlMs?: number }) {
  const estimatedMicros = cleanMicros(input.estimatedMicros, -1);
  if (estimatedMicros < 0) throw new Error('Invalid estimated managed cost');
  return db.transaction(() => {
    const entitlement = getManagedEntitlement(db, input.vaultId);
    if (!entitlement.enabled) throw new Error('Managed agents are not enabled for this vault');
    if (!entitlement.allowedModels.includes(input.model)) throw new Error('Managed model is not allowed for this vault');
    if (!entitlement.monthlyCapMicros || !entitlement.perRunCapMicros) throw new Error('Managed budget is not configured');
    if (estimatedMicros > entitlement.perRunCapMicros) throw new Error('Managed request exceeds the per-run hard cap');
    const key = monthStart();
    const row = db.prepare(`SELECT COALESCE(SUM(estimated_micros), 0) AS reserved
      FROM managed_usage_reservations WHERE vault_id = ? AND month_key = ? AND state = 'reserved'`).get(input.vaultId, key) as { reserved: number };
    const settled = db.prepare(`SELECT COALESCE(SUM(settled_micros), 0) AS settled
      FROM managed_usage_ledger WHERE vault_id = ? AND substr(created_at, 1, 7) = ?`).get(input.vaultId, key) as { settled: number };
    const limit = entitlement.monthlyCapMicros + entitlement.includedMicros;
    if (row.reserved + settled.settled + estimatedMicros > limit) throw new Error('Managed budget exhausted');
    const active = db.prepare(`SELECT COUNT(*) AS count FROM managed_usage_reservations WHERE vault_id = ? AND state = 'reserved'`).get(input.vaultId) as { count: number };
    if (active.count >= entitlement.concurrencyLimit) throw new Error('Managed concurrency limit reached');
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + Math.max(30_000, Math.min(input.ttlMs ?? 10 * 60_000, 60 * 60_000))).toISOString();
    db.prepare(`INSERT INTO managed_usage_reservations (id, vault_id, run_id, model, estimated_micros, state, month_key, expires_at)
      VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(id, input.vaultId, input.runId ?? null, input.model, estimatedMicros, key, expiresAt);
    return { id, expiresAt, estimatedMicros };
  })();
}

export function settleManagedSpend(db: Db, input: { reservationId: string; provider: string; settledMicros: number; outcome: string; providerRequestId?: string; inputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number; outputTokens?: number }) {
  const cost = cleanMicros(input.settledMicros, -1);
  if (cost < 0) throw new Error('Invalid settled managed cost');
  return db.transaction(() => {
    const reservation = db.prepare('SELECT * FROM managed_usage_reservations WHERE id = ?').get(input.reservationId) as { vault_id: string; run_id: number | null; model: string; estimated_micros: number; state: string } | undefined;
    if (!reservation) throw new Error('Managed reservation not found');
    if (reservation.state !== 'reserved') throw new Error('Managed reservation is already settled');
    const ledgerId = crypto.randomUUID();
    db.prepare(`INSERT INTO managed_usage_ledger (id, reservation_id, vault_id, run_id, provider, model, input_tokens, cached_input_tokens, reasoning_tokens, output_tokens, estimated_micros, settled_micros, outcome, provider_request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ledgerId, input.reservationId, reservation.vault_id, reservation.run_id, input.provider, reservation.model,
      cleanMicros(input.inputTokens, 0), cleanMicros(input.cachedInputTokens, 0), cleanMicros(input.reasoningTokens, 0), cleanMicros(input.outputTokens, 0), reservation.estimated_micros, cost, input.outcome.slice(0, 64), (input.providerRequestId || '').slice(0, 200));
    db.prepare("UPDATE managed_usage_reservations SET state = 'settled', settled_at = datetime('now') WHERE id = ?").run(input.reservationId);
    return { id: ledgerId, vaultId: reservation.vault_id, settledMicros: cost };
  })();
}
