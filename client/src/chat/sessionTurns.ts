export type SessionTurn = {
  preceding: Promise<void> | undefined;
  release: () => void;
};

type SessionTurnHandle = { release: () => void; generation: number };

/** Active turns per session key, oldest first — used to unstick steers. */
const sessionTurnHandles = new Map<string, SessionTurnHandle[]>();
let sessionTurnGeneration = 0;

/** Recover the active run identity from durable chat projection after reload. */
export function findProjectedActiveSessionRun(
  messages: Array<{ registrationId?: string; agentId?: string; runId?: number; status?: string }>,
  registrationId: string,
  agentId?: string,
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.status !== 'running' || message.runId == null) continue;
    if (message.registrationId === registrationId) return message.runId;
    // Optimistic shells sometimes only carry agentId before registration is linked.
    if (agentId && message.agentId === agentId && !message.registrationId) return message.runId;
  }
  return undefined;
}

/**
 * Human / orchestrator follow-ups should steer when the session is busy locally
 * or still has a durable running shell — not only when a prior Promise tail exists.
 */
export function shouldSteerActiveSession(opts: {
  orchestrationQueue: boolean;
  hasPrecedingTurn: boolean;
  hasLocalActiveRun: boolean;
  projectedRunId?: number;
}): boolean {
  if (opts.orchestrationQueue) return false;
  return opts.hasPrecedingTurn || opts.hasLocalActiveRun || opts.projectedRunId != null;
}

/** Peer and mission work queue behind a busy session; only humans steer it. */
export function queuesBehindActiveSession(message: {
  id?: string;
  missionTaskId?: string;
  registrationId?: string;
}): boolean {
  const id = String(message.id || '');
  return Boolean(
    message.registrationId
    || id.startsWith('agent-dispatch-')
    || message.missionTaskId
    || id.startsWith('sys-mission-'),
  );
}

/**
 * Serialize top-level prompts for one backing CLI session.
 *
 * The returned turn is installed as the new tail immediately, so later pings
 * wait for it even while the current caller is still waiting on its predecessor.
 */
export function enqueueSessionTurn(
  tails: Map<string, Promise<void>>,
  key: string,
): SessionTurn {
  const preceding = tails.get(key);
  let resolveTurn = () => {};
  const turn = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  tails.set(key, turn);

  const generation = ++sessionTurnGeneration;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    resolveTurn();
    if (tails.get(key) === turn) tails.delete(key);
    const list = sessionTurnHandles.get(key);
    if (!list) return;
    const next = list.filter((handle) => handle.generation !== generation);
    if (next.length) sessionTurnHandles.set(key, next);
    else sessionTurnHandles.delete(key);
  };
  const list = sessionTurnHandles.get(key) ?? [];
  list.push({ release, generation });
  sessionTurnHandles.set(key, list);

  return { preceding, release };
}

/**
 * Unstick a human/orchestrator steer when the predecessor never released after
 * cancel (dead socket, hung provider, app restart mid-turn). Releases every
 * turn for the session except the newest waiter so the steer can proceed.
 * Returns how many prior turns were force-released.
 */
export function forceReleasePriorSessionTurns(key: string): number {
  const list = sessionTurnHandles.get(key);
  if (!list || list.length <= 1) return 0;
  const prior = list.slice(0, -1);
  for (const handle of prior) handle.release();
  return prior.length;
}

/** Test helper: drop module-level handle state between cases. */
export function resetSessionTurnHandlesForTests(): void {
  sessionTurnHandles.clear();
  sessionTurnGeneration = 0;
}

/**
 * Choose the run that a new steering message should interrupt.
 *
 * Repeated messages aimed at a run already being stopped are carried forward
 * to the next serialized turn instead of firing duplicate cancel requests.
 *
 * Important: when there is no local active run, do **not** mark pending.
 * Pending means "kill the next run as soon as it starts" so a *later* steer
 * can replace a continuation that has not begun yet. Marking pending on a
 * cold/missing local map (reload, projected-only lease, race before
 * createRun registers) suicides the run this turn is about to start — the
 * shell ends as "Steered into the continuation below" with no continuation.
 */
export function requestSessionSteer(
  activeRuns: Map<string, number>,
  interruptedRuns: Map<string, number>,
  pendingSteers: Set<string>,
  key: string,
): number | undefined {
  const activeRun = activeRuns.get(key);
  if (activeRun == null) {
    return undefined;
  }
  if (interruptedRuns.get(key) === activeRun) {
    pendingSteers.add(key);
    return undefined;
  }
  interruptedRuns.set(key, activeRun);
  return activeRun;
}

/** Claim one steering message that arrived before the next run became active. */
export function consumePendingSessionSteer(
  interruptedRuns: Map<string, number>,
  pendingSteers: Set<string>,
  key: string,
  runId: number,
): boolean {
  if (!pendingSteers.delete(key)) return false;
  interruptedRuns.set(key, runId);
  return true;
}
