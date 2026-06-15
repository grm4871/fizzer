import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getVault, getNote, updateNote, rescanVault, type Vault } from './vault.js';

type Db = Database.Database;

const liveQueries = new Map<number, Query>();
let eventSink: ((event: RunEvent) => void) | null = null;

const RUNNER_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-4-6';
const RUNNER_MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 30);

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';

export type Run = {
  id: number;
  vault_id: string;
  note_id: string | null;
  prompt: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
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
}

export function setRunEventSink(sink: ((event: RunEvent) => void) | null) {
  eventSink = sink;
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

export async function startRun(db: Db, vault: Vault, noteId: string | null, prompt: string) {
  const result = db.prepare(`
    INSERT INTO runs (vault_id, note_id, prompt, status)
    VALUES (?, ?, ?, 'queued')
  `).run(vault.id, noteId, prompt);
  
  const runId = Number(result.lastInsertRowid);
  const run = getRun(db, runId)!;
  
  appendRunEvent(db, run.id, 'status', { status: 'queued' });
  
  // Run asynchronously in the background
  queueMicrotask(() => executeRunAsync(db, vault, runId));
  
  return run;
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

    const previousRunsCondition = run.note_id 
      ? `vault_id = ? AND note_id = ? AND status IN ('completed', 'failed') AND id < ?` 
      : `vault_id = ? AND note_id IS NULL AND status IN ('completed', 'failed') AND id < ?`;
    
    const previousRunsParams = run.note_id 
      ? [run.vault_id, run.note_id, run.id]
      : [run.vault_id, run.id];

    const previousRuns = db.prepare(`SELECT prompt, summary FROM runs WHERE ${previousRunsCondition} ORDER BY id ASC`).all(...previousRunsParams) as Run[];
    
    let historyContext = '';
    if (previousRuns.length > 0) {
      historyContext = 'Previous conversation history in this session:\n' + 
        previousRuns.map(r => `User: ${r.prompt}\nAssistant: ${r.summary || 'Task completed.'}`).join('\n\n') + '\n\n';
    }

    const systemPromptAppend = [
      'You are an intelligent Obsidian-style notes assistant. You operate directly on the user\'s local vault directory of markdown (.md) files.',
      'Your workspace directory contains the raw markdown files representing the notes. You can read, search, edit, create, and list notes using your standard file tools (like grep, view_file, write_to_file, etc.).',
      activeNoteTitle ? `The user is currently viewing the note: "${activeNoteTitle}.md".` : '',
      historyContext ? `IMPORTANT CONTEXT:\n${historyContext}` : '',
      'Keep your responses helpful, concise, and focus on editing or creating notes as requested in the prompt. Output any markdown widgets (like tables or checkboxes) if helpful.',
    ].filter(Boolean).join('\n\n');

    // Run using Claude SDK query
    const stream = query({
      prompt: run.prompt,
      options: {
        cwd: vault.root_path,
        model: RUNNER_MODEL,
        maxTurns: RUNNER_MAX_TURNS,
        permissionMode: 'acceptEdits',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: systemPromptAppend,
        },
      },
    });

    liveQueries.set(run.id, stream);
    let summary = '';

    try {
      for await (const message of stream) {
        appendRunEvent(db, run.id, classifySdkMessage(message), message);
        if (message.type === 'result') {
          summary = (message as any).result || (message as any).subtype || summary;
        }
      }
    } finally {
      liveQueries.delete(run.id);
    }

    // Sync vault disk changes to database
    rescanVault(db, vault.id, vault.created_by);

    db.prepare(`
      UPDATE runs
      SET status = 'completed', finished_at = datetime('now'), summary = ?
      WHERE id = ?
    `).run(summary || 'Completed note operations successfully.', run.id);
    
    appendRunEvent(db, run.id, 'status', { status: 'completed', summary });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    db.prepare(`
      UPDATE runs
      SET status = 'failed', finished_at = datetime('now'), summary = ?
      WHERE id = ?
    `).run(errMsg, run.id);
    appendRunEvent(db, run.id, 'status', { status: 'failed', summary: errMsg });
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
