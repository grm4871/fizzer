/**
 * @file desktop-runner-host.cjs — Main-process desktop agent runner relay
 *
 * Connects to the Cascade server's /runners socket and executes delegated CLI
 * agent runs locally. Lives in the main process so it always pairs with
 * agent-runner.cjs (no renderer IPC required).
 */

const path = require('path');
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
const activeCleanups = new Map();

function normalizeApiBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'https://cscd.online';
  return raw.replace(/\/$/, '');
}

function emitRunEvent(runId, type, payload) {
  socket?.emit('runner:runEvent', { runId, type, payload });
}

async function handleDelegatedRun(payload) {
  const runId = Number(payload?.runId);
  if (!Number.isFinite(runId)) return;

  if (activeCleanups.has(runId)) {
    activeCleanups.delete(runId);
  }

  try {
    await startLocalAgentRun(payload, (event) => {
      emitRunEvent(runId, event.type, JSON.parse(event.payload_json));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local agent run failed.';
    emitRunEvent(runId, 'status', { status: 'failed', summary: message });
  }
}

function disconnectDesktopRunner() {
  for (const runId of activeCleanups.keys()) {
    void cancelLocalAgentRun(runId);
  }
  activeCleanups.clear();
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
    socket.emit('runner:register');
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
    activeCleanups.delete(runId);
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
};