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
  /** Codex-only override; omitted means defer to the local CLI default. */
  reasoningEffort?: string;
  resumeSessionId?: string;
  chatChannelId?: string;
  chatMessageId?: string;
  chatTriggeringMessageId?: string;
  chatAuthor?: string;
  agentMemoryKey?: string;
  chatRegistrationId?: string;
  /** Durable task identity, made available to the provider helper context. */
  workItemId?: string;
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

/**
 * Subscription usage for one provider, as reported by the desktop runner.
 *
 * `usedPercent` is the worst (highest) window the provider exposes, since that
 * is the window that actually blocks work. `status: 'unknown'` is deliberately
 * first-class: a provider whose plan usage we cannot read reports unknown
 * rather than being omitted or defaulted to 0, so the UI can say "unknown"
 * instead of implying an untouched plan.
 */
export type PlanUsageWindow = {
  label: string;
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string | null;
  resetsLabel?: string | null;
};

export type PlanUsage = {
  status: 'ok' | 'unknown' | 'error';
  usedPercent?: number;
  /** Window that `usedPercent` refers to, in minutes. */
  windowMinutes?: number;
  /** ISO timestamp at which the window resets. */
  resetsAt?: string | null;
  /** Provider-rendered reset time when no stable timestamp is exposed. */
  resetsLabel?: string | null;
  /** All windows exposed by the provider (for example Claude session + week). */
  windows?: PlanUsageWindow[];
  planType?: string | null;
  /** Human-readable reason when status is not 'ok'. */
  detail?: string | null;
  /** When this figure was collected. */
  fetchedAt?: string;
};

export type DesktopRunnerHealth = {
  online: boolean;
  activeRuns: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSeenAt: string | null;
  models: Record<string, string[]> | null;
  /** Subscription usage keyed by agent id (claude-code / codex / grok). */
  planUsage: Record<string, PlanUsage> | null;
};

