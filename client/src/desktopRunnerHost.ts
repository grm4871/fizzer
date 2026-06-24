/**
 * Desktop runner host — keeps a /runners socket open in the Electron app so
 * CLI agent runs triggered from any client (browser, phone, etc.) execute locally.
 */

import { io, type Socket } from 'socket.io-client';
import {
  canRunCliAgentsLocally,
  cancelLocalAgentRun,
  isCliAgentId,
  startLocalAgentRun,
  type CliAgentId,
} from './localAgentRunner';

const API_BASE = import.meta.env.VITE_API_URL || '';

type DelegatedRunPayload = {
  runId: number;
  vaultId: string;
  agent: string;
  prompt: string;
  cwd?: string;
  vaultRoot?: string;
  model?: string;
  resumeSessionId?: string;
  images?: Array<{ media_type: string; data: string }>;
};

let socket: Socket | null = null;
const activeCleanups = new Map<number, () => void>();

function emitRunEvent(runId: number, type: string, payload: unknown) {
  socket?.emit('runner:runEvent', { runId, type, payload });
}

async function handleDelegatedRun(payload: DelegatedRunPayload) {
  const runId = Number(payload.runId);
  if (!Number.isFinite(runId) || !isCliAgentId(payload.agent)) return;

  if (activeCleanups.has(runId)) {
    activeCleanups.get(runId)?.();
    activeCleanups.delete(runId);
  }

  try {
    const cleanup = await startLocalAgentRun({
      runId,
      agent: payload.agent as CliAgentId,
      prompt: payload.prompt,
      cwd: payload.cwd,
      vaultRoot: payload.vaultRoot,
      model: payload.model,
      resumeSessionId: payload.resumeSessionId,
      images: payload.images,
    }, (event) => {
      emitRunEvent(runId, event.type, JSON.parse(event.payload_json));
    });
    activeCleanups.set(runId, cleanup);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local agent run failed.';
    emitRunEvent(runId, 'status', { status: 'failed', summary: message });
  }
}

/**
 * Connect to the server as this user's desktop agent runner.
 * No-op outside the Electron shell or when logged out.
 */
export function startDesktopRunnerHost(): () => void {
  if (!canRunCliAgentsLocally()) return () => {};

  const token = localStorage.getItem('docs_token');
  if (!token) return () => {};

  socket = io(`${API_BASE}/runners`, {
    auth: { token },
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    socket?.emit('runner:register');
  });

  socket.on('run:delegate', (payload: DelegatedRunPayload) => {
    void handleDelegatedRun(payload);
  });

  socket.on('run:cancel', (data: { runId?: number }) => {
    const runId = Number(data?.runId);
    if (!Number.isFinite(runId)) return;
    activeCleanups.get(runId)?.();
    activeCleanups.delete(runId);
    void cancelLocalAgentRun(runId);
  });

  return () => {
    for (const cleanup of activeCleanups.values()) cleanup();
    activeCleanups.clear();
    socket?.disconnect();
    socket = null;
  };
}