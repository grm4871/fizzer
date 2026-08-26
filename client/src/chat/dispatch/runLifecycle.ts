import { useCallback, type MutableRefObject } from 'react';
import type { ChatAgentRegistration, ChatBlock, ChatMessage, ChatReplyRef } from '../types';
import type { NoteSummary } from '../../api';
import { api, ApiError } from '../../api';
import { connectRunsSocket } from '../../socket';
import { isLocalRunId } from '../../localAgentRunner';
import { agentLabel, CHAT_AGENTS, chatAgentConversation, formatAgentChatPrompt, needsCascadeWorkspaceContext, needsRecentChatContext, normalizeChatCwd, type AgentId } from '../agents';
import { isCompactCommand } from '../mentions';
import { appendChatRunBlocks, appendHarnessLog, hasChatRunToolBlock, honestAgentChatBody, afterChatTimestamp, normalizeChatRunBlocks, textFromRunContent } from '../runBlocks';
import { chatMessageStore } from '../messageStore';
import {
  consumePendingSessionSteer, enqueueSessionTurn, findProjectedActiveSessionRun,
  forceReleasePriorSessionTurns, queuesBehindActiveSession, requestSessionSteer,
  shouldSteerActiveSession,
} from '../sessionTurns';

type Refs = {
  activeVaultIdRef: MutableRefObject<string | null>;
  notesRef: MutableRefObject<NoteSummary[]>;
  runSocketsRef: MutableRefObject<Map<number, ReturnType<typeof connectRunsSocket>>>;
  streamingChatMessageIdsRef: MutableRefObject<Set<string>>;
  serverOwnedChatMessageIdsRef: MutableRefObject<Set<string>>;
  agentContextWatermarkRef: MutableRefObject<Map<string, string>>;
  agentSessionTailRef: MutableRefObject<Map<string, Promise<void>>>;
  activeAgentSessionRunRef: MutableRefObject<Map<string, number>>;
  interruptedAgentSessionRunRef: MutableRefObject<Map<string, number>>;
  pendingAgentSteerRef: MutableRefObject<Set<string>>;
  handleRegisterChatAgent: (channelId: string, registration: ChatAgentRegistration, sourceVaultId?: string) => void;
  appendChatMessage: (channelId: string, message: ChatMessage, options?: { persist?: boolean }) => void;
  updateChatMessage: (channelId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage) => void;
};

