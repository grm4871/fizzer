/**
 * @file desktop-runner-host.cjs — Main-process desktop agent runner relay
 *
 * Connects to the Cascade server's /runners socket and executes delegated CLI
 * agent runs locally. Lives in the main process so it always pairs with
 * agent-runner.cjs (no renderer IPC required).
 *
 * Reconnect-safe: calling connect with the same token/url is a no-op when
 * already connected (or reconnecting). Intentional reconnects do not cancel
 * in-flight local agent runs — only explicit disconnect/logout does.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { startLocalAgentRun, cancelLocalAgentRun, setNoteApiConfig } = require('./agent-runner.cjs');

function loadSocketIoClient() {
  try {
    return require('socket.io-client');
  } catch {
    return require(path.join(__dirname, '..', 'node_modules', 'socket.io-client'));
  }
}

const { io } = loadSocketIoClient();

let socket = null;
let apiBase = 'https://cscd.online';
/** Auth token currently driving the socket (for idempotent reconnects). */
let currentToken = '';
/** Active local runs keyed by runId → abort/cleanup marker. */
const activeRuns = new Map();
/**
 * Terminal events that may have been emitted while the server was down.
 * Re-sent on reconnect so the server can settle the run after restart.
 * Entries expire after TERMINAL_REPLAY_MS.
 */
const recentTerminalEvents = new Map();
const TERMINAL_REPLAY_MS = 5 * 60 * 1000;

function normalizeApiBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'https://cscd.online';
  return raw.replace(/\/$/, '');
}

function pruneRecentTerminals() {
  const cutoff = Date.now() - TERMINAL_REPLAY_MS;
  for (const [runId, entry] of recentTerminalEvents.entries()) {
    if (!entry || entry.at < cutoff) recentTerminalEvents.delete(runId);
  }
}

function emitRunEvent(runId, type, payload) {
  if (type === 'status' && payload && typeof payload === 'object') {
    const status = payload.status;
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      recentTerminalEvents.set(runId, { type, payload, at: Date.now() });
      pruneRecentTerminals();
    }
  }
  socket?.emit('runner:runEvent', { runId, type, payload });
}

function registerWithServer(activeSocket) {
  const models = probeLocalModels();
  const activeRunIds = [...activeRuns.keys()].filter((id) => Number.isFinite(Number(id))).map(Number);
  activeSocket.emit('runner:register', { models, activeRunIds });
  // Re-emit terminal status for runs that finished while disconnected so the
  // post-restart server can settle them instead of waiting for orphan timeout.
  pruneRecentTerminals();
  for (const [runId, entry] of recentTerminalEvents.entries()) {
    if (activeRuns.has(runId)) continue; // still live — stream will continue
    activeSocket.emit('runner:runEvent', { runId, type: entry.type, payload: entry.payload });
  }
}

/**
 * Probe locally installed CLIs for model lists (best-effort).
 * Returns { agentId: string[] } for agents that report models.
 */
function probeLocalModels() {
  const models = {};
  try {
    const result = spawnSync('grok', ['models'], {
      encoding: 'utf8',
      timeout: 8000,
      env: process.env,
    });
    if (result.status === 0 && result.stdout) {
      const ids = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        // Lines like "  * grok-4.5 (default)" or "  - grok-composer-2.5-fast"
        const m = line.match(/^\s*[*-]\s+([a-zA-Z0-9._-]+)/);
        if (m) ids.push(m[1]);
      }
      if (ids.length) models.grok = ids;
    }
  } catch {
    // grok not installed
  }
  return models;
}

async function handleDelegatedRun(payload) {
  const runId = Number(payload?.runId);
  if (!Number.isFinite(runId)) return;

  if (activeRuns.has(runId)) {
    try { await cancelLocalAgentRun(runId); } catch { /* ignore */ }
    activeRuns.delete(runId);
  }

  activeRuns.set(runId, true);
  try {
    await startLocalAgentRun(payload, (event) => {
      emitRunEvent(runId, event.type, JSON.parse(event.payload_json));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local agent run failed.';
    emitRunEvent(runId, 'status', { status: 'failed', summary: message });
  } finally {
    activeRuns.delete(runId);
  }
}

/**
 * Drop the socket only. Leave local agent processes running so a brief
 * reconnect (focus resync, transport swap) does not kill mid-turn work.
 */
function detachSocket() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

/**
 * Full teardown: cancel local runs and disconnect. Used on logout / missing token.
 */
function disconnectDesktopRunner() {
  for (const runId of [...activeRuns.keys()]) {
    void cancelLocalAgentRun(runId);
  }
  activeRuns.clear();
  currentToken = '';
  detachSocket();
}

function wireSocketHandlers(activeSocket) {
  activeSocket.on('connect', () => {
    registerWithServer(activeSocket);
    console.log(
      `[DesktopRunner] Connected to ${apiBase}/runners`
      + (activeRuns.size ? ` (reclaiming ${activeRuns.size} active run(s))` : ''),
    );
  });

  activeSocket.on('connect_error', (error) => {
    console.error('[DesktopRunner] Connection error:', error?.message || error);
  });

  activeSocket.on('run:delegate', (payload) => {
    void handleDelegatedRun(payload);
  });

  activeSocket.on('run:cancel', (data) => {
    const runId = Number(data?.runId);
    if (!Number.isFinite(runId)) return;
    activeRuns.delete(runId);
    recentTerminalEvents.delete(runId);
    void cancelLocalAgentRun(runId);
  });

  activeSocket.on('disconnect', (reason) => {
    console.log('[DesktopRunner] Disconnected:', reason);
  });
}

function connectDesktopRunner(token, nextApiBase) {
  const authToken = String(token || '').trim();
  if (!authToken) {
    disconnectDesktopRunner();
    return { success: false, error: 'Missing auth token' };
  }

  const nextBase = normalizeApiBase(nextApiBase);

  // Idempotent: same credentials + existing socket → keep it.
  // Renderer focus/visibility resync calls setRunnerToken often; tearing down
  // here was cancelling agents and failing server-side delegated runs.
  if (socket && currentToken === authToken && apiBase === nextBase) {
    setNoteApiConfig({ url: nextBase, token: authToken });
    if (socket.connected) {
      registerWithServer(socket);
      return { success: true, reused: true };
    }
    // Socket.io client is reconnecting on its own — do not recreate.
    return { success: true, reused: true, reconnecting: true };
  }

  // Credential/url change: swap socket without killing in-flight local runs.
  // The new server connection will own new delegates; old run events still
  // stream if the process is mid-flight (orphaned until process ends).
  apiBase = nextBase;
  currentToken = authToken;
  detachSocket();

  // Let the `cascade-note` wrapper auth against the same live instance the
  // desktop is connected to, reusing this session's token — so agents create
  // notes in the running app (cscd.online) rather than a local file copy.
  setNoteApiConfig({ url: apiBase, token: authToken });

  socket = io(`${apiBase}/runners`, {
    auth: { token: authToken },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    // Avoid hammering the server during brief network blips mid-run.
    reconnectionDelayMax: 10000,
    timeout: 20000,
  });

  wireSocketHandlers(socket);

  return { success: true };
}

module.exports = {
  connectDesktopRunner,
  disconnectDesktopRunner,
  isDesktopRunnerConnected: () => Boolean(socket?.connected),
  getActiveRunCount: () => activeRuns.size,
};
