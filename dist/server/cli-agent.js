/**
 * @file cli-agent.ts — Codex & Grok CLI wrappers
 *
 * Drives the locally-installed Codex and Grok agent CLIs as alternate
 * backends for AI-powered note editing. Both agents authenticate via the
 * user's own CLI logins (subscriptions) — no API keys needed.
 *
 * Each CLI is spawned as a child process in the vault directory with JSON
 * output mode enabled. Their JSONL event streams are translated on-the-fly
 * into the Anthropic-style content blocks (text / thinking / tool_use /
 * tool_result) that the chat UI already renders:
 *
 * **Codex JSONL translation** (`codex exec --json`):
 *   - `thread.started`   → captures session id for conversation resume
 *   - `item.started`     → emits a `tool_use` block (Bash / Edit / etc.)
 *   - `item.completed`:
 *     - `agent_message`  → emits a `text` block
 *     - `reasoning`      → emits a `thinking` block
 *     - tool items       → emits a `tool_result` block (with is_error flag)
 *
 * **Grok JSONL translation** (`grok --output-format streaming-json`):
 *   - `thought` tokens   → accumulated, then flushed as a single `thinking` block
 *   - `text` tokens      → accumulated into the answer text
 *   - `end`              → emits final `text` block, captures session id
 *
 * @module server/cli-agent
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
/** Maximum time (ms) a CLI agent process may run before being killed. */
const CLI_TIMEOUT_MS = Number(process.env.RUNNER_CLI_TIMEOUT || 600_000);
/** Binary names are overridable in case they are not on the server's PATH. */
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const GROK_BIN = process.env.GROK_BIN || 'grok';
/** Maps MIME types to file extensions for temp image files. */
const IMG_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp',
};
// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════
/**
 * Runs a CLI agent (Codex or Grok) against the vault and streams events.
 *
 * Prepends a short IDE-style context line (which note is open) to the user's
 * prompt, then delegates to the appropriate CLI runner. Returns a summary of
 * the agent's work and, if available, a session id for conversation resume.
 *
 * @param opts - Configuration including agent type, prompt, cwd, and emitter
 * @returns Summary text and optional session id for conversation continuity
 */
export async function runCliAgent(opts) {
    // The CLIs are full agents in their own right; we only prepend a short
    // context line (which note is open), then pass the user's prompt verbatim.
    const prompt = opts.context
        ? `[Context: ${opts.context}]\n\n${opts.userPrompt}`
        : opts.userPrompt;
    return opts.agent === 'codex'
        ? runCodex(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [])
        : runGrok(prompt, opts.cwd, opts.emit, opts.resumeSessionId);
}
// ═══════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════
/**
 * Writes base64-encoded images to a temp directory for CLI flags like `-i`.
 *
 * @param images - Array of base64-encoded images with MIME types
 * @returns Object with file paths and a cleanup function to remove them
 */
function writeTempImages(images) {
    if (!images.length)
        return { paths: [], cleanup: () => { } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-img-'));
    const paths = images.map((img, i) => {
        const ext = IMG_EXT[img.media_type] || 'png';
        const file = path.join(dir, `image-${i}.${ext}`);
        fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
        return file;
    });
    return { paths, cleanup: () => { try {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        catch { /* ignore */ } } };
}
/**
 * Spawns a CLI process, streams its stdout line-by-line through `onLine`,
 * accumulates stderr, enforces a timeout, and resolves with a summary.
 *
 * This is the shared process-management core used by both runCodex and runGrok.
 *
 * @param bin        - Binary name or path to execute
 * @param args       - CLI arguments
 * @param cwd        - Working directory (vault root)
 * @param onLine     - Callback invoked for each non-empty stdout line
 * @param getSummary - Called on success to produce the final summary string
 * @param label      - Human-readable label for error messages (e.g. 'Codex')
 * @returns The summary string from getSummary on success
 * @throws On timeout, non-zero exit code, or spawn failure
 */
function driveProcess(bin, args, cwd, onLine, getSummary, label) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (err) {
            reject(new Error(`Failed to launch ${label} ('${bin}'): ${err instanceof Error ? err.message : String(err)}`));
            return;
        }
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill('SIGTERM');
                reject(new Error(`${label} timed out after ${CLI_TIMEOUT_MS}ms`));
            }
        }, CLI_TIMEOUT_MS);
        const rl = readline.createInterface({ input: child.stdout });
        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return;
            try {
                onLine(trimmed);
            }
            catch { /* ignore a single malformed line */ }
        });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`${label} ('${bin}') could not be started: ${err.message}. Is it installed and on PATH?`));
        });
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve(getSummary());
            }
            else {
                const detail = stderr.trim().split('\n').slice(-5).join('\n');
                reject(new Error(`${label} exited with code ${code}.${detail ? `\n${detail}` : ''}`));
            }
        });
    });
}
/** Truncates a string to `n` characters, appending an ellipsis if truncated. */
function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
}
// ═══════════════════════════════════════════════════════════════
// CODEX CLI
// ═══════════════════════════════════════════════════════════════
/**
 * Runs the Codex CLI (`codex exec --json`) and translates its rich JSONL
 * event stream into Anthropic-style content blocks.
 *
 * Codex events → content block mapping:
 *   - `thread.started`              → captures session id
 *   - `item.started` (tool items)   → `{ type: 'tool_use', name, input }`
 *   - `item.completed` / agent_message → `{ type: 'text', text }`
 *   - `item.completed` / reasoning  → `{ type: 'thinking', text }`
 *   - `item.completed` / tool items → `{ type: 'tool_result', content, is_error }`
 *
 * @param prompt     - Full prompt (context + user prompt)
 * @param cwd        - Vault root path
 * @param emit       - Event emitter callback
 * @param resumeId   - Optional session id to resume a prior conversation
 * @param images     - Optional images to attach via `-i` flags
 * @returns Summary text and optional session id
 */