const JWT_SECRET = resolveJwtSecret();
const runnersByUser = new Map<number, RunnerSocket>();
const delegatedRunOwners = new Map<number, number>();
/** Last error reported by (or about) each user's desktop runner. */
const runnerLastError = new Map<number, { message: string; at: string }>();
/** Last capability probe payload from the desktop (agent → model ids). */
const runnerModels = new Map<number, Record<string, string[]>>();
/** Latest subscription usage per user, pushed by the desktop runner. */
const runnerPlanUsage = new Map<number, Record<string, PlanUsage>>();
const runnerLastSeen = new Map<number, string>();
/** Main-process boot id. A change means Electron itself restarted, not merely its renderer. */
const runnerInstanceIds = new Map<number, string>();
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
      const decoded = jwt.verify(token, JWT_SECRET) as RunnerUser & { access?: 'user' | 'agent' };
      if (decoded.access === 'agent') return next(new Error('This operation requires user access'));
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
      /** Stable for renderer reloads; changes only when Electron main restarts. */
      runnerInstanceId?: string;
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
      const nextInstanceId = typeof payload?.runnerInstanceId === 'string' ? payload.runnerInstanceId : '';
      const previousInstanceId = runnerInstanceIds.get(user.id);
      if (nextInstanceId) runnerInstanceIds.set(user.id, nextInstanceId);

      const instanceChanged = Boolean(
        previousInstanceId && nextInstanceId && previousInstanceId !== nextInstanceId,
      );
      // Only a changed Electron-main instance proves omitted children are dead.
      // A renderer/socket reconnect can transiently register before its main
      // snapshot arrives; treating that omission as authoritative kills healthy
      // long-running agents.
      if (instanceChanged) {
        const active = new Set(reclaimed);
        const interrupted = listOpenDelegatedRuns(db)
          .filter((row) => row.owner_user_id === user.id && !active.has(row.run_id))
          .map((row) => row.run_id);
        const reason = 'Desktop app restarted before this run completed.';
        for (const runId of interrupted) {
          delegatedRunOwners.delete(runId);
          hooks.finishDelegatedRun(db, runId, { status: 'failed', summary: reason });
          hooks.publishRunEvent(db, runId, 'status', { status: 'failed', summary: reason });
          clearDelegatedRunRecord(db, runId);
        }
        if (interrupted.length > 0) {
          runnerLastError.set(user.id, { message: reason, at: new Date().toISOString() });
          hooks.onRunsFailedForOwner?.(user.id, interrupted);
        }
      }
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

    // Subscription usage per provider. Only the desktop can read these — the
    // credentials live in the user's CLI config, never on the server.
    socket.on('runner:planUsage', (payload?: { usage?: Record<string, PlanUsage> }) => {
      if (payload?.usage && typeof payload.usage === 'object') {
        const cleaned: Record<string, PlanUsage> = {};
        for (const [agent, raw] of Object.entries(payload.usage)) {
          if (agent !== 'claude-code' && agent !== 'codex' && agent !== 'grok') continue;
          if (!raw || typeof raw !== 'object') continue;
          const status = raw.status === 'ok' || raw.status === 'error' ? raw.status : 'unknown';
          const pct = Number(raw.usedPercent);
          const windows = Array.isArray(raw.windows)
            ? raw.windows.flatMap((window) => {
              if (!window || typeof window !== 'object') return [];
              const windowPct = Number(window.usedPercent);
              if (!Number.isFinite(windowPct)) return [];
              return [{
                label: typeof window.label === 'string' ? window.label.slice(0, 40) : 'usage',
                usedPercent: Math.max(0, Math.min(100, windowPct)),
                ...(Number.isFinite(Number(window.windowMinutes))
                  ? { windowMinutes: Number(window.windowMinutes) }
                  : {}),
                ...(typeof window.resetsAt === 'string' ? { resetsAt: window.resetsAt } : {}),
                ...(typeof window.resetsLabel === 'string' ? { resetsLabel: window.resetsLabel.slice(0, 100) } : {}),
              }];
            })
            : [];
          cleaned[agent] = {
            status,
            // Only trust a percentage on an 'ok' reading; clamp to 0-100 so a
            // provider quirk can't render a meter off the end of its track.
            ...(status === 'ok' && Number.isFinite(pct)
              ? { usedPercent: Math.max(0, Math.min(100, pct)) }
              : {}),
            ...(Number.isFinite(Number(raw.windowMinutes)) ? { windowMinutes: Number(raw.windowMinutes) } : {}),
            ...(typeof raw.resetsAt === 'string' ? { resetsAt: raw.resetsAt } : {}),
            ...(typeof raw.resetsLabel === 'string' ? { resetsLabel: raw.resetsLabel.slice(0, 100) } : {}),
            ...(windows.length ? { windows } : {}),
            ...(typeof raw.planType === 'string' ? { planType: raw.planType } : {}),
            ...(typeof raw.detail === 'string' ? { detail: raw.detail.slice(0, 300) } : {}),
            fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt.slice(0, 100) : new Date().toISOString(),
          };
        }
        runnerPlanUsage.set(user.id, cleaned);
      }
      runnerLastSeen.set(user.id, new Date().toISOString());
    });

    socket.on('runner:runEvent', (data: { runId?: number; type?: string; payload?: unknown }) => {
      const runId = Number(data?.runId);
      if (!Number.isFinite(runId) || !data?.type) return;
      if (!acceptRunEventFromOwner(db, runId, user.id)) return;

      // Persist a backing session as soon as the CLI announces it. Steering may
      // interrupt the active turn before its terminal event; waiting until then
      // loses the only resume handle and turns the follow-up into a cold run.
      if (data.type === 'session' && data.payload && typeof data.payload === 'object') {
        const sessionId = (data.payload as { sessionId?: unknown }).sessionId;
        if (typeof sessionId === 'string' && sessionId.trim()) {
          db.prepare('UPDATE runs SET session_id = ? WHERE id = ?').run(sessionId.trim(), runId);
        }
      }

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
      // Persist terminal status/session before notifying clients. Steering
      // clients serialize follow-ups on this event; publishing first let the
      // next /runs request race ahead of session_id storage and cold-start.
      hooks.publishRunEvent(db, runId, data.type, data.payload ?? {});
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
    planUsage: runnerPlanUsage.get(userId) ?? null,
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

export async function cancelDelegatedRun(userId: number, runId: number): Promise<boolean> {
  const socket = runnersByUser.get(userId);
  if (!socket?.connected) return false;
  return await new Promise<boolean>((resolve) => {
    socket.timeout(15_000).emit(
      'run:cancel',
      { runId },
      (error: Error | null, response?: { success?: boolean }) => {
        resolve(!error && response?.success === true);
      },
    );
  });
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
