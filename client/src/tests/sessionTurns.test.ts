import { describe, expect, it, vi } from 'vitest';
import {
  consumePendingSessionSteer,
  enqueueSessionTurn,
  queuesBehindActiveSession,
  requestSessionSteer,
  findProjectedActiveSessionRun,
} from '../chat/sessionTurns';

describe('findProjectedActiveSessionRun', () => {
  it('recovers the newest running run for a registration after renderer reload', () => {
    expect(findProjectedActiveSessionRun([
      { registrationId: 'sol', runId: 40, status: 'running' },
      { registrationId: 'terra', runId: 41, status: 'running' },
      { registrationId: 'sol', runId: 42, status: 'running' },
    ], 'sol')).toBe(42);
    expect(findProjectedActiveSessionRun([
      { registrationId: 'sol', runId: 42, status: 'failed' },
    ], 'sol')).toBeUndefined();
  });
});

describe('chat session turn serialization', () => {
  it('queues mission workers and coordinator wakeups instead of steering active work', () => {
    expect(queuesBehindActiveSession({ id: 'mission-task-message', missionTaskId: 'task-1' })).toBe(true);
    expect(queuesBehindActiveSession({ id: 'sys-mission-mission-1-wake' })).toBe(true);
    expect(queuesBehindActiveSession({ id: 'human-message' })).toBe(false);
  });

  it('holds a steering prompt until the active turn releases the same session', async () => {
    const tails = new Map<string, Promise<void>>();
    const first = enqueueSessionTurn(tails, 'supagrok:conversation-1');
    const second = enqueueSessionTurn(tails, 'supagrok:conversation-1');
    const dispatched = vi.fn();

    void second.preceding?.then(dispatched);
    await Promise.resolve();
    expect(dispatched).not.toHaveBeenCalled();

    first.release();
    await second.preceding;
    expect(dispatched).toHaveBeenCalledOnce();
    expect(tails.size).toBe(1);

    second.release();
    expect(tails.size).toBe(0);
  });

  it('does not serialize independent agent conversations', () => {
    const tails = new Map<string, Promise<void>>();
    const sol = enqueueSessionTurn(tails, 'sol:conversation-1');
    const supagrok = enqueueSessionTurn(tails, 'supagrok:conversation-1');

    expect(sol.preceding).toBeUndefined();
    expect(supagrok.preceding).toBeUndefined();
  });

  it('interrupts the active run once and carries an extra steer to the next turn', () => {
    const active = new Map([['sol:conversation-1', 41]]);
    const interrupted = new Map<string, number>();
    const pending = new Set<string>();

    expect(requestSessionSteer(active, interrupted, pending, 'sol:conversation-1')).toBe(41);
    expect(requestSessionSteer(active, interrupted, pending, 'sol:conversation-1')).toBeUndefined();
    expect(pending.has('sol:conversation-1')).toBe(true);

    expect(consumePendingSessionSteer(interrupted, pending, 'sol:conversation-1', 42)).toBe(true);
    expect(interrupted.get('sol:conversation-1')).toBe(42);
    expect(pending.size).toBe(0);
  });
});
