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
let cliAgentModuleMtimeMs = -1;
let claudeSdkPromise = null;

// Claude (claude-code) runs locally via the Anthropic Agent SDK, authenticated
// by THIS machine's `claude` login / ANTHROPIC_API_KEY — never the server's.
// Mirrors the run options the server used to apply in server/runner.ts.
const CLAUDE_DEFAULT_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-5';
// Turn caps are off by default (0 = unlimited). Either surface can still be
// bounded explicitly through its environment override.
const CLAUDE_MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 0);
const CLAUDE_THINKING_TOKENS = Number(process.env.RUNNER_THINKING ?? 4000);
const CLAUDE_CHAT_MAX_TURNS = Number(process.env.RUNNER_CHAT_MAX_TURNS || 0);
// Extra turn windows a chat run may auto-continue into after hitting a cap
// (each resumes the same session). Only relevant when a cap is set above.
const CLAUDE_CHAT_MAX_CONTINUES = Number(process.env.RUNNER_CHAT_MAX_CONTINUES || 0);
// Chat runs stay low-thinking so multiuser pings don't burn long monologues.
// Override with RUNNER_CHAT_THINKING if a heavy chat agent needs more.
const CLAUDE_CHAT_THINKING_TOKENS = Number(process.env.RUNNER_CHAT_THINKING ?? 800);
const CLAUDE_AGENT_CONTEXT = 'You are a local workspace assistant. This checkout is not the live Cascade app: use `cascade-note` for live notes (`cascade-note memory` for durable recall), `cascade-scratchpad jot` for work-journal entries, and normal file edits only for local scratch or non-note work. Notes you create via cascade-note are unlisted by default (chat/search/embed only, not the left sidebar). Only pass `--listed` if the user explicitly asks to put a note in the sidebar tree. Respect auth boundaries and only handle secrets the user explicitly provides for this task.';

// Nudge agents to behave like chat participants, not verbose coding CLIs: the
// chat collapses step narration into a trace disclosure, so the actual message
// should be short. Detailed reasoning belongs in thinking, not the reply.
const CHAT_BREVITY_CONTEXT =
  'Shared multiuser chat — match human chat speed, but resolve the user\'s actual intent before choosing the fast path. '
  + 'Short or context-dependent messages can still request real work; complete that work before replying. '
  + 'For genuine conversation or Q&A, return one short direct final answer with no tools. '
  + 'Return the final answer normally; keep progress in the run trace instead of posting separate chat messages. '
  + 'Do not confuse a mentioned @handle with the message author. Do not invent multi-step plans for questions you can answer immediately.';

// Live Cascade API config for helper wrappers, populated by the
// desktop runner host once it knows the server URL + the user's auth token.
// Children inherit these via process.env, so the wrapper authenticates against
// the same live instance the desktop is connected to (cscd.online by default).
const noteApi = { url: '', token: '', configured: false };
const HELPER_CONFIG_PATH = path.join(os.homedir(), '.cascade', 'agent-helper-context.json');
const RUN_CONTEXT_DIR = path.join(os.homedir(), '.cascade', 'run-contexts');
const USER_BIN_DIR = path.join(os.homedir(), '.local', 'bin');
// Electron launched from a desktop entry does not inherit the user's login
// shell PATH. Include the conventional per-user CLI locations so agents
// installed with Bun/npm (for example OMP in ~/.bun/bin) are discoverable.
const USER_EXEC_DIRS = [
  USER_BIN_DIR,
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), 'node_modules', '.bin'),
];
const HELPER_NAMES = ['cascade-note', 'cascade-chat', 'cascade-scratchpad'];

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

function quoteSh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ensureExecutable(file) {
  try {
    if (!fs.existsSync(file)) return false;
    const current = fs.statSync(file).mode;
    fs.chmodSync(file, current | 0o755);
    return true;
  } catch (err) {
    console.warn('[agent-runner] failed to chmod helper:', file, err?.message || err);
    return false;
  }
}

