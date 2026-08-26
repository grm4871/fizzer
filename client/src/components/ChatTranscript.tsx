/**
 * Chat transcript chrome and grouped-message rendering.
 *
 * Scroll intent refs intentionally stay owned by useChatScroll: this module only
 * renders rows and forwards gestures, preserving the parent sticky-scroll state.
 */
import type { MutableRefObject, ReactNode, RefObject } from 'react';
import { Hash, History, MessageCircle } from 'lucide-react';
import type { NoteSummary } from '../api';
import { shouldDetachStickyForTouch, shouldDetachStickyForWheel } from './chatViewHelpers';
import type {
  ChatAgentRegistration,
  ChatMediaAttachment,
  ChatMessage,
  ChatReplyRef,
  PlanUsage,
} from '../chat/types';
import type { ChatMessageGroup, TranscriptSegment } from '../chat/workTrace';
import { workTracePeek } from '../chat/workTrace';
import { ChatGroupRow } from './ChatGroupRow';
import { ChatMissionCard } from './ChatMissionCard';
import { ChatComposer, type ChatComposerHandle } from './ChatComposer';
import { ChatWorkTrace } from './ChatWorkTrace';

export type ChatTranscriptProps = {
  channelId: string;
  channelName: string;
  directMessage: boolean;
  isLoadingMessages: boolean;
  sortedMessages: ChatMessage[];
  transcriptSegments: TranscriptSegment[];
  messagesRef: RefObject<HTMLDivElement | null>;
  messagesContentRef: RefObject<HTMLDivElement | null>;
  endRef: RefObject<HTMLDivElement | null>;
  touchStartYRef: MutableRefObject<number | null>;
  pendingSendFollowRef: MutableRefObject<boolean>;
  programmaticScrollRef: MutableRefObject<boolean>;
  userScrollIntentUntilRef: MutableRefObject<number>;
  composerRef: RefObject<ChatComposerHandle | null>;
  runningMessageState: Map<string, { latestId: string; count: number }>;
  selectedMessageId: string | null;
  jumpHighlightMessageId: string | null;
  loadedMessageIds: Set<string>;
  steeringPromptLabels: Map<string, string>;
  mentionableAliases: string[];
  notes: NoteSummary[];
  registeredAgents: ChatAgentRegistration[];
  vaultId?: string;
  onOpenNote?: (id: string) => void;
  onOpenSharedNote: (messageId: string, title: string) => Promise<void>;
  onCancelRun: (runId: number) => void;
  onToggleSelect: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, message: ChatMessage) => void;
  onReply: (message: ChatMessage) => void;
  onJumpToMessage: (id: string) => void;
  onLightbox: (src: string) => void;
  onImageLoad: () => void;
  onHydrateMessage?: (message: ChatMessage) => void;
  onAgentAvatarClick?: (message: ChatMessage, event: React.MouseEvent) => void;
  resolveMessageRegistration: (message: ChatMessage) => ChatAgentRegistration | undefined;
  getMessageAvatarKind: (message: ChatMessage) => 'agent' | 'human';
  getMessageAvatarUrl: (message: ChatMessage) => string;
  getMessageAuthorLabel: (message: ChatMessage) => string;
  getMessageOwnerLabel: (message: ChatMessage) => string;
  getMessagePlanUsage: (message: ChatMessage) => PlanUsage | null;
  onSendMessage: (channelId: string, body: string, media?: ChatMediaAttachment[], replyTo?: ChatReplyRef) => void;
  onMissionArchiveOpen: () => void;
};

