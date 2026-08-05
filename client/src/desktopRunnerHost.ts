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
  prepareWorktree?: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cancelAgentRun?: (runId: number) => Promise<{ success: boolean; error?: string }>;
  getAgentRunState?: (afterSeq?: number) => Promise<{
    instanceId?: string;
    activeRunIds?: number[];
    events?: AgentEventPayload[];
    cursor?: number;
  }>;
  onAgentEvent?: (callback: (payload: AgentEventPayload) => void) => () => void;
  getRunnerModels?: () => Promise<{ models?: Record<string, string[]> }>;
  getRunnerPlanUsage?: () => Promise<{ usage?: Record<string, unknown> }>;
};

type AgentEventPayload = {
  runId?: number;
  type?: string;
  payload_json?: string;
  bridgeSeq?: number;
};

type DelegatedRunPayload = {
  runId?: number;
  agent?: string;
  prompt?: string;
  cwd?: string;
  vaultRoot?: string;
  model?: string;
  reasoningEffort?: string;
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
const PLAN_USAGE_REFRESH_MS = 5 * 60 * 1000;
const PLAN_USAGE_MIN_REFRESH_MS = 4 * 60 * 1000;

let socket: Socket | null = null;
let currentToken = '';
let apiBase = '';
let agentEventUnsub: (() => void) | null = null;
let planUsageTimer: number | null = null;
let planUsageInFlight: Promise<void> | null = null;
let lastPlanUsageAt = 0;
let lastPlanUsage: Record<string, unknown> | null = null;
const activeRunIds = new Set<number>();
const recentTerminalEvents = new Map<number, { type: string; payload: unknown; at: number }>();
const BRIDGE_CURSOR_KEY = 'cascade_runner_bridge_cursor';
let bridgeInstanceId = '';
let bridgeCursor = 0;

/**
 * Main may report "not found" in the few milliseconds between child-registry
 * cleanup and the terminal bridge event. Wait briefly for that authoritative
 * event before telling the server cancellation failed.
 */
export async function reconcileCancelAcknowledgement(
  success: boolean,
  runId: number,
  active = activeRunIds,
  timeoutMs = 1000,
): Promise<boolean> {
  if (success || !active.has(runId)) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (!active.has(runId)) return true;
  }
  return false;
}

function loadBridgeCursor(instanceId: string): number {
  try {
    const saved = JSON.parse(localStorage.getItem(BRIDGE_CURSOR_KEY) || '{}') as { instanceId?: string; cursor?: number };
    return saved.instanceId === instanceId && Number.isFinite(Number(saved.cursor)) ? Number(saved.cursor) : 0;
  } catch {
    return 0;
  }
}

function saveBridgeCursor(): void {
  if (!bridgeInstanceId) return;
  localStorage.setItem(BRIDGE_CURSOR_KEY, JSON.stringify({ instanceId: bridgeInstanceId, cursor: bridgeCursor }));
}

function processAgentEvent(event: AgentEventPayload): void {
  // Main keeps the replay copy. Do not acknowledge an event until there is a
  // connected server socket to receive it.
  if (!socket?.connected) return;
  const seq = Number(event?.bridgeSeq);
  if (Number.isFinite(seq) && seq <= bridgeCursor) return;
  const runId = Number(event?.runId);
  if (!Number.isFinite(runId) || !event?.type || typeof event.payload_json !== 'string') return;
  try {
    const payload = JSON.parse(event.payload_json);
    emitRunEvent(runId, event.type, payload);
    if (Number.isFinite(seq)) {
      bridgeCursor = Math.max(bridgeCursor, seq);
      saveBridgeCursor();
    }
  } catch {
    // Ignore one malformed IPC event; the run status will still settle.
  }
}

async function restoreMainProcessRuns(): Promise<void> {
  const api = runnerElectronAPI();
  if (!api?.getAgentRunState) return;
  const initial = await api.getAgentRunState(0);
  const instanceId = String(initial?.instanceId || '');
  if (instanceId !== bridgeInstanceId) {
    bridgeInstanceId = instanceId;
    bridgeCursor = loadBridgeCursor(instanceId);
  }
  const state = bridgeCursor > 0 ? await api.getAgentRunState(bridgeCursor) : initial;
  for (const runId of state?.activeRunIds || []) {
    if (Number.isFinite(Number(runId))) activeRunIds.add(Number(runId));
  }
  for (const event of state?.events || []) processAgentEvent(event);
}

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
      if (socket) window.setTimeout(() => void publishPlanUsage(socket, true), 1_000);
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

