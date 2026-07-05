/**
 * @file agent-runner.cjs — Local CLI agent execution for the Electron main process
 *
 * Spawns Codex/Grok/etc. on the user's machine (where CLIs are installed) instead
 * of relying on a remote Cascade server. Reuses the compiled local CLI module.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

let cliAgentModulePromise = null;
let claudeSdkPromise = null;

// Claude (claude-code) runs locally via the Anthropic Agent SDK, authenticated
// by THIS machine's `claude` login / ANTHROPIC_API_KEY — never the server's.
// Mirrors the run options the server used to apply in server/runner.ts.
const CLAUDE_DEFAULT_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-5';
const CLAUDE_MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 100);
const CLAUDE_THINKING_TOKENS = Number(process.env.RUNNER_THINKING ?? 4000);
const CLAUDE_AGENT_CONTEXT = 'You are a local workspace assistant. This checkout is not the live Cascade app: use `cascade-note` for live notes, and use normal file edits only for local scratch or non-note work. Respect auth boundaries and only handle secrets the user explicitly provides for this task.';

// Nudge agents to behave like chat participants, not verbose coding CLIs: the
// chat collapses step narration into a trace disclosure, so the actual message
// should be short. Detailed reasoning belongs in thinking, not the reply.
const CHAT_BREVITY_CONTEXT = "Shared chat — reply briefly and naturally.";

// Live Cascade API config for the `cascade-note` wrapper, populated by the
// desktop runner host once it knows the server URL + the user's auth token.
// Children inherit these via process.env, so the wrapper authenticates against
// the same live instance the desktop is connected to (cscd.online by default).
const noteApi = { url: '', token: '' };
const HELPER_CONFIG_PATH = path.join(os.homedir(), '.cascade', 'agent-helper-context.json');

/** Directory holding the agent helper CLIs; prefer source, fall back to dist. */
function resolveWrapperDir() {
  const candidates = [
    path.join(__dirname, '..', 'cli-agents'),
    path.join(__dirname, '..', 'dist', 'cli-agents'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'cascade-note'))) return dir;
    } catch { /* ignore */ }
  }
  return candidates[0];
}

/** Put wrappers on PATH (once) so agents can invoke `cascade-note`/`cascade-chat`. */
function ensureWrapperOnPath() {
  const dir = resolveWrapperDir();
  const parts = (process.env.PATH || '').split(path.delimiter);
  if (!parts.includes(dir)) process.env.PATH = [dir, ...parts].join(path.delimiter);
  process.env.CASCADE_HELPER_DIR = dir;
  process.env.CASCADE_HELPER_CONFIG = HELPER_CONFIG_PATH;
}

/** Set the live API target/token the wrapper should use (call on runner connect). */
function setNoteApiConfig({ url, token } = {}) {
  if (typeof url === 'string' && url.trim()) noteApi.url = url.trim().replace(/\/$/, '');
  if (typeof token === 'string' && token.trim()) noteApi.token = token.trim();
}

/**
 * Inject helper env (target URL, token, current vault/channel) for a run, and
 * ensure it's on PATH. Vault is also stated in the prompt context, so the env
 * value is just a default the agent can override with --vault.
 */
function applyNoteEnv(opts) {
  ensureWrapperOnPath();
  if (noteApi.url) process.env.CASCADE_NOTE_URL = noteApi.url;
  if (noteApi.token) process.env.CASCADE_NOTE_TOKEN = noteApi.token;
  const vaultId = String(opts && opts.vaultId || '').trim();
  if (vaultId) process.env.CASCADE_NOTE_VAULT = vaultId;
  const channelId = String(opts && opts.chatChannelId || opts?.chat?.channelId || '').trim();
  if (channelId) process.env.CASCADE_CHAT_CHANNEL = channelId;
  const messageId = String(opts && opts.chatMessageId || opts?.chat?.messageId || '').trim();
  if (messageId) process.env.CASCADE_CHAT_MESSAGE = messageId;
  writeHelperConfig({ vaultId, channelId, messageId });
}