function ensureUserBinWrapper(name, source) {
  try {
    fs.mkdirSync(USER_BIN_DIR, { recursive: true, mode: 0o755 });
    const target = path.join(USER_BIN_DIR, name);
    const contents = `#!/bin/sh\nexec node ${quoteSh(source)} "$@"\n`;
    let existing = '';
    try { existing = fs.readFileSync(target, 'utf8'); } catch { /* ignore */ }
    if (existing !== contents) fs.writeFileSync(target, contents, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    return true;
  } catch (err) {
    console.warn('[agent-runner] failed to install helper wrapper:', name, err?.message || err);
    return false;
  }
}

function ensureHelperInstall() {
  const dir = resolveWrapperDir();
  for (const name of HELPER_NAMES) {
    const source = path.join(dir, name);
    if (ensureExecutable(source)) ensureUserBinWrapper(name, source);
  }
}

/** Put wrappers on PATH (once) so agents can invoke `cascade-note`/`cascade-chat`. */
function ensureWrapperOnPath() {
  ensureHelperInstall();
  const dir = resolveWrapperDir();
  const parts = (process.env.PATH || '').split(path.delimiter);
  if (!parts.includes(dir)) process.env.PATH = [dir, ...parts].join(path.delimiter);
  for (const binDir of USER_EXEC_DIRS) {
    if (!parts.includes(binDir) && fs.existsSync(binDir)) {
      process.env.PATH = [binDir, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
    }
  }
  process.env.CASCADE_HELPER_DIR = dir;
  process.env.CASCADE_HELPER_CONFIG = HELPER_CONFIG_PATH;
}

function buildAgentEnv(opts) {
  ensureWrapperOnPath();
  const env = { ...process.env };
  if (noteApi.configured) {
    env.CASCADE_NOTE_URL = noteApi.url;
    env.CASCADE_NOTE_TOKEN = noteApi.token;
    delete env.CASCADE_NOTE_USER;
    delete env.CASCADE_NOTE_PASS;
  } else {
    if (noteApi.url) env.CASCADE_NOTE_URL = noteApi.url;
    if (noteApi.token) env.CASCADE_NOTE_TOKEN = noteApi.token;
  }
  const vaultId = String(opts && opts.vaultId || '').trim();
  if (vaultId) env.CASCADE_NOTE_VAULT = vaultId;
  const channelId = String(opts && opts.chatChannelId || opts?.chat?.channelId || '').trim();
  if (channelId) env.CASCADE_CHAT_CHANNEL = channelId;
  const messageId = String(opts && opts.chatMessageId || opts?.chat?.messageId || '').trim();
  if (messageId) env.CASCADE_CHAT_MESSAGE = messageId;
  env.CASCADE_HELPER_DIR = resolveWrapperDir();
  env.CASCADE_HELPER_CONFIG = HELPER_CONFIG_PATH;
  const pathParts = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (!pathParts.includes(env.CASCADE_HELPER_DIR)) {
    env.PATH = [env.CASCADE_HELPER_DIR, ...pathParts].join(path.delimiter);
  }
  if (!pathParts.includes(USER_BIN_DIR)) {
    env.PATH = [USER_BIN_DIR, env.PATH].filter(Boolean).join(path.delimiter);
  }
  return { env, vaultId, channelId, messageId };
}

/** Set the live API target/token the wrapper should use (call on runner connect). */
function setNoteApiConfig({ url, token } = {}) {
  if (typeof url === 'string') {
    noteApi.url = url.trim().replace(/\/$/, '');
    noteApi.configured = true;
  }
  if (typeof token === 'string') {
    noteApi.token = token.trim();
    noteApi.configured = true;
  }
}

/**
 * Inject helper env (target URL, token, current vault/channel) for a run, and
 * ensure it's on PATH. Vault is also stated in the prompt context, so the env
 * value is just a default the agent can override with --vault.
 */
function helperConfigPathForRun(runId) {
  const id = Number(runId);
  if (Number.isFinite(id) && id > 0) return path.join(RUN_CONTEXT_DIR, `${id}.json`);
  return HELPER_CONFIG_PATH;
}

function writeHelperConfig({ runId, vaultId, channelId, messageId, chatAuthor, agentId, agentMemoryKey, registrationId } = {}) {
  const payload = {
    url: noteApi.configured ? noteApi.url : (noteApi.url || process.env.CASCADE_NOTE_URL || 'https://cscd.online'),
    token: noteApi.configured ? noteApi.token : (noteApi.token || process.env.CASCADE_NOTE_TOKEN || ''),
    vaultId: vaultId || process.env.CASCADE_NOTE_VAULT || '',
    chatChannelId: channelId || process.env.CASCADE_CHAT_CHANNEL || '',
    chatMessageId: messageId || process.env.CASCADE_CHAT_MESSAGE || '',
    chatAuthor: chatAuthor || process.env.CASCADE_CHAT_AUTHOR || '',
    agentId: agentId || '',
    agentMemoryKey: agentMemoryKey || '',
    registrationId: registrationId || '',
    runId: Number.isFinite(Number(runId)) ? Number(runId) : undefined,
    helperDir: resolveWrapperDir(),
    updatedAt: new Date().toISOString(),
  };
  const configPath = helperConfigPathForRun(runId);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
  } catch (err) {
    console.warn('[agent-runner] failed to write helper context:', err?.message || err);
  }
  return configPath;
}

/** Per-run env for helper CLIs so concurrent agents don't stomp each other's author. */
function buildRunHelperEnv(opts) {
  ensureWrapperOnPath();
  const runId = Number(opts?.runId);
  const vaultId = String(opts && opts.vaultId || '').trim();
  const channelId = String(opts && opts.chatChannelId || opts?.chat?.channelId || '').trim();
  const messageId = String(opts && opts.chatMessageId || opts?.chat?.messageId || '').trim();
  const chatAuthor = String(opts && opts.chatAuthor || '').trim();
  const agentId = String(opts && opts.agent || '').trim();
  const agentMemoryKey = String(opts && opts.agentMemoryKey || '').trim();
  const registrationId = String(opts && opts.chatRegistrationId || '').trim();
  const configPath = writeHelperConfig({
    runId,
    vaultId,
    channelId,
    messageId,
    chatAuthor,
    agentId,
    agentMemoryKey,
    registrationId,
  });
  const env = {
    CASCADE_NOTE_URL: noteApi.configured ? noteApi.url : (noteApi.url || process.env.CASCADE_NOTE_URL || 'https://cscd.online'),
    CASCADE_NOTE_TOKEN: noteApi.configured ? noteApi.token : (noteApi.token || process.env.CASCADE_NOTE_TOKEN || ''),
    ...(noteApi.configured ? { CASCADE_NOTE_USER: '', CASCADE_NOTE_PASS: '' } : {}),
    CASCADE_HELPER_CONFIG: configPath,
    CASCADE_HELPER_DIR: resolveWrapperDir(),
    PATH: process.env.PATH || '',
  };
  if (!env.PATH.split(path.delimiter).includes(env.CASCADE_HELPER_DIR)) {
    env.PATH = [env.CASCADE_HELPER_DIR, env.PATH].filter(Boolean).join(path.delimiter);
  }
  for (const binDir of USER_EXEC_DIRS) {
    if (fs.existsSync(binDir) && !env.PATH.split(path.delimiter).includes(binDir)) {
      env.PATH = [binDir, env.PATH].filter(Boolean).join(path.delimiter);
    }
  }
  if (vaultId) env.CASCADE_NOTE_VAULT = vaultId;
  if (channelId) env.CASCADE_CHAT_CHANNEL = channelId;
  if (messageId) env.CASCADE_CHAT_MESSAGE = messageId;
  if (chatAuthor) env.CASCADE_CHAT_AUTHOR = chatAuthor;
  if (Number.isFinite(runId) && runId > 0) env.CASCADE_RUN_ID = String(runId);
  return env;
}

function cleanupRunHelperConfig(runId) {
  const id = Number(runId);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    fs.unlinkSync(helperConfigPathForRun(id));
  } catch { /* ignore */ }
}

