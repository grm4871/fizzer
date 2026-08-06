/**
 * Credential-free managed-agent execution and billing control plane.
 *
 * Provider credentials never enter this module or its database. A trusted
 * execution owner receives a one-time dispatch capability, then a short-lived
 * claim capability. The durable provider idempotency key is deliberately
 * stable across a reclaim, so a recovered worker cannot create a second
 * provider request or chat reply.
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

type Db = Database.Database;
export type ManagedEntitlement = {
  vaultId: string; enabled: boolean; monthlyCapMicros: number; perRunCapMicros: number;
  includedMicros: number; concurrencyLimit: number; allowedModels: string[];
};
export type ManagedExecutionState = 'queued' | 'claimed' | 'completed' | 'failed' | 'canceled' | 'expired';
type ReservationRow = {
  id: string; vault_id: string; run_id: number | null; model: string; estimated_micros: number;
  checkpointed_micros: number; state: string; month_key: string; expires_at: string;
};
type ExecutionRow = {
  id: string; reservation_id: string; vault_id: string; run_id: number; model: string;
  execution_owner: string; provider: string; state: ManagedExecutionState;
  attempt: number;
  dispatch_secret_hash: string; claim_token_hash: string | null; claim_expires_at: string | null;
  provider_idempotency_key: string; provider_request_id: string;
};

const DEFAULT: ManagedEntitlement = {
  vaultId: '', enabled: false, monthlyCapMicros: 0, perRunCapMicros: 0,
  includedMicros: 0, concurrencyLimit: 1, allowedModels: ['deepseek-v4-flash'],
};
const TERMINAL_EXECUTION_STATES = new Set<ManagedExecutionState>(['completed', 'failed', 'canceled', 'expired']);
const monthStart = () => new Date().toISOString().slice(0, 7);
const isoAfter = (ms: number) => new Date(Date.now() + ms).toISOString();
const cleanMicros = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
};
const cleanModels = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[a-z0-9._-]{1,120}$/i.test(item)))].slice(0, 20)
  : DEFAULT.allowedModels;
const cleanOwner = (value: unknown) => typeof value === 'string' && /^[a-z0-9._:@/-]{1,120}$/i.test(value) ? value : '';
const cleanProvider = (value: unknown) => typeof value === 'string' && /^[a-z0-9._-]{1,80}$/i.test(value) ? value : '';
const capabilityHash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const matchesCapability = (expected: string | null | undefined, provided: unknown) => {
  if (!expected || typeof provided !== 'string') return false;
  const actual = capabilityHash(provided);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
};
const boundedMs = (value: unknown, fallback: number, min: number, max: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
};

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
      checkpointed_micros INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS managed_agent_executions (
      id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE REFERENCES managed_usage_reservations(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      execution_owner TEXT NOT NULL,
      provider TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','claimed','completed','failed','canceled','expired')),
      attempt INTEGER NOT NULL DEFAULT 0,
      dispatch_secret_hash TEXT NOT NULL,
      claim_token_hash TEXT,
      claim_expires_at TEXT,
      last_heartbeat_at TEXT,
      provider_idempotency_key TEXT NOT NULL UNIQUE,
      provider_request_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS managed_agent_executions_owner_idx
      ON managed_agent_executions(execution_owner, state, claim_expires_at);
    CREATE TABLE IF NOT EXISTS managed_agent_audit (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      execution_id TEXT REFERENCES managed_agent_executions(id) ON DELETE SET NULL,
      reservation_id TEXT REFERENCES managed_usage_reservations(id) ON DELETE SET NULL,
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS managed_agent_audit_vault_idx ON managed_agent_audit(vault_id, created_at DESC);
  `);
  const columns = db.prepare('PRAGMA table_info(managed_usage_reservations)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'checkpointed_micros')) {
    db.exec('ALTER TABLE managed_usage_reservations ADD COLUMN checkpointed_micros INTEGER NOT NULL DEFAULT 0');
  }
}

function audit(db: Db, input: { vaultId: string; executionId?: string; reservationId?: string; actor: string; event: string; detail?: Record<string, unknown> }): void {
  db.prepare(`INSERT INTO managed_agent_audit (id, vault_id, execution_id, reservation_id, actor, event, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), input.vaultId, input.executionId ?? null, input.reservationId ?? null, input.actor.slice(0, 120), input.event.slice(0, 80), JSON.stringify(input.detail ?? {}));
}

export function getManagedEntitlement(db: Db, vaultId: string): ManagedEntitlement {
  const row = db.prepare('SELECT * FROM managed_agent_entitlements WHERE vault_id = ?').get(vaultId) as Record<string, unknown> | undefined;
  if (!row) return { ...DEFAULT, vaultId };
  let models: unknown = DEFAULT.allowedModels;
  try { models = JSON.parse(String(row.allowed_models_json || '[]')); } catch { /* fail closed below */ }
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

