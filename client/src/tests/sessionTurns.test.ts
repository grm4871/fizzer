import { describe, expect, it, vi } from 'vitest';
import { enqueueSessionTurn } from '../chat/sessionTurns';

describe('chat session turn serialization', () => {
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
});
