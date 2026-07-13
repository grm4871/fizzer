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
import {
  clearDelegatedRunRecord,
  countActiveDelegatedRuns,
  failOpenDelegatedRunsForOwner,
  getDelegatedRunOwnerFromDb,
  listOpenDelegatedRuns,
  recordDelegatedRun,
} from './runner.js';

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
  chatAuthor?: string;
  agentMemoryKey?: string;
  chatRegistrationId?: string;
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
    opts: { status: 'completed' | 'failed' | 'canceled'; summary: string; sessionId?: string },
  ) => void;
  /** Optional: settle chat messages / broadcast after runs fail on disconnect. */
  onRunsFailedForOwner?: (ownerUserId: number, runIds: number[]) => void;
};

export type DesktopRunnerHealth = {
  online: boolean;
  activeRuns: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSeenAt: string | null;
  models: Record<string, string[]> | null;
};

const JWT_SECRET = resolveJwtSecret();
const runnersByUser = new Map<number, RunnerSocket>();
const delegatedRunOwners = new Map<number, number>();
/** Last error reported by (or about) each user's desktop runner. */
const runnerLastError = new Map<number, { message: string; at: string }>();
/** Last capability probe payload from the desktop (agent → model ids). */
const runnerModels = new Map<number, Record<string, string[]>>();
const runnerLastSeen = new Map<number, string>();
/**
 * Pending fail-on-disconnect timers. Socket.io transport swaps, Electron focus
 * resync, and busy main-process event loops cause brief disconnects; killing
 * open runs immediately is what surfaces "Desktop agent runner disconnected"
 * mid-turn. Wait for reconnection before settling.
 */
const DISCONNECT_GRACE_MS = Number(process.env.RUNNER_DISCONNECT_GRACE_MS || 20_000);
/**
 * After model-server restart, in-memory ownership is empty but desktop agents
 * often keep running. Wait this long for desktops to reconnect + reclaim before
 * settling leftover DB rows as failed.
 */
const ORPHAN_RECLAIM_MS = Number(process.env.RUNNER_ORPHAN_RECLAIM_MS || 120_000);
const pendingDisconnectFails = new Map<number, ReturnType<typeof setTimeout>>();

function clearPendingDisconnectFail(userId: number): void {
  const timer = pendingDisconnectFails.get(userId);
  if (timer) {
    clearTimeout(timer);
    pendingDisconnectFails.delete(userId);
  }
}

function failOwnerRunsAfterDisconnect(
  db: Db,
  hooks: RunnerHooks,
  userId: number,
): void {
  // Bail if they reconnected while we were waiting.
  if (isDesktopRunnerOnline(userId)) return;

  const failedFromDb = failOpenDelegatedRunsForOwner(
    db,
    userId,
    'Desktop agent runner disconnected.',
  );
  const failedIds = new Set(failedFromDb);
  for (const [runId, ownerId] of [...delegatedRunOwners.entries()]) {
    if (ownerId !== userId) continue;
    delegatedRunOwners.delete(runId);
    if (failedIds.has(runId)) continue;
    // In-memory only (record may already be cleared); still emit failed.
    hooks.finishDelegatedRun(db, runId, {
      status: 'failed',
      summary: 'Desktop agent runner disconnected.',
    });
    hooks.publishRunEvent(db, runId, 'status', {
      status: 'failed',
      summary: 'Desktop agent runner disconnected.',
    });
    clearDelegatedRunRecord(db, runId);
    failedIds.add(runId);
  }
  for (const runId of failedFromDb) {
    delegatedRunOwners.delete(runId);
  }
  if (failedIds.size > 0) {
    runnerLastError.set(userId, {
      message: `Runner disconnected; ${failedIds.size} run(s) failed.`,
      at: new Date().toISOString(),
    });
    hooks.onRunsFailedForOwner?.(userId, [...failedIds]);
  }
}

