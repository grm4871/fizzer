/**
 * @file cli-agent.ts — local Codex/Grok/Antigravity/Copilot CLI wrappers
 *
 * Drives the locally-installed Codex and Grok agent CLIs as alternate
 * backends for AI-powered note editing. Both agents authenticate via the
 * user's own CLI logins (subscriptions) — no API keys needed.
 *
 * Each CLI is spawned as a child process in the vault directory with JSON
 * output mode enabled. Their JSONL event streams are translated on-the-fly
 * into a **unified event schema** the chat UI already renders:
 *
 * ```
 * emit('text', { message: { content: ContentBlock[] } })
 * emit('user', { message: { content: ContentBlock[] } })  // tool results
 *
 * ContentBlock =
 *   | { type: 'text', text: string }
 *   | { type: 'thinking', thinking?: string, text?: string }
 *   | { type: 'redacted_thinking' }
 *   | { type: 'tool_use', id, name, input }
 *   | { type: 'tool_result', tool_use_id, content, is_error? }
 * ```
 *
 * Terminal status is emitted by agent-runner.cjs (not this module):
 *   emit('status', { status: 'completed'|'failed'|'canceled', summary, sessionId? })
 *
 * ## Per-agent event fidelity
 *
 * | Agent        | text | thinking | tool_use | tool_result | images | resume |
 * |--------------|------|----------|----------|-------------|--------|--------|
 * | claude-code  | yes  | yes      | yes*     | yes*        | yes    | yes    |
 * | codex        | yes  | yes      | yes      | yes         | yes    | yes    |
 * | grok         | yes  | yes      | no†      | no†         | no     | yes    |
 * | copilot      | yes  | partial  | partial  | partial     | no     | yes    |
 * | hermes       | yes  | partial  | partial  | partial     | no     | yes    |
 * | antigravity  | yes  | yes‡     | yes‡     | yes‡       | no     | yes    |
 *
 * \* Claude tools surface via SDK messages; cascade-* helpers are auto-allowed.
 * † Grok runs tools silently — not surfaced in the JSONL stream.
 * ‡ Antigravity: transcript.jsonl → thinking/tool_use/tool_result + formatted harness.
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
 * @module cli-agents/cli-agent
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

type Db = Database.Database;

export const activeCliProcesses = new Map<number, ChildProcess>();
const runHelperEnvByRunId = new Map<number, NodeJS.ProcessEnv>();

export function setRunHelperEnv(runId: number, env: NodeJS.ProcessEnv): void {
  runHelperEnvByRunId.set(runId, env);
}

export function clearRunHelperEnv(runId: number): void {
  runHelperEnvByRunId.delete(runId);
}

function spawnEnv(runId?: number): NodeJS.ProcessEnv {
  if (runId !== undefined) {
    const runEnv = runHelperEnvByRunId.get(runId);
    if (runEnv) return { ...process.env, ...runEnv };
  }
  return process.env;
}

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type AgentEmit = (type: 'text' | 'user' | 'harness', payload: unknown) => void;
export type CliImage = { media_type: string; data: string };

/** Emit a raw harness/terminal chunk (stdout/stderr or formatted SDK lines). */
function emitHarness(emit: AgentEmit | undefined, data: string): void {
  if (!emit || !data) return;
  emit('harness', { data });
}

/** Machine-readable stats line for the harness header (token/ctx/cost chips). */
function emitCascadeStats(emit: AgentEmit | undefined, stats: Record<string, unknown>): void {
  if (!emit || !stats || typeof stats !== 'object') return;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value !== undefined && value !== null && value !== '') clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return;
  try {
    emitHarness(emit, `\x1b[2m# cascade-stats ${JSON.stringify(clean)}\x1b[0m\r\n`);
  } catch { /* ignore */ }
}

function numFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Pull token fields from common CLI usage blobs. */
function statsFromUsageBlob(
  usage: Record<string, unknown> | null | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!usage && Object.keys(extra).length === 0) return extra;
  const u = usage || {};
  const input = numFromUnknown(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens);
  const cached = numFromUnknown(
    u.cached_input_tokens ?? u.cache_read_input_tokens ?? u.cacheReadTokens ?? u.cachedInputTokens,
  );
  const output = numFromUnknown(
    u.output_tokens
    ?? u.outputTokens
    ?? u.completion_tokens
    // Codex sometimes splits reasoning tokens out of output_tokens.
    ?? ((numFromUnknown(u.reasoning_output_tokens) != null || numFromUnknown(u.reasoningOutputTokens) != null)
      ? (numFromUnknown(u.output_tokens) || 0)
        + (numFromUnknown(u.reasoning_output_tokens) || numFromUnknown(u.reasoningOutputTokens) || 0)
      : undefined),
  );
  const total = numFromUnknown(u.total_tokens ?? u.totalTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: numFromUnknown(u.cache_creation_input_tokens ?? u.cacheWriteTokens),
    // Prefer explicit context totals; else input (+ cache) approximates window fill.
    contextUsed: total
      ?? (input != null || cached != null ? (input || 0) + (cached || 0) : undefined),
    totalCostUsd: numFromUnknown(u.total_cost_usd ?? u.cost_usd ?? u.cost),
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

/** Maximum time (ms) a CLI agent process may run before being killed. */
const CLI_TIMEOUT_MS = Number(process.env.RUNNER_CLI_TIMEOUT || 600_000);

/** Binary names are overridable in case they are not on the runner machine's PATH. */
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const GROK_BIN = process.env.GROK_BIN || 'grok';
const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
const OMP_BIN = process.env.OMP_BIN || 'omp';

export type CliAgentId = 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes' | 'omp';

const CLI_AGENT_LABELS: Record<CliAgentId, string> = {
  codex: 'Codex',
  grok: 'Grok',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  hermes: 'Hermes',
  omp: 'OMP',
};

export function getCliAgentBin(agent: CliAgentId): string {
  switch (agent) {
    case 'codex':
      return CODEX_BIN;
    case 'grok':
      return GROK_BIN;
    case 'copilot':
      return COPILOT_BIN;
    case 'hermes':
      return HERMES_BIN;
    case 'omp':
      return OMP_BIN;
    case 'antigravity':
      return process.env.ANTIGRAVITY_BIN || path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
  }
}

function cliBinaryExists(bin: string): boolean {
  if (path.isAbsolute(bin)) {
    try {
      return fs.existsSync(bin) && fs.statSync(bin).isFile();
    } catch {
      return false;
    }
  }
  const result = spawnSync('which', [bin], { stdio: 'ignore' });
  return result.status === 0;
}

export function getCliAgentAvailability(): Record<CliAgentId, { available: boolean; bin: string; message?: string }> {
  const availability = {} as Record<CliAgentId, { available: boolean; bin: string; message?: string }>;
  for (const agent of Object.keys(CLI_AGENT_LABELS) as CliAgentId[]) {
    const bin = getCliAgentBin(agent);
    const label = CLI_AGENT_LABELS[agent];
    const available = cliBinaryExists(bin);
    availability[agent] = available
      ? { available: true, bin }
      : {
          available: false,
          bin,
          message: `${label} ('${bin}') is not installed or not on PATH. CLI agents run in the Cascade desktop app on this computer — install the CLI locally, or set ${agent.toUpperCase().replace('-', '_')}_BIN for the desktop app.`,
        };
  }
  return availability;
}

function assertCliAgentAvailable(agent: CliAgentId): void {
  const status = getCliAgentAvailability()[agent];
  if (!status.available) {
    throw new Error(status.message || `${CLI_AGENT_LABELS[agent]} is not available on this computer.`);
  }
}

interface CliAgentOpts {
  agent: 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes' | 'omp';
  /** Minimal IDE-style context (selected note + vault). Prepended to the prompt. */
  context: string;
  userPrompt: string;
  cwd: string;
  /** Prior backend session id to resume, for conversation continuity. */
  resumeSessionId?: string;
  /** Pasted images to attach (Codex via -i; Grok has no image support). */
  images?: CliImage[];
  emit: AgentEmit;
  runId?: number;
  db?: Db;
  model?: string;
  /** Run with permission prompts bypassed ("yolo"). For Codex this widens the
   * sandbox from workspace-write to danger-full-access. */
  yolo?: boolean;
  /** Explicit child-process environment from the desktop runner. */
  env?: NodeJS.ProcessEnv;
}

/** Maps MIME types to file extensions for temp image files. */
const IMG_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp',
};