/** True when cascade-chat send ran during this run (helper config flag). */
function readUsedChatSend(runId) {
  const id = Number(runId);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    const raw = fs.readFileSync(helperConfigPathForRun(id), 'utf8');
    const parsed = JSON.parse(raw);
    // Ghost files that only contain { usedChatSend: true } (no vault/channel)
    // must not suppress the run bubble — that left empty "(message)" shells.
    if (!parsed || !parsed.usedChatSend) return false;
    const hasContext = Boolean(
      String(parsed.chatChannelId || parsed.vaultId || parsed.token || '').trim(),
    );
    return hasContext;
  } catch {
    return false;
  }
}

/**
 * Emit terminal status. When the agent already posted via cascade-chat send,
 * set suppressChatBody so the run-linked bubble does not also show stdout.
 */
function emitTerminalStatus(emit, runId, status, summary, sessionId) {
  const suppressChatBody = status === 'completed' && readUsedChatSend(runId);
  emit('status', {
    status,
    summary: summary || (status === 'completed' ? 'Done.' : 'Agent failed.'),
    ...(sessionId ? { sessionId } : {}),
    ...(suppressChatBody ? { suppressChatBody: true } : {}),
  });
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
  return `Live notes: \`cascade-note\` (not local .md; creates unlisted by default — use \`--listed\` only if the user asks for sidebar); durable memory: \`cascade-note memory\`; work journal: \`cascade-scratchpad jot\` (append-only — jot observations, outcomes, and dead ends as you work; consolidate into memory notes when the boot context says it is due).${vaultLine} Helpers on PATH and in ${helperDir}.`;
}

