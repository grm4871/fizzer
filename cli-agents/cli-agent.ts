/**
 * @file cli-agent.ts — local Codex/Grok/Antigravity/Copilot CLI wrappers
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
 * @module cli-agents/cli-agent
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

type Db = Database.Database;

export const activeCliProcesses = new Map<number, ChildProcess>();

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type AgentEmit = (type: 'text' | 'user', payload: unknown) => void;
export type CliImage = { media_type: string; data: string };

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

export type CliAgentId = 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes';

const CLI_AGENT_LABELS: Record<CliAgentId, string> = {
  codex: 'Codex',
  grok: 'Grok',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  hermes: 'Hermes',
};

export function isCliAgent(agent: string): agent is CliAgentId {
  return agent === 'codex' || agent === 'grok' || agent === 'antigravity' || agent === 'copilot' || agent === 'hermes';
}

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
  agent: 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes';
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
  } else {
    return runAntigravity(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.db, opts.model, opts.env);
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
function driveProcess(
  bin: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  getSummary: () => string,
  label: string,
  runId?: number,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
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

    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanUpProcess();
        child.kill('SIGTERM');
        reject(new Error(`${label} timed out after ${CLI_TIMEOUT_MS}ms`));
      }
    }, CLI_TIMEOUT_MS);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try { onLine(trimmed); } catch { /* ignore a single malformed line */ }
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); });

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
  const emittedTool = new Set<string>();
  const isToolItem = (type: string) => type !== 'agent_message' && type !== 'reasoning';

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
      // turn.started / turn.completed carry no renderable content.
    }
  };

  try {
    const summaryText = await driveProcess(CODEX_BIN, args, cwd, onLine, () => summary || 'Completed note operations successfully.', 'Codex', runId, env);
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

  const onLine = (line: string) => {
    const ev = JSON.parse(line);
    if (ev.type === 'thought') {
      emit('text', { message: { content: [{ type: 'thinking', thinking: ev.data || '' }] } });
      lastWasText = false;
    } else if (ev.type === 'text') {
      const chunk = ev.data || '';
      const sep = (!lastWasText && emittedText) ? '\n\n' : '';
      emit('text', { message: { content: [{ type: 'text', text: sep + chunk }] } });
      text += sep + chunk;
      if (chunk) { emittedText = true; lastWasText = true; }
    } else if (ev.type === 'end') {
      if (ev.sessionId) sessionId = ev.sessionId;
    }
  };

  try {
    const summaryText = await driveProcess(GROK_BIN, args, cwd, onLine, () => text || 'Completed note operations successfully.', 'Grok', runId, env);
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

/**
 * Dynamically discovers the active Antigravity language server address, CSRF token,
 * project ID, and agent mode by scanning process information and config files.
 */
function discoverAntigravityEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  // Discover and set ANTIGRAVITY_PROJECT_ID
  if (process.env.ANTIGRAVITY_PROJECT_ID) {
    env['ANTIGRAVITY_PROJECT_ID'] = process.env.ANTIGRAVITY_PROJECT_ID;
  } else {
    try {
      const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
      if (fs.existsSync(projectsDir)) {
        const files = fs.readdirSync(projectsDir);
        let projectId: string | undefined;
        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              const filePath = path.join(projectsDir, file);
              const content = fs.readFileSync(filePath, 'utf-8');
              const data = JSON.parse(content);
              const cwdUri = `file://${process.cwd()}`;
              const matchesCwd = content.includes(cwdUri) || content.includes(process.cwd());
              if (matchesCwd || data.name === 'cascade') {
                projectId = data.id;
                break;
              }
            } catch {
              // ignore
            }
          }
        }
        if (!projectId && files.length > 0) {
          const firstJson = files.find(f => f.endsWith('.json'));
          if (firstJson) {
            projectId = firstJson.replace('.json', '');
          }
        }
        if (projectId) {
          env['ANTIGRAVITY_PROJECT_ID'] = projectId;
        }
      }
    } catch (err) {
      console.error('Error discovering Antigravity project ID:', err);
    }
  }

  // Always set agent flag for agentapi executions
  env['ANTIGRAVITY_AGENT'] = '1';

  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    env['ANTIGRAVITY_LS_ADDRESS'] = process.env.ANTIGRAVITY_LS_ADDRESS;
    env['ANTIGRAVITY_CSRF_TOKEN'] = process.env.ANTIGRAVITY_CSRF_TOKEN;
    return env;
  }

  let token: string | undefined;

  // 1. Scan /proc/*/cmdline to find the CSRF token (cmdline is readable without ptrace scopes)
  try {
    const files = fs.readdirSync('/proc');
    for (const file of files) {
      if (/^\d+$/.test(file)) {
        try {
          const cmdline = fs.readFileSync(`/proc/${file}/cmdline`, 'utf-8');
          if (cmdline.includes('language_server')) {
            const parts = cmdline.split('\0');
            const tokenIdx = parts.indexOf('--csrf_token');
            if (tokenIdx !== -1 && tokenIdx + 1 < parts.length && parts[tokenIdx + 1]) {
              token = parts[tokenIdx + 1];
              break;
            }
          }
        } catch {
          // ignore processes we cannot read
        }
      }
    }
  } catch (err) {
    console.error('Error scanning /proc/*/cmdline:', err);
  }

  // 2. Scan language_server.log for the HTTP port
  let port: string | undefined;
  try {
    const logPath = path.join(os.homedir(), '.config', 'Antigravity', 'logs', 'language_server.log');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const matches = [...content.matchAll(/Language server listening on random port at (\d+) for HTTP/g)];
      if (matches.length > 0) {
        port = matches[matches.length - 1][1];
      }
    }
  } catch (err) {
    console.error('Error reading language_server.log:', err);
  }

  if (port && token) {
    env['ANTIGRAVITY_LS_ADDRESS'] = `localhost:${port}`;
    env['ANTIGRAVITY_CSRF_TOKEN'] = token;
    return env;
  }

  // Fallback: Scan /proc/*/environ (works if ptrace_scope is disabled)
  try {
    const files = fs.readdirSync('/proc');
    for (const file of files) {
      if (/^\d+$/.test(file)) {
        try {
          const envContent = fs.readFileSync(`/proc/${file}/environ`, 'utf-8');
          const parts = envContent.split('\0');
          const addrVar = parts.find(p => p.startsWith('ANTIGRAVITY_LS_ADDRESS='));
          const tokenVar = parts.find(p => p.startsWith('ANTIGRAVITY_CSRF_TOKEN='));
          if (addrVar && tokenVar) {
            env['ANTIGRAVITY_LS_ADDRESS'] = addrVar.split('=')[1];
            env['ANTIGRAVITY_CSRF_TOKEN'] = tokenVar.split('=')[1];
            break;
          }
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    // ignore
  }

  return env;
}

/**
 * Helper to run a command and return stdout as string.
 */
function runCommandWithEnv(bin: string, args: string[], cwd: string, baseEnv?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const discoveredEnv = discoverAntigravityEnv();
    const env = { ...(baseEnv || process.env), ...discoveredEnv };

    const logFile = '/home/jt/Desktop/cascade/debug.log';
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] In-App Executing: ${bin} ${args.join(' ')}\n`);
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] Discovered Env: ${JSON.stringify(discoveredEnv)}\n`);
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] Env: LS_ADDRESS=${env.ANTIGRAVITY_LS_ADDRESS}, CSRF_TOKEN=${env.ANTIGRAVITY_CSRF_TOKEN}\n`);

    const child = spawn(bin, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Spawn Error: ${err.message}\n`);
      reject(err);
    });
    child.on('close', (code) => {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Exit Code: ${code}\n`);
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Stdout: ${stdout.trim()}\n`);
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Stderr: ${stderr.trim()}\n`);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Exit code ${code}: ${stderr}`));
      }
    });
  });
}