export interface CliAgentResult {
  summary: string;
  /** Backend session id for this run, to resume on the next turn. */
  sessionId?: string;
}

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
export async function runCliAgent(opts: CliAgentOpts): Promise<CliAgentResult> {
  assertCliAgentAvailable(opts.agent);

  // The CLIs are full agents in their own right; we only prepend a short
  // context line (which note is open), then pass the user's prompt verbatim.
  const prompt = opts.context
    ? `[Context: ${opts.context}]\n\n${opts.userPrompt}`
    : opts.userPrompt;
  if (opts.agent === 'codex') {
    return runCodex(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [], opts.runId, opts.model, opts.yolo, opts.env);
  } else if (opts.agent === 'grok') {
    return runGrok(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.model, opts.env);
  } else if (opts.agent === 'copilot') {
    return runCopilot(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.model, opts.env);
  } else if (opts.agent === 'hermes') {
    return runHermes(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.env);
  } else if (opts.agent === 'omp') {
    return runOmp(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [], opts.runId, opts.model, opts.env);
  } else {
    return runAntigravity(
      prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.db, opts.model, opts.yolo, opts.env,
    );
  }
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
function writeTempImages(images: CliImage[]): { paths: string[]; cleanup: () => void } {
  if (!images.length) return { paths: [], cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-img-'));
  const paths = images.map((img, i) => {
    const ext = IMG_EXT[img.media_type] || 'png';
    const file = path.join(dir, `image-${i}.${ext}`);
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    return file;
  });
  return { paths, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

/**
 * Spawns a CLI process, streams its stdout line-by-line through `onLine`,
 * accumulates stderr, enforces a timeout, and resolves with a summary.
 *
 * Also tees raw stdout/stderr into harness events so the chat UI can render a
 * real terminal view of the headless process pipes (not a PTY — read-only).
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
function driveProcess(
  bin: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  getSummary: () => string,
  label: string,
  runId?: number,
  emit?: AgentEmit,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ? { ...spawnEnv(runId), ...env } : spawnEnv(runId),
      });
      if (runId !== undefined) {
        activeCliProcesses.set(runId, child);
      }
    } catch (err) {
      reject(new Error(`Failed to launch ${label} ('${bin}'): ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const cleanUpProcess = () => {
      if (runId !== undefined) {
        activeCliProcesses.delete(runId);
      }
    };

    emitHarness(emit, `\x1b[2m$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\x1b[0m\r\n`);
    emitHarness(emit, `\x1b[2m# cwd ${cwd}\x1b[0m\r\n`);

    let stderr = '';
    let stdoutBuf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanUpProcess();
        child.kill('SIGTERM');
        reject(new Error(`${label} timed out after ${CLI_TIMEOUT_MS}ms`));
      }
    }, CLI_TIMEOUT_MS);

    // Single stdout consumer: tee raw bytes to the harness terminal and split
    // lines for JSONL parsing (readline would contend for the same stream).
    child.stdout.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      emitHarness(emit, chunk);
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const trimmed = line.trim();
        if (trimmed) {
          try { onLine(trimmed); } catch { /* ignore a single malformed line */ }
        }
        nl = stdoutBuf.indexOf('\n');
      }
    });

    child.stderr.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      stderr += chunk;
      // Dim red for stderr so it is distinguishable in the terminal pane.
      emitHarness(emit, `\x1b[31m${chunk}\x1b[0m`);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanUpProcess();
      reject(new Error(`${label} ('${bin}') could not be started: ${err.message}. Is it installed and on PATH?`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanUpProcess();
      // Flush a trailing partial stdout line (no final newline).
      const trailing = stdoutBuf.trim();
      if (trailing) {
        try { onLine(trailing); } catch { /* ignore */ }
      }
      emitHarness(emit, `\x1b[2m# exit ${code ?? '?'}\x1b[0m\r\n`);
      if (code === 0) {
        resolve(getSummary());
      } else {
        const detail = stderr.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`${label} exited with code ${code}.${detail ? `\n${detail}` : ''}`));
      }
    });
  });
}

/** Truncates a string to `n` characters, appending an ellipsis if truncated. */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
}