async function runCodex(prompt, cwd, emit, resumeId, images = []) {
    const { paths: imagePaths, cleanup } = writeTempImages(images);
    // `-i/--image` is variadic, so it must come AFTER the positional prompt (and
    // session id on resume) or it swallows them. `codex exec resume` rejects
    // --sandbox, so the sandbox mode is set via -c instead.
    const imageArgs = imagePaths.flatMap((p) => ['-i', p]);
    const args = resumeId
        ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', resumeId, prompt, ...imageArgs]
        : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', prompt, ...imageArgs];
    let summary = '';
    let sessionId;
    const emittedTool = new Set();
    const isToolItem = (type) => type !== 'agent_message' && type !== 'reasoning';
    // Build a friendly tool_use block from a Codex item.
    const toolUseBlock = (item) => {
        if (item.type === 'command_execution') {
            return { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command || '' } };
        }
        if (item.type === 'file_change') {
            const file = item.path || item.changes?.[0]?.path || '(files)';
            return { type: 'tool_use', id: item.id, name: 'Edit', input: { file_path: file } };
        }
        return { type: 'tool_use', id: item.id, name: String(item.type), input: {} };
    };
    const emitToolUse = (item) => {
        if (!item.id || emittedTool.has(item.id))
            return;
        emittedTool.add(item.id);
        emit('text', { message: { content: [toolUseBlock(item)] } });
    };
    const onLine = (line) => {
        const ev = JSON.parse(line);
        const item = ev.item;
        switch (ev.type) {
            case 'thread.started':
                if (ev.thread_id)
                    sessionId = ev.thread_id;
                break;
            case 'item.started':
                if (item && isToolItem(item.type))
                    emitToolUse(item);
                break;
            case 'item.completed':
                if (!item)
                    break;
                if (item.type === 'agent_message') {
                    summary = item.text || summary;
                    emit('text', { message: { content: [{ type: 'text', text: item.text || '' }] } });
                }
                else if (item.type === 'reasoning') {
                    emit('text', { message: { content: [{ type: 'thinking', text: item.text || '' }] } });
                }
                else {
                    emitToolUse(item); // ensure the card exists even if 'started' was missed
                    const out = item.aggregated_output ?? item.output ?? '';
                    const isError = typeof item.exit_code === 'number' && item.exit_code !== 0;
                    emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: truncate(String(out), 8000), is_error: isError }] } });
                }
                break;
            // turn.started / turn.completed carry no renderable content.
        }
    };
    try {
        const summaryText = await driveProcess(CODEX_BIN, args, cwd, onLine, () => summary || 'Completed note operations successfully.', 'Codex');
        return { summary: summaryText, sessionId };
    }
    finally {
        cleanup();
    }
}
// ═══════════════════════════════════════════════════════════════
// GROK CLI
// ═══════════════════════════════════════════════════════════════
/**
 * Runs the Grok CLI (`grok --single --output-format streaming-json`) and
 * translates its streaming JSONL into Anthropic-style content blocks.
 *
 * Grok streams `thought` and `text` token chunks, then an `end` event.
 * Tool executions run silently (not surfaced in the stream), so we render
 * accumulated reasoning + the final answer. Disk changes are picked up by
 * the vault rescan afterwards.
 *
 * Grok events → content block mapping:
 *   - `thought` tokens → accumulated, flushed as `{ type: 'thinking', text }`
 *   - `text` tokens    → accumulated into the answer
 *   - `end`            → emits `{ type: 'text', text }`, captures session id
 *
 * @param prompt   - Full prompt (context + user prompt)
 * @param cwd      - Vault root path
 * @param emit     - Event emitter callback
 * @param resumeId - Optional session id to resume a prior conversation
 * @returns Summary text and optional session id
 */
async function runGrok(prompt, cwd, emit, resumeId) {
    const baseArgs = ['--single', prompt, '--output-format', 'streaming-json', '--always-approve', '--cwd', cwd];
    const args = resumeId ? ['--resume', resumeId, ...baseArgs] : baseArgs;
    let thought = '';
    let text = '';
    let thoughtFlushed = false;
    let sessionId;
    const flushThought = () => {
        if (thought && !thoughtFlushed) {
            emit('text', { message: { content: [{ type: 'thinking', text: thought }] } });
            thoughtFlushed = true;
        }
    };
    const onLine = (line) => {
        const ev = JSON.parse(line);
        if (ev.type === 'thought') {
            thought += ev.data || '';
        }
        else if (ev.type === 'text') {
            flushThought(); // reasoning is done once answer text begins
            text += ev.data || '';
        }
        else if (ev.type === 'end') {
            flushThought();
            if (ev.sessionId)
                sessionId = ev.sessionId;
            if (text)
                emit('text', { message: { content: [{ type: 'text', text }] } });
        }
    };
    const summaryText = await driveProcess(GROK_BIN, args, cwd, onLine, () => text || 'Completed note operations successfully.', 'Grok');
    return { summary: summaryText, sessionId };
}