function scheduleDisconnectFail(db: Db, hooks: RunnerHooks, userId: number): void {
  clearPendingDisconnectFail(userId);
  pendingDisconnectFails.set(
    userId,
    setTimeout(() => {
      pendingDisconnectFails.delete(userId);
      failOwnerRunsAfterDisconnect(db, hooks, userId);
    }, DISCONNECT_GRACE_MS),
  );
}

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

    // Reconnected (or first connect) — cancel any pending fail-on-disconnect.
    clearPendingDisconnectFail(user.id);

    // Register the new socket *before* disconnecting any previous one so the
    // old socket's disconnect handler sees it has been replaced and does not
    // schedule a fail-on-disconnect for still-active runs.
    const existing = runnersByUser.get(user.id);
    runnersByUser.set(user.id, socket);
    runnerLastSeen.set(user.id, new Date().toISOString());
    if (existing && existing.id !== socket.id) {
      // Same owner reclaiming the runner slot — leave active runs alone.
      existing.disconnect();
    }

    socket.on('runner:register', (payload?: {
      models?: Record<string, string[]>;
      /** Local mid-flight run ids so the server can reclaim ownership after restart. */
      activeRunIds?: number[];
    }) => {
      runnersByUser.set(user.id, socket);
      runnerLastSeen.set(user.id, new Date().toISOString());
      clearPendingDisconnectFail(user.id);
      if (payload?.models && typeof payload.models === 'object') {
        const cleaned: Record<string, string[]> = {};
        for (const [agent, models] of Object.entries(payload.models)) {
          if (Array.isArray(models)) {
            cleaned[agent] = models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
          }
        }
        runnerModels.set(user.id, cleaned);
      }
      const reclaimed = reclaimActiveRunsFromDesktop(db, user.id, payload?.activeRunIds);
      socket.emit('runner:registered', { ok: true, reclaimed });
    });

    socket.on('runner:capabilities', (payload?: { models?: Record<string, string[]> }) => {
      if (payload?.models && typeof payload.models === 'object') {
        const cleaned: Record<string, string[]> = {};
        for (const [agent, models] of Object.entries(payload.models)) {
          if (Array.isArray(models)) {
            cleaned[agent] = models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
          }
        }
        runnerModels.set(user.id, cleaned);
      }
      runnerLastSeen.set(user.id, new Date().toISOString());
    });

    socket.on('runner:runEvent', (data: { runId?: number; type?: string; payload?: unknown }) => {
      const runId = Number(data?.runId);
      if (!Number.isFinite(runId) || !data?.type) return;
      if (!acceptRunEventFromOwner(db, runId, user.id)) return;

      hooks.publishRunEvent(db, runId, data.type, data.payload ?? {});

      if (data.type === 'status' && data.payload && typeof data.payload === 'object') {
        const status = (data.payload as { status?: string }).status;
        if (status === 'completed' || status === 'failed' || status === 'canceled') {
          const payload = data.payload as { summary?: string; sessionId?: string };
          const summary = payload.summary
            || (status === 'completed' ? 'Done.' : status === 'canceled' ? 'Run canceled by user.' : 'Agent failed.');
          if (status === 'failed' && payload.summary) {
            runnerLastError.set(user.id, { message: payload.summary, at: new Date().toISOString() });
          }
          hooks.finishDelegatedRun(db, runId, {
            status,
            summary,
            sessionId: payload.sessionId,
          });
          delegatedRunOwners.delete(runId);
          clearDelegatedRunRecord(db, runId);
        }
      }
    });

    socket.on('disconnect', () => {
      if (runnersByUser.get(user.id)?.id !== socket.id) {
        // A newer socket already replaced this one — leave active runs alone.
        return;
      }
      runnersByUser.delete(user.id);
      // Defer failing open runs so a reconnect within the grace window keeps
      // them alive (socket.io transport swap, focus resync, brief offline).
      scheduleDisconnectFail(db, hooks, user.id);
    });
  });
}

export function isDesktopRunnerOnline(userId: number): boolean {
  const socket = runnersByUser.get(userId);
  return Boolean(socket?.connected);
}

export function getDesktopRunnerStatus(userId: number, db?: Db): DesktopRunnerHealth {
  const err = runnerLastError.get(userId);
  return {
    online: isDesktopRunnerOnline(userId),
    activeRuns: db ? countActiveDelegatedRuns(db, userId) : countInMemoryDelegatedRuns(userId),
    lastError: err?.message ?? null,
    lastErrorAt: err?.at ?? null,
    lastSeenAt: runnerLastSeen.get(userId) ?? null,
    models: runnerModels.get(userId) ?? null,
  };
}

