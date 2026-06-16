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

import { spawn, type ChildProcess } from 'node:child_process';
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

/** Binary names are overridable in case they are not on the server's PATH. */
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const GROK_BIN = process.env.GROK_BIN || 'grok';

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
  // The CLIs are full agents in their own right; we only prepend a short
  // context line (which note is open), then pass the user's prompt verbatim.
  const prompt = opts.context
    ? `[Context: ${opts.context}]\n\n${opts.userPrompt}`
    : opts.userPrompt;
  if (opts.agent === 'codex') {
    return runCodex(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [], opts.runId, opts.model);
  } else if (opts.agent === 'grok') {
    return runGrok(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.model);
  } else if (opts.agent === 'copilot') {
    return runCopilot(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.model);
  } else if (opts.agent === 'hermes') {
    return runHermes(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId);
  } else {
    return runAntigravity(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.db, opts.model);
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
): Promise<CliAgentResult> {
  const { paths: imagePaths, cleanup } = writeTempImages(images);
  // `-i/--image` is variadic, so it must come AFTER the positional prompt (and
  // session id on resume) or it swallows them. `codex exec resume` rejects
  // --sandbox, so the sandbox mode is set via -c instead.
  const imageArgs = imagePaths.flatMap((p) => ['-i', p]);
  const modelArgs = model ? ['--model', model] : [];
  const args = resumeId
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', ...modelArgs, resumeId, prompt, ...imageArgs]
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...modelArgs, prompt, ...imageArgs];

  let summary = '';
  let sessionId: string | undefined;
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
          emit('text', { message: { content: [{ type: 'text', text: item.text || '' }] } });
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
    const summaryText = await driveProcess(CODEX_BIN, args, cwd, onLine, () => summary || 'Completed note operations successfully.', 'Codex', runId);
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
): Promise<CliAgentResult> {
  const modelArgs = model ? ['--model', model] : [];
  const baseArgs = ['--single', prompt, '--output-format', 'streaming-json', '--always-approve', '--cwd', cwd, ...modelArgs];
  const args = resumeId ? ['--resume', resumeId, ...baseArgs] : baseArgs;

  let text = '';
  let sessionId: string | undefined;

  const onLine = (line: string) => {
    const ev = JSON.parse(line);
    if (ev.type === 'thought') {
      emit('text', { message: { content: [{ type: 'thinking', thinking: ev.data || '' }] } });
    } else if (ev.type === 'text') {
      emit('text', { message: { content: [{ type: 'text', text: ev.data || '' }] } });
      text += ev.data || '';
    } else if (ev.type === 'end') {
      if (ev.sessionId) sessionId = ev.sessionId;
    }
  };

  const summaryText = await driveProcess(GROK_BIN, args, cwd, onLine, () => text || 'Completed note operations successfully.', 'Grok', runId);
  return { summary: summaryText, sessionId };
}

// ═══════════════════════════════════════════════════════════════
// ANTIGRAVITY AGENT
// ═══════════════════════════════════════════════════════════════

/**
 * Helper to run a command and return stdout as string.
 */
function runCommand(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
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
): Promise<CliAgentResult> {
  const bin = process.env.ANTIGRAVITY_BIN || path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
  
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
    stdoutStr = await runCommand(bin, args, cwd);
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

  const transcriptPath = path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );

  let processedLines = 0;
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
              emit('text', { message: { content: [{ type: 'text', text }] } });
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

      if (done || (processedLines > 2 && noNewLinesCount >= 20)) {
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

const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';

/**
 * Runs the Copilot CLI and translates its JSONL event stream into content blocks.
 */
async function runCopilot(prompt: string, cwd: string, emit: AgentEmit, resumeId?: string, runId?: number, model?: string): Promise<CliAgentResult> {
  const modelArgs = model ? ['--model', model] : [];
  const baseArgs = ['-p', prompt, '--output-format', 'json', '--yolo', ...modelArgs];
  const args = resumeId ? ['--session-id', resumeId, ...baseArgs] : baseArgs;

  let summary = '';
  let sessionId: string | undefined;
  const emittedTool = new Set<string>();
  const isToolItem = (type: string) => type !== 'agent_message' && type !== 'reasoning';

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
    try {
      if (line.startsWith('{')) {
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
              emit('text', { message: { content: [{ type: 'text', text: item.text || '' }] } });
            } else if (item.type === 'reasoning') {
              emit('text', { message: { content: [{ type: 'thinking', text: item.text || '' }] } });
            } else {
              emitToolUse(item);
              const out = item.aggregated_output ?? item.output ?? '';
              const isError = typeof item.exit_code === 'number' && item.exit_code !== 0;
              emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: truncate(String(out), 8000), is_error: isError }] } });
            }
            break;
        }
      } else {
        summary = line;
        emit('text', { message: { content: [{ type: 'text', text: line }] } });
      }
    } catch {
      summary = line;
      emit('text', { message: { content: [{ type: 'text', text: line }] } });
    }
  };

  const summaryText = await driveProcess(COPILOT_BIN, args, cwd, onLine, () => summary || 'Completed note operations successfully.', 'Copilot', runId);
  return { summary: summaryText, sessionId: sessionId || resumeId };
}

// ═══════════════════════════════════════════════════════════════
// HERMES AGENT
// ═══════════════════════════════════════════════════════════════

const HERMES_BIN = process.env.HERMES_BIN || 'hermes';

/**
 * Runs the Hermes CLI in one-shot mode and streams its text output line by line.
 */
async function runHermes(prompt: string, cwd: string, emit: AgentEmit, resumeId?: string, runId?: number): Promise<CliAgentResult> {
  const baseArgs = ['-z', prompt, '--yolo'];
  const args = resumeId ? ['-r', resumeId, ...baseArgs] : baseArgs;

  let text = '';
  const onLine = (line: string) => {
    text += line + '\n';
    emit('text', { message: { content: [{ type: 'text', text: line }] } });
  };

  const summaryText = await driveProcess(HERMES_BIN, args, cwd, onLine, () => text.trim() || 'Completed note operations successfully.', 'Hermes', runId);
  return { summary: summaryText, sessionId: resumeId };
}
