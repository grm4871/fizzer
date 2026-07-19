/**
 * Desktop runner host — Chromium-side /runners relay.
 *
 * The socket MUST live in the renderer (Chromium network stack), not Electron
 * main (Node/OpenSSL). On some residential networks a middlebox corrupts Node
 * TLS ClientHellos to cscd.online (returns 0xFF padding → WRONG_VERSION_NUMBER)
 * while Chromium still connects fine. Agents still execute in main via IPC.
 */

import { io, type Socket } from 'socket.io-client';

type RunnerElectronAPI = {
  setRunnerToken?: (opts: { token: string; apiUrl?: string }) => Promise<{ success: boolean; error?: string }>;
  clearRunnerToken?: () => Promise<{ success: boolean }>;
  startAgentRun?: (opts: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
  cancelAgentRun?: (runId: number) => Promise<{ success: boolean; error?: string }>;
  onAgentEvent?: (callback: (payload: AgentEventPayload) => void) => () => void;
  getRunnerModels?: () => Promise<{ models?: Record<string, string[]> }>;
};

type AgentEventPayload = {
  runId?: number;
  type?: string;
  payload_json?: string;
};

type DelegatedRunPayload = {
  runId?: number;
  agent?: string;
  prompt?: string;
  cwd?: string;
  vaultRoot?: string;
  model?: string;
  yolo?: boolean;
  resumeSessionId?: string;
  images?: unknown[];
  conversationId?: string;
  vaultId?: string;
  chatChannelId?: string;
  chatMessageId?: string;
  noteId?: string;
  [key: string]: unknown;
};

const TERMINAL_REPLAY_MS = 5 * 60 * 1000;

let socket: Socket | null = null;
let currentToken = '';
let apiBase = '';
let agentEventUnsub: (() => void) | null = null;
const activeRunIds = new Set<number>();
const recentTerminalEvents = new Map<number, { type: string; payload: unknown; at: number }>();

function runnerElectronAPI(): RunnerElectronAPI | undefined {
  return (window as unknown as { electronAPI?: RunnerElectronAPI }).electronAPI;
}

function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin.replace(/\/$/, '');
  }
  return '';
}

function pruneRecentTerminals(): void {
  const cutoff = Date.now() - TERMINAL_REPLAY_MS;
  for (const [runId, entry] of recentTerminalEvents.entries()) {
    if (!entry || entry.at < cutoff) recentTerminalEvents.delete(runId);
  }
}

function emitRunEvent(runId: number, type: string, payload: unknown): void {
  if (type === 'status' && payload && typeof payload === 'object') {
    const status = (payload as { status?: string }).status;
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      recentTerminalEvents.set(runId, { type, payload, at: Date.now() });
      pruneRecentTerminals();
      activeRunIds.delete(runId);
    }
  }
  socket?.emit('runner:runEvent', { runId, type, payload });
}

async function probeModels(): Promise<Record<string, string[]>> {
  const api = runnerElectronAPI();
  if (!api?.getRunnerModels) return {};
  try {
    const res = await api.getRunnerModels();
    return res?.models && typeof res.models === 'object' ? res.models : {};
  } catch {
    return {};
  }
}

async function registerWithServer(activeSocket: Socket): Promise<void> {
  const models = await probeModels();
  const ids = [...activeRunIds].filter((id) => Number.isFinite(id));
  activeSocket.emit('runner:register', { models, activeRunIds: ids });
  pruneRecentTerminals();
  for (const [runId, entry] of recentTerminalEvents.entries()) {
    if (activeRunIds.has(runId)) continue;
    activeSocket.emit('runner:runEvent', { runId, type: entry.type, payload: entry.payload });
  }
}

