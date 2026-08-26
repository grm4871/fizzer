/** Helper PATH, per-run config, prompt context, and terminal status seam. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Resvg } = require('@resvg/resvg-js');
// Claude runs through THIS machine's separately installed `claude` CLI and its
// login / ANTHROPIC_API_KEY — never the server's credentials.
// Mirrors the run options the server used to apply in server/runner.ts.
const CLAUDE_DEFAULT_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-5';
// Match Claude Code's adaptive reasoning instead of imposing a small fixed
// thinking budget. The local CLI currently defaults to medium effort; callers
// can override either surface without introducing a hard token ceiling.
const CLAUDE_EFFORT = process.env.RUNNER_EFFORT || 'medium';
const CLAUDE_CHAT_EFFORT = process.env.RUNNER_CHAT_EFFORT || CLAUDE_EFFORT;
const CLAUDE_AGENT_CONTEXT = 'You are a local workspace assistant. This checkout is not the live Cascade app: use `cascade-note` for live notes (`cascade-note memory` for durable recall), `cascade-scratchpad jot` for work-journal entries, and normal file edits only for local scratch or non-note work. Notes you create via cascade-note are unlisted by default (chat/search/embed only, not the left sidebar). Only pass `--listed` if the user explicitly asks to put a note in the sidebar tree. Respect auth boundaries and only handle secrets the user explicitly provides for this task.';

// Nudge agents to behave like chat participants, not verbose coding CLIs: the
// chat collapses step narration into a trace disclosure, so the actual message
// should be short. Detailed reasoning belongs in thinking, not the reply.
const CHAT_BREVITY_CONTEXT = 'You are a chat participant, not a coding CLI. Reply like a person in a chat channel: a few short sentences of plain prose, lead with the outcome. Do NOT format the reply as a report — no headings, no bold/italic emphasis, no bullet lists, no em-dash asides, and no restating the question. Keep it to one short paragraph where possible; use a blank line only to separate genuinely distinct points, never after every sentence. Put reasoning, step narration, and detail in thinking or the run trace, not the message. Do not confuse a mentioned @handle with the message author.';
const CHAT_CONTEXT_TOOL_CONTEXT = 'Your channel transcript is append-only. A continued turn contains only new room activity and an exact message cursor. Use the pre-authorized `cascade-chat history --around-message-id <id> --include-reply-context` or `cascade-chat search <query>` tool when that delta is insufficient; never require a repeated sliding-window transcript.';

// Live Cascade API config for helper wrappers, populated by the
// desktop runner host once it knows the server URL + the user's auth token.
// Children inherit these via process.env, so the wrapper authenticates against
// the same live instance the desktop is connected to (cscd.online by default).
const noteApi = { url: '', token: '', configured: false };
const AGENT_STATE_DIR = process.env.CASCADE_AGENT_STATE_DIR
  || process.env.CASCADE_USER_DATA_DIR
  || path.join(os.homedir(), '.cascade');
const HELPER_CONFIG_PATH = path.join(AGENT_STATE_DIR, 'agent-helper-context.json');
const RUN_CONTEXT_DIR = path.join(AGENT_STATE_DIR, 'run-contexts');
const USER_BIN_DIR = process.env.CASCADE_AGENT_BIN_DIR || path.join(os.homedir(), '.local', 'bin');
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
const INLINE_SVG_NOTE = (sourcePath) => `[FIZZER HARNESS NOTE TO AGENT: THIS INLINE SVG WAS REPLACED BY AN IMAGE. TO SEE THE SOURCE CODE FOR THE SVG, SEE <${sourcePath}>]`;

/** Render inline SVG prompt fragments into image attachments while retaining source access. */
function renderInlineSvgAttachments(prompt, inlineSvgs) {
  const input = String(prompt || '');
  const sources = Array.isArray(inlineSvgs) ? inlineSvgs.filter((svg) => typeof svg === 'string') : [];
  if (!sources.length) return { prompt: input, images: [], cleanup: () => {} };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-inline-svg-'));
  const images = [];
  let rewritten = input;
  sources.forEach((svg, offset) => {
    const index = offset + 1;
    const marker = `[[FIZZER_INLINE_SVG:${index}]]`;
    if (!rewritten.includes(marker)) return;
    const sourcePath = path.join(dir, `inline-${index}.svg`);
    try {
      fs.writeFileSync(sourcePath, svg, { mode: 0o600 });
      const png = new Resvg(svg).render().asPng();
      images.push({ media_type: 'image/png', data: Buffer.from(png).toString('base64') });
      rewritten = rewritten.replace(marker, INLINE_SVG_NOTE(sourcePath));
    } catch (error) {
      console.warn('[agent-runner] failed to render inline SVG:', error?.message || error);
      try { fs.rmSync(sourcePath, { force: true }); } catch { /* ignore */ }
      rewritten = rewritten.replace(marker, svg);
    }
  });

  if (!images.length) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { prompt: rewritten, images: [], cleanup: () => {} };
  }

  let cleaned = false;
  return {
    prompt: rewritten,
    images,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

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

function chatTriggeringMessageId(opts) {
  return String(opts && opts.chatTriggeringMessageId || opts?.chat?.triggeringMessageId || '').trim();
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
  const triggeringMessageId = chatTriggeringMessageId(opts);
  if (triggeringMessageId) env.CASCADE_CHAT_TRIGGERING_MESSAGE = triggeringMessageId;
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

function writeHelperConfig({ runId, vaultId, channelId, messageId, triggeringMessageId, chatAuthor, agentId, agentMemoryKey, registrationId, workItemId } = {}) {
  const payload = {
    url: noteApi.configured ? noteApi.url : (noteApi.url || process.env.CASCADE_NOTE_URL || 'https://cscd.online'),
    token: noteApi.configured ? noteApi.token : (noteApi.token || process.env.CASCADE_NOTE_TOKEN || ''),
    vaultId: vaultId || process.env.CASCADE_NOTE_VAULT || '',
    chatChannelId: channelId || process.env.CASCADE_CHAT_CHANNEL || '',
    chatMessageId: messageId || process.env.CASCADE_CHAT_MESSAGE || '',
    chatTriggeringMessageId: triggeringMessageId || process.env.CASCADE_CHAT_TRIGGERING_MESSAGE || '',
    chatAuthor: chatAuthor || process.env.CASCADE_CHAT_AUTHOR || '',
    agentId: agentId || '',
    agentMemoryKey: agentMemoryKey || '',
    registrationId: registrationId || '',
    workItemId: workItemId || '',
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
  const triggeringMessageId = chatTriggeringMessageId(opts);
  const chatAuthor = String(opts && opts.chatAuthor || '').trim();
  const agentId = String(opts && opts.agent || '').trim();
  const agentMemoryKey = String(opts && opts.agentMemoryKey || '').trim();
  const registrationId = String(opts && opts.chatRegistrationId || '').trim();
  const workItemId = String(opts && opts.workItemId || '').trim();
  const configPath = writeHelperConfig({
    runId,
    vaultId,
    channelId,
    messageId,
    triggeringMessageId,
    chatAuthor,
    agentId,
    agentMemoryKey,
    registrationId,
    workItemId,
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
  if (triggeringMessageId) env.CASCADE_CHAT_TRIGGERING_MESSAGE = triggeringMessageId;
  if (chatAuthor) env.CASCADE_CHAT_AUTHOR = chatAuthor;
  if (workItemId) env.CASCADE_WORK_ITEM_ID = workItemId;
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
    summary: summary || (status === 'completed' ? '' : status === 'canceled' ? 'Run canceled.' : 'Agent failed.'),
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




module.exports = { CLAUDE_DEFAULT_MODEL, CLAUDE_EFFORT, CLAUDE_CHAT_EFFORT, CLAUDE_AGENT_CONTEXT, CHAT_BREVITY_CONTEXT, CHAT_CONTEXT_TOOL_CONTEXT, renderInlineSvgAttachments, resolveWrapperDir, buildAgentEnv, setNoteApiConfig, chatTriggeringMessageId, buildRunHelperEnv, cleanupRunHelperConfig, readUsedChatSend, emitTerminalStatus, isChatRun, noteCapabilityContext, helperAllowedTools };