function writeHelperConfig({ vaultId, channelId, messageId } = {}) {
  const payload = {
    url: noteApi.url || process.env.CASCADE_NOTE_URL || 'https://cscd.online',
    token: noteApi.token || process.env.CASCADE_NOTE_TOKEN || '',
    vaultId: vaultId || process.env.CASCADE_NOTE_VAULT || '',
    chatChannelId: channelId || process.env.CASCADE_CHAT_CHANNEL || '',
    chatMessageId: messageId || process.env.CASCADE_CHAT_MESSAGE || '',
    helperDir: resolveWrapperDir(),
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(HELPER_CONFIG_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(HELPER_CONFIG_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.chmodSync(HELPER_CONFIG_PATH, 0o600);
  } catch (err) {
    console.warn('[agent-runner] failed to write helper context:', err?.message || err);
  }
}

/** True when this run was triggered from a chat channel (vs a note pane). */
function isChatRun(opts) {
  return Boolean(String(opts && opts.chatChannelId || opts?.chat?.channelId || '').trim());
}

/** One-line capability note for non-chat runs. Chat runs carry this in the user prompt. */
function noteCapabilityContext(opts) {
  const helperDir = resolveWrapperDir();
  const vaultId = String(opts && opts.vaultId || '').trim();
  const vaultLine = vaultId ? ` Vault: ${vaultId}.` : '';
  return `Live notes: \`cascade-note\` (not local .md).${vaultLine} Helpers on PATH and in ${helperDir}.`;
}



// Live Claude SDK query streams, keyed by runId, so cancellation can close them.
const activeClaudeQueries = new Map();

async function loadClaudeSdk() {
  if (!claudeSdkPromise) {
    claudeSdkPromise = (async () => {
      try {
        return await import('@anthropic-ai/claude-agent-sdk');
      } catch {
        const p = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
        return import(pathToFileURL(p).href);
      }
    })();
  }
  return claudeSdkPromise;
}

// Same mapping the server applied: SDK message type → run_event type expected
// by the chat renderer.
function classifySdkMessage(message) {
  if (message.type === 'assistant') return 'text';
  if (message.type === 'result') return 'result';
  if (message.type === 'system') return 'system';
  return message.type || 'message';
}

function expandHome(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveAgentCwd(inputCwd, vaultRoot) {
  const expanded = expandHome(inputCwd);
  if (expanded) {
    const resolved = path.resolve(expanded);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // fall through
    }
  }
  const root = String(vaultRoot || '').trim();
  if (root) {
    const resolvedRoot = path.resolve(root);
    try {
      if (fs.existsSync(resolvedRoot) && fs.statSync(resolvedRoot).isDirectory()) return resolvedRoot;
    } catch {
      // fall through
    }
  }
  return os.homedir();
}

async function loadCliAgentModule() {
  if (!cliAgentModulePromise) {
    const modPath = path.join(__dirname, '..', 'dist', 'cli-agents', 'cli-agent.js');
    cliAgentModulePromise = import(pathToFileURL(modPath).href);
  }
  return cliAgentModulePromise;
}

/**
 * Run Claude locally via the Agent SDK, translating the SDK message stream into
 * the same run_events the renderer already understands. Auth comes from this
 * machine's `claude` login / ANTHROPIC_API_KEY.
 */
async function runClaudeLocally(opts, emit) {
  const { query } = await loadClaudeSdk();
  const runId = Number(opts.runId);
  applyNoteEnv(opts);
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);
  const model = (typeof opts.model === 'string' && opts.model.trim()) ? opts.model.trim() : CLAUDE_DEFAULT_MODEL;
  const resumeSessionId = (typeof opts.resumeSessionId === 'string' && opts.resumeSessionId) ? opts.resumeSessionId : undefined;
  const images = Array.isArray(opts.images)
    ? opts.images.filter((im) => im && typeof im.media_type === 'string' && typeof im.data === 'string')
    : [];

  // With images, send a structured user message (text + image blocks);
  // otherwise a plain string prompt.
  const claudePrompt = images.length
    ? (async function* () {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: opts.prompt },
              ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
            ],
          },
          parent_tool_use_id: null,
          session_id: '',
        };
      })()
    : opts.prompt;

  const stream = query({
    prompt: claudePrompt,
    options: {
      cwd,
      model,
      maxTurns: CLAUDE_MAX_TURNS,
      // "Yolo" bypasses all permission prompts (requires the explicit
      // allowDangerouslySkipPermissions acknowledgement); otherwise auto-accept
      // only file edits.
      permissionMode: opts.yolo ? 'bypassPermissions' : 'acceptEdits',
      ...(opts.yolo ? { allowDangerouslySkipPermissions: true } : {}),
      // Even without yolo, let agents run the read-only wrapper commands
      // (`cascade-chat`, `cascade-note`) unprompted so they can pull channel
      // history/notes for context. Everything else still respects acceptEdits.
      allowedTools: ['Bash(cascade-chat:*)', 'Bash(cascade-note:*)'],
      // Electron's main process is not a Node runtime, so spawn a real `node`
      // from PATH to host the bundled Claude Code CLI.
      executable: 'node',
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      // Stream token-level deltas so thinking renders live in its block rather
      // than arriving all at once as a finished assistant message.
      includePartialMessages: true,
      ...(CLAUDE_THINKING_TOKENS > 0
        ? { thinking: { type: 'enabled', budgetTokens: CLAUDE_THINKING_TOKENS } }
        : {}),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: isChatRun(opts) ? CHAT_BREVITY_CONTEXT : `${CLAUDE_AGENT_CONTEXT} ${noteCapabilityContext(opts)}`,
      },
    },
  });

  activeClaudeQueries.set(runId, stream);
  let summary = '';
  let sessionId;
  // Tracks whether the previous streamed block was text, so a new text block
  // (a fresh turn, typically split off by a tool call in between) gets a
  // paragraph break instead of being glued onto the prior turn's text.
  let lastBlockWasText = false;
  try {
    for await (const message of stream) {
      if (message.session_id) sessionId = message.session_id;

      // Partial streaming: translate token-level deltas into the same
      // { message: { content: [...] } } shape the chat accumulators expect,
      // routing thinking_delta → a thinking block and text_delta → a text
      // block. The assembled `assistant` message is skipped below so its
      // content isn't appended a second time on top of these deltas.
      if (message.type === 'stream_event') {
        const ev = message.event;
        if (ev?.type === 'content_block_start') {
          const blockType = ev.content_block?.type;
          if (blockType === 'redacted_thinking') {
            emit('text', { message: { content: [{ type: 'redacted_thinking' }] } });
            lastBlockWasText = false;
          } else if (blockType === 'text' && lastBlockWasText) {
            // Separate this turn's text from the previous one.
            emit('text', { message: { content: [{ type: 'text', text: '\n\n' }] } });
          }
        } else if (ev?.type === 'content_block_delta') {
          const delta = ev.delta;
          if (delta?.type === 'thinking_delta' && delta.thinking) {
            emit('text', { message: { content: [{ type: 'thinking', thinking: delta.thinking }] } });
            lastBlockWasText = false;
          } else if (delta?.type === 'text_delta' && delta.text) {
            emit('text', { message: { content: [{ type: 'text', text: delta.text }] } });
            lastBlockWasText = true;
          }
        }
        continue;
      }

      // The complete assistant message duplicates the streamed deltas above.
      if (message.type === 'assistant') continue;

      emit(classifySdkMessage(message), message);
      if (message.type === 'result') summary = message.result || message.subtype || summary;
    }
  } finally {
    activeClaudeQueries.delete(runId);
  }
  return { summary: summary || 'Completed note operations successfully.', sessionId };
}