async function publishPlanUsage(activeSocket: Socket, force = false): Promise<void> {
  const api = runnerElectronAPI();
  if (!api?.getRunnerPlanUsage || !activeSocket.connected) return;
  if (!force && Date.now() - lastPlanUsageAt < PLAN_USAGE_MIN_REFRESH_MS) {
    if (lastPlanUsage) activeSocket.emit('runner:planUsage', { usage: lastPlanUsage });
    return;
  }
  if (planUsageInFlight) return planUsageInFlight;
  planUsageInFlight = (async () => {
    try {
      const result = await api.getRunnerPlanUsage?.();
      if (!activeSocket.connected || !result?.usage || typeof result.usage !== 'object') return;
      lastPlanUsageAt = Date.now();
      lastPlanUsage = result.usage;
      activeSocket.emit('runner:planUsage', { usage: result.usage });
    } catch {
      // Best effort: old desktop builds simply keep plan usage absent.
    } finally {
      planUsageInFlight = null;
    }
  })();
  return planUsageInFlight;
}

async function registerWithServer(activeSocket: Socket): Promise<void> {
  await restoreMainProcessRuns();
  const models = await probeModels();
  const ids = [...activeRunIds].filter((id) => Number.isFinite(id));
  activeSocket.emit('runner:register', { models, activeRunIds: ids, runnerInstanceId: bridgeInstanceId || undefined });
  void publishPlanUsage(activeSocket);
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
    processAgentEvent(event);
  });
}

function detachSocket(): void {
  if (planUsageTimer != null) {
    window.clearInterval(planUsageTimer);
    planUsageTimer = null;
  }
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

function disconnectDesktopRunnerSocket(): void {
  currentToken = '';
  apiBase = '';
  lastPlanUsageAt = 0;
  lastPlanUsage = null;
  detachSocket();
}

function wireSocketHandlers(activeSocket: Socket): void {
  activeSocket.on('connect', () => {
    void registerWithServer(activeSocket);
    if (planUsageTimer != null) window.clearInterval(planUsageTimer);
    planUsageTimer = window.setInterval(
      () => void publishPlanUsage(activeSocket),
      PLAN_USAGE_REFRESH_MS,
    );
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

  activeSocket.on('workspace:prepare', async (
    payload: Record<string, unknown>,
    acknowledge?: (result: Record<string, unknown>) => void,
  ) => {
    const api = runnerElectronAPI();
    if (!api?.prepareWorktree) {
      acknowledge?.({ ok: false, error: 'This desktop build cannot prepare task workspaces' });
      return;
    }
    try {
      acknowledge?.(await api.prepareWorktree(payload));
    } catch (error) {
      acknowledge?.({
        ok: false,
        error: error instanceof Error ? error.message : 'Could not prepare task workspace',
      });
    }
  });

  activeSocket.on('run:cancel', async (
    data: { runId?: number },
    acknowledge?: (result: { success: boolean }) => void,
  ) => {
    const runId = Number(data?.runId);
    if (!Number.isFinite(runId)) {
      acknowledge?.({ success: false });
      return;
    }
    const result = await runnerElectronAPI()?.cancelAgentRun?.(runId).catch(() => ({ success: false }));
    const success = await reconcileCancelAcknowledgement(result?.success === true, runId);
    if (success) {
      activeRunIds.delete(runId);
      recentTerminalEvents.delete(runId);
    }
    acknowledge?.({ success });
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

  // Child agents receive a short-lived, server-restricted credential. Keep the
  // user's full session token in the renderer for the runner socket only.
  if (api.setRunnerToken) {
    void api.clearRunnerToken?.();
    void fetch(`${resolvedBase}/api/auth/agent-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { token?: string; error?: string };
        if (!response.ok || !body.token) {
          throw new Error(body.error || 'Could not create restricted agent credential');
        }
        return api.setRunnerToken!({ token: body.token, apiUrl: resolvedBase });
      })
      .then((result) => {
        if (!result?.success) throw new Error(result?.error || 'Could not configure restricted agent credential');
        connectDesktopRunnerSocket(token, resolvedBase);
      })
      .catch((error) => {
        console.error('Desktop runner credential setup failed:', error);
        void api.clearRunnerToken?.();
      });
  } else {
    // Legacy desktop bridge: socket still lives here so TLS uses Chromium.
    connectDesktopRunnerSocket(token, resolvedBase);
  }

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
