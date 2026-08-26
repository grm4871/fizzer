import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type {
  ChatAgentRegistration,
  ChatMediaAttachment,
  ChatMessage,
  ChatReplyRef,
} from './types';
import {
  canMergeChatMessages,
  dataUrlsToRunImages,
  mediaToRunImages,
} from './shared';
import { api, ApiError, type NoteSummary } from '../api';
import { connectRunsSocket } from '../socket';
import { isLocalRunId, cancelLocalAgentRun } from '../localAgentRunner';
import type { AgentId } from './agents';
import {
  buildQuotedReplyPrompt,
  getMentionedRegistrations,
  isCompactCommand,
  normalizeMention,
  precedingMessageBatch,
  precedingMessageBatchText,
  replyQuoteTargetsAgent,
  stripRegisteredAgentMentions,
} from './mentions';
import type { ChatRelationship } from './relationships';
import {
  applyRemoteChatMessage,
  mergeRemoteChatMessage,
  newId,
  toChatMessagePatch,
} from './runBlocks';
import type { ChatState } from './session';
import { chatMessageStore } from './messageStore';
import { useAgentRunLifecycle } from './dispatch/runLifecycle';

export type ChatAgentDispatch = {
  id: string;
  messageId: string;
  channelId: string;
  registration: ChatAgentRegistration;
  message: ChatMessage;
  runId: number | null;
  reasoningEffort?: string;
  createdAt: string;
};

export type PersistedChatMessage = {
  message: ChatMessage;
  agents: ChatAgentRegistration[];
  dispatches: ChatAgentDispatch[];
};

type ChatDispatchRefs = {
  activeVaultIdRef: MutableRefObject<string | null>;
  notesRef: MutableRefObject<NoteSummary[]>;
  chatStateRef: MutableRefObject<ChatState>;
  runSocketsRef: MutableRefObject<Map<number, ReturnType<typeof connectRunsSocket>>>;
  streamingChatMessageIdsRef: MutableRefObject<Set<string>>;
  serverOwnedChatMessageIdsRef: MutableRefObject<Set<string>>;
  agentContextWatermarkRef: MutableRefObject<Map<string, string>>;
  agentSessionTailRef: MutableRefObject<Map<string, Promise<void>>>;
  activeAgentSessionRunRef: MutableRefObject<Map<string, number>>;
  interruptedAgentSessionRunRef: MutableRefObject<Map<string, number>>;
  pendingAgentSteerRef: MutableRefObject<Set<string>>;
  pendingChatPatchRef: MutableRefObject<Map<string, ChatMessage>>;
  chatPatchTimerRef: MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
  startingChatDispatchesRef: MutableRefObject<Set<string>>;
};

