import { describe, expect, it, vi } from 'vitest';
import { chatMessageStore } from '../chat/messageStore';
import type { ChatMessage } from '../components/ChatView';

function message(id: string, channelId: string): ChatMessage {
  return { id, channelId, author: 'asdfasdf', body: id, createdAt: id };
}

describe('chatMessageStore', () => {
  it('distinguishes an unloaded channel from a loaded-empty one', () => {
    expect(chatMessageStore.hasChannel('never')).toBe(false);
    chatMessageStore.set('loaded-empty', []);
    expect(chatMessageStore.hasChannel('loaded-empty')).toBe(true);
    expect(chatMessageStore.getChannel('loaded-empty')).toEqual([]);
  });

  it('returns a stable reference until the channel actually changes', () => {
    chatMessageStore.set('stable', [message('a', 'stable')]);
    const first = chatMessageStore.getChannel('stable');
    // Updater returns the same array ref → treated as no-op.
    chatMessageStore.update('stable', (prev) => prev);
    expect(chatMessageStore.getChannel('stable')).toBe(first);
  });

  it('notifies only subscribers of the mutated channel — the isolation invariant', () => {
    chatMessageStore.set('chan-a', [message('a1', 'chan-a')]);
    chatMessageStore.set('chan-b', [message('b1', 'chan-b')]);
    const onA = vi.fn();
    const onB = vi.fn();
    const offA = chatMessageStore.subscribe('chan-a', onA);
    const offB = chatMessageStore.subscribe('chan-b', onB);

    chatMessageStore.update('chan-a', (prev) => [...prev, message('a2', 'chan-a')]);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled(); // a token in chan-a never touches chan-b

    // A no-op update (same ref) emits to nobody.
    chatMessageStore.update('chan-a', (prev) => prev);
    expect(onA).toHaveBeenCalledTimes(1);

    offA();
    offB();
  });

  it('updateAll only emits for channels whose list actually changed', () => {
    chatMessageStore.set('run-owner', [message('r1', 'run-owner')]);
    chatMessageStore.set('bystander', [message('x1', 'bystander')]);
    const onOwner = vi.fn();
    const onBystander = vi.fn();
    const offOwner = chatMessageStore.subscribe('run-owner', onOwner);
    const offBystander = chatMessageStore.subscribe('bystander', onBystander);

    chatMessageStore.updateAll((messages) => {
      let changed = false;
      const next = messages.map((m) => (m.id === 'r1' ? (changed = true, { ...m, body: 'canceled' }) : m));
      return changed ? next : messages;
    });

    expect(onOwner).toHaveBeenCalledTimes(1);
    expect(onBystander).not.toHaveBeenCalled();
    offOwner();
    offBystander();
  });

  it('forgets a channel on remove', () => {
    chatMessageStore.set('doomed', [message('d1', 'doomed')]);
    chatMessageStore.remove('doomed');
    expect(chatMessageStore.hasChannel('doomed')).toBe(false);
    expect(chatMessageStore.getChannel('doomed')).toEqual([]);
  });
});
