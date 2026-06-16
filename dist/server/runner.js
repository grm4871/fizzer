/**
 * @file runner.ts — Multi-agent run orchestrator
 *
 * Runs agent run sessions (Claude SDK, Codex, Grok) and manages
 * Socket.IO streaming of run events to the client.
 *
 * @module server/runner
 */
import crypto from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getNote, rescanVault } from './vault.js';
import { runCliAgent } from './cli-agent.js';
const liveQueries = new Map();
let eventSink = null;
// Sink for vault-level events (e.g. notifying open editors to reload agent edits).
let vaultEventSink = null;
const RUNNER_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-4-6';
const RUNNER_MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 30);
// Thinking budget (tokens). Set RUNNER_THINKING=0 to disable extended thinking.
const RUNNER_THINKING_TOKENS = Number(process.env.RUNNER_THINKING ?? 4000);
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
      summary TEXT
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
}
export function setRunEventSink(sink) {
    eventSink = sink;
}
export function setVaultEventSink(sink) {
    vaultEventSink = sink;
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
export async function sendRunMessage(db, runId, message) {
    const run = getRun(db, runId);
    if (!run)
        throw new Error('Run not found');
    if (run.status !== 'running')
        throw new Error('Run is not currently running');
    const stream = liveQueries.get(run.id);
    if (!stream)
        throw new Error('Live agent session is not available');
    const text = message.trim();
    if (!text)
        throw new Error('Message cannot be empty');
    const event = appendRunEvent(db, run.id, 'follow_up', { message: text });
    await stream.streamInput(toUserMessage(text));
    return event;
}
// Images attached to a run, held in memory between startRun and the async
// executor (kept out of the DB to avoid bloating it with base64 blobs).
const pendingImages = new Map();
export async function startRun(db, vault, noteId, prompt, agent = 'claude-code', opts = {}) {
    const conversationId = opts.conversationId || crypto.randomUUID();
    const result = db.prepare(`
    INSERT INTO runs (vault_id, note_id, prompt, agent, conversation_id, status)
    VALUES (?, ?, ?, ?, ?, 'queued')
  `).run(vault.id, noteId, prompt, agent, conversationId);
    const runId = Number(result.lastInsertRowid);
    const run = getRun(db, runId);
    if (opts.images && opts.images.length)
        pendingImages.set(runId, opts.images);
    appendRunEvent(db, run.id, 'status', { status: 'queued' });
    // Run asynchronously in the background
    queueMicrotask(() => executeRunAsync(db, vault, runId));
    return run;
}
// Find the session id of the most recent prior run in the same conversation
// (same vault + note + agent), so the next turn can resume that session.
function findPriorSession(db, run) {
    const cond = run.note_id
        ? 'vault_id = ? AND note_id = ? AND agent = ? AND conversation_id = ? AND session_id IS NOT NULL AND id < ?'
        : 'vault_id = ? AND note_id IS NULL AND agent = ? AND conversation_id = ? AND session_id IS NOT NULL AND id < ?';
    const params = run.note_id
        ? [run.vault_id, run.note_id, run.agent, run.conversation_id, run.id]
        : [run.vault_id, run.agent, run.conversation_id, run.id];
    const row = db.prepare(`SELECT session_id FROM runs WHERE ${cond} ORDER BY id DESC LIMIT 1`).get(...params);
    return row?.session_id || undefined;
}
async function executeRunAsync(db, vault, runId) {
    const run = getRun(db, runId);
    if (!run)
        return;
    try {
        db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
        appendRunEvent(db, run.id, 'status', { status: 'running' });
        let activeNoteTitle = '';
        if (run.note_id) {
            const note = getNote(db, run.note_id);
            if (note)
                activeNoteTitle = note.title;
        }
        // Minimal, IDE-style context: which note is open and that it lives in a
        // vault of interlinked notes — nothing more. No persona or behavioral
        // steering; the user's prompt drives everything the agent does.
        const context = [
            'This working directory is a vault of interlinked markdown (.md) notes.',
            activeNoteTitle ? `The currently selected note is "${activeNoteTitle}.md".` : '',
        ].filter(Boolean).join(' ');
        const images = pendingImages.get(runId) || [];
        pendingImages.delete(runId);
        let summary = '';
        let sessionId;
        // Resume the conversation's prior session for this agent, if any.
        const resumeSessionId = findPriorSession(db, run);
        if (run.agent === 'codex' || run.agent === 'grok') {
            // Codex / Grok run via their locally-installed CLI agents (own logins).
            const result = await runCliAgent({
                agent: run.agent,
                context,
                userPrompt: run.prompt,
                cwd: vault.root_path,
                resumeSessionId,
                images,
                emit: (type, payload) => appendRunEvent(db, run.id, type, payload),
            });
            summary = result.summary;
            sessionId = result.sessionId;
        }
        else {
            // Run using Claude SDK query. With images, send a structured user message
            // (text + image blocks); otherwise a plain string prompt.
            const claudePrompt = images.length
                ? (async function* () {
                    yield {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [
                                { type: 'text', text: run.prompt },
                                ...images.map((img) => ({
                                    type: 'image',
                                    source: { type: 'base64', media_type: img.media_type, data: img.data },
                                })),
                            ],
                        },
                        parent_tool_use_id: null,
                        session_id: '',
                    };
                })()
                : run.prompt;
            const stream = query({
                prompt: claudePrompt,
                options: {
                    cwd: vault.root_path,
                    model: RUNNER_MODEL,
                    maxTurns: RUNNER_MAX_TURNS,
                    permissionMode: 'acceptEdits',
                    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
                    ...(RUNNER_THINKING_TOKENS > 0
                        ? { thinking: { type: 'enabled', budgetTokens: RUNNER_THINKING_TOKENS } }
                        : {}),
                    systemPrompt: {
                        type: 'preset',
                        preset: 'claude_code',
                        append: context,
                    },
                },
            });
            liveQueries.set(run.id, stream);
            try {
                for await (const message of stream) {
                    appendRunEvent(db, run.id, classifySdkMessage(message), message);
                    const sid = message.session_id;
                    if (sid)
                        sessionId = sid;
                    if (message.type === 'result') {
                        summary = message.result || message.subtype || summary;
                    }
                }
            }
            finally {
                liveQueries.delete(run.id);
            }
        }
        db.prepare(`
      UPDATE runs
      SET status = 'completed', finished_at = datetime('now'), summary = ?, session_id = ?
      WHERE id = ?
    `).run(summary || 'Completed note operations successfully.', sessionId ?? run.session_id, run.id);
        appendRunEvent(db, run.id, 'status', { status: 'completed', summary });
    }
    catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        db.prepare(`
      UPDATE runs
      SET status = 'failed', finished_at = datetime('now'), summary = ?
      WHERE id = ?
    `).run(errMsg, run.id);
        appendRunEvent(db, run.id, 'status', { status: 'failed', summary: errMsg });
    }
    finally {
        // Sync disk changes the agent made to the DB, then notify open clients so
        // an active editor reloads the edits live. Runs even on failure, since the
        // agent may have edited files before erroring (e.g. running out of tokens).
        rescanVault(db, vault.id, vault.created_by);
        vaultEventSink?.(vault.id, 'vault:noteChanged', { noteId: run.note_id ?? '', vaultId: vault.id });
    }
}
function appendRunEvent(db, runId, type, payload) {
    const latest = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?').get(runId);
    const result = db.prepare('INSERT INTO run_events (run_id, seq, type, payload_json) VALUES (?, ?, ?, ?)').run(runId, latest.next, type, JSON.stringify(payload));
    const event = db.prepare('SELECT * FROM run_events WHERE id = ?').get(Number(result.lastInsertRowid));
    eventSink?.(event);
    return event;
}
function classifySdkMessage(message) {
    if (message.type === 'assistant')
        return 'text';
    if (message.type === 'result')
        return 'result';
    if (message.type === 'system')
        return 'system';
    return message.type || 'message';
}
function toUserMessage(text) {
    return (async function* messages() {
        yield {
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            priority: 'now',
        };
    })();
}