/** Permission rules for helper names plus the absolute paths agents may discover. */
function helperAllowedTools() {
  const helperDir = resolveWrapperDir();
  const commands = new Set();
  for (const name of HELPER_NAMES) {
    commands.add(name);
    commands.add(path.join(helperDir, name));
    commands.add(path.join(USER_BIN_DIR, name));
  }
  return [...commands].flatMap((command) => [
    `Bash(${command})`,
    `Bash(${command} *)`,
  ]);
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

/** Emit a harness/terminal chunk for the chat terminal pane. */
function emitHarness(emit, data) {
  if (!data) return;
  emit('harness', { data: String(data) });
}

function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * Emit a machine-readable `# cascade-stats …` harness line for the chat UI.
 * Merges whatever fields we have (usage, context, rate limits) — the client
 * keeps the latest non-null values per field.
 */
function emitCascadeStats(emit, stats) {
  if (!emit || !stats || typeof stats !== 'object') return;
  // Drop undefined so the JSON stays compact and easy to merge.
  const clean = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value !== undefined && value !== null && value !== '') clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return;
  try {
    emitHarness(emit, `\x1b[2m# cascade-stats ${JSON.stringify(clean)}\x1b[0m\r\n`);
  } catch { /* ignore */ }
}

/** Pull context-window / turn / cost fields off a Claude SDK result message. */
function statsFromClaudeResult(message, model, maxTurns) {
  const usage = message.usage || {};
  const modelUsage = message.modelUsage && typeof message.modelUsage === 'object'
    ? message.modelUsage
    : {};
  // Prefer the entry matching the run model; else first modelUsage row.
  let mu = modelUsage[model];
  if (!mu) {
    const keys = Object.keys(modelUsage);
    mu = keys.length ? modelUsage[keys[0]] : null;
  }
  const contextWindow = numOrUndef(mu?.contextWindow);
  // Approximate filled context from last-turn API usage when SDK doesn't
  // give an explicit total. Cache-read + input ≈ tokens in the window.
  const inputTokens = numOrUndef(usage.input_tokens) ?? numOrUndef(mu?.inputTokens);
  const outputTokens = numOrUndef(usage.output_tokens) ?? numOrUndef(mu?.outputTokens);
  const cacheRead = numOrUndef(usage.cache_read_input_tokens) ?? numOrUndef(mu?.cacheReadInputTokens);
  const cacheWrite = numOrUndef(usage.cache_creation_input_tokens) ?? numOrUndef(mu?.cacheCreationInputTokens);
  let contextUsed = null;
  if (inputTokens != null || cacheRead != null) {
    contextUsed = (inputTokens || 0) + (cacheRead || 0);
  }
  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalCostUsd: numOrUndef(message.total_cost_usd) ?? numOrUndef(mu?.costUSD),
    numTurns: numOrUndef(message.num_turns),
    maxTurns: numOrUndef(maxTurns),
    durationMs: numOrUndef(message.duration_ms),
    durationApiMs: numOrUndef(message.duration_api_ms),
    contextWindow,
    contextUsed: contextUsed ?? undefined,
    maxOutputTokens: numOrUndef(mu?.maxOutputTokens),
  };
}

