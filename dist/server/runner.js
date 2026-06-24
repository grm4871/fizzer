/**
 * @file runner.ts — Multi-agent run orchestrator
 *
 * Runs agent run sessions (Claude SDK, Codex, Grok) and manages
 * Socket.IO streaming of run events to the client.
 *
 * @module server/runner
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getNote, rescanVault } from './vault.js';
import { runCliAgent, activeCliProcesses } from './cli-agent.js';
import { cancelDelegatedRun, clearDelegatedRun, getDelegatedRunOwner, isDelegatedRun, } from './desktop-runner.js';
const liveQueries = new Map();
const pendingRunCwds = new Map();
let eventSink = null;
// Sink for vault-level events (e.g. notifying open editors to reload agent edits).
let vaultEventSink = null;
// Sink that mirrors a run's streamed output into its linked chat message, so the
// agent reply is persisted/broadcast server-side regardless of which client (if
// any) is still connected to relay the stream.
let chatSyncSink = null;
const RUNNER_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-4-6';
const RUNNER_MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 30);
// Thinking budget (tokens). Set RUNNER_THINKING=0 to disable extended thinking.
const RUNNER_THINKING_TOKENS = Number(process.env.RUNNER_THINKING ?? 4000);
const WIDGET_TOOLING_RELATIVE_PATH = path.join('.cascade', 'widget-tooling.md');
const SAFE_AGENT_CONTEXT = 'Operate as a user-authorized local workspace assistant. Use normal local file operations in this vault, respect service terms, authentication boundaries, and rate limits, and do not handle secrets except when the user explicitly provides them for this local task.';
const WIDGET_TOOLING_DOC = `# Cascade Widget Tooling

Cascade notes can contain inline interactive widgets. Use this only when the user asks for a widget, chart, calculator, dashboard, button, simulation, or other interactive notebook object.

## Format

Widgets are Markdown fenced code blocks:

\`\`\`\`markdown
\`\`\`cascade-widget
---
title: Example widget
runtime: iframe
autorun: false
feed_url: https://example.com/feed.xml
notify: false
interval_minutes: 30
permissions:
  network: feed
  actions: agent, feed
  terminal: ask
---
<div id="app">Widget HTML goes here</div>

<style>
  #app { font: 14px system-ui; }
</style>

<script type="module">
  document.querySelector('#app').textContent = 'Hello from a widget';
</script>
\`\`\`
\`\`\`\`

The body is self-contained HTML, CSS, and JavaScript rendered in a sandboxed iframe after the user clicks Run. Use vanilla browser APIs. Do not use external scripts or CDN imports; they are blocked in the current runtime. Avoid long-running synchronous loops because they can freeze the local renderer process.

## Runtime API

Widget JavaScript can call:

\`\`\`js
cascade.agent({ prompt: 'Update this widget in-place.' })
cascade.setHeight(420)
const feed = await cascade.feed({ url: 'https://example.com/feed.xml', force: true })
const result = await cascade.terminal({ command: 'ls -la', timeout_ms: 10000 })
\`\`\`

\`cascade.agent\` starts an agent request with the current widget block included. Use it for buttons like Refresh, Recompute, or Improve. \`cascade.setHeight\` manually adjusts the iframe height, though widgets auto-resize in most cases. \`cascade.feed\` fetches RSS, Atom, or JSON Feed data through the host app, because the iframe itself has no network access. It returns \`{ title, url, site_url, items, fetched_at }\`, where each item has \`{ id, title, url, summary, published_at }\`. \`cascade.terminal\` asks the host app to run a shell command in the vault root; the user must approve the widget once, then the same widget source can make repeated terminal calls for polling until the widget source changes. It returns \`{ stdout, stderr, exit_code, timed_out }\`.

## RSS / Feed Widgets

For feed-backed widgets, put the feed URL in frontmatter as \`feed_url\` and call \`cascade.feed({ url })\` from widget JavaScript. Set \`notify: true\` only when the user wants Cascade to poll that feed in the background and notify them about new top items. Background polling honors \`interval_minutes\`, with a minimum of 5 minutes. The first poll establishes a baseline and should not be treated as unread news.

## Good Practices

- Keep widgets self-contained inside one \`\`\`cascade-widget block.
- Prefer SVG, Canvas, and plain DOM for charts.
- Include data inline unless the user asks for a refresh workflow.
- For refresh buttons, call \`cascade.agent({ prompt })\` and ask the agent to update only that widget block.
- For RSS-like data, prefer \`cascade.feed\` over terminal commands or direct browser fetches.
- Use feed and terminal actions only for public or user-authorized resources, and keep refreshes respectful of published terms and rate limits.
- For terminal-backed widgets, call \`cascade.terminal({ command })\` from a button or a short polling loop for local data like system stats. Keep polling intervals reasonable, usually 2 seconds or slower, and keep command timeouts short.
- Do not run terminal commands immediately on load unless the user has enabled \`autorun: true\` for the widget and the command is necessary for the displayed data.
- If the user verifies a widget and wants it to run automatically when the note opens, set \`autorun: true\` in frontmatter.
- If the user wants background feed notifications, set \`notify: true\` and keep the feed URL in \`feed_url\`.
- Keep source readable, because the note remains the source of truth.
- If you need current external data, explain that the refresh/update action should gather sources and rewrite the widget.
`;
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
    const event = publishRunEvent(db, run.id, 'follow_up', { message: text });
    await stream.streamInput(toUserMessage(text));
    return event;
}
export async function cancelRun(db, runId) {
    const run = getRun(db, runId);
    if (!run)
        return false;
    // Already finished — idempotent cancel so stale UI can clear itself.
    if (run.status === 'completed' || run.status === 'failed') {
        return true;
    }
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
    // 1. Claude SDK
    const stream = liveQueries.get(runId);
    if (stream) {
        try {
            stream.close();
        }
        catch (err) {
            console.error('Error closing Claude stream:', err);
        }
        liveQueries.delete(runId);
    }
    // 2. CLI process
    const child = activeCliProcesses.get(runId);
    if (child) {
        try {
            child.kill('SIGKILL');
        }
        catch (err) {
            console.error('Error killing CLI process:', err);
        }
        activeCliProcesses.delete(runId);
    }
    // Mark orphaned DB rows as canceled even when no live process exists (e.g. after restart).
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
// Images attached to a run, held in memory between startRun and the async
// executor (kept out of the DB to avoid bloating it with base64 blobs).
const pendingImages = new Map();
function ensureWidgetToolingDoc(vault) {
    const docPath = path.join(vault.root_path, WIDGET_TOOLING_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, WIDGET_TOOLING_DOC, 'utf8');
    return WIDGET_TOOLING_RELATIVE_PATH.split(path.sep).join('/');
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
    if (opts.delegateToDesktop) {
        return run;
    }
    if (opts.images && opts.images.length)
        pendingImages.set(runId, opts.images);
    if (opts.cwd)
        pendingRunCwds.set(runId, opts.cwd);
    // Run asynchronously in the background
    queueMicrotask(() => executeRunAsync(db, vault, runId));
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
async function executeRunAsync(db, vault, runId) {
    const run = getRun(db, runId);
    if (!run)
        return;
    try {
        db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
        publishRunEvent(db, run.id, 'status', { status: 'running' });
        let activeNoteTitle = '';
        if (run.note_id) {
            const note = getNote(db, run.note_id);
            if (note)
                activeNoteTitle = note.title;
        }
        const widgetToolingPath = ensureWidgetToolingDoc(vault);
        // Minimal, IDE-style context: which note is open and that it lives in a
        // vault of interlinked notes — nothing more. No persona or behavioral
        // steering; the user's prompt drives everything the agent does.
        const context = [
            SAFE_AGENT_CONTEXT,
            'This working directory is a vault of interlinked markdown (.md) notes.',
            activeNoteTitle ? `The currently selected note is "${activeNoteTitle}.md".` : '',
            `If the user asks about inline widgets, charts, buttons, or interactive notebook objects, reference ${widgetToolingPath} for the supported Cascade widget tooling.`,
        ].filter(Boolean).join(' ');
        const images = pendingImages.get(runId) || [];
        pendingImages.delete(runId);
        const runCwd = pendingRunCwds.get(runId) || vault.root_path;
        pendingRunCwds.delete(runId);
        let summary = '';
        let sessionId;
        // Resume the conversation's prior session for this agent, if any.
        const resumeSessionId = findPriorSession(db, run);
        if (run.agent === 'codex' || run.agent === 'grok' || run.agent === 'antigravity' || run.agent === 'copilot' || run.agent === 'hermes') {
            // Codex / Grok / Antigravity / Copilot / Hermes run via their locally-installed CLI/API agents.
            const result = await runCliAgent({
                agent: run.agent,
                context,
                userPrompt: run.prompt,
                cwd: runCwd,
                resumeSessionId,
                images,
                model: run.model || undefined,
                runId: run.id,
                db,
                emit: (type, payload) => publishRunEvent(db, run.id, type, payload),
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
                    cwd: runCwd,
                    model: run.model || RUNNER_MODEL,
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
                    publishRunEvent(db, run.id, classifySdkMessage(message), message);
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
        const currentRun = getRun(db, run.id);
        if (currentRun && currentRun.status === 'running') {
            db.prepare(`
        UPDATE runs
        SET status = 'completed', finished_at = datetime('now'), summary = ?, session_id = ?
        WHERE id = ?
      `).run(summary || 'Completed note operations successfully.', sessionId ?? run.session_id, run.id);
            publishRunEvent(db, run.id, 'status', { status: 'completed', summary });
        }
    }
    catch (error) {
        const currentRun = getRun(db, run.id);
        if (currentRun && (currentRun.status === 'running' || currentRun.status === 'queued')) {
            const errMsg = error instanceof Error ? error.message : String(error);
            db.prepare(`
        UPDATE runs
        SET status = 'failed', finished_at = datetime('now'), summary = ?
        WHERE id = ?
      `).run(errMsg, run.id);
            publishRunEvent(db, run.id, 'status', { status: 'failed', summary: errMsg });
        }
    }
    finally {
        // Sync disk changes the agent made to the DB, then notify open clients so
        // an active editor reloads the edits live. Runs even on failure, since the
        // agent may have edited files before erroring (e.g. running out of tokens).
        rescanVault(db, vault.id, vault.created_by);
        vaultEventSink?.(vault.id, 'vault:noteChanged', { noteId: run.note_id ?? '', vaultId: vault.id });
    }
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