function countInMemoryDelegatedRuns(userId: number): number {
  let n = 0;
  for (const owner of delegatedRunOwners.values()) {
    if (owner === userId) n += 1;
  }
  return n;
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

export function delegateRunToDesktop(userId: number, payload: DelegatedRunPayload, db?: Db): boolean {
  const socket = runnersByUser.get(userId);
  if (!socket?.connected) return false;
  delegatedRunOwners.set(payload.runId, userId);
  if (db) recordDelegatedRun(db, payload.runId, userId);
  socket.emit('run:delegate', payload);
  return true;
}

export function isDelegatedRun(runId: number): boolean {
  return delegatedRunOwners.has(runId);
}

export function getDelegatedRunOwner(runId: number): number | undefined {
  return delegatedRunOwners.get(runId);
}

/** Restore in-memory ownership after server restart (desktop reclaimed the run). */
export function reclaimDelegatedRun(runId: number, userId: number): void {
  delegatedRunOwners.set(runId, userId);
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

/** Remember a runner-level error (e.g. 503 "no runner") for the health UI. */
export function noteDesktopRunnerError(userId: number, message: string): void {
  runnerLastError.set(userId, { message, at: new Date().toISOString() });
}

/**
 * Accept a streamed run event if this user owns the run in memory, or if the
 * durable delegated_runs row still names them (post-restart rehydrate path).
 */
function acceptRunEventFromOwner(db: Db, runId: number, userId: number): boolean {
  const memOwner = delegatedRunOwners.get(runId);
  if (memOwner === userId) return true;
  if (memOwner != null && memOwner !== userId) return false;

  const dbOwner = getDelegatedRunOwnerFromDb(db, runId);
  if (dbOwner !== userId) return false;
  // Rehydrate memory so cancel/count paths see the live owner again.
  delegatedRunOwners.set(runId, userId);
  return true;
}

/**
 * Reclaim ownership for mid-flight runs the desktop reports after reconnect.
 * Only accepts ids still open in delegated_runs for this user.
 */
function reclaimActiveRunsFromDesktop(
  db: Db,
  userId: number,
  activeRunIds: number[] | undefined,
): number[] {
  if (!Array.isArray(activeRunIds) || activeRunIds.length === 0) return [];
  const reclaimed: number[] = [];
  for (const raw of activeRunIds) {
    const runId = Number(raw);
    if (!Number.isFinite(runId)) continue;
    const dbOwner = getDelegatedRunOwnerFromDb(db, runId);
    if (dbOwner !== userId) continue;
    delegatedRunOwners.set(runId, userId);
    reclaimed.push(runId);
  }
  if (reclaimed.length > 0) {
    console.log(`[runner] Reclaimed ${reclaimed.length} run(s) for user ${userId}: ${reclaimed.join(', ')}`);
  }
  return reclaimed;
}

/**
 * After process boot, leave open delegated runs alive so reconnecting desktops
 * can finish them. Only settle leftovers after ORPHAN_RECLAIM_MS if still open
 * and not reclaimed by an online desktop.
 */
export function scheduleOrphanReclaimAfterRestart(db: Db, hooks: RunnerHooks): void {
  const open = listOpenDelegatedRuns(db);
  const looseOpen = db.prepare(`
    SELECT id FROM runs
    WHERE status IN ('queued', 'running')
      AND id NOT IN (SELECT run_id FROM delegated_runs)
  `).all() as Array<{ id: number }>;
  if (open.length === 0 && looseOpen.length === 0) return;

  console.log(
    `[runner] ${open.length} open delegated run(s)`
    + (looseOpen.length ? ` + ${looseOpen.length} loose` : '')
    + ` after restart; reclaim window ${ORPHAN_RECLAIM_MS}ms`,
  );

  setTimeout(() => {
    const stillOpen = listOpenDelegatedRuns(db);
    let kept = 0;
    const failedIds: number[] = [];
    const summaryUnclaimed = 'Desktop agent runner did not reclaim this run after server restart.';

    for (const { run_id, owner_user_id } of stillOpen) {
      if (delegatedRunOwners.get(run_id) === owner_user_id && isDesktopRunnerOnline(owner_user_id)) {
        kept += 1;
        continue;
      }
      const run = db.prepare(
        `SELECT id FROM runs WHERE id = ? AND status IN ('queued', 'running')`,
      ).get(run_id) as { id: number } | undefined;
      if (!run) {
        clearDelegatedRunRecord(db, run_id);
        delegatedRunOwners.delete(run_id);
        continue;
      }
      hooks.finishDelegatedRun(db, run_id, { status: 'failed', summary: summaryUnclaimed });
      hooks.publishRunEvent(db, run_id, 'status', { status: 'failed', summary: summaryUnclaimed });
      clearDelegatedRunRecord(db, run_id);
      delegatedRunOwners.delete(run_id);
      failedIds.push(run_id);
    }

    // Loose open runs (no delegated_runs row) cannot reclaim — settle only those.
    const looseSummary = 'Server restarted while this run was in progress.';
    const stillLoose = db.prepare(`
      SELECT id FROM runs
      WHERE status IN ('queued', 'running')
        AND id NOT IN (SELECT run_id FROM delegated_runs)
    `).all() as Array<{ id: number }>;
    for (const row of stillLoose) {
      hooks.finishDelegatedRun(db, row.id, { status: 'failed', summary: looseSummary });
      hooks.publishRunEvent(db, row.id, 'status', { status: 'failed', summary: looseSummary });
      failedIds.push(row.id);
    }

    if (failedIds.length > 0) {
      hooks.onRunsFailedForOwner?.(0, failedIds);
    }
    console.log(
      `[runner] Orphan reclaim done: kept=${kept}, failed=${failedIds.length}`,
    );
  }, ORPHAN_RECLAIM_MS);
}
