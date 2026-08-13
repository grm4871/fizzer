/**
 * @file messageStore.ts — External per-channel chat message store.
 *
 * Chat transcripts stream at ~20 React commits/sec per active agent run. Holding
 * `messagesByChannel` in App-level `useState` meant every token re-rendered the
 * entire App shell (sidebar tree, pane grid, note editors, toolbar) even though
 * only one ChatView cared. This store keeps messages out of App's render path:
 * writes are plain function calls (no prop drilling), and only the ChatView(s)
 * subscribed — via {@link useChannelMessages} / `useSyncExternalStore` — to the
 * mutated channel re-render. The App component never re-renders on a token.
 *
 * Snapshots are referentially stable: a channel's array identity changes only
 * when its contents change, and absent channels share a frozen empty array, so
 * `useSyncExternalStore` bails out correctly.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { ChatMessage } from './types';

const EMPTY: ChatMessage[] = Object.freeze([]) as unknown as ChatMessage[];

type Listener = () => void;

class ChatMessageStore {
  private channels = new Map<string, ChatMessage[]>();
  private listeners = new Map<string, Set<Listener>>();

  /** Current messages for a channel; a shared frozen array when none are cached. */
  getChannel(channelId: string): ChatMessage[] {
    return this.channels.get(channelId) ?? EMPTY;
  }

  /** Distinguishes "loaded, empty" from "never loaded" (callers gate optimistic
   *  inserts on this so they never seed an unopened channel). */
  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /**
   * Replace a channel's list via an immutable updater. If the updater returns the
   * same array reference (the established "no change" signal), nothing is emitted
   * and no subscriber re-renders.
   */
  update(channelId: string, updater: (prev: ChatMessage[]) => ChatMessage[]): void {
    const prev = this.getChannel(channelId);
    const next = updater(prev);
    if (next === prev) return;
    this.channels.set(channelId, next);
    this.emit(channelId);
  }

  /**
   * Apply an updater to every loaded channel — used when the owning channel is
   * unknown (e.g. canceling a run by id). Returning the same array reference from
   * the updater leaves that channel untouched, so only channels that actually
   * changed re-render.
   */
  updateAll(updater: (prev: ChatMessage[], channelId: string) => ChatMessage[]): void {
    for (const channelId of Array.from(this.channels.keys())) {
      this.update(channelId, (prev) => updater(prev, channelId));
    }
  }

  /** Set a channel's list outright (used by the load/reconcile path). */
  set(channelId: string, messages: ChatMessage[]): void {
    if (this.channels.get(channelId) === messages) return;
    this.channels.set(channelId, messages);
    this.emit(channelId);
  }

  /** Forget a channel entirely (e.g. its note/channel was deleted). */
  remove(channelId: string): void {
    if (!this.channels.has(channelId)) return;
    this.channels.delete(channelId);
    this.emit(channelId);
  }

  subscribe(channelId: string, listener: Listener): () => void {
    let set = this.listeners.get(channelId);
    if (!set) {
      set = new Set();
      this.listeners.set(channelId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(channelId);
    };
  }

  private emit(channelId: string): void {
    const set = this.listeners.get(channelId);
    if (!set) return;
    for (const listener of set) listener();
  }
}

export const chatMessageStore = new ChatMessageStore();

/** Subscribe a component to one channel's transcript. Re-renders only when that
 *  channel's messages change — never for unrelated channels or App shell churn. */
export function useChannelMessages(channelId: string): ChatMessage[] {
  const subscribe = useCallback(
    (cb: Listener) => chatMessageStore.subscribe(channelId, cb),
    [channelId],
  );
  const getSnapshot = useCallback(() => chatMessageStore.getChannel(channelId), [channelId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