function expireReservations(db: Db, now: string): number {
  const expired = db.prepare(`UPDATE managed_usage_reservations SET state = 'expired'
    WHERE state = 'reserved' AND expires_at <= ?`).run(now);
  db.prepare(`UPDATE managed_agent_executions SET state = 'expired', completed_at = datetime('now')
    WHERE reservation_id IN (SELECT id FROM managed_usage_reservations WHERE state = 'expired')
      AND state IN ('queued', 'claimed')`).run();
  return expired.changes;
}

/** Explicit expiry sweep for workers/boot maintenance; never guesses provider outcomes. */
export function reapExpiredManagedReservations(db: Db, now = new Date().toISOString()): number {
  return db.transaction(() => expireReservations(db, now))();
}

function reserveManagedSpendInternal(db: Db, input: { vaultId: string; runId?: number; model: string; estimatedMicros: number; ttlMs?: number }) {
  const estimatedMicros = cleanMicros(input.estimatedMicros, -1);
  if (estimatedMicros < 0) throw new Error('Invalid estimated managed cost');
  expireReservations(db, new Date().toISOString());
  if (input.runId != null) {
    const existing = db.prepare('SELECT * FROM managed_usage_reservations WHERE run_id = ?').get(input.runId) as ReservationRow | undefined;
    if (existing) {
      if (existing.vault_id === input.vaultId && existing.model === input.model && existing.estimated_micros === estimatedMicros && existing.state === 'reserved') {
        return { id: existing.id, expiresAt: existing.expires_at, estimatedMicros: existing.estimated_micros, reused: true };
      }
      throw new Error('Managed run already has an immutable reservation');
    }
  }
  const entitlement = getManagedEntitlement(db, input.vaultId);
  if (!entitlement.enabled) throw new Error('Managed agents are not enabled for this vault');
  if (!entitlement.allowedModels.includes(input.model)) throw new Error('Managed model is not allowed for this vault');
  if (!entitlement.monthlyCapMicros || !entitlement.perRunCapMicros) throw new Error('Managed budget is not configured');
  if (estimatedMicros > entitlement.perRunCapMicros) throw new Error('Managed request exceeds the per-run hard cap');
  const key = monthStart();
  const reserved = db.prepare(`SELECT COALESCE(SUM(estimated_micros), 0) AS micros
    FROM managed_usage_reservations WHERE vault_id = ? AND month_key = ? AND state = 'reserved'`).get(input.vaultId, key) as { micros: number };
  const settled = db.prepare(`SELECT COALESCE(SUM(settled_micros), 0) AS micros
    FROM managed_usage_ledger WHERE vault_id = ? AND substr(created_at, 1, 7) = ?`).get(input.vaultId, key) as { micros: number };
  const limit = entitlement.monthlyCapMicros + entitlement.includedMicros;
  if (reserved.micros + settled.micros + estimatedMicros > limit) throw new Error('Managed budget exhausted');
  const active = db.prepare(`SELECT COUNT(*) AS count FROM managed_usage_reservations WHERE vault_id = ? AND state = 'reserved'`).get(input.vaultId) as { count: number };
  if (active.count >= entitlement.concurrencyLimit) throw new Error('Managed concurrency limit reached');
  const id = crypto.randomUUID();
  const expiresAt = isoAfter(boundedMs(input.ttlMs, 10 * 60_000, 30_000, 60 * 60_000));
  db.prepare(`INSERT INTO managed_usage_reservations (id, vault_id, run_id, model, estimated_micros, state, month_key, expires_at)
    VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(id, input.vaultId, input.runId ?? null, input.model, estimatedMicros, key, expiresAt);
  return { id, expiresAt, estimatedMicros, reused: false };
}

/** Reserve before provider work begins. The run id makes retrying dispatch idempotent. */
export function reserveManagedSpend(db: Db, input: { vaultId: string; runId?: number; model: string; estimatedMicros: number; ttlMs?: number }) {
  return db.transaction(() => reserveManagedSpendInternal(db, input))();
}

function settlementFromLedger(db: Db, reservationId: string) {
  return db.prepare(`SELECT id, vault_id, settled_micros, provider, outcome, provider_request_id
    FROM managed_usage_ledger WHERE reservation_id = ?`).get(reservationId) as {
      id: string; vault_id: string; settled_micros: number; provider: string; outcome: string; provider_request_id: string;
    } | undefined;
}

function settleManagedSpendInternal(db: Db, input: { reservationId: string; provider: string; settledMicros: number; outcome: string; providerRequestId?: string; inputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number; outputTokens?: number }) {
  const cost = cleanMicros(input.settledMicros, -1);
  if (cost < 0) throw new Error('Invalid settled managed cost');
  const provider = cleanProvider(input.provider);
  if (!provider) throw new Error('Invalid managed provider');
  const outcome = typeof input.outcome === 'string' ? input.outcome.slice(0, 64) : '';
  if (!outcome) throw new Error('Managed outcome is required');
  const requestId = (input.providerRequestId || '').slice(0, 200);
  const reservation = db.prepare('SELECT * FROM managed_usage_reservations WHERE id = ?').get(input.reservationId) as ReservationRow | undefined;
  if (!reservation) throw new Error('Managed reservation not found');
  const existing = settlementFromLedger(db, input.reservationId);
  if (existing) {
    if (existing.provider === provider && existing.settled_micros === cost && existing.outcome === outcome && existing.provider_request_id === requestId) {
      return { id: existing.id, vaultId: existing.vault_id, settledMicros: existing.settled_micros, reused: true };
    }
    throw new Error('Managed reservation was already settled with different receipt data');
  }
  if (reservation.state !== 'reserved') throw new Error('Managed reservation is not active');
  // The reservation is a hard maximum, not an optimistic estimate. A worker
  // must stop before crossing it and may not backfill an unreserved overage.
  if (cost > reservation.estimated_micros) throw new Error('Managed settled cost exceeds the reserved hard cap');
  const ledgerId = crypto.randomUUID();
  db.prepare(`INSERT INTO managed_usage_ledger (id, reservation_id, vault_id, run_id, provider, model, input_tokens, cached_input_tokens, reasoning_tokens, output_tokens, estimated_micros, settled_micros, outcome, provider_request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ledgerId, input.reservationId, reservation.vault_id, reservation.run_id, provider, reservation.model,
    cleanMicros(input.inputTokens, 0), cleanMicros(input.cachedInputTokens, 0), cleanMicros(input.reasoningTokens, 0), cleanMicros(input.outputTokens, 0), reservation.estimated_micros, cost, outcome, requestId);
  db.prepare("UPDATE managed_usage_reservations SET state = 'settled', settled_at = datetime('now'), checkpointed_micros = MAX(checkpointed_micros, ?) WHERE id = ?")
    .run(cost, input.reservationId);
  return { id: ledgerId, vaultId: reservation.vault_id, settledMicros: cost, reused: false };
}

/** Persist exactly one immutable provider receipt; identical delivery retries return it. */
export function settleManagedSpend(db: Db, input: { reservationId: string; provider: string; settledMicros: number; outcome: string; providerRequestId?: string; inputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number; outputTokens?: number }) {
  return db.transaction(() => settleManagedSpendInternal(db, input))();
}

/**
 * Create a selected-owner execution. Dispatch capability is returned exactly
 * once to the trusted transport; only its hash is retained for audit/reclaim.
 */
export function dispatchManagedExecution(db: Db, input: { vaultId: string; runId: number; model: string; estimatedMicros: number; executionOwner: string; provider: string; ttlMs?: number }) {
  const owner = cleanOwner(input.executionOwner);
  const provider = cleanProvider(input.provider);
  if (!owner || !provider || !Number.isInteger(input.runId)) throw new Error('Invalid managed execution dispatch');
  return db.transaction(() => {
    const reservation = reserveManagedSpendInternal(db, input);
    const existing = db.prepare('SELECT * FROM managed_agent_executions WHERE reservation_id = ?').get(reservation.id) as ExecutionRow | undefined;
    if (existing) {
      if (existing.execution_owner !== owner || existing.provider !== provider) throw new Error('Managed execution owner is immutable');
      throw new Error('Managed execution already dispatched; dispatch capability cannot be replayed');
    }
    const executionId = crypto.randomUUID();
    const dispatchSecret = crypto.randomBytes(32).toString('base64url');
    const providerIdempotencyKey = crypto.randomUUID();
    db.prepare(`INSERT INTO managed_agent_executions
      (id, reservation_id, vault_id, run_id, model, execution_owner, provider, state, dispatch_secret_hash, provider_idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .run(executionId, reservation.id, input.vaultId, input.runId, input.model, owner, provider, capabilityHash(dispatchSecret), providerIdempotencyKey);
    audit(db, { vaultId: input.vaultId, executionId, reservationId: reservation.id, actor: 'control-plane', event: 'dispatched', detail: { executionOwner: owner, provider, model: input.model, hardCapMicros: reservation.estimatedMicros } });
    return { executionId, reservationId: reservation.id, dispatchSecret, expiresAt: reservation.expiresAt, hardCapMicros: reservation.estimatedMicros };
  })();
}

/** Claim a selected execution owner lease; a lapsed lease may be reclaimed. */
export function claimManagedExecution(db: Db, input: { executionId: string; executionOwner: string; dispatchSecret: string; leaseMs?: number }) {
  const owner = cleanOwner(input.executionOwner);
  if (!owner) throw new Error('Invalid execution owner');
  return db.transaction(() => {
    const now = new Date().toISOString();
    const execution = db.prepare('SELECT * FROM managed_agent_executions WHERE id = ?').get(input.executionId) as ExecutionRow | undefined;
    if (!execution || execution.execution_owner !== owner || !matchesCapability(execution.dispatch_secret_hash, input.dispatchSecret)) throw new Error('Managed execution claim denied');
    if (TERMINAL_EXECUTION_STATES.has(execution.state)) throw new Error('Managed execution is terminal');
    if (execution.state === 'claimed' && execution.claim_expires_at && execution.claim_expires_at > now) throw new Error('Managed execution is already claimed');
    const reservation = db.prepare('SELECT * FROM managed_usage_reservations WHERE id = ?').get(execution.reservation_id) as ReservationRow | undefined;
    if (!reservation || reservation.state !== 'reserved' || reservation.expires_at <= now) throw new Error('Managed execution reservation has expired');
    const claimToken = crypto.randomBytes(32).toString('base64url');
    const leaseMs = boundedMs(input.leaseMs, 90_000, 15_000, 10 * 60_000);
    const claimExpiresAt = isoAfter(leaseMs);
    const claimed = db.prepare(`UPDATE managed_agent_executions
      SET state = 'claimed', attempt = attempt + 1, claim_token_hash = ?, claim_expires_at = ?, last_heartbeat_at = ?, claimed_at = COALESCE(claimed_at, datetime('now'))
      WHERE id = ? AND (state = 'queued' OR (state = 'claimed' AND (claim_expires_at IS NULL OR claim_expires_at <= ?)))`)
      .run(capabilityHash(claimToken), claimExpiresAt, now, execution.id, now);
    if (claimed.changes !== 1) throw new Error('Managed execution claim raced with another worker');
    audit(db, { vaultId: execution.vault_id, executionId: execution.id, reservationId: execution.reservation_id, actor: owner, event: 'claimed', detail: { attempt: execution.attempt + 1 } });
    return { claimToken, claimExpiresAt, provider: execution.provider, model: execution.model, hardCapMicros: reservation.estimated_micros, providerIdempotencyKey: execution.provider_idempotency_key };
  })();
}

function assertClaim(db: Db, input: { executionId: string; executionOwner: string; claimToken: string }): ExecutionRow {
  const owner = cleanOwner(input.executionOwner);
  const execution = db.prepare('SELECT * FROM managed_agent_executions WHERE id = ?').get(input.executionId) as ExecutionRow | undefined;
  if (!execution || !owner || execution.execution_owner !== owner || !matchesCapability(execution.claim_token_hash, input.claimToken)) throw new Error('Managed execution lease denied');
  if (execution.state !== 'claimed' || !execution.claim_expires_at || execution.claim_expires_at <= new Date().toISOString()) throw new Error('Managed execution lease expired');
  return execution;
}

/** Renew a claimed lease and its reservation before it expires. */
export function heartbeatManagedExecution(db: Db, input: { executionId: string; executionOwner: string; claimToken: string; leaseMs?: number }) {
  return db.transaction(() => {
    const execution = assertClaim(db, input);
    const now = new Date().toISOString();
    const claimExpiresAt = isoAfter(boundedMs(input.leaseMs, 90_000, 15_000, 10 * 60_000));
    db.prepare('UPDATE managed_agent_executions SET claim_expires_at = ?, last_heartbeat_at = ? WHERE id = ?').run(claimExpiresAt, now, execution.id);
    // An active, authenticated worker may keep its reservation alive, but can
    // never enlarge its fixed cost cap or monthly budget allocation.
    db.prepare("UPDATE managed_usage_reservations SET expires_at = ? WHERE id = ? AND state = 'reserved'")
      .run(isoAfter(60 * 60_000), execution.reservation_id);
    return { claimExpiresAt };
  })();
}

/** Record monotonic usage progress; over-cap provider work is rejected before settlement. */
export function checkpointManagedExecution(db: Db, input: { executionId: string; executionOwner: string; claimToken: string; observedMicros: number; providerRequestId?: string }) {
  const observedMicros = cleanMicros(input.observedMicros, -1);
  if (observedMicros < 0) throw new Error('Invalid managed checkpoint cost');
  return db.transaction(() => {
    const execution = assertClaim(db, input);
    const reservation = db.prepare('SELECT * FROM managed_usage_reservations WHERE id = ?').get(execution.reservation_id) as ReservationRow | undefined;
    if (!reservation || reservation.state !== 'reserved') throw new Error('Managed execution reservation is not active');
    if (observedMicros > reservation.estimated_micros) throw new Error('Managed checkpoint exceeds the reserved hard cap');
    const requestId = typeof input.providerRequestId === 'string' ? input.providerRequestId.slice(0, 200) : '';
    db.prepare(`UPDATE managed_usage_reservations SET checkpointed_micros = MAX(checkpointed_micros, ?) WHERE id = ?`).run(observedMicros, reservation.id);
    if (requestId) db.prepare("UPDATE managed_agent_executions SET provider_request_id = CASE WHEN provider_request_id = '' THEN ? ELSE provider_request_id END WHERE id = ?").run(requestId, execution.id);
    return { hardCapMicros: reservation.estimated_micros, checkpointedMicros: Math.max(reservation.checkpointed_micros, observedMicros) };
  })();
}

/** Settle a claimed execution and its run billing atomically. Delivery retries are idempotent. */
export function settleManagedExecution(db: Db, input: { executionId: string; executionOwner: string; claimToken: string; settledMicros: number; outcome: string; providerRequestId?: string; inputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number; outputTokens?: number }) {
  return db.transaction(() => {
    const execution = db.prepare('SELECT * FROM managed_agent_executions WHERE id = ?').get(input.executionId) as ExecutionRow | undefined;
    if (!execution || execution.execution_owner !== cleanOwner(input.executionOwner) || !matchesCapability(execution.claim_token_hash, input.claimToken)) throw new Error('Managed execution lease denied');
    const requestId = (input.providerRequestId || execution.provider_request_id || '').slice(0, 200);
    if (TERMINAL_EXECUTION_STATES.has(execution.state)) {
      const receipt = settlementFromLedger(db, execution.reservation_id);
      if (receipt && receipt.provider === execution.provider && receipt.settled_micros === input.settledMicros && receipt.outcome === input.outcome && receipt.provider_request_id === requestId) {
        return { id: receipt.id, vaultId: receipt.vault_id, settledMicros: receipt.settled_micros, reused: true };
      }
      throw new Error('Managed execution is terminal');
    }
    // Do not accept a terminal event from a worker whose lease was reclaimed.
    assertClaim(db, input);
    const receipt = settleManagedSpendInternal(db, {
      reservationId: execution.reservation_id, provider: execution.provider, settledMicros: input.settledMicros,
      outcome: input.outcome, providerRequestId: requestId, inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens, reasoningTokens: input.reasoningTokens, outputTokens: input.outputTokens,
    });
    const state: ManagedExecutionState = input.outcome === 'completed' ? 'completed' : input.outcome === 'canceled' ? 'canceled' : 'failed';
    db.prepare("UPDATE managed_agent_executions SET state = ?, completed_at = datetime('now'), claim_expires_at = NULL, provider_request_id = CASE WHEN provider_request_id = '' THEN ? ELSE provider_request_id END WHERE id = ?")
      .run(state, requestId, execution.id);
    audit(db, { vaultId: execution.vault_id, executionId: execution.id, reservationId: execution.reservation_id, actor: execution.execution_owner, event: 'settled', detail: { outcome: input.outcome.slice(0, 64), settledMicros: receipt.settledMicros, reused: receipt.reused } });
    return receipt;
  })();
}

/** Safe operator view: cost/lease/audit facts only, never dispatch or claim capabilities. */
export function getManagedAgentOperatorStatus(db: Db, vaultId: string) {
  const key = monthStart();
  const entitlement = getManagedEntitlement(db, vaultId);
  const reserved = db.prepare(`SELECT COALESCE(SUM(estimated_micros), 0) AS micros FROM managed_usage_reservations
    WHERE vault_id = ? AND month_key = ? AND state = 'reserved'`).get(vaultId, key) as { micros: number };
  const settled = db.prepare(`SELECT COALESCE(SUM(settled_micros), 0) AS micros FROM managed_usage_ledger
    WHERE vault_id = ? AND substr(created_at, 1, 7) = ?`).get(vaultId, key) as { micros: number };
  const executions = db.prepare(`SELECT id, run_id, model, execution_owner, provider, state, attempt, claim_expires_at, last_heartbeat_at, provider_request_id, created_at, completed_at
    FROM managed_agent_executions WHERE vault_id = ? ORDER BY created_at DESC LIMIT 20`).all(vaultId) as Array<Record<string, unknown>>;
  const auditRows = db.prepare(`SELECT execution_id, reservation_id, actor, event, detail_json, created_at
    FROM managed_agent_audit WHERE vault_id = ? ORDER BY created_at DESC LIMIT 20`).all(vaultId) as Array<Record<string, unknown>>;
  return {
    monthKey: key,
    budget: { capMicros: entitlement.monthlyCapMicros + entitlement.includedMicros, settledMicros: settled.micros, reservedMicros: reserved.micros, availableMicros: Math.max(0, entitlement.monthlyCapMicros + entitlement.includedMicros - settled.micros - reserved.micros) },
    executions,
    audit: auditRows.map((row) => ({ ...row, detail: (() => { try { return JSON.parse(String(row.detail_json)); } catch { return {}; } })(), detail_json: undefined })),
  };
}