function numOrUndef(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Normalize a Claude rate_limit_event into cascade-stats fields. */
function statsFromRateLimitInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const out = {
    rateLimitStatus: info.status || undefined,
    rateLimitType: info.rateLimitType || undefined,
    rateLimitUtilization: numOrUndef(info.utilization),
    rateLimitResetsAt: info.resetsAt != null
      ? (typeof info.resetsAt === 'number'
        ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString()
        : String(info.resetsAt))
      : undefined,
    overageStatus: info.overageStatus || undefined,
    overageInUse: info.isUsingOverage === true || info.overageInUse === true ? true : undefined,
  };
  if (Object.values(out).every((v) => v === undefined)) return null;
  return out;
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
  const modPath = path.join(__dirname, '..', 'dist', 'cli-agents', 'cli-agent.js');
  // Bust cache when dist rebuilds so harness fixes apply without killing Electron.
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(modPath).mtimeMs; } catch { /* ignore */ }
  if (!cliAgentModulePromise || cliAgentModuleMtimeMs !== mtimeMs) {
    cliAgentModuleMtimeMs = mtimeMs;
    const href = pathToFileURL(modPath).href + `?t=${mtimeMs || Date.now()}`;
    cliAgentModulePromise = import(href);
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
  const helperEnv = buildRunHelperEnv(opts);
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);
  const model = (typeof opts.model === 'string' && opts.model.trim()) ? opts.model.trim() : CLAUDE_DEFAULT_MODEL;
  const chatRun = isChatRun(opts);
  const maxTurns = chatRun ? CLAUDE_CHAT_MAX_TURNS : CLAUDE_MAX_TURNS;
  const thinkingTokens = chatRun ? CLAUDE_CHAT_THINKING_TOKENS : CLAUDE_THINKING_TOKENS;
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
      // Omit maxTurns entirely when unlimited (0) so the SDK imposes no cap.
      ...(maxTurns > 0 ? { maxTurns } : {}),
      env: { ...process.env, ...helperEnv },
      // "Yolo" bypasses all permission prompts (requires the explicit
      // allowDangerouslySkipPermissions acknowledgement); otherwise auto-accept
      // only file edits.
      permissionMode: opts.yolo ? 'bypassPermissions' : 'acceptEdits',
      ...(opts.yolo ? { allowDangerouslySkipPermissions: true } : {}),
      // Even without yolo, let agents run the wrapper commands unprompted so
      // they can pull channel history/notes, use memory, and send chat messages.
      // Everything else still respects acceptEdits.
      allowedTools: helperAllowedTools(),
      // Electron's main process is not a Node runtime, so spawn a real `node`
      // from PATH to host the bundled Claude Code CLI.
      executable: 'node',
      // Pass env explicitly. The SDK REPLACES the subprocess env when `env` is
      // set, so include process.env + our helper additions so the child (and
      // the Bash tool inside it) can find `cascade-note` / `cascade-chat` on
      // PATH and pick up the auth token / vault / channel context.
      env: { ...process.env, ...helperEnv },
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      // Stream token-level deltas so thinking renders live in its block rather
      // than arriving all at once as a finished assistant message.
      includePartialMessages: true,
      ...(thinkingTokens > 0
        ? { thinking: { type: 'enabled', budgetTokens: thinkingTokens } }
        : {}),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: chatRun ? CHAT_BREVITY_CONTEXT : `${CLAUDE_AGENT_CONTEXT} ${noteCapabilityContext(opts)}`,
      },
    },
  });

  activeClaudeQueries.set(runId, stream);
  let summary = '';
  let streamedText = '';
  let latestAssistantText = '';
  let sessionId;
  // Tracks whether the previous streamed block was text, so a new text block
  // (a fresh turn, typically split off by a tool call in between) gets a
  // paragraph break instead of being glued onto the prior turn's text.
  let lastBlockWasText = false;
  let harnessInThinking = false;
  // Accumulate tool_use JSON from stream deltas so the chat UI gets structured
  // tool cards (assistant complete messages are skipped to avoid double text).
  /** @type {{ id: string, name: string, json: string } | null} */
  let pendingTool = null;
  emitHarness(emit, `\x1b[2m# claude-code ${model} · ${cwd}\x1b[0m\r\n`);
  // Advertise configured turn cap up front so the panel can show turns N/max mid-run.
  emitCascadeStats(emit, { model, maxTurns: maxTurns > 0 ? maxTurns : undefined });
  try {
    for await (const message of stream) {
      if (message.session_id) sessionId = message.session_id;

      // Subscription rate-limit telemetry (claude.ai plans). Sparse but useful.
      if (message.type === 'rate_limit_event') {
        const rl = statsFromRateLimitInfo(message.rate_limit_info);
        if (rl) emitCascadeStats(emit, rl);
        continue;
      }

      // Partial streaming: translate token-level deltas into the same
      // { message: { content: [...] } } shape the chat accumulators expect,
      // routing thinking_delta → a thinking block and text_delta → a text
      // block. The assembled `assistant` message is skipped below so its
      // content isn't appended a second time on top of these deltas.
      // Also tee a human-readable transcript into the harness terminal pane.
      if (message.type === 'stream_event') {
        const ev = message.event;
        if (ev?.type === 'message_start') {
          // Keep the latest inference's answer separate from earlier progress
          // narration. The terminal summary becomes the clean chat body.
          latestAssistantText = '';
        } else if (ev?.type === 'content_block_start') {
          const block = ev.content_block;
          const blockType = block?.type;
          if (blockType === 'thinking' || blockType === 'redacted_thinking') {
            if (!harnessInThinking) {
              emitHarness(emit, '\x1b[2m# thinking\x1b[0m\r\n');
              harnessInThinking = true;
            }
            if (blockType === 'redacted_thinking') {
              emit('text', { message: { content: [{ type: 'redacted_thinking' }] } });
              emitHarness(emit, '\x1b[2m[redacted]\x1b[0m');
              lastBlockWasText = false;
            }
          } else if (blockType === 'tool_use') {
            harnessInThinking = false;
            const name = block?.name || 'tool';
            const id = block?.id || `tool-${Date.now()}`;
            pendingTool = { id, name, json: '' };
            // Emit early so the timeline shows the tool while args stream in.
            emit('text', {
              message: {
                content: [{ type: 'tool_use', id, name, input: block?.input && Object.keys(block.input).length ? block.input : {} }],
              },
            });
            const inputPreview = formatToolInput(block?.input);
            emitHarness(emit, `\x1b[36m▶ ${name}\x1b[0m${inputPreview ? ` ${inputPreview.slice(0, 200)}` : ''}\r\n`);
            lastBlockWasText = false;
          } else if (blockType === 'text') {
            if (harnessInThinking) {
              emitHarness(emit, '\r\n');
              harnessInThinking = false;
            }
            if (lastBlockWasText) {
              // Separate this turn's text from the previous one.
              emit('text', { message: { content: [{ type: 'text', text: '\n\n' }] } });
              emitHarness(emit, '\r\n\r\n');
              streamedText += '\n\n';
            }
          }
        } else if (ev?.type === 'content_block_delta') {
          const delta = ev.delta;
          if (delta?.type === 'thinking_delta' && delta.thinking) {
            emit('text', { message: { content: [{ type: 'thinking', thinking: delta.thinking }] } });
            emitHarness(emit, `\x1b[2m${delta.thinking}\x1b[0m`);
            lastBlockWasText = false;
          } else if (delta?.type === 'text_delta' && delta.text) {
            emit('text', { message: { content: [{ type: 'text', text: delta.text }] } });
            emitHarness(emit, delta.text);
            streamedText += delta.text;
            latestAssistantText += delta.text;
            lastBlockWasText = true;
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            if (pendingTool) pendingTool.json += delta.partial_json;
            emitHarness(emit, `\x1b[36m${delta.partial_json}\x1b[0m`);
          }
        } else if (ev?.type === 'content_block_stop') {
          if (harnessInThinking) {
            emitHarness(emit, '\r\n');
            harnessInThinking = false;
          }
          if (pendingTool) {
            let input = {};
            if (pendingTool.json) {
              try {
                input = JSON.parse(pendingTool.json);
              } catch {
                input = { _raw: pendingTool.json };
              }
            }
            emit('text', {
              message: {
                content: [{
                  type: 'tool_use',
                  id: pendingTool.id,
                  name: pendingTool.name,
                  input,
                }],
              },
            });
            pendingTool = null;
          }
        }
        continue;
      }

      // The complete assistant message duplicates the streamed deltas above.
      if (message.type === 'assistant') continue;

      // Tool results and other non-streamed messages → harness + structured events.
      if (message.type === 'user' && message.message?.content) {
        const content = Array.isArray(message.message.content) ? message.message.content : [];
        for (const block of content) {
          if (block?.type === 'tool_result') {
            const body = typeof block.content === 'string'
              ? block.content
              : formatToolInput(block.content);
            const flag = block.is_error ? '\x1b[31m✗' : '\x1b[32m✓';
            const preview = String(body || '').slice(0, 4000);
            emitHarness(emit, `${flag} tool_result\x1b[0m\r\n${preview}\r\n`);
          }
        }
      } else if (message.type === 'result') {
        emitHarness(emit, `\x1b[2m# result ${message.subtype || message.result || 'done'}\x1b[0m\r\n`);
        emitCascadeStats(emit, statsFromClaudeResult(message, model, maxTurns > 0 ? maxTurns : undefined));
        // Best-effort: ask the live query for context-window breakdown + plan
        // rate limits. Methods may no-op once the stream is closing.
        try {
          if (typeof stream.getContextUsage === 'function') {
            const ctx = await stream.getContextUsage();
            if (ctx && typeof ctx === 'object') {
              emitCascadeStats(emit, {
                contextUsed: numOrUndef(ctx.totalTokens),
                contextWindow: numOrUndef(ctx.maxTokens) ?? numOrUndef(ctx.rawMaxTokens),
                contextPct: numOrUndef(ctx.percentage),
                model: typeof ctx.model === 'string' ? ctx.model : undefined,
                autoCompactThreshold: numOrUndef(ctx.autoCompactThreshold),
              });
            }
          }
        } catch { /* control channel may already be closed */ }
        try {
          const usageFn = stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
          if (typeof usageFn === 'function') {
            const plan = await usageFn.call(stream);
            if (plan && plan.rate_limits_available && plan.rate_limits) {
              const rl = plan.rate_limits;
              // Prefer the most-constrained window for a single summary line.
              const windows = [
                ['five_hour', rl.five_hour],
                ['seven_day', rl.seven_day],
                ['seven_day_opus', rl.seven_day_opus],
                ['seven_day_sonnet', rl.seven_day_sonnet],
              ];
              let best = null;
              for (const [type, win] of windows) {
                if (!win || win.utilization == null) continue;
                if (!best || win.utilization > best.utilization) {
                  best = { type, utilization: win.utilization, resets_at: win.resets_at };
                }
              }
              if (best) {
                emitCascadeStats(emit, {
                  rateLimitType: best.type,
                  rateLimitUtilization: best.utilization,
                  rateLimitResetsAt: best.resets_at || undefined,
                  rateLimitStatus: best.utilization >= 100 ? 'rejected'
                    : best.utilization >= 80 ? 'allowed_warning' : 'allowed',
                  subscriptionType: plan.subscription_type || undefined,
                });
              }
              // Keep a fuller snapshot for the UI if multiple windows exist.
              const rateLimitWindows = {};
              for (const [type, win] of windows) {
                if (!win || win.utilization == null) continue;
                rateLimitWindows[type] = {
                  utilization: win.utilization,
                  resetsAt: win.resets_at || null,
                };
              }
              if (Object.keys(rateLimitWindows).length) {
                emitCascadeStats(emit, { rateLimitWindows, subscriptionType: plan.subscription_type || undefined });
              }
            }
          }
        } catch { /* experimental / unavailable */ }
      } else if (message.type === 'system') {
        emitHarness(emit, `\x1b[2m# system ${message.subtype || ''}\x1b[0m\r\n`);
      }

      emit(classifySdkMessage(message), message);
      if (message.type === 'result') summary = message.result || message.subtype || summary;
    }
  } catch (error) {
    // The SDK throws when the per-query turn cap is hit. Tag it with the live
    // session id + partial text so the caller can auto-continue (resume the
    // same session for another turn window) instead of hard-failing.
    if (error && /maximum number of turns/i.test(error.message || '')) {
      error.cascadeMaxTurns = true;
      error.cascadeSessionId = sessionId;
      error.cascadePartialText = streamedText;
    }
    throw error;
  } finally {
    activeClaudeQueries.delete(runId);
  }
  // Chat runs: prefer the streamed assistant text over a generic SDK result.
  // Non-chat note runs keep the SDK result as the summary for the run list.
  if (chatRun && (latestAssistantText.trim() || streamedText.trim())) {
    return { summary: latestAssistantText.trim() || streamedText.trim(), sessionId };
  }
  return { summary: summary || streamedText.trim() || 'Completed note operations successfully.', sessionId };
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
    // Auto-continue past the per-query turn cap: hitting maxTurns isn't a
    // context-window problem (the SDK autocompacts that on its own) — it's a
    // guardrail on agentic loop length. Rather than hard-fail a long task, we
    // resume the same session for another turn window, bounded so a runaway
    // still stops. Only for chat runs; note-pane runs keep the single window.
    const chatRun = isChatRun(opts);
    const maxContinues = chatRun ? CLAUDE_CHAT_MAX_CONTINUES : 0;
    let resume = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId : undefined;
    let runPrompt = prompt;
    let attempt = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const result = await runClaudeLocally({ ...opts, prompt: runPrompt, resumeSessionId: resume }, emit);
          emitTerminalStatus(emit, runId, 'completed', result.summary, result.sessionId);
          return { sessionId: result.sessionId };
        } catch (error) {
          if (error && error.cascadeMaxTurns && error.cascadeSessionId && attempt < maxContinues) {
            attempt += 1;
            resume = error.cascadeSessionId;
            runPrompt = 'Continue where you left off.';
            emitHarness(emit, `\x1b[2m# turn limit reached — auto-continuing (${attempt}/${maxContinues})\x1b[0m\r\n`);
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          // Friendlier, actionable message when we truly cap out — the session
          // persists, so a follow-up ping resumes from here.
          const friendly = error && error.cascadeMaxTurns
            ? `Reached the turn limit after ${maxContinues + 1} windows — reply to continue where I left off.`
            : message;
          emitTerminalStatus(emit, runId, 'failed', friendly, error?.cascadeSessionId);
          throw error;
        }
      }
    } finally {
      cleanupRunHelperConfig(runId);
    }
  }

  const { runCliAgent, setRunHelperEnv, clearRunHelperEnv } = await loadCliAgentModule();
  const helperEnv = buildRunHelperEnv(opts);
  setRunHelperEnv(runId, helperEnv);
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);

  const env = { ...process.env, ...helperEnv };

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
      env,
    });
    emitTerminalStatus(emit, runId, 'completed', result.summary || 'Done.', result.sessionId);
    return { sessionId: result.sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitTerminalStatus(emit, runId, 'failed', message);
    throw error;
  } finally {
    clearRunHelperEnv(runId);
    cleanupRunHelperConfig(runId);
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

  const mod = await loadCliAgentModule();
  // Antigravity keeps polling transcript.jsonl after agentapi exits — flag it.
  let flagged = false;
  if (typeof mod.cancelAntigravityRun === 'function') {
    try { mod.cancelAntigravityRun(id); flagged = true; } catch { /* ignore */ }
  }
  const child = mod.activeCliProcesses?.get(id);
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    mod.activeCliProcesses.delete(id);
    return true;
  }
  return flagged;
}

module.exports = {
  startLocalAgentRun,
  cancelLocalAgentRun,
  helperAllowedTools,
  resolveAgentCwd,
  setNoteApiConfig,
};
