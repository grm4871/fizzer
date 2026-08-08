/**
 * @file runner.ts — Run records + event relay
 *
 * Records agent runs and relays their Socket.IO events to clients. Agents
 * (Claude SDK and the CLIs alike) execute on the user's own machine via the
 * desktop runner relay — see server/desktop-runner.ts and the `/runs` handler
 * in index.ts. The server itself never runs an agent in-process; it only
 * persists run rows/events and streams them back to connected clients.
 *
 * @module server/runner
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Vault } from './vault.js';
import {
  cancelDelegatedRun,
  clearDelegatedRun,
  getDelegatedRunOwner,
  isDelegatedRun,
  isDesktopRunnerOnline,
} from './desktop-runner.js';

export type AgentId = 'claude-code' | 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes' | 'akron-grok' | 'omp';

type Db = Database.Database;

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// A chat member's conversation id stays stable for continuity, and its backing
// CLI session remains continuous by default, matching direct Codex/Claude Code
// behavior and leaving context compaction to their harnesses. Operators can set
// either value to impose an explicit rotation policy; 0 disables that bound.
export const DEFAULT_CHAT_SESSION_MAX_RUNS = 0;
export const DEFAULT_CHAT_SESSION_MAX_AGE_HOURS = 0;
const CHAT_SESSION_MAX_RUNS = Math.floor(nonNegativeNumber(
  process.env.CHAT_SESSION_MAX_RUNS,
  DEFAULT_CHAT_SESSION_MAX_RUNS,
));
const CHAT_SESSION_MAX_AGE_HOURS = nonNegativeNumber(
  process.env.CHAT_SESSION_MAX_AGE_HOURS,
  DEFAULT_CHAT_SESSION_MAX_AGE_HOURS,
);

let eventSink: ((event: RunEvent) => void) | null = null;
// Sink that mirrors a run's streamed output into its linked chat message, so the
// agent reply is persisted/broadcast server-side regardless of which client (if
// any) is still connected to relay the stream.
let chatSyncSink: ((runId: number, eventType: string) => void) | null = null;

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export type Run = {
  id: number;
  vault_id: string;
  note_id: string | null;
  prompt: string;
  agent: AgentId;
  session_id: string | null;
  conversation_id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  model: string | null;
  chat_dispatch_id: string | null;
};

/** Terminal statuses — run will not produce further events. */
export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

export type RunEvent = {
  id: number;
  run_id: number;
  seq: number;
  type: string;
  payload_json: string;
  ts: string;
};

export function ensureRunnerSchema(db: Db) {
  // Check if runs table exists and has vault_id column
  const info = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (info.length > 0) {
    const hasVaultId = info.some(col => col.name === 'vault_id');
    if (!hasVaultId) {
      console.log('Detected legacy runs table. Dropping legacy runs and run_events tables...');
      db.exec('DROP TABLE IF EXISTS run_events');
      db.exec('DROP TABLE IF EXISTS runs');
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'claude-code',
      session_id TEXT,
      conversation_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      summary TEXT,
      model TEXT,
      chat_dispatch_id TEXT
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, seq)
    );

    -- Survives server restart so orphaned delegated runs can be settled.
    CREATE TABLE IF NOT EXISTS delegated_runs (
      run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      owner_user_id INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS delegated_runs_owner_idx ON delegated_runs(owner_user_id);
  `);

  // Migrations: add columns to pre-existing runs tables.
  const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runCols.some(col => col.name === 'agent')) {
    db.exec("ALTER TABLE runs ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude-code'");
  }
  if (!runCols.some(col => col.name === 'session_id')) {
    db.exec("ALTER TABLE runs ADD COLUMN session_id TEXT");
  }
  if (!runCols.some(col => col.name === 'conversation_id')) {
    db.exec("ALTER TABLE runs ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''");
  }
  if (!runCols.some(col => col.name === 'model')) {
    db.exec("ALTER TABLE runs ADD COLUMN model TEXT");
  }
  if (!runCols.some(col => col.name === 'chat_dispatch_id')) {
    db.exec("ALTER TABLE runs ADD COLUMN chat_dispatch_id TEXT");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS runs_chat_dispatch_idx
      ON runs(chat_dispatch_id) WHERE chat_dispatch_id IS NOT NULL
  `);
}

/** Record that a run is actively delegated to a user's desktop runner. */
export function recordDelegatedRun(db: Db, runId: number, ownerUserId: number): void {
  db.prepare(`
    INSERT INTO delegated_runs (run_id, owner_user_id, started_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(run_id) DO UPDATE SET owner_user_id = excluded.owner_user_id
  `).run(runId, ownerUserId);
}

export function clearDelegatedRunRecord(db: Db, runId: number): void {
  db.prepare('DELETE FROM delegated_runs WHERE run_id = ?').run(runId);
}

