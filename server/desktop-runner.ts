/**
 * @file desktop-runner.ts — Relay CLI agent runs to a user's connected desktop app
 *
 * When a user triggers a chat agent from a browser (or any client), the server
 * delegates execution to their desktop Cascade instance, which has local CLIs
 * installed. Events stream back through the server to whichever client joined
 * the run room.
 */

import jwt from 'jsonwebtoken';
import type { Server, Socket } from 'socket.io';
import type Database from 'better-sqlite3';
import { resolveJwtSecret } from './security.js';

type Db = Database.Database;

export type RunImage = { media_type: string; data: string };

export type DelegatedRunPayload = {
  runId: number;
  vaultId: string;
  agent: string;
  prompt: string;
  cwd?: string;
  vaultRoot?: string;
  model?: string;
  resumeSessionId?: string;
  chatChannelId?: string;
  chatMessageId?: string;
  images?: RunImage[];
  /** Run with permission prompts bypassed ("yolo"). */
  yolo?: boolean;
};

type RunnerUser = { id: number; username: string };

type RunnerSocket = Socket & { data: { user?: RunnerUser } };

type RunnerHooks = {
  publishRunEvent: (db: Db, runId: number, type: string, payload: unknown) => unknown;
  finishDelegatedRun: (
    db: Db,
    runId: number,
    opts: { status: 'completed' | 'failed'; summary: string; sessionId?: string },
  ) => void;
};

const JWT_SECRET = resolveJwtSecret();
const runnersByUser = new Map<number, RunnerSocket>();
const delegatedRunOwners = new Map<number, number>();

export function initDesktopRunners(io: Server, db: Db, hooks: RunnerHooks): void {
  const runnersNamespace = io.of('/runners');
  runnersNamespace.use((socket, next) => {
    const token = typeof socket.handshake.auth.token === 'string' ? socket.handshake.auth.token : null;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as RunnerUser;
      socket.data.user = { id: decoded.id, username: decoded.username };
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  runnersNamespace.on('connection', (socket) => {
    const user = socket.data.user as RunnerUser | undefined;
    if (!user) {
      socket.disconnect();
      return;
    }

    const existing = runnersByUser.get(user.id);
    if (existing && existing.id !== socket.id) {
      existing.disconnect();
    }
    runnersByUser.set(user.id, socket);

    socket.on('runner:register', () => {
      runnersByUser.set(user.id, socket);
      socket.emit('runner:registered', { ok: true });
    });

    socket.on('runner:runEvent', (data: { runId?: number; type?: string; payload?: unknown }) => {
      const runId = Number(data?.runId);
      if (!Number.isFinite(runId) || !data?.type) return;
      if (delegatedRunOwners.get(runId) !== user.id) return;

      hooks.publishRunEvent(db, runId, data.type, data.payload ?? {});

      if (data.type === 'status' && data.payload && typeof data.payload === 'object') {
        const status = (data.payload as { status?: string }).status;
        if (status === 'completed' || status === 'failed') {
          const payload = data.payload as { summary?: string; sessionId?: string };
          hooks.finishDelegatedRun(db, runId, {
            status,
            summary: payload.summary || (status === 'completed' ? 'Done.' : 'Agent failed.'),
            sessionId: payload.sessionId,
          });
          delegatedRunOwners.delete(runId);
        }
      }
    });

    socket.on('disconnect', () => {
      if (runnersByUser.get(user.id)?.id === socket.id) {
        runnersByUser.delete(user.id);
      }
    });
  });
}

export function isDesktopRunnerOnline(userId: number): boolean {
  const socket = runnersByUser.get(userId);
  return Boolean(socket?.connected);
}

export function getDesktopRunnerStatus(userId: number) {
  return { online: isDesktopRunnerOnline(userId) };
}

/**
 * Resolve once the user's desktop runner is online, polling briefly so a
 * momentary gap (socket.io reconnect, or a heartbeat that lapsed while the
 * runner was busy streaming) doesn't hard-fail a run that's about to be
 * dispatchable. Returns false only if still offline after `timeoutMs`.
 */
export async function waitForDesktopRunner(userId: number, timeoutMs = 6000): Promise<boolean> {
  if (isDesktopRunnerOnline(userId)) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (isDesktopRunnerOnline(userId)) return true;
  }
  return false;
}

export function delegateRunToDesktop(userId: number, payload: DelegatedRunPayload): boolean {
  const socket = runnersByUser.get(userId);
  if (!socket?.connected) return false;
  delegatedRunOwners.set(payload.runId, userId);
  socket.emit('run:delegate', payload);
  return true;
}

export function isDelegatedRun(runId: number): boolean {
  return delegatedRunOwners.has(runId);
}

export function getDelegatedRunOwner(runId: number): number | undefined {
  return delegatedRunOwners.get(runId);
}

export function cancelDelegatedRun(userId: number, runId: number): boolean {
  const socket = runnersByUser.get(userId);
  if (!socket?.connected) return false;
  socket.emit('run:cancel', { runId });
  return true;
}

export function clearDelegatedRun(runId: number): void {
  delegatedRunOwners.delete(runId);
}