/**
 * Start an agent run locally. Events are delivered via `sendEvent`.
 * Resolves when the run finishes (success or failure).
 */
async function startLocalAgentRun(opts, sendEvent) {
  const runId = Number(opts.runId);
  if (!Number.isFinite(runId)) throw new Error('Invalid run id');

  const agent = String(opts.agent || '').trim();
  const prompt = String(opts.prompt || '').trim();
  if (!agent) throw new Error('Agent is required');
  if (!prompt) throw new Error('Prompt is required');

  let seq = 0;
  const emit = (type, payload) => {
    sendEvent({
      runId,
      seq: ++seq,
      type,
      payload_json: JSON.stringify(payload),
    });
  };

  emit('status', { status: 'running' });

  if (agent === 'claude-code') {
    try {
      const result = await runClaudeLocally({ ...opts, prompt }, emit);
      emit('status', { status: 'completed', summary: result.summary, sessionId: result.sessionId });
      return { sessionId: result.sessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('status', { status: 'failed', summary: message });
      throw error;
    }
  }

  const { runCliAgent } = await loadCliAgentModule();
  applyNoteEnv(opts);
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);

  try {
    const result = await runCliAgent({
      agent,
      context: isChatRun(opts) ? '' : `${CLAUDE_AGENT_CONTEXT} ${noteCapabilityContext(opts)}`,
      userPrompt: prompt,
      cwd,
      resumeSessionId: typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId : undefined,
      images: Array.isArray(opts.images) ? opts.images : [],
      model: typeof opts.model === 'string' ? opts.model : undefined,
      yolo: opts.yolo === true,
      runId,
      emit,
    });
    emit('status', {
      status: 'completed',
      summary: result.summary || 'Done.',
      sessionId: result.sessionId,
    });
    return { sessionId: result.sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit('status', { status: 'failed', summary: message });
    throw error;
  }
}

async function cancelLocalAgentRun(runId) {
  const id = Number(runId);

  // Claude SDK runs: close the live query stream.
  const claudeStream = activeClaudeQueries.get(id);
  if (claudeStream) {
    try { claudeStream.close?.(); } catch { /* ignore */ }
    activeClaudeQueries.delete(id);
    return true;
  }

  const { activeCliProcesses } = await loadCliAgentModule();
  const child = activeCliProcesses.get(id);
  if (!child) return false;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  activeCliProcesses.delete(id);
  return true;
}

module.exports = {
  startLocalAgentRun,
  cancelLocalAgentRun,
  resolveAgentCwd,
  setNoteApiConfig,
};