export function listDelegatedRunIdsForOwner(db: Db, ownerUserId: number): number[] {
  const rows = db.prepare('SELECT run_id FROM delegated_runs WHERE owner_user_id = ?').all(ownerUserId) as Array<{ run_id: number }>;
  return rows.map((r) => r.run_id);
}

export function countActiveDelegatedRuns(db: Db, ownerUserId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM delegated_runs d
    JOIN runs r ON r.id = d.run_id
    WHERE d.owner_user_id = ? AND r.status IN ('queued', 'running')
  `).get(ownerUserId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Open delegated runs that still need a live desktop owner after process restart. */
export function listOpenDelegatedRuns(db: Db): Array<{ run_id: number; owner_user_id: number }> {
  return db.prepare(`
    SELECT d.run_id AS run_id, d.owner_user_id AS owner_user_id
    FROM delegated_runs d
    JOIN runs r ON r.id = d.run_id
    WHERE r.status IN ('queued', 'running')
  `).all() as Array<{ run_id: number; owner_user_id: number }>;
}

/** DB owner for an open delegated run (survives server restart; in-memory map does not). */
export function getDelegatedRunOwnerFromDb(db: Db, runId: number): number | undefined {
  const row = db.prepare(`
    SELECT d.owner_user_id AS owner_user_id
    FROM delegated_runs d
    JOIN runs r ON r.id = d.run_id
    WHERE d.run_id = ? AND r.status IN ('queued', 'running')
  `).get(runId) as { owner_user_id: number } | undefined;
  return row?.owner_user_id;
}

export function setRunEventSink(sink: ((event: RunEvent) => void) | null) {
  eventSink = sink;
}

export function setChatSyncSink(sink: ((runId: number, eventType: string) => void) | null) {
  chatSyncSink = sink;
}

export function listRuns(db: Db, vaultId: string) {
  return db.prepare('SELECT * FROM runs WHERE vault_id = ? ORDER BY started_at DESC, id DESC').all(vaultId) as Run[];
}

export type ActiveSession = Run & {
  message_id: string | null;
  channel_id: string | null;
  channel_title: string | null;
  author: string | null;
  registration_id: string | null;
  mention: string | null;
};

export function listActiveSessions(db: Db, vaultId: string): ActiveSession[] {
  return db.prepare(`
    SELECT r.*,
      cm.id AS message_id,
      cm.channel_id AS channel_id,
      channel.title AS channel_title,
      cm.author AS author,
      cm.registration_id AS registration_id,
      member.mention AS mention
    FROM runs r
    LEFT JOIN chat_messages cm ON cm.id = (
      SELECT message.id
      FROM chat_messages message
      WHERE message.run_id = r.id
      ORDER BY message.created_at DESC
      LIMIT 1
    )
    LEFT JOIN notes channel ON channel.id = cm.channel_id
    LEFT JOIN chat_agent_members member ON member.id = cm.registration_id
    WHERE r.vault_id = ? AND r.status IN ('queued', 'running')
    ORDER BY r.started_at DESC, r.id DESC
  `).all(vaultId) as ActiveSession[];
}

export function getRun(db: Db, id: number) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined;
}

export function listRunEvents(db: Db, runId: number, afterSeq = 0) {
  if (afterSeq > 0) {
    return db.prepare(`
      SELECT * FROM run_events
      WHERE run_id = ? AND seq > ?
      ORDER BY seq ASC
    `).all(runId, afterSeq) as RunEvent[];
  }
  return db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as RunEvent[];
}

export async function cancelRun(
  db: Db,
  runId: number,
  opts: { steering?: boolean } = {},
): Promise<boolean> {
  const run = getRun(db, runId);
  if (!run) return false;

  // Already finished — idempotent cancel so stale UI can clear itself.
  if (isTerminalRunStatus(run.status)) {
    return true;
  }

  // Active runs execute on the user's desktop; tell that runner to stop.
  // After server restart, ownership may only exist in delegated_runs until reclaim.
  const ownerId = getDelegatedRunOwner(runId) ?? getDelegatedRunOwnerFromDb(db, runId);
  if (ownerId != null || isDelegatedRun(runId)) {
    if (ownerId != null) {
      // Prefer waiting for Electron to confirm the local process exited so a
      // continuation does not resume the same provider session concurrently.
      const stopped = await cancelDelegatedRun(ownerId, runId);
      if (!stopped) {
        // Offline / missing desktop can never ack — force-settle below.
        // Steering is a product requirement: never leave the next turn stuck on
        // "still stopping" because a hung CLI never acked cancel while online.
        // Non-steering cancels still wait for a clean stop when the runner is up.
        if (isDesktopRunnerOnline(ownerId) && !opts.steering) return false;
      }
    }
    clearDelegatedRun(runId);
    clearDelegatedRunRecord(db, runId);
    const summary = opts.steering ? 'Steered into the continuation below.' : 'Run canceled by user.';
    db.prepare(`
      UPDATE runs
      SET status = 'canceled', finished_at = datetime('now'), summary = ?
      WHERE id = ?
    `).run(summary, runId);
    publishRunEvent(db, runId, 'status', { status: 'canceled', summary, steering: opts.steering === true });
    return true;
  }

  // No live owner (e.g. server restarted, never reclaimed): mark canceled so
  // stale UI can clear itself.
  if (run.status === 'running' || run.status === 'queued') {
    const summary = opts.steering ? 'Steered into the continuation below.' : 'Run canceled by user.';
    clearDelegatedRunRecord(db, runId);
    db.prepare(`
      UPDATE runs
      SET status = 'canceled', finished_at = datetime('now'), summary = ?
      WHERE id = ?
    `).run(summary, runId);
    publishRunEvent(db, runId, 'status', { status: 'canceled', summary, steering: opts.steering === true });
    return true;
  }

  return false;
}

/**
 * True when an open sticky-session lease cannot still be running on a desktop:
 * no owner, or the recorded owner is offline. Used to release ghost leases after
 * app restart so the next chat turn is not permanently 409'd.
 */
export function isUnreclaimableOpenRun(db: Db, runId: number): boolean {
  const run = getRun(db, runId);
  if (!run || isTerminalRunStatus(run.status)) return false;
  const ownerId = getDelegatedRunOwner(runId) ?? getDelegatedRunOwnerFromDb(db, runId);
  if (ownerId == null) return true;
  return !isDesktopRunnerOnline(ownerId);
}

/** Force a terminal cancel for a ghost open run that can never ack stop. */
export function forceCancelUnreclaimableRun(
  db: Db,
  runId: number,
  summary = 'Run abandoned after desktop disconnect or restart.',
): boolean {
  const run = getRun(db, runId);
  if (!run || isTerminalRunStatus(run.status)) return false;
  if (!isUnreclaimableOpenRun(db, runId)) return false;
  clearDelegatedRun(runId);
  clearDelegatedRunRecord(db, runId);
  db.prepare(`
    UPDATE runs
    SET status = 'canceled', finished_at = datetime('now'), summary = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(summary, runId);
  publishRunEvent(db, runId, 'status', { status: 'canceled', summary });
  return true;
}