export function useAgentRunLifecycle({
  activeVaultIdRef, notesRef, runSocketsRef, streamingChatMessageIdsRef,
  serverOwnedChatMessageIdsRef, agentContextWatermarkRef, agentSessionTailRef,
  activeAgentSessionRunRef, interruptedAgentSessionRunRef, pendingAgentSteerRef,
  handleRegisterChatAgent, appendChatMessage, updateChatMessage,
}: Refs) {
  const startAgentChatRun = useCallback(async (
    channelId: string,
    registration: ChatAgentRegistration,
    prompt: string,
    triggeringMessage: ChatMessage,
    runImages: Array<{ media_type: string; data: string }> = [],
    dispatchId?: string,
  ): Promise<boolean> => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return false;

    const agentId = registration.agentId as AgentId;
    if (!CHAT_AGENTS.some((agent) => agent.id === agentId)) return false;
    const channelName = notesRef.current.find((note) => note.id === channelId)?.title || 'chat';
    const conversation = chatAgentConversation(
      registration.id,
      registration.conversationId,
      triggeringMessage.missionTaskId,
    );
    const watermarkKey = conversation.watermarkKey;
    const sessionTurn = enqueueSessionTurn(agentSessionTailRef.current, watermarkKey);
    const orchestrationQueue = queuesBehindActiveSession(triggeringMessage);
    const projectedRunId = findProjectedActiveSessionRun(
      chatMessageStore.getChannel(channelId),
      registration.id,
      registration.agentId,
    );
    if (projectedRunId != null && !activeAgentSessionRunRef.current.has(watermarkKey)) {
      activeAgentSessionRunRef.current.set(watermarkKey, projectedRunId);
    }
    // Supervisor/human steers must fire when a durable run is still open even if
    // the local Promise tail was already released (reload, missed terminal).
    const steeringTurn = shouldSteerActiveSession({
      orchestrationQueue,
      hasPrecedingTurn: Boolean(sessionTurn.preceding),
      hasLocalActiveRun: activeAgentSessionRunRef.current.has(watermarkKey),
      projectedRunId,
    });
    const agentMessageId = dispatchId
      ? `agent-dispatch-${dispatchId}`
      : `agent-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const collaborationReplyTo: ChatReplyRef | undefined = triggeringMessage.replyTo?.relationship
      ? {
        messageId: triggeringMessage.id,
        author: triggeringMessage.author,
        mention: '',
        preview: triggeringMessage.body.trim().slice(0, 120) || '(collaboration request)',
        relationship: 'builds_on',
      }
      : undefined;

    const cancelSteeringRun = async (runId: number) => {
      try {
        await api<{ success: boolean }>(`/api/runs/${runId}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ steering: true }),
        });
      } catch {
        // Terminal event / 409 retry still frees the lease when possible.
      }
    };

    if (steeringTurn) {
      const runToInterrupt = requestSessionSteer(
        activeAgentSessionRunRef.current,
        interruptedAgentSessionRunRef.current,
        pendingAgentSteerRef.current,
        watermarkKey,
      );
      const interruptId = runToInterrupt
        ?? projectedRunId
        ?? activeAgentSessionRunRef.current.get(watermarkKey);
      if (interruptId != null) {
        // Await cancel so the provider lease is released before we wait on the
        // local turn chain. Fire-and-forget left steers stuck for 60s then fail.
        await cancelSteeringRun(interruptId);
      }
      // Always unstick the local queue for human/supervisor steers — cancel
      // alone does not release a hung predecessor that never saw a terminal event.
      forceReleasePriorSessionTurns(watermarkKey);
    } else if (!orchestrationQueue && projectedRunId != null) {
      // App restart clears local session tails, so the next human ping is not
      // classified as a steer even though a durable open run may still hold the
      // sticky registration lease. Interrupt that ghost so POST /runs does not
      // fail forever with "still stopping".
      activeAgentSessionRunRef.current.set(watermarkKey, projectedRunId);
      interruptedAgentSessionRunRef.current.set(watermarkKey, projectedRunId);
      await cancelSteeringRun(projectedRunId);
      forceReleasePriorSessionTurns(watermarkKey);
    }

    let runSocket: ReturnType<typeof connectRunsSocket> | null = null;
    let activeRunId: number | null = null;
    type MessageUpdater = (message: ChatMessage) => ChatMessage;
    let pendingMessageUpdates: MessageUpdater[] = [];
    let messageUpdateTimer: number | null = null;
    let pendingHarnessChunks = '';
    let pendingHarnessRunId: number | null = null;
    let harnessFlushTimer: number | null = null;
    // Dual-rate batching: structured content stays snappy; raw harness bytes
    // are much higher volume and don't need 30fps React commits.
    const STREAM_UI_MS = 48;
    const HARNESS_UI_MS = 140;

    const flushMessageUpdates = () => {
      if (messageUpdateTimer != null) window.clearTimeout(messageUpdateTimer);
      messageUpdateTimer = null;
      if (harnessFlushTimer != null) {
        window.clearTimeout(harnessFlushTimer);
        harnessFlushTimer = null;
      }
      if (pendingHarnessChunks) {
        const chunk = pendingHarnessChunks;
        const harnessRunId = pendingHarnessRunId;
        pendingHarnessChunks = '';
        pendingHarnessRunId = null;
        pendingMessageUpdates.push((message) => ({
          ...message,
          harnessLog: appendHarnessLog(message.harnessLog, chunk),
          ...(harnessRunId != null ? { runId: harnessRunId } : {}),
        }));
      }
      if (pendingMessageUpdates.length === 0) return;
      const updates = pendingMessageUpdates;
      pendingMessageUpdates = [];
      updateChatMessage(channelId, agentMessageId, (message) =>
        updates.reduce((next, update) => update(next), message));
    };

    // CLI streams often emit text, structured blocks, and harness bytes as
    // separate events for the same output. Collapse those into one React update.
    const queueMessageUpdate = (updater: MessageUpdater) => {
      pendingMessageUpdates.push(updater);
      if (messageUpdateTimer != null) return;
      messageUpdateTimer = window.setTimeout(flushMessageUpdates, STREAM_UI_MS);
    };

    const queueHarnessChunk = (chunk: string, runIdForChunk: number) => {
      pendingHarnessChunks += chunk;
      pendingHarnessRunId = runIdForChunk;
      if (harnessFlushTimer != null || messageUpdateTimer != null) return;
      // If structure updates are pending, piggy-back; else slow-path harness only.
      harnessFlushTimer = window.setTimeout(flushMessageUpdates, HARNESS_UI_MS);
    };

    const applyMessageUpdateNow = (updater: MessageUpdater) => {
      pendingMessageUpdates.push(updater);
      flushMessageUpdates();
    };

    // Eager placeholder so messageId always exists before /runs (and the server
    // can single-write into it). Server will also ensure/create if needed.
    // createdAt is strictly after the triggering prompt so same-ms + seq races
    // cannot sort the agent shell above the user message.
    streamingChatMessageIdsRef.current.add(agentMessageId);
    appendChatMessage(channelId, {
      id: agentMessageId,
      channelId,
      author: registration.displayName || agentLabel(agentId),
      body: orchestrationQueue && sessionTurn.preceding ? 'Queued...' : 'Thinking...',
      createdAt: afterChatTimestamp(triggeringMessage.createdAt),
      status: orchestrationQueue && sessionTurn.preceding ? 'sending' : 'running',
      agentId,
      registrationId: registration.id,
      ...(triggeringMessage.missionTaskId
        ? { missionTaskId: triggeringMessage.missionTaskId }
        : {}),
      ...(collaborationReplyTo ? { replyTo: collaborationReplyTo } : {}),
    }, { persist: false });

    try {
      // The prior terminal event is published only after its session id is
      // stored server-side. Waiting here therefore guarantees /runs can resume
      // that same backing session instead of racing into a duplicate cold boot.
      // A predecessor that never publishes a terminal event must not leave this
      // optimistic shell saying "Thinking..." forever. The server has not been
      // asked to create a run yet, so it is safe to fail this startup locally.
      if (orchestrationQueue) {
        // Long worker tasks routinely exceed a minute. Their next assignment is
        // durable and should wait for a real provider session, not time out or
        // interrupt it as if the user had steered the current answer. But a
        // prior *local* queue entry can fail before it creates any run; waiting
        // on that orphaned promise forever makes the durable ping inert. Check
        // periodically and only break the queue when no server-backed run owns
        // the session. A real run remains fully serialized, however long it is.
        while (sessionTurn.preceding) {
          let predecessorSettled = false;
          let livenessTimer: number | undefined;
          try {
            await Promise.race([
              sessionTurn.preceding.then(() => { predecessorSettled = true; }),
              new Promise<void>((resolve) => {
                livenessTimer = window.setTimeout(resolve, 15_000);
              }),
            ]);
          } finally {
            if (livenessTimer != null) window.clearTimeout(livenessTimer);
          }
          if (predecessorSettled) break;
          const precedingRunId = findProjectedActiveSessionRun(
            chatMessageStore.getChannel(channelId),
            registration.id,
            registration.agentId,
          );
          if (precedingRunId != null) continue;
          forceReleasePriorSessionTurns(watermarkKey);
          break;
        }
        applyMessageUpdateNow((message) => ({
          ...message,
          body: 'Thinking...',
          status: 'running',
        }));
      } else {
        // Human / orchestrator steers: never fail the turn solely because the
        // predecessor hung after cancel. Interrupt again, force-release priors,
        // then proceed — createRun's 409 path still serializes the provider lease.
        const waitForPreceding = async (ms: number) => {
          if (!sessionTurn.preceding) return;
          let startupTimeout: number | undefined;
          try {
            await Promise.race([
              sessionTurn.preceding,
              new Promise<never>((_resolve, reject) => {
                startupTimeout = window.setTimeout(
                  () => reject(new Error('preceding-timeout')),
                  ms,
                );
              }),
            ]);
          } finally {
            if (startupTimeout != null) window.clearTimeout(startupTimeout);
          }
        };
        try {
          // After force-release, steers should not sit for nearly a minute.
          await waitForPreceding(steeringTurn ? 8_000 : 60_000);
        } catch {
          const stuckRunId = findProjectedActiveSessionRun(
            chatMessageStore.getChannel(channelId),
            registration.id,
            registration.agentId,
          );
          if (stuckRunId != null) {
            activeAgentSessionRunRef.current.set(watermarkKey, stuckRunId);
            await cancelSteeringRun(stuckRunId);
          }
          forceReleasePriorSessionTurns(watermarkKey);
          try {
            await waitForPreceding(2_000);
          } catch {
            // Last resort: proceed. Server 409 + cancel retries handle a still-open lease.
          }
        }
      }
      // One sticky session per agent: the run resumes (and extends) the member's
      // conversation, so its earlier turns are already in context. A `/clear`
      // rotates conversationId, so a fresh key here has no watermark.
      const watermark = agentContextWatermarkRef.current.get(watermarkKey);
      // A steering turn resumes the interrupted CLI session even though the
      // canceled predecessor intentionally did not advance the normal completed
      // watermark. Treat it as a continuation so we do not send cold-start
      // framing into the resumed transcript.
      const continuation = steeringTurn || Boolean(watermark);
      const steeredPrompt = steeringTurn
        ? `Mid-session steering from ${triggeringMessage.author}:\n${prompt}`
        : prompt;
      const runPrompt = agentId === 'claude-code' && isCompactCommand(prompt, [registration])
        ? '/compact'
        : formatAgentChatPrompt(channelName, registration, steeredPrompt, triggeringMessage.author, continuation);
      // Conversation id groups runs for backend session resume (findPriorSession).
      // The actual CLI session_id is resolved server-side — not this value.
      const conversationId = conversation.conversationId;
      let assistantText = '';
      let bufferedBlocks: ChatBlock[] = [];
      const processedSeqs = new Set<number>();

      const finishRun = (runId: number, cleanup: () => void) => {
        cleanup();
        sessionTurn.release();
        if (activeAgentSessionRunRef.current.get(watermarkKey) === runId) {
          activeAgentSessionRunRef.current.delete(watermarkKey);
        }
        if (interruptedAgentSessionRunRef.current.get(watermarkKey) === runId) {
          interruptedAgentSessionRunRef.current.delete(watermarkKey);
        }
        streamingChatMessageIdsRef.current.delete(agentMessageId);
        serverOwnedChatMessageIdsRef.current.delete(agentMessageId);
        if (!isLocalRunId(runId)) {
          const socket = runSocketsRef.current.get(runId);
          if (socket) {
            socket.off('connect', joinRunRoom);
            socket.disconnect();
          }
          runSocketsRef.current.delete(runId);
        }
      };

      let joinRunRoom: () => void = () => {};

      const processRunEvent = (event: { seq?: number; type: string; payload_json: string }, runId: number, cleanup: () => void) => {
        if (typeof event?.seq === 'number') {
          if (processedSeqs.has(event.seq)) return;
          processedSeqs.add(event.seq);
        }
        try {
          if (event.type === 'status') {
            const payload = JSON.parse(event.payload_json);
            if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'canceled') {
              const terminal = payload.status as 'completed' | 'failed' | 'canceled';
              const suppressChatBody = payload.suppressChatBody === true;
              const finalBody = honestAgentChatBody(
                assistantText,
                typeof payload.summary === 'string' ? payload.summary : undefined,
                terminal,
                { suppressChatBody },
              );
              const nextStatus = terminal === 'completed' ? undefined : terminal;
              // Suppressed terminal lifecycle events (dual-post completion or
              // automatic cleanup) drop the Thinking placeholder entirely.
              if (suppressChatBody) {
                chatMessageStore.update(channelId, (existing) => {
                  const next = existing.filter((message) => message.id !== agentMessageId);
                  return next.length === existing.length ? existing : next;
                });
                agentContextWatermarkRef.current.set(watermarkKey, agentMessageId);
                finishRun(runId, cleanup);
                return;
              }
              applyMessageUpdateNow((message) => ({
                ...message,
                body: finalBody,
                status: nextStatus,
                runId,
              }));
              if (terminal === 'completed') {
                // The agent's session now holds everything through this reply, so
                // the next turn only needs messages posted after it. Left untouched
                // on failure so the next turn re-feeds the context this run missed.
                agentContextWatermarkRef.current.set(watermarkKey, agentMessageId);
              }
              finishRun(runId, cleanup);
            }
          } else if (event.type === 'text') {
            const payload = JSON.parse(event.payload_json);
            const blocks = normalizeChatRunBlocks(payload.message?.content);
            const text = textFromRunContent(payload.message?.content);
            const hasToolBlock = hasChatRunToolBlock(payload.message?.content);
            if (!text && blocks.length === 0 && !hasToolBlock) return;
            // Accumulate final-answer candidates. Only adapters that explicitly
            // distinguish assistant-visible prose from reasoning may stream the
            // text into the chat body; everything else stays in the trace.
            if (text) assistantText += text;
            bufferedBlocks = appendChatRunBlocks(bufferedBlocks, blocks);
            const chatVisible = payload.chatVisible === true && Boolean(text.trim());
            queueMessageUpdate((message) => ({
              ...message,
              // Reasoning remains in the trace. Codex agent_message and Claude
              // text_delta events opt in to immediate chat rendering so the
              // user does not wait for the full run to finish before reading.
              body: chatVisible && assistantText.trim()
                ? assistantText.trimStart()
                : message.body || 'Thinking...',
              blocks: appendChatRunBlocks(message.blocks, blocks),
              runId,
            }));
          } else if (event.type === 'user') {
            const payload = JSON.parse(event.payload_json);
            const blocks = normalizeChatRunBlocks(payload.message?.content);
            if (blocks.length === 0) return;
            bufferedBlocks = appendChatRunBlocks(bufferedBlocks, blocks);
            queueMessageUpdate((message) => ({
              ...message,
              blocks: appendChatRunBlocks(message.blocks, blocks),
              runId,
            }));
          } else if (event.type === 'harness') {
            const payload = JSON.parse(event.payload_json);
            const chunk = typeof payload?.data === 'string' ? payload.data : '';
            if (!chunk) return;
            queueHarnessChunk(chunk, runId);
          }
        } catch {
          // Ignore one malformed stream event; the run status will still settle.
        }
      };

      // Run creation must not wait behind a fresh Socket.IO handshake. The
      // server persists every event and also broadcasts the chat projection;
      // after POST succeeds we join the run room and backfill anything emitted
      // before the transport connected.
      const runBody = JSON.stringify({
        prompt: runPrompt,
        note_id: null,
        agent: agentId,
        conversation_id: conversationId,
        model: registration.model || undefined,
        cwd: normalizeChatCwd(registration.cwd) || undefined,
        yolo: registration.yolo,
        images: runImages,
        // Identifies the registered agent so the server can route the run to the
        // agent owner's desktop runner (cross-user pings) and enforce its
        // pingable-by-others setting, rather than trusting these client values.
        registrationId: registration.id,
        ...(dispatchId ? { chatDispatchId: dispatchId } : {}),
        // Link the run to this chat message so the server persists/broadcasts
        // the streamed reply to all clients (see serverOwnedChatMessageIdsRef).
        chat: {
          channelId,
          messageId: agentMessageId,
          triggeringMessageId: triggeringMessage.id,
          author: registration.displayName || agentLabel(agentId),
          // Hermes already has a large native agent prompt. Only pay for
          // Cascade-specific context when the request genuinely depends on it.
          contextNeeded: needsRecentChatContext(prompt),
          workspaceNeeded: needsCascadeWorkspaceContext(prompt),
          ...(collaborationReplyTo ? { replyTo: collaborationReplyTo } : {}),
        },
      });
      const createRun = () => api<{ run: { id: number; status: string; conversation_id: string }; reused?: boolean }>(
        `/api/vaults/${vaultId}/runs`,
        { method: 'POST', body: runBody },
      );
      // 409 "still stopping" means the sticky session lease is held by another
      // open run (often mid-cancel after a steer). Cancel with steering + retry
      // with longer backoff so desktop stop can finish; never treat the first
      // 409 as a permanent failed "queued" turn.
      let res: { run: { id: number; status: string; conversation_id: string }; reused?: boolean };
      try {
        res = await createRun();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const activeId = Number(error.data?.activeRunId);
        if (Number.isFinite(activeId)) {
          await api<{ success: boolean }>(`/api/runs/${activeId}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ steering: true }),
          }).catch(() => {});
          forceReleasePriorSessionTurns(watermarkKey);
        }
        let lastError: unknown = error;
        res = await (async () => {
          for (let attempt = 0; attempt < 8; attempt += 1) {
            // Desktop cancel ack can take several seconds; short retries left
            // steers permanently "queued" while the lease was still draining.
            await new Promise((resolve) => window.setTimeout(resolve, 400 + attempt * 350));
            try {
              return await createRun();
            } catch (retryError) {
              lastError = retryError;
              if (!(retryError instanceof ApiError) || retryError.status !== 409) throw retryError;
              const retryActiveId = Number(retryError.data?.activeRunId);
              if (Number.isFinite(retryActiveId)) {
                await api<{ success: boolean }>(`/api/runs/${retryActiveId}/cancel`, {
                  method: 'POST',
                  body: JSON.stringify({ steering: true }),
                }).catch(() => {});
                forceReleasePriorSessionTurns(watermarkKey);
              }
            }
          }
          throw lastError;
        })();
      }

      activeRunId = res.run.id;
      activeAgentSessionRunRef.current.set(watermarkKey, res.run.id);
      // The run is registered server-side; the server now owns persistence of this
      // message's streamed updates. Skip our own debounced PATCH to avoid duplicate
      // writes — we still update local state for instant display.
      serverOwnedChatMessageIdsRef.current.add(agentMessageId);
      // Legacy members predate per-member sessions: adopt the conversation the
      // server just minted and persist it so later turns resume the same session.
      if (conversation.adoptConversation && res.run.conversation_id) {
        handleRegisterChatAgent(channelId, { ...registration, conversationId: res.run.conversation_id }, vaultId);
      }

      queueMessageUpdate((message) => ({
        ...message,
        runId: res.run.id,
      }));

      runSocket = connectRunsSocket();
      runSocketsRef.current.set(res.run.id, runSocket);
      joinRunRoom = () => runSocket!.emit('joinRun', res.run.id);
      runSocket.on('connect', () => {
        joinRunRoom();
      });
      runSocket.emit('joinRun', res.run.id);
      const cleanup = () => {};
      runSocket.on('event', (event) => processRunEvent(event, res.run.id, cleanup));

      try {
        const history = await api<{ events: Array<{ seq: number; type: string; payload_json: string }> }>(`/api/runs/${res.run.id}/events`);
        for (const event of history.events) processRunEvent(event, res.run.id, cleanup);
      } catch {
        // Best-effort backfill; live events will still populate going forward.
      }
      if (consumePendingSessionSteer(
        interruptedAgentSessionRunRef.current,
        pendingAgentSteerRef.current,
        watermarkKey,
        res.run.id,
      )) {
        void api<{ success: boolean }>(`/api/runs/${res.run.id}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ steering: true }),
        }).catch(() => {});
      }
      return true;
    } catch (error) {
      // A coordinator can finish a mission before its queued synthetic review
      // prompt reaches the provider session. The server removes that obsolete
      // dispatch; quietly prune the optimistic shell instead of showing an
      // empty failed Harness panel for work that is already complete.
      if (dispatchId && error instanceof Error && error.message === 'Chat dispatch not found') {
        chatMessageStore.update(channelId, (existing) => (
          existing.filter((message) => message.id !== agentMessageId)
        ));
        runSocket?.disconnect();
        streamingChatMessageIdsRef.current.delete(agentMessageId);
        sessionTurn.release();
        return false;
      }
      // Release server ownership so this client-side failure is persisted by us.
      // If the run was actually created and later succeeds, the server's update
      // (higher stream score) still wins over this 'failed' state.
      serverOwnedChatMessageIdsRef.current.delete(agentMessageId);
      if (activeRunId != null) {
        runSocketsRef.current.get(activeRunId)?.disconnect();
        runSocketsRef.current.delete(activeRunId);
      } else {
        runSocket?.disconnect();
      }
      streamingChatMessageIdsRef.current.delete(agentMessageId);
      if (activeRunId != null && activeAgentSessionRunRef.current.get(watermarkKey) === activeRunId) {
        activeAgentSessionRunRef.current.delete(watermarkKey);
      }
      applyMessageUpdateNow((message) => ({
        ...message,
        body: error instanceof Error ? error.message : 'Failed to start agent.',
        status: 'failed',
      }));
      sessionTurn.release();
      return false;
    }
  }, [appendChatMessage, updateChatMessage, handleRegisterChatAgent]);
  return startAgentChatRun;
}
