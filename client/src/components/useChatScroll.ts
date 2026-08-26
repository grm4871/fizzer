/**
 * Owns transcript viewport mechanics. The refs and gesture windows must stay
 * together: ResizeObserver scrolls only while `wasAtBottom` is true, while
 * trusted upward gestures clear that flag before layout events arrive.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatMediaAttachment, ChatMessage, ChatReplyRef } from '../chat/types';
import { isAtScrollBottom, isPendingAgentRunShell, shouldSnapToRecentOnSend } from './chatViewHelpers';

type UseChatScrollOptions = {
  channelId: string;
  sortedMessages: ChatMessage[];
  onSendMessage: (channelId: string, body: string, media?: ChatMediaAttachment[], replyTo?: ChatReplyRef) => void;
  jumpToMessageId?: string;
  onJumpHandled?: () => void;
  setSelectedMessageId: (id: string) => void;
  setJumpHighlightMessageId: Dispatch<SetStateAction<string | null>>;
};

export function useChatScroll({
  channelId,
  sortedMessages,
  onSendMessage,
  jumpToMessageId,
  onJumpHandled,
  setSelectedMessageId,
  setJumpHighlightMessageId,
}: UseChatScrollOptions) {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const jumpHighlightTimerRef = useRef<number | null>(null);
  const previousChannelIdRef = useRef<string | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticClearRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const pendingSendFollowRef = useRef(false);
  const userScrollQuietUntilRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (performance.now() < userScrollQuietUntilRef.current) return;
    if (!wasAtBottomRef.current && previousChannelIdRef.current === channelId) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const scroller = messagesRef.current;
      if (!scroller) return;
      if (performance.now() < userScrollQuietUntilRef.current) return;
      if (!wasAtBottomRef.current && previousChannelIdRef.current === channelId) return;
      if (!isAtScrollBottom(scroller)) {
        programmaticScrollRef.current = true;
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    if (programmaticClearRef.current != null) clearTimeout(programmaticClearRef.current);
    programmaticClearRef.current = window.setTimeout(() => {
      programmaticClearRef.current = null;
      programmaticScrollRef.current = false;
    }, 120);
  }, [channelId]);

  const scrollToBottomIfSticky = useCallback(() => {
    if (!wasAtBottomRef.current) return;
    if (performance.now() < userScrollQuietUntilRef.current) return;
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (wasAtBottomRef.current && performance.now() >= userScrollQuietUntilRef.current) scrollToBottom();
    });
  }, [scrollToBottom]);

  const sendMessage = useCallback((targetChannelId: string, body: string, media?: ChatMediaAttachment[], replyTo?: ChatReplyRef) => {
    const scroller = messagesRef.current;
    const shouldSnap = !scroller || shouldSnapToRecentOnSend(scroller);
    wasAtBottomRef.current = shouldSnap;
    pendingSendFollowRef.current = shouldSnap;
    if (shouldSnap) {
      userScrollQuietUntilRef.current = 0;
      userScrollIntentUntilRef.current = 0;
    }
    onSendMessage(targetChannelId, body, media, replyTo);
    if (shouldSnap) {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
    }
  }, [onSendMessage, scrollToBottom]);

  useLayoutEffect(() => {
    if (previousChannelIdRef.current !== channelId) {
      previousChannelIdRef.current = channelId;
      wasAtBottomRef.current = true;
      pendingSendFollowRef.current = false;
      userScrollQuietUntilRef.current = 0;
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
      const t1 = window.setTimeout(scrollToBottom, 60);
      const t2 = window.setTimeout(scrollToBottom, 200);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    const latest = sortedMessages.at(-1);
    if (pendingSendFollowRef.current && isPendingAgentRunShell(latest)) {
      pendingSendFollowRef.current = false;
      wasAtBottomRef.current = true;
      userScrollQuietUntilRef.current = 0;
      userScrollIntentUntilRef.current = 0;
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
      const settle = window.setTimeout(scrollToBottom, 80);
      return () => clearTimeout(settle);
    }
    scrollToBottomIfSticky();
  }, [channelId, scrollToBottom, scrollToBottomIfSticky, sortedMessages]);

  const jumpHandledRef = useRef<string | null>(null);
  const jumpTimersRef = useRef<{ raf: number; timer: number }>({ raf: 0, timer: 0 });
  const runJumpToMessage = useCallback((targetId: string) => {
    setSelectedMessageId(targetId);
    setJumpHighlightMessageId(targetId);
    if (jumpHighlightTimerRef.current != null) clearTimeout(jumpHighlightTimerRef.current);
    jumpHighlightTimerRef.current = window.setTimeout(() => {
      jumpHighlightTimerRef.current = null;
      setJumpHighlightMessageId((current) => current === targetId ? null : current);
    }, 1300);
    wasAtBottomRef.current = false;
    pendingSendFollowRef.current = false;
    userScrollQuietUntilRef.current = performance.now() + 1200;
    const scrollToTarget = () => {
      const scroller = messagesRef.current;
      if (!scroller) return false;
      const selector = `[data-message-id="${(window.CSS?.escape ?? String)(targetId)}"]`;
      const el = scroller.querySelector<HTMLElement>(selector);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    };
    let tries = 0;
    const tick = () => {
      const done = scrollToTarget();
      tries += 1;
      if (!done || tries < 4) jumpTimersRef.current.timer = window.setTimeout(tick, 90);
    };
    cancelAnimationFrame(jumpTimersRef.current.raf);
    if (jumpTimersRef.current.timer) clearTimeout(jumpTimersRef.current.timer);
    jumpTimersRef.current.raf = requestAnimationFrame(tick);
  }, [setJumpHighlightMessageId, setSelectedMessageId]);

  useEffect(() => () => {
    cancelAnimationFrame(jumpTimersRef.current.raf);
    if (jumpTimersRef.current.timer) clearTimeout(jumpTimersRef.current.timer);
  }, []);

  useEffect(() => {
    if (!jumpToMessageId) { jumpHandledRef.current = null; return; }
    if (jumpHandledRef.current === jumpToMessageId) return;
    if (!sortedMessages.some((message) => message.id === jumpToMessageId)) return;
    jumpHandledRef.current = jumpToMessageId;
    runJumpToMessage(jumpToMessageId);
    onJumpHandled?.();
  }, [jumpToMessageId, onJumpHandled, runJumpToMessage, sortedMessages]);

  useEffect(() => {
    const content = messagesContentRef.current;
    const viewport = messagesRef.current;
    if ((!content && !viewport) || typeof ResizeObserver === 'undefined') return;
    let roFrame: number | null = null;
    const ro = new ResizeObserver(() => {
      if (roFrame != null) return;
      roFrame = requestAnimationFrame(() => {
        roFrame = null;
        scrollToBottomIfSticky();
      });
    });
    if (content) ro.observe(content);
    if (viewport) ro.observe(viewport);
    return () => {
      if (roFrame != null) cancelAnimationFrame(roFrame);
      ro.disconnect();
    };
  }, [channelId, scrollToBottomIfSticky]);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
    if (jumpHighlightTimerRef.current != null) clearTimeout(jumpHighlightTimerRef.current);
    if (programmaticClearRef.current != null) clearTimeout(programmaticClearRef.current);
  }, []);

  const updateBottomStickiness = useCallback(() => {
    const element = messagesRef.current;
    if (!element) return;
    const atBottom = isAtScrollBottom(element);
    if (programmaticScrollRef.current) {
      if (!atBottom && performance.now() < userScrollIntentUntilRef.current) {
        programmaticScrollRef.current = false;
        wasAtBottomRef.current = false;
        userScrollQuietUntilRef.current = performance.now() + 220;
      }
      return;
    }
    if (performance.now() >= userScrollIntentUntilRef.current) {
      if (atBottom) wasAtBottomRef.current = true;
      return;
    }
    wasAtBottomRef.current = atBottom;
    if (!atBottom) userScrollQuietUntilRef.current = performance.now() + 220;
  }, []);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateBottomStickiness, { passive: true });
    return () => el.removeEventListener('scroll', updateBottomStickiness);
  }, [channelId, updateBottomStickiness]);

  return {
    messagesRef,
    messagesContentRef,
    endRef,
    touchStartYRef,
    pendingSendFollowRef,
    programmaticScrollRef,
    userScrollIntentUntilRef,
    sendMessage,
    scrollToBottomIfSticky,
    runJumpToMessage,
  };
}