export async function startRun(
  db: Db,
  vault: Vault,
  noteId: string | null,
  prompt: string,
  agent: AgentId = 'claude-code',
  opts: { conversationId?: string; model?: string; sessionId?: string; chatDispatchId?: string } = {},
) {
  const conversationId = opts.conversationId || crypto.randomUUID();
  const model = opts.model || null;
  const result = db.prepare(`
    INSERT INTO runs (
      vault_id, note_id, prompt, agent, conversation_id, status, model, session_id, chat_dispatch_id
    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `).run(
    vault.id,
    noteId,
    prompt,
    agent,
    conversationId,
    model,
    opts.sessionId || null,
    opts.chatDispatchId || null,
  );

  const runId = Number(result.lastInsertRowid);
  const run = getRun(db, runId)!;

  publishRunEvent(db, run.id, 'status', { status: 'queued' });

  // Execution happens on the user's machine: the /runs handler delegates this
  // run to their connected desktop runner (delegateRunToDesktop). The server
  // only records the run here and relays the events streamed back.
  return run;
}

export function findRunByChatDispatch(db: Db, dispatchId: string): Run | undefined {
  if (!dispatchId) return undefined;
  return db.prepare('SELECT * FROM runs WHERE chat_dispatch_id = ? LIMIT 1').get(dispatchId) as Run | undefined;
}

/** Durable per-registration execution lease for sticky channel provider sessions. */
export function findOpenRunForChatRegistration(
  db: Db,
  registrationId: string,
  exceptDispatchId = '',
): Run | undefined {
  if (!registrationId) return undefined;
  // Mission tasks use isolated conversation ids (`mission:<taskId>`). They must
  // neither hold nor contend for the sticky channel lease so anonymous
  // subagents (and any parallel mission workers) can run beside the named
  // member's channel session.
  return db.prepare(`
    SELECT r.*
    FROM runs r
    JOIN chat_agent_dispatches d ON d.id = r.chat_dispatch_id
    LEFT JOIN chat_mission_tasks t ON t.dispatch_id = d.id
    WHERE d.registration_id = ?
      AND r.status IN ('queued', 'running')
      AND (? = '' OR d.id <> ?)
      AND t.id IS NULL
    ORDER BY r.id ASC
    LIMIT 1
  `).get(registrationId, exceptDispatchId, exceptDispatchId) as Run | undefined;
}

