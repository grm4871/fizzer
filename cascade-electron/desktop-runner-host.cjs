/**
 * @file desktop-runner-host.cjs — Main-process desktop agent runner relay
 *
 * Connects to the Cascade server's /runners socket and executes delegated CLI
 * agent runs locally. Lives in the main process so it always pairs with
 * agent-runner.cjs (no renderer IPC required).
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
/** Active local runs keyed by runId → abort/cleanup marker. */
const activeRuns = new Map();

function normalizeApiBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'https://cscd.online';
  return raw.replace(/\/$/, '');
}

function emitRunEvent(runId, type, payload) {
  socket?.emit('runner:runEvent', { runId, type, payload });
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

function disconnectDesktopRunner() {
  for (const runId of [...activeRuns.keys()]) {
    void cancelLocalAgentRun(runId);
  }
  activeRuns.clear();
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

function connectDesktopRunner(token, nextApiBase) {
  const authToken = String(token || '').trim();
  if (!authToken) {
    disconnectDesktopRunner();
    return { success: false, error: 'Missing auth token' };
  }

  apiBase = normalizeApiBase(nextApiBase);
  disconnectDesktopRunner();

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
  });

  socket.on('connect', () => {
    const models = probeLocalModels();
    socket.emit('runner:register', { models });
    console.log(`[DesktopRunner] Connected to ${apiBase}/runners`);
  });

  socket.on('connect_error', (error) => {
    console.error('[DesktopRunner] Connection error:', error?.message || error);
  });

  socket.on('run:delegate', (payload) => {
    void handleDelegatedRun(payload);
  });

  socket.on('run:cancel', (data) => {
    const runId = Number(data?.runId);
    if (!Number.isFinite(runId)) return;
    activeRuns.delete(runId);
    void cancelLocalAgentRun(runId);
  });

  socket.on('disconnect', (reason) => {
    console.log('[DesktopRunner] Disconnected:', reason);
  });

  return { success: true };
}

module.exports = {
  connectDesktopRunner,
  disconnectDesktopRunner,
  isDesktopRunnerConnected: () => Boolean(socket?.connected),
  getActiveRunCount: () => activeRuns.size,
};