function redactGrokDiagnostic(input: string): string {
  return input
    .replace(/"key_prefix":"[^"]*"/g, '"key_prefix":"[redacted]"')
    .replace(/"rt_prefix":"[^"]*"/g, '"rt_prefix":"[redacted]"')
    .replace(/key_prefix":"[^"]*"/g, 'key_prefix":"[redacted]"')
    .replace(/rt_prefix":"[^"]*"/g, 'rt_prefix":"[redacted]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

function extractGrokDiagnostic(debugFile: string): string | undefined {
  try {
    if (!fs.existsSync(debugFile)) return undefined;
    const raw = fs.readFileSync(debugFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-300);
    const candidates: string[] = [];
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        const status = ev?.ctx?.status_code ?? ev?.ctx?.http_status;
        const message = ev?.ctx?.message ?? ev?.ctx?.error;
        if (status || message || ev?.lvl === 'error') {
          candidates.push(redactGrokDiagnostic(JSON.stringify({
            level: ev?.lvl,
            message: ev?.msg,
            status,
            detail: message,
          })));
        }
      } catch {
        if (/api error|forbidden|permission-denied|unauthorized|rate|paywall|subscription/i.test(line)) {
          candidates.push(redactGrokDiagnostic(line));
        }
      }
    }
    const detail = candidates.slice(-3).join('\n');
    return detail || undefined;
  } catch {
    return undefined;
  }
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
async function runCodex(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  images: CliImage[] = [],
  runId?: number,
  model?: string,
  yolo?: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const { paths: imagePaths, cleanup } = writeTempImages(images);
  // `-i/--image` is variadic, so it must come AFTER the positional prompt (and
  // session id on resume) or it swallows them. `codex exec resume` rejects
  // --sandbox, so the sandbox mode is set via -c instead.
  const imageArgs = imagePaths.flatMap((p) => ['-i', p]);
  const modelArgs = model ? ['--model', model] : [];
  const sandbox = yolo ? 'danger-full-access' : 'workspace-write';
  const sandboxConfigArgs = yolo
    ? []
    : ['-c', 'sandbox_workspace_write.network_access=true'];
  const args = resumeId
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode=${sandbox}`, ...sandboxConfigArgs, ...modelArgs, resumeId, prompt, ...imageArgs]
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandbox, ...sandboxConfigArgs, ...modelArgs, prompt, ...imageArgs];

  let summary = '';
  let sessionId: string | undefined;
  let emittedText = false; // prefix a paragraph break before later turns' text
  let turnCount = 0;
  const emittedTool = new Set<string>();
  const isToolItem = (type: string) => type !== 'agent_message' && type !== 'reasoning';

  if (model) emitCascadeStats(emit, { model });

  // Build a friendly tool_use block from a Codex item.
  const toolUseBlock = (item: any) => {
    if (item.type === 'command_execution') {
      return { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command || '' } };
    }
    if (item.type === 'file_change') {
      const file = item.path || item.changes?.[0]?.path || '(files)';
      return { type: 'tool_use', id: item.id, name: 'Edit', input: { file_path: file } };
    }
    return { type: 'tool_use', id: item.id, name: String(item.type), input: {} };
  };

  const emitToolUse = (item: any) => {
    if (!item.id || emittedTool.has(item.id)) return;
    emittedTool.add(item.id);
    emit('text', { message: { content: [toolUseBlock(item)] } });
  };

  const onLine = (line: string) => {
    const ev = JSON.parse(line);
    const item = ev.item;
    // Usage can appear on turn.completed or nested event_msg token_count payloads.
    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      turnCount += 1;
      emitCascadeStats(emit, statsFromUsageBlob(ev.usage as Record<string, unknown>, {
        model,
        numTurns: turnCount,
      }));
    } else if (ev.type === 'event_msg' && ev.payload && typeof ev.payload === 'object') {
      const payload = ev.payload as Record<string, unknown>;
      if (payload.type === 'token_count') {
        const info = (payload.info && typeof payload.info === 'object')
          ? payload.info as Record<string, unknown>
          : payload;
        const usage = (info.total_token_usage && typeof info.total_token_usage === 'object')
          ? info.total_token_usage as Record<string, unknown>
          : (info.last_token_usage && typeof info.last_token_usage === 'object')
            ? info.last_token_usage as Record<string, unknown>
            : info;
        emitCascadeStats(emit, statsFromUsageBlob(usage, { model, numTurns: turnCount || undefined }));
      }
    } else if (ev.usage && typeof ev.usage === 'object') {
      emitCascadeStats(emit, statsFromUsageBlob(ev.usage as Record<string, unknown>, { model }));
    }

    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id) sessionId = ev.thread_id;
        break;
      case 'item.started':
        if (item && isToolItem(item.type)) emitToolUse(item);
        break;
      case 'item.completed':
        if (!item) break;
        if (item.type === 'agent_message') {
          summary = item.text || summary;
          const text = item.text || '';
          emit('text', { message: { content: [{ type: 'text', text: (emittedText ? '\n\n' : '') + text }] } });
          if (text) emittedText = true;
        } else if (item.type === 'reasoning') {
          emit('text', { message: { content: [{ type: 'thinking', text: item.text || '' }] } });
        } else {
          emitToolUse(item); // ensure the card exists even if 'started' was missed
          const out = item.aggregated_output ?? item.output ?? '';
          const isError = typeof item.exit_code === 'number' && item.exit_code !== 0;
          emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: truncate(String(out), 8000), is_error: isError }] } });
        }
        break;
      // turn.started handled above via usage path; no content blocks.
    }
  };

  try {
    const summaryText = await driveProcess(CODEX_BIN, args, cwd, onLine, () => summary || 'Completed note operations successfully.', 'Codex', runId, emit, env);
    return { summary: summaryText, sessionId };
  } finally {
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
async function runGrok(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  runId?: number,
  model?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const modelArgs = model ? ['--model', model] : [];
  const debugFile = path.join(os.tmpdir(), `cascade-grok-${runId ?? process.pid}-${Date.now()}.jsonl`);
  const baseArgs = ['--single', prompt, '--output-format', 'streaming-json', '--debug-file', debugFile, '--always-approve', '--cwd', cwd, ...modelArgs];
  const args = resumeId ? ['--resume', resumeId, ...baseArgs] : baseArgs;

  let text = '';
  let sessionId: string | undefined;
  // Separate a turn's answer from the previous one. Grok tools run silently, so
  // a `thought` (or any non-text event) between answers marks the boundary.
  let emittedText = false;
  let lastWasText = false;
  let thoughtChars = 0;
  let textChars = 0;

  if (model) emitCascadeStats(emit, { model });

  const onLine = (line: string) => {
    const ev = JSON.parse(line);
    // Any usage blob mid-stream → surface for harness chips.
    if (ev.usage && typeof ev.usage === 'object') {
      emitCascadeStats(emit, statsFromUsageBlob(ev.usage as Record<string, unknown>, { model }));
    }
    if (ev.type === 'thought') {
      const chunk = String(ev.data || '');
      thoughtChars += chunk.length;
      emit('text', { message: { content: [{ type: 'thinking', thinking: chunk }] } });
      lastWasText = false;
    } else if (ev.type === 'text') {
      const chunk = ev.data || '';
      const sep = (!lastWasText && emittedText) ? '\n\n' : '';
      emit('text', { message: { content: [{ type: 'text', text: sep + chunk }] } });
      text += sep + chunk;
      textChars += String(chunk).length;
      if (chunk) { emittedText = true; lastWasText = true; }
    } else if (ev.type === 'end') {
      if (ev.sessionId) sessionId = ev.sessionId;
      const usage = (ev.usage && typeof ev.usage === 'object')
        ? ev.usage as Record<string, unknown>
        : (ev.stats && typeof ev.stats === 'object' ? ev.stats as Record<string, unknown> : null);
      if (usage) {
        emitCascadeStats(emit, statsFromUsageBlob(usage, { model }));
      } else if (thoughtChars > 0 || textChars > 0) {
        // Rough char-based estimate when the CLI omits usage — labeled approx in UI via raw counts.
        // ~4 chars/token is a common heuristic for Latin text.
        const approxIn = Math.max(1, Math.round((prompt.length) / 4));
        const approxOut = Math.max(0, Math.round((thoughtChars + textChars) / 4));
        emitCascadeStats(emit, {
          model,
          inputTokens: approxIn,
          outputTokens: approxOut,
        });
      }
    }
  };

  try {
    const summaryText = await driveProcess(GROK_BIN, args, cwd, onLine, () => text || 'Completed note operations successfully.', 'Grok', runId, emit, env);
    return { summary: summaryText, sessionId };
  } catch (error) {
    const diagnostic = extractGrokDiagnostic(debugFile);
    const base = error instanceof Error ? error.message : String(error);
    throw new Error(diagnostic ? `${base}\n\nGrok diagnostic:\n${diagnostic}` : base);
  } finally {
    try { fs.unlinkSync(debugFile); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// ANTIGRAVITY AGENT
// ═══════════════════════════════════════════════════════════════

/** agentapi only accepts these --model= tiers (not full IDE model enums). */
type AntigravityTier = 'flash_lite' | 'flash' | 'pro';
const ANTIGRAVITY_TIERS = new Set<string>(['flash_lite', 'flash', 'pro']);

/** Poll interval while watching transcript.jsonl. */
const AGY_POLL_MS = 400;
/**
 * Only treat "no new transcript lines" as done after a *final* planner
 * response (no tools). Mid-tool gaps used to kill runs at ~10s.
 */
const AGY_IDLE_AFTER_FINAL_POLLS = 8; // ~3.2s settle after final text
/** Hard ceiling if the agent stalls mid-tool forever (still far above old 10s). */
const AGY_STALL_POLLS = 450; // ~3 min with no new lines
/** Wait for transcript.jsonl after new-conversation / send-message. */
const AGY_TRANSCRIPT_WAIT_MS = 30_000;

type AgyTranscriptStep = {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
};

function antigravityBin(): string {
  return process.env.ANTIGRAVITY_BIN || path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
}

function antigravityTranscriptPath(conversationId: string): string {
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
}

/** Planner narration ("I will view…") is harness/thinking — not a chat reply. */
function agyIsPlannerMonologue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^I will\b/i.test(t)) return true;
  if (/^I(?:'ll| am going to)\b/i.test(t)) return true;
  if (/^Let me\b/i.test(t)) return true;
  return false;
}

function resolveAntigravityProjectConfigPath(cwd: string): string | null {
  const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  const absCwd = path.resolve(cwd);
  for (const file of fs.readdirSync(projectsDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(projectsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes(absCwd) || content.includes(`file://${absCwd}`)) return filePath;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Patch the Antigravity project config so Cascade hookup runs auto-approve
 * plans/commands instead of blocking on IDE permission prompts.
 */
function ensureAntigravityCascadeHookup(cwd: string, yolo?: boolean): void {
  const configPath = resolveAntigravityProjectConfigPath(cwd);
  if (!configPath) return;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }

  const settings = (data.settings as Record<string, unknown>) || {};
  settings.fileAccessPolicy = 'AGENT_SETTING_POLICY_ALLOW';
  settings.autoExecutionPolicy = 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER';
  settings.artifactReviewMode = 'ARTIFACT_REVIEW_MODE_TURBO';
  if (yolo) settings.internetPolicy = 'AGENT_SETTING_POLICY_ALLOW';
  data.settings = settings;

  const absCwd = path.resolve(cwd);
  const grants = new Set<string>();
  const existing = data.permissionGrants as { permissionGrants?: { allow?: string[] } } | undefined;
  for (const g of existing?.permissionGrants?.allow || []) grants.add(g);
  for (const prefix of ['read_file', 'write_file']) {
    grants.add(`${prefix}(${absCwd})`);
    grants.add(`${prefix}(${absCwd}/.env)`);
  }
  for (const cmd of ['npm', 'node', 'npx', 'agentapi', 'curl', 'rg', 'git', 'bash', 'sh', 'tsx', 'tsc']) {
    grants.add(`command(${cmd})`);
  }
  data.permissionGrants = { permissionGrants: { allow: [...grants] } };

  try {
    fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
  } catch { /* ignore */ }
}

/** Best-effort LS call to unblock pending plan/permission prompts. */
function agyLsPost(endpoint: string, body: Record<string, unknown>): boolean {
  const discovered = discoverAntigravityEnv();
  const addr = discovered.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_LS_ADDRESS;
  const token = discovered.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !token) return false;
  const host = addr.includes('://') ? addr : `http://${addr}`;
  const url = `${host.replace(/\/$/, '')}/exa.language_server_pb.LanguageServerService/${endpoint}`;
  try {
    const result = spawnSync(
      'curl',
      [
        '-sS', '-m', '4',
        '-X', 'POST', url,
        '-H', 'Content-Type: application/json',
        '-H', `X-Codeium-Csrf-Token: ${token}`,
        '-d', JSON.stringify(body),
      ],
      { encoding: 'utf8', timeout: 6000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function agyTryAutoApprove(conversationId: string): void {
  agyLsPost('ResolveOutstandingSteps', { cascadeId: conversationId });
}

/** Map UI / live model ids (slugs, enums, labels) to agentapi --model= tiers. */
export function resolveAntigravityModelTier(model?: string | null): AntigravityTier | undefined {
  if (!model || !String(model).trim()) return undefined;
  let raw = String(model).trim();
  // "id|label" live entries from listAntigravityModels
  if (raw.includes('|')) raw = raw.split('|')[0].trim();
  const lower = raw.toLowerCase();
  if (ANTIGRAVITY_TIERS.has(lower)) return lower as AntigravityTier;

  // GetAvailableModels slugs + enums + human labels.
  // Lite / extra-low → flash_lite
  if (
    /flash_lite|flash-lite|extra-low|flash.*\(low\)|m187\b|m50\b|gemini-2\.5-flash-lite|gemini-3\.1-flash-lite/i.test(raw)
  ) {
    return 'flash_lite';
  }
  // High flash / mid flash / generic flash → flash
  if (
    /flash.*\(high\)|flash.*\(medium\)|m132\b|m20\b|m18\b|m21\b|gemini-3-flash|gemini-3\.5-flash|gemini-2\.5-flash|gemini-3\.1-flash/i.test(raw)
    || lower === 'flash'
  ) {
    return 'flash';
  }
  // Pro family
  if (
    /gemini-2\.5-pro|gemini-3\.1-pro|gemini-pro|pro-high|pro-low|m36\b|m16\b|m37\b|\(high\)|\(low\)/i.test(raw)
    && /pro/i.test(raw)
  ) {
    return 'pro';
  }
  if (/\bpro\b/i.test(raw) && !/flash/i.test(raw)) return 'pro';
  // Claude / GPT-OSS / other cascade slots — agentapi only has tiers; use pro.
  if (/claude|opus|sonnet|gpt|oss|anthropic/i.test(raw)) return 'pro';
  if (/model_placeholder_m/i.test(raw)) return 'pro';
  return undefined;
}

/**
 * Discover Antigravity language_server HTTP address + CSRF + project id.
 * Prefer env, then /proc cmdline + language_server.log, then /proc environ.
 */
function discoverAntigravityEnv(cwd?: string): Record<string, string> {
  const env: Record<string, string> = { ANTIGRAVITY_AGENT: '1' };

  if (process.env.ANTIGRAVITY_PROJECT_ID) {
    env.ANTIGRAVITY_PROJECT_ID = process.env.ANTIGRAVITY_PROJECT_ID;
  } else {
    try {
      const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
      if (fs.existsSync(projectsDir)) {
        const files = fs.readdirSync(projectsDir);
        let projectId: string | undefined;
        const searchCwd = cwd ? path.resolve(cwd) : process.cwd();
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const filePath = path.join(projectsDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content) as { id?: string; name?: string };
            if (content.includes(searchCwd) || content.includes(`file://${searchCwd}`) || data.name === 'cascade') {
              projectId = data.id || file.replace(/\.json$/, '');
              break;
            }
          } catch { /* ignore */ }
        }
        if (!projectId) {
          const firstJson = files.find((f) => f.endsWith('.json'));
          if (firstJson) projectId = firstJson.replace(/\.json$/, '');
        }
        if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
      }
    } catch { /* ignore */ }
  }

  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    env.ANTIGRAVITY_LS_ADDRESS = process.env.ANTIGRAVITY_LS_ADDRESS;
    env.ANTIGRAVITY_CSRF_TOKEN = process.env.ANTIGRAVITY_CSRF_TOKEN;
    return env;
  }

  let token: string | undefined;
  let port: string | undefined;

  try {
    for (const file of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(file)) continue;
      try {
        const cmdline = fs.readFileSync(`/proc/${file}/cmdline`, 'utf-8');
        if (!cmdline.includes('language_server')) continue;
        const parts = cmdline.split('\0');
        const tokenIdx = parts.indexOf('--csrf_token');
        if (tokenIdx !== -1 && parts[tokenIdx + 1]) {
          token = parts[tokenIdx + 1];
          break;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  try {
    const logPath = path.join(os.homedir(), '.config', 'Antigravity', 'logs', 'language_server.log');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const matches = [...content.matchAll(/Language server listening on random port at (\d+) for HTTP/g)];
      if (matches.length > 0) port = matches[matches.length - 1][1];
    }
  } catch { /* ignore */ }

  // Validate log port is actually open; fall back to /proc/net/tcp listeners later if needed.
  if (port && token) {
    env.ANTIGRAVITY_LS_ADDRESS = `localhost:${port}`;
    env.ANTIGRAVITY_CSRF_TOKEN = token;
    return env;
  }

  try {
    for (const file of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(file)) continue;
      try {
        const envContent = fs.readFileSync(`/proc/${file}/environ`, 'utf-8');
        const parts = envContent.split('\0');
        const addrVar = parts.find((p) => p.startsWith('ANTIGRAVITY_LS_ADDRESS='));
        const tokenVar = parts.find((p) => p.startsWith('ANTIGRAVITY_CSRF_TOKEN='));
        if (addrVar && tokenVar) {
          env.ANTIGRAVITY_LS_ADDRESS = addrVar.slice('ANTIGRAVITY_LS_ADDRESS='.length);
          env.ANTIGRAVITY_CSRF_TOKEN = tokenVar.slice('ANTIGRAVITY_CSRF_TOKEN='.length);
          break;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return env;
}

type AgyModelEntry = { id: string; label: string; recommended?: boolean };

function agyLsJson(endpoint: string, body: Record<string, unknown> = {}): unknown | null {
  const discovered = discoverAntigravityEnv();
  const addr = discovered.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_LS_ADDRESS;
  const token = discovered.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !token) return null;
  const host = addr.includes('://') ? addr : `http://${addr}`;
  const url = `${host.replace(/\/$/, '')}/exa.language_server_pb.LanguageServerService/${endpoint}`;
  try {
    const result = spawnSync(
      'curl',
      [
        '-sS', '-m', '6',
        '-X', 'POST', url,
        '-H', 'Content-Type: application/json',
        '-H', `X-Codeium-Csrf-Token: ${token}`,
        '-d', JSON.stringify(body),
      ],
      { encoding: 'utf8', timeout: 8000 },
    );
    if (result.status !== 0 || !result.stdout?.trim()) return null;
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Full live catalog from Antigravity LS.
 * Prefer GetAvailableModels (complete map with slugs + displayName); merge
 * GetCascadeModelConfigData (recommended cascade picker rows) so nothing the
 * IDE shows is dropped. Entries are `id|label` for the desktop/UI merge.
 */
export function listAntigravityModels(): string[] {
  const byId = new Map<string, AgyModelEntry>();
  const add = (id: string, label: string, recommended = false) => {
    const cleanId = id.trim();
    const cleanLabel = (label || id).trim();
    if (!cleanId) return;
    // Skip autocomplete/tab-only internals.
    if (/^tab[_-]|tab_jump|tab_flash/i.test(cleanId) || /^tab[_-]/i.test(cleanLabel)) return;
    if (/^chat_\d+$/i.test(cleanId)) return;
    const prev = byId.get(cleanId);
    if (prev) {
      // Prefer richer label / recommended flag.
      if (cleanLabel.length > prev.label.length) prev.label = cleanLabel;
      if (recommended) prev.recommended = true;
      return;
    }
    byId.set(cleanId, { id: cleanId, label: cleanLabel, recommended });
  };

  // agentapi runnable tiers (always present even if LS is down).
  add('flash_lite', 'Gemini Flash Lite (agentapi tier)', true);
  add('flash', 'Gemini Flash (agentapi tier)', true);
  add('pro', 'Gemini Pro (agentapi tier)', true);

  // 1) Full registry — includes 2.5 Pro, 3 Flash, Flash Lite, Image, etc.
  const available = agyLsJson('GetAvailableModels') as {
    response?: { models?: Record<string, Record<string, unknown>> };
    models?: Record<string, Record<string, unknown>>;
  } | null;
  const modelMap = available?.response?.models || available?.models || {};
  for (const [slug, meta] of Object.entries(modelMap)) {
    if (!meta || typeof meta !== 'object') continue;
    const isInternal = Boolean(meta.isInternal ?? meta.is_internal);
    const displayName = String(meta.displayName || meta.display_name || '').trim();
    const enumId = String(meta.model || '').trim();
    const recommended = Boolean(meta.recommended ?? meta.isRecommended);
    // Keep public models (displayName) and recommended; drop nameless internals.
    if (isInternal && !displayName && !recommended) continue;
    if (!displayName && !recommended && isInternal) continue;
    const label = displayName || slug;
    // Prefer human slug as id when present; also index enum for resolve/mapping.
    add(slug, label, recommended);
    if (enumId && enumId !== slug) add(enumId, label, recommended);
  }

  // 2) Cascade picker rows (may include battle/recommended-only extras).
  const cascade = agyLsJson('GetCascadeModelConfigData') as {
    clientModelConfigs?: Array<{
      label?: string;
      isRecommended?: boolean;
      modelOrAlias?: { model?: string; alias?: string };
    }>;
    battleModeModelConfigs?: Array<{
      label?: string;
      isRecommended?: boolean;
      modelOrAlias?: { model?: string; alias?: string };
    }>;
  } | null;
  for (const cfg of [
    ...(cascade?.clientModelConfigs || []),
    ...(cascade?.battleModeModelConfigs || []),
  ]) {
    const label = (cfg.label || '').trim();
    const modelKey = (cfg.modelOrAlias?.model || cfg.modelOrAlias?.alias || '').trim();
    if (modelKey) add(modelKey, label || modelKey, Boolean(cfg.isRecommended));
    if (label) add(label, label, Boolean(cfg.isRecommended));
  }

  // Drop pure aliases: keep agentapi tiers + human slugs; drop MODEL_* enums
  // and bare label-as-id when a slug already covers the same label.
  const score = (e: AgyModelEntry): number => {
    if (ANTIGRAVITY_TIERS.has(e.id)) return 40;
    if (/^MODEL_/i.test(e.id)) return 10;
    if (e.id === e.label) return 5;
    if (/^[a-z0-9][a-z0-9._-]+$/i.test(e.id)) return 50; // slug
    return 20;
  };
  // Group by lowercase label; within a group keep all distinct slugs (they are
  // different model ids even when displayName collides), but only the best
  // non-slug alias.
  const groups = new Map<string, AgyModelEntry[]>();
  for (const e of byId.values()) {
    const lk = e.label.toLowerCase();
    const arr = groups.get(lk) || [];
    arr.push(e);
    groups.set(lk, arr);
  }
  const picked: AgyModelEntry[] = [];
  for (const [, group] of groups) {
    const slugs = group.filter((e) => /^[a-z0-9][a-z0-9._-]+$/i.test(e.id) && !/^MODEL_/i.test(e.id) && e.id !== e.label);
    if (slugs.length > 0) {
      // Distinct slug ids share a displayName — disambiguate labels with id.
      if (slugs.length === 1) {
        picked.push(slugs[0]);
      } else {
        for (const s of slugs) {
          picked.push({
            ...s,
            label: s.label.includes(s.id) ? s.label : `${s.label} · ${s.id}`,
          });
        }
      }
      continue;
    }
    group.sort((a, b) => score(b) - score(a));
    picked.push(group[0]);
  }

  // Stable order: agentapi tiers first, then recommended, then label alpha.
  const ordered = picked.sort((a, b) => {
    const aTier = ANTIGRAVITY_TIERS.has(a.id) ? 0 : 1;
    const bTier = ANTIGRAVITY_TIERS.has(b.id) ? 0 : 1;
    if (aTier !== bTier) return aTier - bTier;
    if (Boolean(a.recommended) !== Boolean(b.recommended)) return a.recommended ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return ordered.map((e) => (e.label && e.label !== e.id ? `${e.id}|${e.label}` : e.id));
}

function agyToolFriendlyName(name: string): string {
  const n = (name || '').trim();
  const map: Record<string, string> = {
    list_dir: 'List Directory',
    list_directory: 'List Directory',
    view_file: 'View File',
    write_to_file: 'Write File',
    replace_file_content: 'Edit File',
    multi_replace_file_content: 'Edit File',
    grep_search: 'Search Workspace',
    run_command: 'Bash',
    search_web: 'Web Search',
    code_action: 'Code Action',
    generate_image: 'Generate Image',
    invoke_subagent: 'Subagent',
    ask_question: 'Ask Question',
    read_browser_page: 'Browser',
    open_browser_url: 'Browser',
  };
  return map[n] || map[n.toLowerCase()] || n || 'Tool';
}

function agyPreviewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 200);
  if (typeof input !== 'object') return String(input).slice(0, 200);
  const rec = input as Record<string, unknown>;
  for (const key of ['Command', 'command', 'DirectoryPath', 'FilePath', 'file_path', 'path', 'Query', 'pattern', 'Url', 'url']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) {
      // agentapi sometimes double-quotes JSON string values
      return v.replace(/^"+|"+$/g, '').slice(0, 200);
    }
  }
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return '';
  }
}

function agyNormalizeToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const unquoted = v.replace(/^"+|"+$/g, '');
      out[k] = unquoted;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Spawn agentapi (or other) and capture stdout; tees to harness; tracks cancel. */
function runCommand(
  bin: string,
  args: string[],
  cwd: string,
  runId?: number,
  emit?: AgentEmit,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const discoveredEnv = discoverAntigravityEnv(cwd);
    const env = { ...(baseEnv || spawnEnv(runId)), ...discoveredEnv };

    if (!env.ANTIGRAVITY_LS_ADDRESS || !env.ANTIGRAVITY_CSRF_TOKEN) {
      reject(new Error(
        'Antigravity language server not found (ANTIGRAVITY_LS_ADDRESS / CSRF). '
        + 'Open the Antigravity app and sign in, then retry.',
      ));
      return;
    }

    emitHarness(emit, `\x1b[2m$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\x1b[0m\r\n`);
    emitHarness(emit, `\x1b[2m# antigravity ls ${env.ANTIGRAVITY_LS_ADDRESS} · project ${env.ANTIGRAVITY_PROJECT_ID || '?'}\x1b[0m\r\n`);

    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`Failed to launch agentapi: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (runId !== undefined) activeCliProcesses.set(runId, child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanup = () => {
      if (runId !== undefined) activeCliProcesses.delete(runId);
    };

    child.stdout?.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      stdout += chunk;
      // agentapi returns one JSON blob — keep harness tidy (no full prompt dump)
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      stderr += chunk;
      emitHarness(emit, `\x1b[31m${chunk}\x1b[0m`);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`agentapi could not start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      emitHarness(emit, `\x1b[2m# agentapi exit ${code ?? '?'}\x1b[0m\r\n`);
      if (code === 0) {
        resolve(stdout);
      } else {
        const detail = (stderr || stdout).trim().slice(-800);
        reject(new Error(`agentapi exited ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

/**
 * Runs the Antigravity agent via agentapi + transcript.jsonl polling.
 * Emits structured text/thinking/tool blocks for the chat harness panel
 * (not raw JSONL dumps).
 */
async function runAntigravity(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  runId?: number,
  db?: Db,
  model?: string,
  yolo?: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const bin = antigravityBin();
  assertCliAgentAvailable('antigravity');
  ensureAntigravityCascadeHookup(cwd, yolo);
  if (runId !== undefined) antigravityCancelFlags.delete(runId);

  // Snapshot line count before send-message so we only stream new turns.
  let processedLines = 0;
  if (resumeId) {
    const prior = antigravityTranscriptPath(resumeId);
    if (fs.existsSync(prior)) {
      processedLines = fs.readFileSync(prior, 'utf-8').split('\n').filter((l) => l.trim()).length;
    }
  }

  const tier = resolveAntigravityModelTier(model);
  const args: string[] = resumeId
    ? ['send-message', resumeId, prompt]
    : (() => {
        const a = ['new-conversation'];
        if (tier) a.push(`--model=${tier}`);
        a.push(prompt);
        return a;
      })();

  if (model && tier && model !== tier) {
    emitHarness(emit, `\x1b[2m# model ${model} → agentapi tier ${tier}\x1b[0m\r\n`);
  } else if (tier) {
    emitCascadeStats(emit, { model: tier });
  }

  let stdoutStr: string;
  try {
    stdoutStr = await runCommand(bin, args, cwd, runId, emit, env ? { ...spawnEnv(runId), ...env } : undefined);
  } catch (err) {
    throw new Error(`Failed to run agentapi: ${err instanceof Error ? err.message : String(err)}`);
  }

  let conversationId = '';
  try {
    const res = JSON.parse(stdoutStr) as {
      error?: string;
      response?: {
        newConversation?: { conversationId?: string };
        sendMessage?: { recipientId?: string };
      };
    };
    if (res.error) throw new Error(res.error);
    conversationId = res.response?.newConversation?.conversationId
      || res.response?.sendMessage?.recipientId
      || '';
  } catch (err) {
    if (err instanceof Error && !err.message.includes('JSON')) throw err;
    throw new Error(`Failed to parse agentapi JSON output: ${stdoutStr.slice(0, 500)}`);
  }
  if (!conversationId) {
    throw new Error(`No conversationId returned by agentapi: ${stdoutStr.slice(0, 500)}`);
  }

  emitHarness(emit, `\x1b[2m# conversation ${conversationId}\x1b[0m\r\n`);
  const transcriptPath = antigravityTranscriptPath(conversationId);

  // Wait for transcript file
  const waitDeadline = Date.now() + AGY_TRANSCRIPT_WAIT_MS;
  while (!fs.existsSync(transcriptPath)) {
    if (Date.now() > waitDeadline) {
      throw new Error(`Transcript file was not created at ${transcriptPath}`);
    }
    if (runId !== undefined && isAntigravityRunCanceled(runId, db)) {
      return { summary: 'Run canceled by user.', sessionId: conversationId };
    }
    await sleep(AGY_POLL_MS);
  }

  let summary = '';
  let done = false;
  let sawFinalPlanner = false;
  let idleAfterFinal = 0;
  let stallPolls = 0;
  let approvePolls = 0;
  const pendingToolIds: string[] = [];
  const emittedTools = new Set<string>();
  let emittedText = false;
  let lastStepType = '';

  const checkTranscript = (): void => {
    let content: string;
    try {
      content = fs.readFileSync(transcriptPath, 'utf-8');
    } catch {
      return;
    }
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length <= processedLines) {
      stallPolls += 1;
      if (sawFinalPlanner) {
        idleAfterFinal += 1;
        if (idleAfterFinal >= AGY_IDLE_AFTER_FINAL_POLLS) done = true;
      } else if (stallPolls >= AGY_STALL_POLLS) {
        emitHarness(emit, `\x1b[33m# stall timeout after ${Math.round((AGY_STALL_POLLS * AGY_POLL_MS) / 1000)}s with no transcript progress\x1b[0m\r\n`);
        done = true;
      }
      return;
    }

    stallPolls = 0;
    idleAfterFinal = 0;

    for (let i = processedLines; i < lines.length; i++) {
      let step: AgyTranscriptStep;
      try {
        step = JSON.parse(lines[i]) as AgyTranscriptStep;
      } catch {
        continue;
      }

      const source = step.source || '';
      const type = (step.type || '').toUpperCase();
      const status = (step.status || '').toUpperCase();
      lastStepType = type;

      // Skip system noise in structured stream (still ignore raw dump).
      if (type === 'CONVERSATION_HISTORY' || type === 'USER_INPUT' || type === 'SYSTEM_MESSAGE') {
        continue;
      }

      if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
        const text = (step.content || '').trim();
        const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        const isThinking = toolCalls.length > 0 || agyIsPlannerMonologue(text);

        if (text) {
          if (isThinking) {
            // Monologue before tools → thinking only (never chat body / summary).
            emit('text', {
              message: { content: [{ type: 'thinking', thinking: text }] },
            });
            emitHarness(emit, `\x1b[2m# thinking\x1b[0m\r\n\x1b[2m${text.slice(0, 500)}\x1b[0m\r\n`);
          } else {
            summary = text;
            const sep = emittedText ? '\n\n' : '';
            emit('text', {
              message: { content: [{ type: 'text', text: sep + text }] },
            });
            emittedText = true;
            emitHarness(emit, `${text}\r\n`);
          }
        }

        for (const tc of toolCalls) {
          const toolId = tc.id || `agy-${conversationId}-${step.step_index ?? i}-${pendingToolIds.length}`;
          if (emittedTools.has(toolId)) continue;
          emittedTools.add(toolId);
          pendingToolIds.push(toolId);
          const name = agyToolFriendlyName(tc.name || 'tool');
          const input = agyNormalizeToolArgs(tc.args);
          emit('text', {
            message: {
              content: [{ type: 'tool_use', id: toolId, name, input }],
            },
          });
          const preview = agyPreviewInput(input);
          emitHarness(emit, `\x1b[36m▶ ${name}\x1b[0m${preview ? ` ${preview}` : ''}\r\n`);
        }

        // True completion: planner finished with no more tools.
        if (status === 'DONE' && toolCalls.length === 0) {
          sawFinalPlanner = true;
        } else {
          sawFinalPlanner = false;
        }
        continue;
      }

      // Tool results and other model steps
      if (source === 'MODEL' || source === 'SYSTEM') {
        if (type === 'ERROR_MESSAGE' || status === 'ERROR') {
          const msg = String(step.content || 'Antigravity error').slice(0, 2000);
          if (/denied permission|pending review|user interaction|awaiting approval/i.test(msg)) {
            agyTryAutoApprove(conversationId);
          }
          emitHarness(emit, `\x1b[31m✖ ${msg}\x1b[0m\r\n`);
          const toolId = pendingToolIds.shift();
          if (toolId) {
            emit('user', {
              message: {
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolId,
                  content: truncate(msg, 8000),
                  is_error: true,
                }],
              },
            });
          }
          continue;
        }

        // Tool execution result steps (VIEW_FILE, RUN_COMMAND, …)
        if (type !== 'PLANNER_RESPONSE' && type !== 'EPHEMERAL_MESSAGE' && type !== 'CHECKPOINT') {
          const outText = String(step.content || '');
          const toolId = pendingToolIds.shift() || `agy-result-${step.step_index ?? i}`;
          const isError = status === 'ERROR';
          emit('user', {
            message: {
              content: [{
                type: 'tool_result',
                tool_use_id: toolId,
                content: truncate(outText, 8000),
                is_error: isError,
              }],
            },
          });
          const preview = outText.replace(/\s+/g, ' ').trim().slice(0, 160);
          emitHarness(emit, `${isError ? '\x1b[31m' : '\x1b[2m'}◀ ${type}${preview ? `: ${preview}` : ''}\x1b[0m\r\n`);
          sawFinalPlanner = false;
        }
      }
    }
    processedLines = lines.length;

    // If we already saw final planner and drained new lines, allow settle.
    if (sawFinalPlanner && pendingToolIds.length === 0) {
      idleAfterFinal = Math.max(idleAfterFinal, 1);
    }
  };

  while (!done) {
    if (runId !== undefined && isAntigravityRunCanceled(runId, db)) {
      return { summary: summary || 'Run canceled by user.', sessionId: conversationId };
    }
    // Desktop cancel kills the agentapi child; after that we only poll. Also
    // treat explicit cancel flag on the process map absence mid-wait as soft.
    try {
      checkTranscript();
    } catch { /* ignore single poll errors */ }
    approvePolls += 1;
    if (approvePolls % 15 === 0) agyTryAutoApprove(conversationId);
    if (!done) await sleep(AGY_POLL_MS);
  }

  if (!emittedText || !summary.trim() || agyIsPlannerMonologue(summary)) {
    summary = 'Done.';
  }

  emitHarness(emit, `\x1b[2m# done · ${processedLines} transcript lines\x1b[0m\r\n`);
  if (runId !== undefined) antigravityCancelFlags.delete(runId);
  return { summary, sessionId: conversationId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAntigravityRunCanceled(runId: number, db?: Db): boolean {
  // Cancel path: cancelLocalAgentRun kills the child; desktop also finishes
  // the run as canceled. Check DB when available; otherwise check process map
  // was force-cleared with a sentinel — we use a side map.
  if (antigravityCancelFlags.has(runId)) return true;
  if (!db) return false;
  try {
    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status?: string } | undefined;
    return row?.status === 'canceled' || row?.status === 'failed';
  } catch {
    return false;
  }
}

/** Set by cancel hooks so transcript polling stops promptly. */
const antigravityCancelFlags = new Set<number>();

/** Allow desktop cancel to stop transcript polling without a live child. */
export function cancelAntigravityRun(runId: number): void {
  antigravityCancelFlags.add(runId);
  const child = activeCliProcesses.get(runId);
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    activeCliProcesses.delete(runId);
  }
}

// ═══════════════════════════════════════════════════════════════
// COPILOT AGENT
// ═══════════════════════════════════════════════════════════════

/**
 * Runs the Copilot CLI and translates its JSONL event stream into content blocks.
 */
async function runCopilot(prompt: string, cwd: string, emit: AgentEmit, resumeId?: string, runId?: number, model?: string, env?: NodeJS.ProcessEnv): Promise<CliAgentResult> {
  const modelArgs = model ? ['--model', model] : [];
  const baseArgs = ['-p', prompt, '--output-format', 'json', '--yolo', ...modelArgs];
  const args = resumeId ? ['--session-id', resumeId, ...baseArgs] : baseArgs;

  let summary = '';
  let reasoningText = '';
  let sessionId: string | undefined;
  const emittedTool = new Set<string>();
  // Separate each answer turn from the previous one; reasoning/tool events
  // between turns reset the flag so the next text starts a new paragraph.
  let emittedText = false;
  let lastWasText = false;

  const getToolFriendlyName = (name: string) => {
    if (name === 'read' || name === 'view_file') return 'View File';
    if (name === 'write' || name === 'write_to_file' || name === 'create') return 'Write File';
    if (name === 'edit' || name === 'replace_file_content' || name === 'multi_replace_file_content') return 'Edit File';
    if (name === 'grep' || name === 'grep_search') return 'Search Workspace';
    if (name === 'bash' || name === 'run_command') return 'Bash';
    return name;
  };

  const onLine = (line: string) => {
    try {
      if (line.startsWith('{')) {
        const ev = JSON.parse(line);
        switch (ev.type) {
          case 'assistant.reasoning_delta':
            if (ev.data?.deltaContent) {
              reasoningText += ev.data.deltaContent;
              emit('text', { message: { content: [{ type: 'thinking', thinking: ev.data.deltaContent }] } });
              lastWasText = false;
            }
            break;
          case 'assistant.reasoning':
            if (ev.data?.content) {
              const hadDeltas = reasoningText.length > 0;
              reasoningText = ev.data.content;
              if (!hadDeltas) {
                emit('text', { message: { content: [{ type: 'thinking', thinking: ev.data.content }] } });
              }
              lastWasText = false;
            }
            break;
          case 'assistant.message_delta':
            if (ev.data?.deltaContent) {
              const sep = (!lastWasText && emittedText) ? '\n\n' : '';
              summary += sep + ev.data.deltaContent;
              emit('text', { message: { content: [{ type: 'text', text: sep + ev.data.deltaContent }] } });
              emittedText = true;
              lastWasText = true;
            }
            break;
          case 'assistant.message':
            if (ev.data) {
              if (ev.data.content) {
                const hadDeltas = summary.length > 0;
                summary = ev.data.content;
                if (!hadDeltas) {
                  const sep = (!lastWasText && emittedText) ? '\n\n' : '';
                  emit('text', { message: { content: [{ type: 'text', text: sep + ev.data.content }] } });
                  emittedText = true;
                  lastWasText = true;
                }
              }
              for (const req of ev.data.toolRequests || []) {
                if (req.toolCallId && !emittedTool.has(req.toolCallId)) {
                  emittedTool.add(req.toolCallId);
                  emit('text', {
                    message: {
                      content: [{
                        type: 'tool_use',
                        id: req.toolCallId,
                        name: getToolFriendlyName(req.name),
                        input: req.arguments || {}
                      }]
                    }
                  });
                  lastWasText = false;
                }
              }
            }
            break;
          case 'tool.execution_start':
            if (ev.data?.toolCallId && !emittedTool.has(ev.data.toolCallId)) {
              emittedTool.add(ev.data.toolCallId);
              emit('text', {
                message: {
                  content: [{
                    type: 'tool_use',
                    id: ev.data.toolCallId,
                    name: getToolFriendlyName(ev.data.toolName),
                    input: ev.data.arguments || {}
                  }]
                }
              });
              lastWasText = false;
            }
            break;
          case 'tool.execution_complete':
            if (ev.data?.toolCallId) {
              const out = ev.data.result?.content ?? ev.data.result?.detailedContent ?? '';
              const isError = ev.data.success === false;
              emit('user', {
                message: {
                  content: [{
                    type: 'tool_result',
                    tool_use_id: ev.data.toolCallId,
                    content: truncate(String(out), 8000),
                    is_error: isError
                  }]
                }
              });
              lastWasText = false;
            }
            break;
          case 'result':
            if (ev.sessionId) sessionId = ev.sessionId;
            break;
        }
      } else {
        summary = line;
        emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
      }
    } catch {
      summary = line;
      emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
    }
  };

  const summaryText = await driveProcess(COPILOT_BIN, args, cwd, onLine, () => summary || 'Completed note operations successfully.', 'Copilot', runId, emit, env);
  return { summary: summaryText, sessionId: sessionId || resumeId };
}

// ═══════════════════════════════════════════════════════════════
// HERMES AGENT
// ═══════════════════════════════════════════════════════════════

/**
 * Runs the Hermes CLI (`hermes -z`) and translates its output into content blocks.
 *
 * Hermes oneshot keeps stdout machine-readable (final answer only). With
 * `HERMES_CASCADE_EVENTS=1` it also streams reasoning deltas as NDJSON on stderr:
 *   - `reasoning.delta` → `{ type: 'thinking', thinking }`
 *   - `session_id`      → captured for conversation resume
 */
async function runHermes(prompt: string, cwd: string, emit: AgentEmit, resumeId?: string, runId?: number, env?: NodeJS.ProcessEnv): Promise<CliAgentResult> {
  const baseArgs = ['-z', prompt, '--yolo'];
  const args = resumeId ? ['-r', resumeId, ...baseArgs] : baseArgs;

  let text = '';
  let sessionId: string | undefined = resumeId;

  const onStdoutLine = (line: string) => {
    text += line + '\n';
    // Keep the line break so multi-line output doesn't collapse onto one line.
    emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
  };

  const onStderrLine = (line: string) => {
    if (!line.startsWith('{')) return;
    const ev = JSON.parse(line) as { type?: string; text?: string; id?: string };
    if (ev.type === 'reasoning.delta' && ev.text) {
      emit('text', { message: { content: [{ type: 'thinking', thinking: ev.text }] } });
    } else if (ev.type === 'session_id' && ev.id) {
      sessionId = ev.id;
    }
  };

  const summaryText = await driveHermesProcess(
    HERMES_BIN,
    args,
    cwd,
    onStdoutLine,
    onStderrLine,
    () => text.trim() || 'Completed note operations successfully.',
    'Hermes',
    runId,
    emit,
    env,
  );
  return { summary: summaryText, sessionId };
}

/** Like driveProcess, but also parses Hermes cascade NDJSON events from stderr. */
function driveHermesProcess(
  bin: string,
  args: string[],
  cwd: string,
  onStdoutLine: (line: string) => void,
  onStderrLine: (line: string) => void,
  getSummary: () => string,
  label: string,
  runId?: number,
  emit?: AgentEmit,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(env ? { ...spawnEnv(runId), ...env } : spawnEnv(runId)), HERMES_CASCADE_EVENTS: '1' },
      });
      if (runId !== undefined) {
        activeCliProcesses.set(runId, child);
      }
    } catch (err) {
      reject(new Error(`Failed to launch ${label} ('${bin}'): ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const cleanUpProcess = () => {
      if (runId !== undefined) {
        activeCliProcesses.delete(runId);
      }
    };

    emitHarness(emit, `\x1b[2m$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\x1b[0m\r\n`);
    emitHarness(emit, `\x1b[2m# cwd ${cwd}\x1b[0m\r\n`);

    let stderr = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanUpProcess();
        child.kill('SIGTERM');
        reject(new Error(`${label} timed out after ${CLI_TIMEOUT_MS}ms`));
      }
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      emitHarness(emit, chunk);
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const trimmed = line.trim();
        if (trimmed) {
          try { onStdoutLine(trimmed); } catch { /* ignore a single malformed line */ }
        }
        nl = stdoutBuf.indexOf('\n');
      }
    });

    child.stderr.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      emitHarness(emit, `\x1b[31m${chunk}\x1b[0m`);
      stderrBuf += chunk;
      let nl = stderrBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed) {
          nl = stderrBuf.indexOf('\n');
          continue;
        }
        if (trimmed.startsWith('{')) {
          try { onStderrLine(trimmed); } catch { /* ignore a single malformed event */ }
        } else {
          stderr += trimmed + '\n';
        }
        nl = stderrBuf.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanUpProcess();
      reject(new Error(`${label} ('${bin}') could not be started: ${err.message}. Is it installed and on PATH?`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanUpProcess();
      const trailingOut = stdoutBuf.trim();
      if (trailingOut) {
        try { onStdoutLine(trailingOut); } catch { /* ignore */ }
      }
      const trailingErr = stderrBuf.trim();
      if (trailingErr) {
        if (trailingErr.startsWith('{')) {
          try { onStderrLine(trailingErr); } catch { /* ignore */ }
        } else {
          stderr += trailingErr + '\n';
        }
      }
      emitHarness(emit, `\x1b[2m# exit ${code ?? '?'}\x1b[0m\r\n`);
      if (code === 0) {
        resolve(getSummary());
      } else {
        const detail = stderr.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`${label} exited with code ${code}.${detail ? `\n${detail}` : ''}`));
      }
    });
  });
}
// ═══════════════════════════════════════════════════════════════
// OMP AGENT
// ═══════════════════════════════════════════════════════════════

/**
 * Runs the OMP CLI and translates its JSONL event stream into content blocks.
 */
async function runOmp(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  images: CliImage[] = [],
  runId?: number,
  model?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const { paths: imagePaths, cleanup } = writeTempImages(images);
  const imageArgs = imagePaths.map((p) => `@${p}`);
  const modelArgs = model ? ['--model', model] : [];
  const baseArgs = [prompt, '--mode', 'json', '--allow-home', ...imageArgs, ...modelArgs];
  const args = resumeId ? ['--resume', resumeId, ...baseArgs] : baseArgs;

  let summary = '';
  let reasoningText = '';
  let sessionId: string | undefined = resumeId;
  const emittedTool = new Set<string>();
  let emittedText = false;
  let lastWasText = false;

  const getToolFriendlyName = (name: string) => {
    if (name === 'read' || name === 'view_file') return 'View File';
    if (name === 'write' || name === 'write_to_file' || name === 'create') return 'Write File';
    if (name === 'edit' || name === 'replace_file_content' || name === 'multi_replace_file_content') return 'Edit File';
    if (name === 'grep' || name === 'grep_search') return 'Search Workspace';
    if (name === 'bash' || name === 'run_command') return 'Bash';
    return name;
  };

  const onLine = (line: string) => {
    try {
      if (line.startsWith('{')) {
        const ev = JSON.parse(line);
        switch (ev.type) {
          case 'session':
            if (ev.id) sessionId = ev.id;
            break;
          case 'message_update':
            if (ev.assistantMessageEvent) {
              const ame = ev.assistantMessageEvent;
              if (ame.type === 'thinking_delta' && ame.delta) {
                reasoningText += ame.delta;
                emit('text', { message: { content: [{ type: 'thinking', thinking: ame.delta }] } });
                lastWasText = false;
              } else if (ame.type === 'text_delta' && ame.delta) {
                const sep = (!lastWasText && emittedText) ? '\n\n' : '';
                summary += sep + ame.delta;
                emit('text', { message: { content: [{ type: 'text', text: sep + ame.delta }] } });
                emittedText = true;
                lastWasText = true;
              } else if (ame.type === 'toolcall_end' && ame.toolCall) {
                const tc = ame.toolCall;
                if (tc.id && !emittedTool.has(tc.id)) {
                  emittedTool.add(tc.id);
                  emit('text', {
                    message: {
                      content: [{
                        type: 'tool_use',
                        id: tc.id,
                        name: getToolFriendlyName(tc.name),
                        input: tc.arguments || {}
                      }]
                    }
                  });
                  lastWasText = false;
                }
              }
            }
            break;
          case 'tool_execution_start':
            if (ev.toolCallId && !emittedTool.has(ev.toolCallId)) {
              emittedTool.add(ev.toolCallId);
              emit('text', {
                message: {
                  content: [{
                    type: 'tool_use',
                    id: ev.toolCallId,
                    name: getToolFriendlyName(ev.toolName),
                    input: ev.args || {}
                  }]
                }
              });
              lastWasText = false;
            }
            break;
          case 'tool_execution_end':
            if (ev.toolCallId) {
              const out = ev.result?.content ?? ev.result?.detailedContent ?? '';
              let contentText = '';
              if (Array.isArray(out)) {
                contentText = out.map(o => typeof o === 'object' && o !== null ? (o.text || JSON.stringify(o)) : String(o)).join('\n');
              } else if (typeof out === 'string') {
                contentText = out;
              } else if (out && typeof out === 'object') {
                contentText = JSON.stringify(out);
              }
              const isError = ev.isError === true || ev.success === false;
              emit('user', {
                message: {
                  content: [{
                    type: 'tool_result',
                    tool_use_id: ev.toolCallId,
                    content: truncate(String(contentText || out), 8000),
                    is_error: isError
                  }]
                }
              });
              lastWasText = false;
            }
            break;
        }
      }
    } catch {
      // ignore
    }
  };

  try {
    const summaryText = await driveProcess(
      OMP_BIN,
      args,
      cwd,
      onLine,
      () => summary || 'Completed note operations successfully.',
      'OMP',
      runId,
      emit,
      env
    );
    return { summary: summaryText, sessionId };
  } finally {
    cleanup();
  }
}

/**
 * Returns available models from OMP CLI.
 */
export function listOmpModels(): string[] {
  try {
    const bin = getCliAgentBin('omp');
    const result = spawnSync(bin, ['models'], {
      encoding: 'utf8',
      timeout: 5000,
      env: process.env,
    });
    if (result.status === 0 && result.stdout) {
      const ids: string[] = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*[│|]\s*([a-zA-Z0-9._-]+)\s*[│|]/);
        if (m) {
          const modelId = m[1].trim();
          if (modelId !== 'model' && !modelId.startsWith('──')) {
            ids.push(modelId);
          }
        }
      }
      return ids;
    }
  } catch {
    // ignore
  }
  return [];
}