export type ConversationSessionQuery = {
  vaultId: string;
  noteId: string | null;
  agent: AgentId;
  conversationId: string;
  boundedChat?: boolean;
  nowMs?: number;
};

/**
 * Find the live CLI session behind a conversation.
 *
 * Chat conversations are intentionally bounded even though their conversation
 * id remains stable. Once the current backing session is old or has handled
 * enough top-level requests, returning undefined starts a fresh CLI session;
 * the normal cold-start channel context restores the useful recent discussion.
 */
export function findConversationSession(
  db: Db,
  query: ConversationSessionQuery,
): string | undefined {
  if (!query.conversationId) return undefined;
  const noteCondition = query.noteId ? 'note_id = ?' : 'note_id IS NULL';
  const params = query.noteId
    ? [query.vaultId, query.noteId, query.agent, query.conversationId]
    : [query.vaultId, query.agent, query.conversationId];
  const latest = db.prepare(`
    SELECT session_id, started_at
    FROM runs
    WHERE vault_id = ?
      AND ${noteCondition}
      AND agent = ?
      AND conversation_id = ?
      AND session_id IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(...params) as { session_id: string; started_at: string } | undefined;
  if (!latest?.session_id) return undefined;
  if (!query.boundedChat) return latest.session_id;

  const segment = db.prepare(`
    SELECT COUNT(*) AS run_count, MIN(started_at) AS first_started_at
    FROM runs
    WHERE vault_id = ?
      AND ${noteCondition}
      AND agent = ?
      AND conversation_id = ?
      AND session_id = ?
  `).get(...params, latest.session_id) as { run_count: number; first_started_at: string | null };

  if (CHAT_SESSION_MAX_RUNS > 0 && Number(segment.run_count) >= CHAT_SESSION_MAX_RUNS) {
    return undefined;
  }
  if (CHAT_SESSION_MAX_AGE_HOURS > 0 && segment.first_started_at) {
    const startedAt = Date.parse(`${segment.first_started_at.replace(' ', 'T')}Z`);
    const nowMs = Number.isFinite(query.nowMs) ? Number(query.nowMs) : Date.now();
    if (Number.isFinite(startedAt) && nowMs - startedAt >= CHAT_SESSION_MAX_AGE_HOURS * 3_600_000) {
      return undefined;
    }
  }
  return latest.session_id;
}

// Find the session id of the most recent prior run in the same conversation
// (same vault + note + agent), so the next turn can resume that session.
export function findPriorSession(db: Db, run: Run): string | undefined {
  return findConversationSession(db, {
    vaultId: run.vault_id,
    noteId: run.note_id,
    agent: run.agent,
    conversationId: run.conversation_id,
  });
}

export function publishRunEvent(db: Db, runId: number, type: string, payload: unknown) {
  const latest = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?').get(runId) as { next: number };
  const result = db.prepare('INSERT INTO run_events (run_id, seq, type, payload_json) VALUES (?, ?, ?, ?)').run(
    runId,
    latest.next,
    type,
    JSON.stringify(payload)
  );
  const event = db.prepare('SELECT * FROM run_events WHERE id = ?').get(Number(result.lastInsertRowid)) as RunEvent;
  eventSink?.(event);
  chatSyncSink?.(runId, type);
  return event;
}

export function finishDelegatedRun(
  db: Db,
  runId: number,
  opts: { status: 'completed' | 'failed' | 'canceled'; summary: string; sessionId?: string },
): void {
  const run = getRun(db, runId);
  if (!run) return;
  if (isTerminalRunStatus(run.status)) return;

  db.prepare(`
    UPDATE runs
    SET status = ?, finished_at = datetime('now'), summary = ?, session_id = COALESCE(?, session_id)
    WHERE id = ?
  `).run(opts.status, opts.summary, opts.sessionId ?? null, runId);
  clearDelegatedRunRecord(db, runId);
}

/**
 * Mark open DB-delegated runs for an owner as failed (desktop gone / restart).
 * Does not touch in-memory maps — caller clears those. Returns settled run ids.
 */
export function failOpenDelegatedRunsForOwner(
  db: Db,
  ownerUserId: number,
  reason = 'Desktop agent runner disconnected.',
): number[] {
  const runIds = listDelegatedRunIdsForOwner(db, ownerUserId);
  const settled: number[] = [];
  for (const runId of runIds) {
    const run = getRun(db, runId);
    if (!run || isTerminalRunStatus(run.status)) {
      clearDelegatedRunRecord(db, runId);
      continue;
    }
    db.prepare(`
      UPDATE runs
      SET status = 'failed', finished_at = datetime('now'), summary = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(reason, runId);
    publishRunEvent(db, runId, 'status', { status: 'failed', summary: reason });
    clearDelegatedRunRecord(db, runId);
    settled.push(runId);
  }
  return settled;
}