async function handleDelegatedRun(payload: DelegatedRunPayload): Promise<void> {
  const api = runnerElectronAPI();
  const runId = Number(payload?.runId);
  if (!Number.isFinite(runId) || !api?.startAgentRun) return;

  if (activeRunIds.has(runId) && api.cancelAgentRun) {
    try { await api.cancelAgentRun(runId); } catch { /* ignore */ }
    activeRunIds.delete(runId);
  }

  activeRunIds.add(runId);
  try {
    const res = await api.startAgentRun(payload as Record<string, unknown>);
    if (!res?.success) {
      const message = res?.error || 'Failed to start local agent run.';
      emitRunEvent(runId, 'status', { status: 'failed', summary: message });
      activeRunIds.delete(runId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local agent run failed.';
    emitRunEvent(runId, 'status', { status: 'failed', summary: message });
    activeRunIds.delete(runId);
  }
}

function ensureAgentEventBridge(): void {
  if (agentEventUnsub) return;
  const api = runnerElectronAPI();
  if (!api?.onAgentEvent) return;
  agentEventUnsub = api.onAgentEvent((event) => {
    const runId = Number(event?.runId);
    if (!Number.isFinite(runId) || !event?.type || typeof event.payload_json !== 'string') return;
    try {
      const payload = JSON.parse(event.payload_json);
      emitRunEvent(runId, event.type, payload);
    } catch {
      // Ignore one malformed IPC event; the run status will still settle.
    }
  });
}

function detachSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

function disconnectDesktopRunnerSocket(): void {
  currentToken = '';
  apiBase = '';
  detachSocket();
}

function wireSocketHandlers(activeSocket: Socket): void {
  activeSocket.on('connect', () => {
    void registerWithServer(activeSocket);
    console.info(
      `[DesktopRunner] Connected to ${apiBase}/runners`
      + (activeRunIds.size ? ` (reclaiming ${activeRunIds.size} active run(s))` : ''),
    );
  });

  activeSocket.on('connect_error', (error) => {
    console.error('[DesktopRunner] Connection error:', error?.message || error);
  });

  activeSocket.on('run:delegate', (payload: DelegatedRunPayload) => {
    void handleDelegatedRun(payload);
  });

  activeSocket.on('run:cancel', (data: { runId?: number }) => {
    const runId = Number(data?.runId);
    if (!Number.isFinite(runId)) return;
    activeRunIds.delete(runId);
    recentTerminalEvents.delete(runId);
    void runnerElectronAPI()?.cancelAgentRun?.(runId);
  });

  activeSocket.on('disconnect', (reason) => {
    console.info('[DesktopRunner] Disconnected:', reason);
  });
}

function connectDesktopRunnerSocket(token: string, nextApiBase: string): void {
  const authToken = String(token || '').trim();
  if (!authToken) {
    disconnectDesktopRunnerSocket();
    return;
  }

  const nextBase = String(nextApiBase || '').replace(/\/$/, '') || resolveApiBase();
  if (!nextBase) return;

  ensureAgentEventBridge();

  // Idempotent: same credentials + existing socket → keep it.
  if (socket && currentToken === authToken && apiBase === nextBase) {
    if (socket.connected) void registerWithServer(socket);
    return;
  }

  apiBase = nextBase;
  currentToken = authToken;
  detachSocket();

  socket = io(`${apiBase}/runners`, {
    auth: { token: authToken },
    // Polling first: Chromium HTTPS works here even when WS upgrade or Node
    // TLS is middleboxed. engine.io upgrades to websocket when available.
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 20000,
  });

  wireSocketHandlers(socket);
}

/**
 * Ensure the desktop runner relay is connected (after login).
 * Idempotent — safe to call on focus/visibility resync without killing runs.
 * No-op in a plain browser (no electronAPI).
 *
 * @param opts.clearOnStop When true (default), the returned stop() tears the
 *   runner down (logout / unmount). Pass false for resume pings that should
 *   only re-assert the token without ever clearing on cleanup.
 */
export function startDesktopRunnerHost(opts?: { clearOnStop?: boolean }): () => void {
  const api = runnerElectronAPI();
  if (!api?.setRunnerToken && !api?.startAgentRun) return () => {};

  const token = localStorage.getItem('docs_token');
  if (!token) return () => {};

  const resolvedBase = resolveApiBase();

  // Main process still needs token/url for cascade-note child env + model probe.
  if (api.setRunnerToken) {
    void api.setRunnerToken({ token, apiUrl: resolvedBase });
  }

  // Socket lives here so TLS uses Chromium, not Node.
  connectDesktopRunnerSocket(token, resolvedBase);

  const clearOnStop = opts?.clearOnStop !== false;
  return () => {
    if (!clearOnStop) return;
    // Logout/unmount: cancel in-flight local agents, then drop the socket.
    const cancel = api.cancelAgentRun;
    if (cancel) {
      for (const runId of [...activeRunIds]) {
        void cancel(runId);
      }
    }
    activeRunIds.clear();
    disconnectDesktopRunnerSocket();
    void api.clearRunnerToken?.();
  };
}

/** Soft re-assert of the runner connection (no teardown). */
export function ensureDesktopRunnerHost(): void {
  startDesktopRunnerHost({ clearOnStop: false })();
}