export function ChatTranscript({
  channelId,
  channelName,
  directMessage,
  isLoadingMessages,
  sortedMessages,
  transcriptSegments,
  messagesRef,
  messagesContentRef,
  endRef,
  touchStartYRef,
  pendingSendFollowRef,
  programmaticScrollRef,
  userScrollIntentUntilRef,
  composerRef,
  runningMessageState,
  selectedMessageId,
  jumpHighlightMessageId,
  loadedMessageIds,
  steeringPromptLabels,
  mentionableAliases,
  notes,
  registeredAgents,
  vaultId,
  onOpenNote,
  onOpenSharedNote,
  onCancelRun,
  onToggleSelect,
  onContextMenu,
  onReply,
  onJumpToMessage,
  onLightbox,
  onImageLoad,
  onHydrateMessage,
  onAgentAvatarClick,
  resolveMessageRegistration,
  getMessageAvatarKind,
  getMessageAvatarUrl,
  getMessageAuthorLabel,
  getMessageOwnerLabel,
  getMessagePlanUsage,
  onSendMessage,
  onMissionArchiveOpen,
}: ChatTranscriptProps) {
  const renderGroupRow = (group: ChatMessageGroup) => {
    const head = group.messages[0];
    const groupSelected = selectedMessageId != null && group.messages.some((message) => message.id === selectedMessageId);
    const groupJumpHighlighted = jumpHighlightMessageId != null && group.messages.some((message) => message.id === jumpHighlightMessageId);
    const runKey = head.registrationId || head.agentId || '';
    const runState = runKey ? runningMessageState.get(runKey) : undefined;
    return (
      <ChatGroupRow
        key={head.id}
        group={group}
        selectedMessageId={groupSelected ? selectedMessageId : null}
        jumpHighlightMessageId={groupJumpHighlighted ? jumpHighlightMessageId : null}
        avatarKind={getMessageAvatarKind(head)}
        avatarUrl={getMessageAvatarUrl(head)}
        authorLabel={getMessageAuthorLabel(head)}
        ownerLabel={getMessageOwnerLabel(head)}
        planUsage={getMessagePlanUsage(head)}
        latestRunningMessageId={runState?.latestId}
        runningSiblingCount={runState?.count || 0}
        steeringPromptLabels={steeringPromptLabels}
        mentionableAliases={mentionableAliases}
        notes={notes}
        onOpenNote={onOpenNote}
        onOpenSharedNote={onOpenSharedNote}
        onCancelRun={onCancelRun}
        onToggleSelect={onToggleSelect}
        onContextMenu={onContextMenu}
        onReply={onReply}
        onJumpToMessage={onJumpToMessage}
        loadedMessageIds={loadedMessageIds}
        onLightbox={onLightbox}
        onImageLoad={onImageLoad}
        onAgentAvatarClick={resolveMessageRegistration(head) && onAgentAvatarClick
          ? (event) => onAgentAvatarClick(head, event)
          : undefined}
        scrollRootRef={messagesRef}
        vaultId={vaultId}
        onHydrateMessage={onHydrateMessage}
        contextMenuMessage={group.messages.find((message) => Boolean(message.mission))}
      />
    );
  };

  const renderSegment = (segment: TranscriptSegment): ReactNode[] => {
    if (segment.kind === 'group') return [renderGroupRow(segment.group)];
    const updateHost = segment.updateGroups.at(-1)?.messages.at(-1);
    const host = updateHost || segment.carrier || segment.trace.find((message) => message.registrationId || message.agentId);
    if (!host) return [];
    const carrier = updateHost || !segment.carrier ? {
      ...host,
      id: `agent-trace-${segment.id}`,
      body: '',
      status: undefined,
    } : segment.carrier;
    const traceSelected = selectedMessageId != null && segment.trace.some((message) => message.id === selectedMessageId);
    const traceJumpHighlighted = jumpHighlightMessageId != null && segment.trace.some((message) => message.id === jumpHighlightMessageId);
    const missionArtifacts = [
      ...(carrier.mission ? [carrier] : []),
      ...segment.fullGroups.flatMap((group) => group.messages).filter((message) => Boolean(message.mission)),
    ];
    const displayCarrier = carrier.mission ? { ...carrier, mission: undefined } : carrier;
    const carrierKey = displayCarrier.registrationId || displayCarrier.agentId || displayCarrier.author;
    const clumpedUpdateMessages: ChatMessage[] = [];
    const separateUpdateGroups: ChatMessageGroup[] = [];
    for (const group of segment.updateGroups) {
      const head = group.messages[0];
      const headKey = head.registrationId || head.agentId || head.author;
      if (headKey === carrierKey) clumpedUpdateMessages.push(...group.messages);
      else separateUpdateGroups.push(group);
    }
    const clumpedSelected = selectedMessageId != null && clumpedUpdateMessages.some((message) => message.id === selectedMessageId);
    const missionHasTrace = missionArtifacts.length > 0 && segment.trace.length > 0;
    const workTrace = (
      <ChatWorkTrace
        trace={segment.trace}
        selectedMessageId={traceSelected || clumpedSelected ? selectedMessageId : null}
        onCancelRun={onCancelRun}
        onContextMenu={onContextMenu}
        onReply={onReply}
        vaultId={vaultId}
        onHydrateMessage={onHydrateMessage}
        runningMessageState={runningMessageState}
        embedded={missionHasTrace}
      />
    );
    const peek = workTracePeek(segment.trace);
    const unifiedMission = missionArtifacts.length > 0
      ? missionArtifacts.map((message) => (
        <ChatMissionCard
          key={message.id}
          mission={message.mission!}
          vaultId={vaultId}
          channelId={message.channelId}
          traceContent={workTrace}
          tracePeek={peek}
          replyMessage={message}
          onReply={onReply}
          onContextMenu={onContextMenu}
        />
      ))
      : workTrace;
    const nodes: ReactNode[] = [
      <ChatGroupRow
        key={`work-${segment.id}`}
        group={{ messages: [displayCarrier, ...clumpedUpdateMessages] }}
        selectedMessageId={traceSelected ? selectedMessageId : null}
        jumpHighlightMessageId={traceJumpHighlighted ? jumpHighlightMessageId : null}
        avatarKind="agent"
        avatarUrl={getMessageAvatarUrl(displayCarrier)}
        authorLabel={getMessageAuthorLabel(displayCarrier)}
        ownerLabel={getMessageOwnerLabel(displayCarrier)}
        planUsage={getMessagePlanUsage(displayCarrier)}
        latestRunningMessageId={undefined}
        runningSiblingCount={0}
        steeringPromptLabels={steeringPromptLabels}
        mentionableAliases={mentionableAliases}
        notes={notes}
        onOpenNote={onOpenNote}
        onOpenSharedNote={onOpenSharedNote}
        onCancelRun={onCancelRun}
        onToggleSelect={onToggleSelect}
        onContextMenu={onContextMenu}
        onReply={onReply}
        onJumpToMessage={onJumpToMessage}
        loadedMessageIds={loadedMessageIds}
        onLightbox={onLightbox}
        onImageLoad={onImageLoad}
        onAgentAvatarClick={resolveMessageRegistration(displayCarrier) && onAgentAvatarClick
          ? (event) => onAgentAvatarClick(displayCarrier, event)
          : undefined}
        scrollRootRef={messagesRef}
        vaultId={vaultId}
        onHydrateMessage={onHydrateMessage}
        traceContent={unifiedMission}
        traceAfterFirstMessage={clumpedUpdateMessages.length > 0}
        contextMenuMessage={missionArtifacts[0]}
      />,
    ];
    for (const group of segment.fullGroups) {
      const messagesWithoutMissions = group.messages.filter((message) => !message.mission);
      if (messagesWithoutMissions.length) nodes.push(renderGroupRow({ messages: messagesWithoutMissions }));
    }
    for (const group of separateUpdateGroups) nodes.push(renderGroupRow(group));
    return nodes;
  };

  return (
    <>
      <header className="chat-header">
        <div className="chat-header-copy">
          <h2>{channelName}</h2>
          <span>{sortedMessages.length} messages</span>
        </div>
        {vaultId && !directMessage && (
          <button type="button" className="chat-mission-archive-button" title="Mission history" aria-label="Open mission history" onClick={onMissionArchiveOpen}>
            <History size={15} />
            <span>Missions</span>
          </button>
        )}
      </header>
      <div
        ref={messagesRef}
        className="chat-messages"
        role="log"
        aria-label={`${channelName} messages`}
        onTouchStart={(event) => { touchStartYRef.current = event.touches[0]?.clientY ?? null; }}
        onTouchMove={(event) => {
          const startY = touchStartYRef.current;
          const currentY = event.touches[0]?.clientY;
          if (shouldDetachStickyForTouch(startY, currentY)) {
            pendingSendFollowRef.current = false;
            programmaticScrollRef.current = false;
            userScrollIntentUntilRef.current = performance.now() + 500;
          }
        }}
        onTouchEnd={() => { touchStartYRef.current = null; }}
        onWheel={(event) => {
          if (shouldDetachStickyForWheel(event.deltaY)) {
            pendingSendFollowRef.current = false;
            programmaticScrollRef.current = false;
            userScrollIntentUntilRef.current = performance.now() + 180;
          }
        }}
      >
        <div ref={messagesContentRef} className="chat-messages-content">
          {isLoadingMessages && sortedMessages.length === 0 ? (
            <div className="chat-empty" aria-live="polite"><span className="chat-loading-dot" aria-hidden="true" /><strong>Loading messages…</strong></div>
          ) : sortedMessages.length === 0 ? (
            <div className="chat-empty">
              {directMessage ? <MessageCircle size={28} className="chat-empty-icon" /> : <Hash size={28} className="chat-empty-icon" />}
              <strong>{directMessage ? channelName : `#${channelName}`}</strong>
              <span className="chat-empty-hint">{directMessage ? 'No messages yet — say hello.' : 'No messages yet — say hello or @mention an agent to start.'}</span>
            </div>
          ) : transcriptSegments.flatMap(renderSegment)}
          <div ref={endRef} />
        </div>
      </div>
      <ChatComposer
        ref={composerRef}
        channelId={channelId}
        channelName={channelName}
        directMessage={directMessage}
        notes={notes}
        mentionableAliases={mentionableAliases}
        registeredAgents={registeredAgents}
        onSendMessage={onSendMessage}
      />
    </>
  );
}
