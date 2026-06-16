/**
 * @file runner.ts — Multi-agent run orchestrator
 *
 * Runs agent run sessions (Claude SDK, Codex, Grok) and manages
 * Socket.IO streaming of run events to the client.
 *
 * @module server/runner
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getNote, rescanVault, type Vault } from './vault.js';
import { runCliAgent, activeCliProcesses } from './cli-agent.js';

export type AgentId = 'claude-code' | 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes';

type Db = Database.Database;

const liveQueries = new Map<number, Query>();
let eventSink: ((event: RunEvent) => void) | null = null;
// Sink for vault-level events (e.g. notifying open editors to reload agent edits).
let vaultEventSink: ((vaultId: string, event: string, data: unknown) => void) | null = null;

const RUNNER_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-4-6';
const RUNNER_MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 30);
// Thinking budget (tokens). Set RUNNER_THINKING=0 to disable extended thinking.
const RUNNER_THINKING_TOKENS = Number(process.env.RUNNER_THINKING ?? 4000);

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';

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
};

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
}

export function setRunEventSink(sink: ((event: RunEvent) => void) | null) {
  eventSink = sink;
}

export function setVaultEventSink(sink: ((vaultId: string, event: string, data: unknown) => void) | null) {
  vaultEventSink = sink;
}

export function listRuns(db: Db, vaultId: string) {
  return db.prepare('SELECT * FROM runs WHERE vault_id = ? ORDER BY started_at DESC, id DESC').all(vaultId) as Run[];
}

export function getRun(db: Db, id: number) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined;
}

export function listRunEvents(db: Db, runId: number) {
  return db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as RunEvent[];
}

export async function sendRunMessage(db: Db, runId: number, message: string) {
  const run = getRun(db, runId);
  if (!run) throw new Error('Run not found');
  if (run.status !== 'running') throw new Error('Run is not currently running');
  const stream = liveQueries.get(run.id);
  if (!stream) throw new Error('Live agent session is not available');

  const text = message.trim();
  if (!text) throw new Error('Message cannot be empty');
  const event = appendRunEvent(db, run.id, 'follow_up', { message: text });
  await stream.streamInput(toUserMessage(text));
  return event;
}

export async function cancelRun(db: Db, runId: number): Promise<boolean> {
  let canceled = false;

  // 1. Claude SDK
  const stream = liveQueries.get(runId);
  if (stream) {
    try {
      stream.close();
    } catch (err) {
      console.error('Error closing Claude stream:', err);
    }
    liveQueries.delete(runId);
    canceled = true;
  }

  // 2. CLI process
  const child = activeCliProcesses.get(runId);
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch (err) {
      console.error('Error killing CLI process:', err);
    }
    activeCliProcesses.delete(runId);
    canceled = true;
  }

  // Update DB status to failed
  const run = getRun(db, runId);
  if (run && (run.status === 'running' || run.status === 'queued')) {
    db.prepare(`
      UPDATE runs
      SET status = 'failed', finished_at = datetime('now'), summary = 'Run canceled by user.'
      WHERE id = ?
    `).run(runId);
    appendRunEvent(db, runId, 'status', { status: 'failed', summary: 'Run canceled by user.' });
    canceled = true;
  }

  return canceled;
}

export type RunImage = { media_type: string; data: string };

// Images attached to a run, held in memory between startRun and the async
// executor (kept out of the DB to avoid bloating it with base64 blobs).
const pendingImages = new Map<number, RunImage[]>();

export async function startRun(
  db: Db,
  vault: Vault,
  noteId: string | null,
  prompt: string,
  agent: AgentId = 'claude-code',
  opts: { conversationId?: string; images?: RunImage[]; model?: string } = {},
) {
  const conversationId = opts.conversationId || crypto.randomUUID();
  const model = opts.model || null;
  const result = db.prepare(`
    INSERT INTO runs (vault_id, note_id, prompt, agent, conversation_id, status, model)
    VALUES (?, ?, ?, ?, ?, 'queued', ?)
  `).run(vault.id, noteId, prompt, agent, conversationId, model);

  const runId = Number(result.lastInsertRowid);
  const run = getRun(db, runId)!;

  if (opts.images && opts.images.length) pendingImages.set(runId, opts.images);

  appendRunEvent(db, run.id, 'status', { status: 'queued' });

  // Run asynchronously in the background
  queueMicrotask(() => executeRunAsync(db, vault, runId));

  return run;
}

// Find the session id of the most recent prior run in the same conversation
// (same vault + note + agent), so the next turn can resume that session.
function findPriorSession(db: Db, run: Run): string | undefined {
  const cond = run.note_id
    ? 'vault_id = ? AND note_id = ? AND agent = ? AND conversation_id = ? AND session_id IS NOT NULL AND id < ?'
    : 'vault_id = ? AND note_id IS NULL AND agent = ? AND conversation_id = ? AND session_id IS NOT NULL AND id < ?';
  const params = run.note_id
    ? [run.vault_id, run.note_id, run.agent, run.conversation_id, run.id]
    : [run.vault_id, run.agent, run.conversation_id, run.id];
  const row = db.prepare(`SELECT session_id FROM runs WHERE ${cond} ORDER BY id DESC LIMIT 1`).get(...params) as { session_id: string } | undefined;
  return row?.session_id || undefined;
}

async function executeRunAsync(db: Db, vault: Vault, runId: number) {
  const run = getRun(db, runId);
  if (!run) return;
  
  try {
    db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
    appendRunEvent(db, run.id, 'status', { status: 'running' });

    let activeNoteTitle = '';
    if (run.note_id) {
      const note = getNote(db, run.note_id);
      if (note) activeNoteTitle = note.title;
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
    let sessionId: string | undefined;
    // Resume the conversation's prior session for this agent, if any.
    const resumeSessionId = findPriorSession(db, run);

    if (run.agent === 'codex' || run.agent === 'grok' || run.agent === 'antigravity' || run.agent === 'copilot' || run.agent === 'hermes') {
      // Codex / Grok / Antigravity / Copilot / Hermes run via their locally-installed CLI/API agents.
      const result = await runCliAgent({
        agent: run.agent,
        context,
        userPrompt: run.prompt,
        cwd: vault.root_path,
        resumeSessionId,
        images,
        model: run.model || undefined,
        emit: (type, payload) => appendRunEvent(db, run.id, type, payload),
      });
      summary = result.summary;
      sessionId = result.sessionId;
    } else {
      // Run using Claude SDK query. With images, send a structured user message
      // (text + image blocks); otherwise a plain string prompt.
      const claudePrompt = images.length
        ? (async function* () {
            yield {
              type: 'user' as const,
              message: {
                role: 'user' as const,
                content: [
                  { type: 'text' as const, text: run.prompt },
                  ...images.map((img) => ({
                    type: 'image' as const,
                    source: { type: 'base64' as const, media_type: img.media_type as any, data: img.data },
                  })),
                ],
              },
              parent_tool_use_id: null,
              session_id: '',
            };
          })()
        : run.prompt;
      const stream = query({
        prompt: claudePrompt as any,
        options: {
          cwd: vault.root_path,
          model: run.model || RUNNER_MODEL,
          maxTurns: RUNNER_MAX_TURNS,
          permissionMode: 'acceptEdits',
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          ...(RUNNER_THINKING_TOKENS > 0
            ? { thinking: { type: 'enabled' as const, budgetTokens: RUNNER_THINKING_TOKENS } }
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
          const sid = (message as any).session_id;
          if (sid) sessionId = sid;
          if (message.type === 'result') {
            summary = (message as any).result || (message as any).subtype || summary;
          }
        }
      } finally {
        liveQueries.delete(run.id);
      }
    }

    const currentRun = getRun(db, run.id);
    if (currentRun && currentRun.status === 'running') {
      db.prepare(`
        UPDATE runs
        SET status = 'completed', finished_at = datetime('now'), summary = ?, session_id = ?
        WHERE id = ?
      `).run(summary || 'Completed note operations successfully.', sessionId ?? run.session_id, run.id);

      appendRunEvent(db, run.id, 'status', { status: 'completed', summary });
    }

  } catch (error) {
    const currentRun = getRun(db, run.id);
    if (currentRun && (currentRun.status === 'running' || currentRun.status === 'queued')) {
      const errMsg = error instanceof Error ? error.message : String(error);
      db.prepare(`
        UPDATE runs
        SET status = 'failed', finished_at = datetime('now'), summary = ?
        WHERE id = ?
      `).run(errMsg, run.id);
      appendRunEvent(db, run.id, 'status', { status: 'failed', summary: errMsg });
    }
  } finally {
    // Sync disk changes the agent made to the DB, then notify open clients so
    // an active editor reloads the edits live. Runs even on failure, since the
    // agent may have edited files before erroring (e.g. running out of tokens).
    rescanVault(db, vault.id, vault.created_by);
    vaultEventSink?.(vault.id, 'vault:noteChanged', { noteId: run.note_id ?? '', vaultId: vault.id });
  }
}

function appendRunEvent(db: Db, runId: number, type: string, payload: unknown) {
  const latest = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?').get(runId) as { next: number };
  const result = db.prepare('INSERT INTO run_events (run_id, seq, type, payload_json) VALUES (?, ?, ?, ?)').run(
    runId,
    latest.next,
    type,
    JSON.stringify(payload)
  );
  const event = db.prepare('SELECT * FROM run_events WHERE id = ?').get(Number(result.lastInsertRowid)) as RunEvent;
  eventSink?.(event);
  return event;
}

function classifySdkMessage(message: SDKMessage) {
  if (message.type === 'assistant') return 'text';
  if (message.type === 'result') return 'result';
  if (message.type === 'system') return 'system';
  return message.type || 'message';
}

function toUserMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* messages() {
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      priority: 'now',
    };
  })();
}