export function useChatDispatch({
  activeVaultIdRef,
  notesRef,
  chatStateRef,
  setChatState,
  setNotice,
  user,
  handleRegisterChatAgent,
  runSocketsRef,
  streamingChatMessageIdsRef,
  serverOwnedChatMessageIdsRef,
  agentContextWatermarkRef,
  agentSessionTailRef,
  activeAgentSessionRunRef,
  interruptedAgentSessionRunRef,
  pendingAgentSteerRef,
  pendingChatPatchRef,
  chatPatchTimerRef,
  startingChatDispatchesRef,
}: ChatDispatchRefs & {
  setChatState: Dispatch<SetStateAction<ChatState>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  user: { username: string } | null;
  handleRegisterChatAgent: (channelId: string, registration: ChatAgentRegistration, sourceVaultId?: string) => void;
}) {
  const persistChatMessageToServer = useCallback(async (
    vaultId: string,
    channelId: string,
    message: ChatMessage,
  ): Promise<PersistedChatMessage | null> => {
    try {
      const data = await api<{
        message: ChatMessage;
        agents?: ChatAgentRegistration[];
        dispatches?: ChatAgentDispatch[];
      }>(`/api/vaults/${vaultId}/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify(message),
      });
      if (!data.message) return null;
      const merged = mergeRemoteChatMessage(message, data.message);
      // A transcript refresh can race this POST. Even if an older snapshot
      // removed the optimistic row, the successful authoritative response must
      // put it back instead of silently accepting a server-only message.
      chatMessageStore.update(channelId, (existing) => applyRemoteChatMessage(existing, data.message));
      const agents = data.agents ?? chatStateRef.current.registeredAgentsByChannel[channelId] ?? [];
      if (data.agents) {
        setChatState((prev) => ({
          ...prev,
          registeredAgentsByChannel: {
            ...prev.registeredAgentsByChannel,
            [channelId]: data.agents!,
          },
        }));
      }
      return { message: merged, agents, dispatches: data.dispatches ?? [] };
    } catch (error) {
      console.error('Failed to persist chat message:', error);
      setNotice(error instanceof Error ? error.message : 'Could not save chat message');
      return null;
    }
  }, []);

  const flushChatMessagePatch = useCallback(async (vaultId: string, channelId: string, messageId: string) => {
    const message = pendingChatPatchRef.current.get(messageId);
    if (!message) return;
    pendingChatPatchRef.current.delete(messageId);
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify(toChatMessagePatch(message)),
      });
    } catch (error) {
      // Mission completion can durably remove a queued synthetic wake while a
      // renderer still has one final throttled stream patch. The deletion wins.
      if (
        (error instanceof ApiError && error.status === 404)
        || (typeof error === 'object' && error !== null && 'status' in error && error.status === 404)
        || (error instanceof Error && error.message === 'Message not found')
      ) return;
      console.error('Failed to update chat message:', error);
    }
  }, []);

  const scheduleChatMessagePatch = useCallback((
    vaultId: string,
    channelId: string,
    messageId: string,
    message: ChatMessage,
    immediate = false,
  ) => {
    pendingChatPatchRef.current.set(messageId, message);
    if (immediate) {
      const existingTimer = chatPatchTimerRef.current.get(messageId);
      if (existingTimer) clearTimeout(existingTimer);
      chatPatchTimerRef.current.delete(messageId);
      void flushChatMessagePatch(vaultId, channelId, messageId);
      return;
    }
    // Throttle (not debounce): keep an already-scheduled flush so streamed tokens
    // are broadcast to other clients at most ~300ms apart. A debounce here would
    // reset on every token and never fire during continuous streaming, so remote
    // observers would see nothing until the run completed.
    if (chatPatchTimerRef.current.has(messageId)) return;
    const timer = setTimeout(() => {
      chatPatchTimerRef.current.delete(messageId);
      void flushChatMessagePatch(vaultId, channelId, messageId);
    }, 300);
    chatPatchTimerRef.current.set(messageId, timer);
  }, [flushChatMessagePatch]);

  const handleHydrateChatMessage = useCallback((message: ChatMessage) => {
    const channelId = message.channelId;
    if (!channelId) return;
    chatMessageStore.update(channelId, (existing) => {
      const index = existing.findIndex((item) => item.id === message.id);
      if (index === -1) return [...existing, message];
      const next = [...existing];
      next[index] = mergeRemoteChatMessage(existing[index], {
        ...message,
        // Prefer full harness/blocks/images from the expand/hydrate fetch.
        harnessLog: message.harnessLog || existing[index].harnessLog,
        blocks: message.blocks?.length ? message.blocks : existing[index].blocks,
        hasHarness: message.hasHarness ?? existing[index].hasHarness,
        images: message.images?.length ? message.images : existing[index].images,
      });
      return next;
    });
  }, []);

  const handleDeleteChatMessage = useCallback(async (channelId: string, messageId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete message');
      return;
    }
    // Drop it locally too: the socket broadcast also removes it, but this keeps
    // the click responsive (and correct if the socket is currently down).
    if (!chatMessageStore.hasChannel(channelId)) return;
    chatMessageStore.update(channelId, (existing) => {
      const next = existing.filter((message) => message.id !== messageId);
      return next.length === existing.length ? existing : next;
    });
  }, []);

  /** Copy a message into another channel (Discord-style forward). */
  const handleForwardChatMessage = useCallback(async (
    channelId: string,
    messageId: string,
    targetChannelId: string,
  ) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const data = await api<{ message: ChatMessage }>(
      `/api/vaults/${vaultId}/channels/${channelId}/messages/${encodeURIComponent(messageId)}/forward`,
      { method: 'POST', body: JSON.stringify({ targetChannelId }) },
    );
    // Show it immediately in a cached target transcript; the socket broadcast
    // dedupes on id, so this is safe when the channel is also open elsewhere.
    if (chatMessageStore.hasChannel(targetChannelId)) {
      chatMessageStore.update(targetChannelId, (existing) => (
        existing.some((message) => message.id === data.message.id)
          ? existing
          : [...existing, data.message]
      ));
    }
    const target = notesRef.current.find((note) => note.id === targetChannelId);
    setNotice(`Forwarded to #${target?.title ?? 'channel'}`);
  }, []);

  const appendChatMessage = useCallback((
    channelId: string,
    message: ChatMessage,
    options: { persist?: boolean } = {},
  ) => {
    chatMessageStore.update(channelId, (existing) => (
      existing.some((item) => item.id === message.id)
        ? existing.map((item) => item.id === message.id ? { ...item, ...message } : item)
        : [...existing, message]
    ));
    const vaultId = activeVaultIdRef.current;
    if (vaultId && options.persist !== false) void persistChatMessageToServer(vaultId, channelId, message);
  }, [persistChatMessageToServer]);

  const updateChatMessage = useCallback((channelId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
    // Compute the next message synchronously from the freshest known version so
    // we can both update React state and schedule the server patch. We can't read
    // a value assigned *inside* the setChatState updater here — React 18 doesn't
    // run that updater synchronously, so it would still be null when we schedule
    // the patch, and the streamed/final agent text would never be broadcast to
    // other clients. The base prefers a pending (not-yet-flushed) patch so a burst
    // of synchronous stream events (e.g. the history backfill loop) accumulates.
    const base = pendingChatPatchRef.current.get(messageId)
      ?? chatMessageStore.getChannel(channelId).find((message) => message.id === messageId);
    if (!base) return;
    const patched = updater(base);
    chatMessageStore.update(channelId, (existing) => existing.map((message) => (
      message.id === messageId ? patched : message
    )));
    const vaultId = activeVaultIdRef.current;
    if (vaultId && !serverOwnedChatMessageIdsRef.current.has(messageId)) {
      const immediate = !patched.status || patched.status === 'failed' || patched.status === 'canceled';
      scheduleChatMessagePatch(vaultId, channelId, messageId, patched, immediate);
    }
  }, [scheduleChatMessagePatch]);
  const startAgentChatRun = useAgentRunLifecycle({
    activeVaultIdRef, notesRef, runSocketsRef, streamingChatMessageIdsRef,
    serverOwnedChatMessageIdsRef, agentContextWatermarkRef, agentSessionTailRef,
    activeAgentSessionRunRef, interruptedAgentSessionRunRef, pendingAgentSteerRef,
    handleRegisterChatAgent, appendChatMessage, updateChatMessage,
  });

  const dispatchChatAgentIntents = useCallback(async (
    channelId: string,
    triggeringMessage: ChatMessage,
    registrations: ChatAgentRegistration[],
    dispatches: ChatAgentDispatch[],
    history: ChatMessage[],
    ownMedia: ChatMediaAttachment[] = [],
  ) => {
    const pendingDispatches = dispatches.filter((dispatch) => dispatch.runId == null);
    if (pendingDispatches.length === 0) return;
    const vaultId = activeVaultIdRef.current;
    const contextMessages = history.filter((message) => message.id !== triggeringMessage.id);
    // A typed handoff can point far outside the renderer's recent window. Fetch
    // only its linked evidence chain (bounded by the server hop limit), never
    // the whole channel, so a recovered dispatch still receives the real source.
    if (triggeringMessage.replyTo && vaultId) {
      const known = new Map(contextMessages.map((message) => [message.id, message]));
      let ref: ChatReplyRef | undefined = triggeringMessage.replyTo;
      for (let depth = 0; ref && depth < 5; depth += 1) {
        let linked = known.get(ref.messageId);
        if (!linked) {
          try {
            const data: { message: ChatMessage } = await api(
              `/api/vaults/${vaultId}/channels/${channelId}/messages/${encodeURIComponent(ref.messageId)}`,
            );
            linked = data.message;
            if (linked) {
              known.set(linked.id, linked);
              contextMessages.push(linked);
            }
          } catch {
            break;
          }
        }
        ref = linked?.replyTo;
      }
    }
    const attachmentNames = (triggeringMessage.attachments ?? []).map((item) => item.name).join(' ');
    const typedSource = [triggeringMessage.body.trim(), attachmentNames].filter(Boolean).join(' ');
    const directPrompt = stripRegisteredAgentMentions(typedSource, registrations);
    const hasQuotedContext = Boolean(triggeringMessage.replyTo);
    const batchPrompt = directPrompt || hasQuotedContext
      ? ''
      : precedingMessageBatchText(contextMessages, triggeringMessage);
    const taskGuidance = triggeringMessage.missionTaskId
      ? `Cascade mission task id: ${triggeringMessage.missionTaskId}. The mission card updates automatically when this run ends. If you are blocked rather than finished, run \`cascade-chat mission update --task ${triggeringMessage.missionTaskId} --status blocked --summary "<what is needed>"\` before replying.`
      : '';
    // Built per recipient: the reply chain can carry asks aimed at other agents,
    // and only a recipient-specific prompt can say which ones are not theirs.
    const promptFor = (selfMention: string) => {
      const quotedPrompt = triggeringMessage.replyTo
        ? buildQuotedReplyPrompt(triggeringMessage.replyTo, contextMessages, 1_200, 4, selfMention)
        : '';
      return [quotedPrompt, directPrompt || batchPrompt, taskGuidance].filter(Boolean).join('\n\n')
        || typedSource
        || 'Please review the attached media.';
    };

    const ownImages = ownMedia.length > 0
      ? mediaToRunImages(ownMedia)
      : dataUrlsToRunImages(triggeringMessage.images);
    const quotedMessage = triggeringMessage.replyTo
      ? contextMessages.find((message) => message.id === triggeringMessage.replyTo?.messageId)
      : undefined;
    const imageSources = (ownImages.length > 0
      ? []
      : (quotedMessage ? [quotedMessage] : precedingMessageBatch(contextMessages, triggeringMessage)))
      // Text-only rows cannot contribute media. Bound hydration before network
      // work so a long mention-only batch never serially fetches old messages.
      .filter((source) => !source.id.startsWith('agent-dispatch-')
        && ((source.images?.length ?? 0) > 0 || source.hasImages))
      .slice(-4);
    const carriedImages = (await Promise.all(imageSources.map(async (source) => {
      const inline = dataUrlsToRunImages(source.images);
      if (inline.length > 0 || !source.hasImages || !vaultId) return inline;
      try {
        const full = await api<{ message: ChatMessage }>(
          `/api/vaults/${vaultId}/channels/${channelId}/messages/${encodeURIComponent(source.id)}`,
        );
        return dataUrlsToRunImages(full.message?.images);
      } catch {
        return [];
      }
    }))).flat();
    const runImages = [...ownImages, ...carriedImages.slice(-4)];
    const agentsWithoutImages = new Set<AgentId>(['grok', 'antigravity', 'copilot', 'hermes', 'akron-grok']);

    await Promise.all(pendingDispatches.map(async (dispatch) => {
      if (startingChatDispatchesRef.current.has(dispatch.id)) return;
      startingChatDispatchesRef.current.add(dispatch.id);
      try {
        const blind = agentsWithoutImages.has(dispatch.registration.agentId as AgentId);
        const prompt = promptFor(dispatch.registration.mention || '');
        const promptForRun = blind && runImages.length > 0
          ? `${prompt}\n\n(This message carries ${runImages.length} image(s) you cannot receive — say so instead of guessing.)`
          : prompt;
        await startAgentChatRun(
          channelId,
          dispatch.registration,
          promptForRun,
          triggeringMessage,
          blind ? [] : runImages,
          dispatch.id,
        );
      } finally {
        startingChatDispatchesRef.current.delete(dispatch.id);
      }
    }));
  }, [startAgentChatRun]);

  const recoverPendingChatAgentDispatches = useCallback(async (channelId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      const data = await api<{ dispatches: ChatAgentDispatch[] }>(
        `/api/vaults/${vaultId}/channels/${channelId}/agent-dispatches/pending`,
      );
      const dispatches = data.dispatches ?? [];
      if (dispatches.length === 0) return;
      const registrations = chatStateRef.current.registeredAgentsByChannel[channelId] ?? [];
      const grouped = new Map<string, ChatAgentDispatch[]>();
      for (const dispatch of dispatches) {
        grouped.set(dispatch.messageId, [...(grouped.get(dispatch.messageId) ?? []), dispatch]);
      }
      for (const group of grouped.values()) {
        const trigger = group[0].message;
        await dispatchChatAgentIntents(
          channelId,
          trigger,
          registrations.length > 0 ? registrations : group.map((item) => item.registration),
          group,
          chatMessageStore.getChannel(channelId),
        );
      }
    } catch {
      // Reconnect will try again. The durable outbox is intentionally left
      // pending, so a transient API gap cannot turn a visible ping into a loss.
    }
  }, [dispatchChatAgentIntents]);

  const markChatRunCanceled = useCallback((runId: number) => {
    chatMessageStore.updateAll((messages) => {
      let changed = false;
      const next = messages.map((message) => {
        if (message.runId === runId && message.status === 'running') {
          changed = true;
          return {
            ...message,
            body: message.body === 'Thinking...' ? 'Run canceled by user.' : message.body,
            status: 'canceled' as const,
          };
        }
        return message;
      });
      return changed ? next : messages;
    });
  }, []);

  const handleCancelChatRun = useCallback(async (runId: number): Promise<boolean> => {
    markChatRunCanceled(runId);
    try {
      if (isLocalRunId(runId)) {
        // Negative run ids are legacy client-local runs (no longer started here).
        const cancelled = await cancelLocalAgentRun(runId);
        if (!cancelled) {
          setNotice('Could not cancel run');
          return false;
        }
      } else {
        const socket = runSocketsRef.current.get(runId);
        if (socket) {
          socket.disconnect();
          runSocketsRef.current.delete(runId);
        }
        const res = await api<{ success: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' });
        if (!res.success) {
          setNotice('Could not cancel run');
          return false;
        }
      }
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not cancel run');
      return false;
    }
  }, [markChatRunCanceled]);

  const handleCollaborateChatMessage = useCallback(async (
    channelId: string,
    sourceMessageId: string,
    targetRegistrationId: string,
    relationship: ChatRelationship,
    instruction: string,
  ): Promise<void> => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const history = chatMessageStore.getChannel(channelId);
    const data = await api<{
      message: ChatMessage;
      agents: ChatAgentRegistration[];
      dispatches: ChatAgentDispatch[];
    }>(`/api/vaults/${vaultId}/channels/${channelId}/messages/${encodeURIComponent(sourceMessageId)}/collaborate`, {
      method: 'POST',
      body: JSON.stringify({
        target: targetRegistrationId,
        relationship,
        instruction,
        requestId: `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }),
    });
    chatMessageStore.update(channelId, (messages) => {
      const index = messages.findIndex((message) => message.id === data.message.id);
      if (index === -1) return [...messages, data.message];
      const next = [...messages];
      next[index] = mergeRemoteChatMessage(messages[index], data.message);
      return next;
    });
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: data.agents,
      },
    }));
    await dispatchChatAgentIntents(
      channelId,
      data.message,
      data.agents,
      data.dispatches,
      history,
    );
  }, [dispatchChatAgentIntents]);

  const handleSendChatMessage = useCallback((
    channelId: string,
    body: string,
    media: ChatMediaAttachment[] = [],
    replyTo?: ChatReplyRef,
  ) => {
    const trimmed = body.trim();
    if ((!trimmed && media.length === 0) || !user) return;

    // `/clear` (optionally targeting @mentions) rotates the session for the
    // channel's agents so the next message starts fresh, without deleting history.
    const channelRegistrations = chatStateRef.current.registeredAgentsByChannel[channelId] ?? [];
    const clearCommand = stripRegisteredAgentMentions(trimmed, channelRegistrations).trim();
    if (/^\/(clear|reset)$/i.test(clearCommand)) {
      const mentioned = getMentionedRegistrations(trimmed, channelRegistrations, false);
      const targets = mentioned.length > 0 ? mentioned : channelRegistrations;
      if (targets.length === 0) {
        setNotice('No agents in this channel to clear.');
        return;
      }
      for (const registration of targets) {
        handleRegisterChatAgent(channelId, { ...registration, conversationId: newId('conv') });
      }
      const names = targets.map((item) => `@${normalizeMention(item.mention || item.agentId)}`).join(', ');
      appendChatMessage(channelId, {
        id: newId('sys'),
        channelId,
        author: 'Cascade',
        body: `🧹 Cleared the session for ${names}. The next message starts a fresh conversation.`,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const images = media.filter((item) => item.media_type.startsWith('image/')).map((item) => item.url);
    const attachments = media
      .filter((item) => !item.media_type.startsWith('image/'))
      .map((item) => ({ name: item.name || 'attachment', media_type: item.media_type, url: item.url }));

    const candidate: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId,
      author: user.username,
      body: trimmed,
      createdAt: new Date().toISOString(),
      ...(images.length > 0 ? { images } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
    };

    const messages = chatMessageStore.getChannel(channelId);
    const last = messages[messages.length - 1];
    const typedSource = [trimmed, attachments.map((item) => item.name).join(' ')].filter(Boolean).join(' ');
    const replyTargetIsAgent = replyQuoteTargetsAgent(replyTo, messages);
    const hasAgentIntent = Boolean(replyTo)
      || isCompactCommand(trimmed, channelRegistrations)
      || getMentionedRegistrations(typedSource, channelRegistrations, false).length > 0
      || channelRegistrations.some((registration) => registration.replyToEveryMessage);
    let outgoingMessage = candidate;
    let mergeTargetId: string | null = null;
    // A reply or dispatch intent gets its own durable row. Folding it into an
    // earlier PATCH can lose thread provenance, and would make orchestration
    // depend on a renderer staying alive long enough to launch the run.
    if (!hasAgentIntent && last && canMergeChatMessages(last, candidate)) {
      mergeTargetId = last.id;
      outgoingMessage = {
        ...last,
        body: `${last.body}\n${trimmed}`,
        createdAt: candidate.createdAt,
      };
    }

    chatMessageStore.update(channelId, (channelMessages) => (
      mergeTargetId
        ? [...channelMessages.slice(0, -1), outgoingMessage]
        : [...channelMessages, candidate]
    ));

    const vaultId = activeVaultIdRef.current;
    // Persist the user prompt *before* starting agents. If the agent shell is
    // inserted first it gets a lower rowid/seq and survives reloads as
    // "response then prompt" even when the UI briefly looked correct.
    void (async () => {
      if (!vaultId) return;
      if (mergeTargetId) {
        scheduleChatMessagePatch(vaultId, channelId, mergeTargetId, outgoingMessage, true);
        return;
      }
      const saved = await persistChatMessageToServer(vaultId, channelId, candidate);
      if (!saved) return;
      if (replyTargetIsAgent && saved.dispatches.length === 0) {
        const replyMention = normalizeMention(replyTo?.mention || '');
        if (replyMention) setNotice(`Could not route reply to @${replyMention}. Reconnect and try again.`);
      }
      await dispatchChatAgentIntents(
        channelId,
        saved.message,
        saved.agents,
        saved.dispatches,
        messages,
        media,
      );
    })();
  }, [scheduleChatMessagePatch, persistChatMessageToServer, dispatchChatAgentIntents, user, handleRegisterChatAgent, appendChatMessage]);

  return {
    dispatchChatAgentIntents,
    recoverPendingChatAgentDispatches,
    handleHydrateChatMessage,
    handleDeleteChatMessage,
    handleForwardChatMessage,
    handleCancelChatRun,
    handleCollaborateChatMessage,
    handleSendChatMessage,
  };
}
