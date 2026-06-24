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
import { cancelDelegatedRun, clearDelegatedRun, getDelegatedRunOwner, isDelegatedRun, } from './desktop-runner.js';
let eventSink = null;
// Sink that mirrors a run's streamed output into its linked chat message, so the
// agent reply is persisted/broadcast server-side regardless of which client (if
// any) is still connected to relay the stream.
let chatSyncSink = null;
export function ensureRunnerSchema(db) {
    // Check if runs table exists and has vault_id column
    const info = db.prepare("PRAGMA table_info(runs)").all();
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
      model TEXT
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
  `);
    // Migrations: add columns to pre-existing runs tables.
    const runCols = db.prepare("PRAGMA table_info(runs)").all();
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
}
export function setRunEventSink(sink) {
    eventSink = sink;
}
export function setChatSyncSink(sink) {
    chatSyncSink = sink;
}
export function listRuns(db, vaultId) {
    return db.prepare('SELECT * FROM runs WHERE vault_id = ? ORDER BY started_at DESC, id DESC').all(vaultId);
}
export function getRun(db, id) {
    return db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
}
export function listRunEvents(db, runId) {
    return db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(runId);
}
export async function cancelRun(db, runId) {
    const run = getRun(db, runId);
    if (!run)
        return false;
    // Already finished — idempotent cancel so stale UI can clear itself.
    if (run.status === 'completed' || run.status === 'failed') {
        return true;
    }
    // Active runs execute on the user's desktop; tell that runner to stop.
    if (isDelegatedRun(runId)) {
        const ownerId = getDelegatedRunOwner(runId);
        if (ownerId != null) {
            cancelDelegatedRun(ownerId, runId);
        }
        clearDelegatedRun(runId);
        db.prepare(`
      UPDATE runs
      SET status = 'failed', finished_at = datetime('now'), summary = 'Run canceled by user.'
      WHERE id = ?
    `).run(runId);
        publishRunEvent(db, runId, 'status', { status: 'failed', summary: 'Run canceled by user.' });
        return true;
    }
    // No live owner (e.g. server restarted): mark the orphaned row canceled so
    // stale UI can clear itself.
    if (run.status === 'running' || run.status === 'queued') {
        db.prepare(`
      UPDATE runs
      SET status = 'failed', finished_at = datetime('now'), summary = 'Run canceled by user.'
      WHERE id = ?
    `).run(runId);
        publishRunEvent(db, runId, 'status', { status: 'failed', summary: 'Run canceled by user.' });
        return true;
    }
    return false;
}
export async function startRun(db, vault, noteId, prompt, agent = 'claude-code', opts = {}) {
    const conversationId = opts.conversationId || crypto.randomUUID();
    const model = opts.model || null;
    const result = db.prepare(`
    INSERT INTO runs (vault_id, note_id, prompt, agent, conversation_id, status, model)
    VALUES (?, ?, ?, ?, ?, 'queued', ?)
  `).run(vault.id, noteId, prompt, agent, conversationId, model);
    const runId = Number(result.lastInsertRowid);
    const run = getRun(db, runId);
    publishRunEvent(db, run.id, 'status', { status: 'queued' });
    // Execution happens on the user's machine: the /runs handler delegates this
    // run to their connected desktop runner (delegateRunToDesktop). The server
    // only records the run here and relays the events streamed back.
    return run;
}
// Find the session id of the most recent prior run in the same conversation
// (same vault + note + agent), so the next turn can resume that session.
export function findPriorSession(db, run) {
    const cond = run.note_id
        ? 'vault_id = ? AND note_id = ? AND agent = ? AND conversation_id = ? AND session_id IS NOT NULL AND id < ?'
        : 'vault_id = ? AND note_id IS NULL AND agent = ? AND conversation_id = ? AND session_id IS NOT NULL AND id < ?';
    const params = run.note_id
        ? [run.vault_id, run.note_id, run.agent, run.conversation_id, run.id]
        : [run.vault_id, run.agent, run.conversation_id, run.id];
    const row = db.prepare(`SELECT session_id FROM runs WHERE ${cond} ORDER BY id DESC LIMIT 1`).get(...params);
    return row?.session_id || undefined;
}
export function publishRunEvent(db, runId, type, payload) {
    const latest = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?').get(runId);
    const result = db.prepare('INSERT INTO run_events (run_id, seq, type, payload_json) VALUES (?, ?, ?, ?)').run(runId, latest.next, type, JSON.stringify(payload));
    const event = db.prepare('SELECT * FROM run_events WHERE id = ?').get(Number(result.lastInsertRowid));
    eventSink?.(event);
    chatSyncSink?.(runId, type);
    return event;
}
export function finishDelegatedRun(db, runId, opts) {
    const run = getRun(db, runId);
    if (!run)
        return;
    if (run.status === 'completed' || run.status === 'failed')
        return;
    db.prepare(`
    UPDATE runs
    SET status = ?, finished_at = datetime('now'), summary = ?, session_id = COALESCE(?, session_id)
    WHERE id = ?
  `).run(opts.status, opts.summary, opts.sessionId ?? null, runId);
}