/**
 * Runs the Antigravity agent using the `agentapi` language server wrapper commands.
 * Polls the generated `transcript.jsonl` file to stream assistant reasoning and responses.
 *
 * @param prompt   - Full prompt (context + user prompt)
 * @param cwd      - Vault root path
 * @param emit     - Event emitter callback
 * @param resumeId - Optional session id to resume a prior conversation
 * @returns Summary text and session id
 */
async function runAntigravity(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  runId?: number,
  db?: Db,
  model?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const bin = process.env.ANTIGRAVITY_BIN || path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');

  const transcriptPathFor = (conversationId: string) => path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );

  // On resume the transcript already holds the full prior conversation. Snapshot
  // the line count *before* send-message so we only stream new turns — otherwise
  // we replay the last reply and exit early on an old DONE step.
  let processedLines = 0;
  if (resumeId) {
    const priorTranscript = transcriptPathFor(resumeId);
    if (fs.existsSync(priorTranscript)) {
      const content = fs.readFileSync(priorTranscript, 'utf-8');
      processedLines = content.split('\n').filter((line) => line.trim()).length;
    }
  }

  let args: string[] = [];
  if (resumeId) {
    args = ['send-message', resumeId, prompt];
  } else {
    args = ['new-conversation'];
    if (model) {
      args.push(`--model=${model}`);
    }
    args.push(prompt);
  }

  let stdoutStr: string;
  try {
    stdoutStr = await runCommandWithEnv(bin, args, cwd, env);
  } catch (err) {
    throw new Error(`Failed to run agentapi: ${err instanceof Error ? err.message : String(err)}`);
  }

  let conversationId = '';
  try {
    const res = JSON.parse(stdoutStr);
    if (res.response?.newConversation?.conversationId) {
      conversationId = res.response.newConversation.conversationId;
    } else if (res.response?.sendMessage?.recipientId) {
      conversationId = res.response.sendMessage.recipientId;
    }
  } catch (err) {
    throw new Error(`Failed to parse agentapi JSON output: ${stdoutStr}`);
  }

  if (!conversationId) {
    throw new Error(`No conversationId returned by agentapi: ${stdoutStr}`);
  }

  const transcriptPath = transcriptPathFor(conversationId);

  let summary = 'Completed note operations successfully.';
  let done = false;
  let isChecking = false;
  let noNewLinesCount = 0;

  // Wait for the transcript.jsonl file to exist
  let exists = false;
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(transcriptPath)) {
      exists = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!exists) {
    throw new Error(`Transcript file was not created at ${transcriptPath}`);
  }

  const transcriptBaseline = processedLines;

  const getToolFriendlyName = (name: string) => {
    if (name === 'list_dir') return 'List Directory';
    if (name === 'view_file') return 'View File';
    if (name === 'write_to_file') return 'Write File';
    if (name === 'replace_file_content') return 'Edit File';
    if (name === 'multi_replace_file_content') return 'Edit File';
    if (name === 'grep_search') return 'Search Workspace';
    if (name === 'run_command') return 'Bash';
    return name;
  };

  const emittedTools = new Set<string>();
  let emittedText = false; // prefix a paragraph break before later turns' text

  const checkTranscript = async () => {
    if (isChecking) return;
    isChecking = true;

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      
      if (lines.length > processedLines) {
        noNewLinesCount = 0;

        for (let i = processedLines; i < lines.length; i++) {
          const step = JSON.parse(lines[i]);
          
          if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
            const text = step.content || '';
            const toolCalls = step.tool_calls || [];
            
            if (text) {
              summary = text;
              emit('text', { message: { content: [{ type: 'text', text: (emittedText ? '\n\n' : '') + text }] } });
              emittedText = true;
            }

            for (const tc of toolCalls) {
              const toolId = tc.id || `tc-${step.step_index}`;
              if (!emittedTools.has(toolId)) {
                emittedTools.add(toolId);
                const friendlyName = getToolFriendlyName(tc.name);
                emit('text', {
                  message: {
                    content: [{
                      type: 'tool_use',
                      id: toolId,
                      name: friendlyName,
                      input: tc.args || {}
                    }]
                  }
                });
              }
            }

            if (step.status === 'DONE' && toolCalls.length === 0) {
              done = true;
            }
          } else if (step.source === 'MODEL' && step.type !== 'USER_INPUT' && step.type !== 'CONVERSATION_HISTORY' && step.type !== 'SYSTEM_MESSAGE') {
            const toolId = `tc-${step.step_index - 1}`;
            const outText = step.content || '';
            const isError = step.status === 'ERROR' || step.type === 'ERROR_MESSAGE';
            emit('user', {
              message: {
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolId,
                  content: truncate(String(outText), 8000),
                  is_error: isError
                }]
              }
            });
          }
        }
        processedLines = lines.length;
      } else {
        noNewLinesCount++;
      }

      if (done || (processedLines > transcriptBaseline && noNewLinesCount >= 20)) {
        done = true;
      }
    } catch (err) {
      // ignore read/parse errors
    } finally {
      isChecking = false;
    }
  };

  while (!done) {
    if (db && runId !== undefined) {
      const currentRun = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string } | undefined;
      if (currentRun && currentRun.status === 'failed') {
        done = true;
        break;
      }
    }
    await checkTranscript();
    if (!done) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return {
    summary,
    sessionId: conversationId
  };
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

  const summaryText = await driveProcess(COPILOT_BIN, args, cwd, onLine, () => summary || 'Completed note operations successfully.', 'Copilot', runId, env);
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
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(env || process.env), HERMES_CASCADE_EVENTS: '1' },
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

    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanUpProcess();
        child.kill('SIGTERM');
        reject(new Error(`${label} timed out after ${CLI_TIMEOUT_MS}ms`));
      }
    }, CLI_TIMEOUT_MS);

    const stdoutRl = readline.createInterface({ input: child.stdout });
    stdoutRl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try { onStdoutLine(trimmed); } catch { /* ignore a single malformed line */ }
    });

    const stderrRl = readline.createInterface({ input: child.stderr });
    stderrRl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('{')) {
        try { onStderrLine(trimmed); } catch { /* ignore a single malformed event */ }
      } else {
        stderr += trimmed + '\n';
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
      if (code === 0) {
        resolve(getSummary());
      } else {
        const detail = stderr.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`${label} exited with code ${code}.${detail ? `\n${detail}` : ''}`));
      }
    });
  });
}
