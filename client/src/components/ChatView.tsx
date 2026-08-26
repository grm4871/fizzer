import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type NoteSummary } from '../api';
import { normalizeMention } from '../chat/mentions';
import { buildReplyRef } from '../chat/replies';
import type {
  ChatAgentOption,
  ChatAgentRegistration,
  ChatChannelPresence,
  ChatMediaAttachment,
  ChatMessage,
  ChatReplyRef,
  DesktopRunnerHealth,
  SharedChatNote,
  VaultAgent,
} from '../chat/types';
import { ChatAgentPanel, type ChatAgentPanelHandle, planUsageProviderId } from './ChatAgentPanel';
import { ChatAvatar } from './ChatAvatar';
import { ChatChannelSettings } from './ChatChannelSettings';
import { ChatSidebarButtons } from './ChatSidebarButtons';
import { ChatOverlays } from './ChatOverlays';
import { ChatTranscript } from './ChatTranscript';
import type { ChatComposerHandle } from './ChatComposer';
import { CHAT_RELATIONSHIP_INSTRUCTIONS, type ChatRelationship } from '../chat/relationships';
import { hasRunActivity } from '../chat/harnessActivity';
import { segmentTranscript } from '../chat/workTrace';
import { useChannelMessages } from '../chat/messageStore';
import { useChatScroll } from './useChatScroll';
import { getRunningMessageState, getSteeringPromptLabels } from './ChatGroupRow';
import { useChatOverlayActions } from './useChatOverlayActions';

export {
  canGroupChatMessages,
  canMergeChatMessages,
  CHAT_NOTE_MARKER,
  createChatAgentRegistrationId,
  dataUrlsToRunImages,
  mediaToRunImages,
  mergeChatPresence,
} from '../chat/shared';
export type {
  ChatAgentOption,
  ChatAgentRegistration,
  ChatBlock,
  ChatChannelPresence,
  ChatForwardRef,
  ChatMediaAttachment,
  ChatMessage,
  ChatMission,
  ChatMissionEvent,
  ChatMissionTask,
  ChatMissionTaskStatus,
  ChatReplyRef,
  DesktopRunnerHealth,
  PlanUsage,
  PlanUsageWindow,
  SharedChatNote,
  VaultAgent,
} from '../chat/types';
export {
  CHAT_MEDIA_LIMIT,
  CHAT_MEDIA_MAX_BYTES,
  isMp4Attachment,
  isVideoMediaType,
  prepareReplyForSend,
} from './ChatComposer';
export { REASONING_EFFORTS, ReasoningEffortSelect } from './ChatAgentPanel';
export { ChatMediaEmbed } from './ChatMarkdown';
export {
  getRunningMessageState,
  getSteeringPromptLabels,
  shouldRenderRunPanel,
} from './ChatGroupRow';
export { buildReplyRef, resolveReplyMention } from '../chat/replies';

interface ChatViewProps {
  channelId: string;
  channelName: string;
  isLoadingMessages?: boolean;
  currentUser: string;
  presence: ChatChannelPresence;
  availableAgents: ChatAgentOption[];
  registeredAgents: ChatAgentRegistration[];
  vaultAgents?: VaultAgent[];
  runnerHealth?: DesktopRunnerHealth | null;
  onRegisterAgent: (channelId: string, registration: ChatAgentRegistration) => void;
  onRemoveAgent: (channelId: string, registrationId: string) => void;
  onUpsertVaultAgent?: (agent: Partial<VaultAgent> & { agentId: string }) => Promise<VaultAgent | void> | VaultAgent | void;
  onDeleteVaultAgent?: (vaultAgentId: string) => Promise<void> | void;
  onDeleteAgentProfile?: (vaultAgentId: string) => Promise<void> | void;
  onAddVaultAgentToChannel?: (channelId: string, vaultAgentId: string) => Promise<void> | void;
  onInviteUser: (channelId: string, username: string) => Promise<void>;
  onRemoveParticipant?: (channelId: string, username: string) => Promise<void>;
  onLeaveChannel?: (channelId: string) => Promise<void>;
  onSendMessage: (channelId: string, body: string, media?: ChatMediaAttachment[], replyTo?: ChatReplyRef) => void;
  /** Create a typed, single-agent handoff linked to an existing chat message. */
  onCollaborateMessage?: (
    channelId: string,
    sourceMessageId: string,
    targetRegistrationId: string,
    relationship: ChatRelationship,
    instruction: string,
  ) => Promise<void>;
  /** Delete a message for everyone (own messages, or any when you host the channel). */
  onDeleteMessage?: (channelId: string, messageId: string) => Promise<void> | void;
  /** Copy a message into another channel. Resolves once the copy is posted. */
  onForwardMessage?: (channelId: string, messageId: string, targetChannelId: string) => Promise<void>;
  onCancelRun: (runId: number) => void;
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (channelId: string, messageId: string, title: string) => Promise<SharedChatNote | null>;
  /** When set, members panel open state is controlled by the app (workspace toolbar). */
  membersOpen?: boolean;
  onMembersOpenChange?: (open: boolean) => void;
  vaultId?: string;
  /** Merge a full message (e.g. harness log) after expand-fetch. */
  onHydrateMessage?: (message: ChatMessage) => void;
  /** When set, scroll to and highlight this message once it's in the list (e.g. from search). */
  jumpToMessageId?: string;
  /** Called after a jump target has been consumed so the parent can clear it. */
  onJumpHandled?: () => void;
  /** Mount the shared vault rail outside the channel content, or suppress the inline copy. */
  sidebarMode?: 'inline' | 'only' | 'hidden';
  /** Present the chat as a person-to-person thread, without channel/workspace chrome. */
  directMessage?: boolean;
}

// Stable fallback: an inline `= []` default would mint a new identity every
// render and defeat the notes-aware memo comparators below.
const EMPTY_NOTES: NoteSummary[] = [];

export {
  shouldSnapToRecentOnSend,
  isPendingAgentRunShell,
  shouldDetachStickyForWheel,
  shouldDetachStickyForTouch,
} from './chatViewHelpers';

export const ChatView = memo(function ChatView({
  channelId,
  channelName,
  isLoadingMessages = false,
  currentUser,
  presence,
  availableAgents,
  registeredAgents,
  vaultAgents = [],
  runnerHealth = null,
  onRegisterAgent,
  onRemoveAgent,
  onUpsertVaultAgent,
  onDeleteVaultAgent,
  onDeleteAgentProfile,
  onAddVaultAgentToChannel,
  onInviteUser,
  onRemoveParticipant,
  onLeaveChannel,
  onSendMessage,
  onCollaborateMessage,
  onDeleteMessage,
  onForwardMessage,
  onCancelRun,
  notes = EMPTY_NOTES,
  onOpenNote,
  onOpenSharedNote,
  membersOpen: membersOpenProp,
  onMembersOpenChange,
  vaultId,
  onHydrateMessage,
  jumpToMessageId,
  onJumpHandled,
  sidebarMode = 'inline',
  directMessage = false,
}: ChatViewProps) {
  // Messages come from an external per-channel store, not props: streaming tokens
  // then re-render only this ChatView, never the App shell. See messageStore.ts.
  const messages = useChannelMessages(channelId);
  const [usersCollapsedLocal, setUsersCollapsedLocal] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('cascade_chat_users_collapsed') === '1'
  );
  // Controlled from App toolbar when provided; otherwise local desktop rail state.
  const usersCollapsed = onMembersOpenChange
    ? !(membersOpenProp ?? false)
    : usersCollapsedLocal;
  const setUsersCollapsed = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(usersCollapsed) : value;
    if (onMembersOpenChange) {
      onMembersOpenChange(!next);
    } else {
      setUsersCollapsedLocal(next);
    }
  }, [onMembersOpenChange, usersCollapsed]);
  const [agentChrome, setAgentChrome] = useState({ inviteOpen: false, agentMenuOpen: false });
  const onAgentChromeChange = useCallback((chrome: { inviteOpen: boolean; agentMenuOpen: boolean }) => {
    setAgentChrome(chrome);
  }, []);
  // Channel-wide working directory: when set, every agent in the channel runs
  // from here (overrides each agent's own cwd, enforced server-side).
  const [channelCwd, setChannelCwd] = useState('');
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);

  useEffect(() => {
    if (!vaultId || !channelId) return;
    let alive = true;
    api<{ settings: { cwd: string; kanbanNoteId?: string } }>(`/api/vaults/${vaultId}/channels/${channelId}/settings`)
      .then((d) => {
        if (!alive) return;
        setChannelCwd(d.settings?.cwd ?? '');
      })
      .catch(() => { /* keep current value */ });
    return () => { alive = false; };
  }, [vaultId, channelId]);

  // `override` lets the workspace panel repoint the channel at a worktree path
  // without waiting for the input's state round-trip.
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [jumpHighlightMessageId, setJumpHighlightMessageId] = useState<string | null>(null);
  const composerRef = useRef<ChatComposerHandle>(null);
  const agentPanelRef = useRef<ChatAgentPanelHandle>(null);
  const {
    contextMenu, contextMenuRef, participantMenu, participantMenuRef, deleteArmed, setDeleteArmed,
    collaborationSource, collaborationTargetId, collaborationRelationship, collaborationInstruction,
    collaborationBusy, collaborationError, forwardSource, forwardQuery, forwardTargets, forwardingTo, forwardError,
    missionArchiveOpen, missionArchive, missionArchiveBusy, missionArchiveError, lightboxSrc, sharedNote, reportMessage,
    setMissionArchiveOpen, setCollaborationTargetId, setCollaborationRelationship, setCollaborationInstruction,
    setCollaborationSource, setForwardSource, setForwardQuery, setLightboxSrc, setSharedNote, setReportMessage,
    loadMissionArchive, openSharedNote, openLightbox, startCollaboration, submitCollaboration, openMessageContextMenu,
    openParticipantContextMenu, startForward, forwardTo, deleteMessage, addToKanban, reportFromContext,
    participantAction, canCollaborate, targetsForCollaboration, closeContextMenu,
  } = useChatOverlayActions({
    channelId,
    vaultId,
    currentUser,
    presence,
    registeredAgents,
    notes,
    channelCwd,
    directMessage,
    onCollaborateMessage,
    onForwardMessage,
    onDeleteMessage,
    onRemoveParticipant,
    onLeaveChannel,
    onOpenSharedNote,
  });
  const sortedMessages = useMemo(() => {
    // Index-stable sort: never invent order for messages missing seq. Treating
    // missing seq as MAX_SAFE_INTEGER put an already-persisted agent shell
    // (has seq) *before* the optimistic user prompt (no seq yet) — classic
    // "response then prompt" flip while idle/network races.
    const indexed = messages.map((message, index) => ({ message, index }));
    return indexed
      .filter(({ message }) => {
        if (message.status === 'running' || message.status === 'sending') return true;
        if (message.status === 'failed' || message.status === 'canceled') return true;
        if (message.body?.trim()) return true;
        if (message.images?.length || message.attachments?.length) return true;
        if (hasRunActivity(message)) return true;
        if (message.agentId || message.registrationId || message.runId != null) return false;
        return true;
      })
      .sort((a, b) => {
        const byTime = new Date(a.message.createdAt).getTime() - new Date(b.message.createdAt).getTime();
        if (byTime !== 0) return byTime;
        const seqA = a.message.seq;
        const seqB = b.message.seq;
        if (typeof seqA === 'number' && typeof seqB === 'number' && seqA !== seqB) {
          return seqA - seqB;
        }
        // Incomplete seq pair: keep append order (user is pushed before agent).
        return a.index - b.index;
      })
      .map(({ message }) => message);
  }, [messages]);
  const {
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
  } = useChatScroll({
    channelId,
    sortedMessages,
    onSendMessage,
    jumpToMessageId,
    onJumpHandled,
    setSelectedMessageId,
    setJumpHighlightMessageId,
  });
  // Grouping identity cache removed: transcript segments are recomputed with
  // message-ref equality via sortedMessages + segmentTranscript.
  // Lazily hydrate messages whose data-URL images the list payload stripped.
  // Track only in-flight work, not "ever hydrated": a reconnect can replace a
  // full message with another slim copy and must be allowed to hydrate it again.
  const hydratingImageIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!vaultId || !onHydrateMessage) return;
    for (const message of sortedMessages) {
      if (!message.hasImages || message.images?.length || hydratingImageIdsRef.current.has(message.id)) continue;
      // A dispatch shell exists before its run is accepted and therefore has no
      // persisted message to hydrate. Waiting for the server-owned replacement
      // avoids a noisy 404 when an offline desktop rejects the dispatch.
      if (message.id.startsWith('agent-dispatch-')) continue;
      hydratingImageIdsRef.current.add(message.id);
      void api<{ message: ChatMessage }>(
        `/api/vaults/${vaultId}/channels/${message.channelId}/messages/${encodeURIComponent(message.id)}`,
      )
        .then((data) => { if (data.message) onHydrateMessage(data.message); })
        .catch(() => {})
        .finally(() => { hydratingImageIdsRef.current.delete(message.id); });
    }
  }, [sortedMessages, vaultId, onHydrateMessage]);

  const runningMessageState = useMemo(() => {
    return getRunningMessageState(sortedMessages);
  }, [sortedMessages]);
  const steeringPromptLabels = useMemo(() => {
    return getSteeringPromptLabels(sortedMessages, registeredAgents, runningMessageState);
  }, [registeredAgents, runningMessageState, sortedMessages]);
  const registeredAgentRows = useMemo(() => registeredAgents.map((registration) => {
    const agent = availableAgents.find((option) => option.id === registration.agentId);
    return agent ? { ...agent, registration } : null;
  }).filter((agent): agent is ChatAgentOption & { registration: ChatAgentRegistration } => Boolean(agent)), [availableAgents, registeredAgents]);
  const agentAuthors = useMemo(() => new Set(
    registeredAgentRows.flatMap((agent) => [agent.label, agent.registration.displayName].filter(Boolean)),
  ), [registeredAgentRows]);
  // Collapse multi-agent chatter into TUI-style work traces between human turns.
  const transcriptSegments = useMemo(
    () => segmentTranscript(sortedMessages, { agentAuthors }),
    [agentAuthors, sortedMessages],
  );
  const registrationById = useMemo(() => {
    const byId = new Map<string, ChatAgentRegistration>();
    const byAgentOrName = new Map<string, ChatAgentRegistration>();
    for (const agent of registeredAgents) {
      byId.set(agent.id, agent);
      if (agent.agentId) byAgentOrName.set(agent.agentId, agent);
      if (agent.displayName) byAgentOrName.set(agent.displayName, agent);
    }
    return { byId, byAgentOrName };
  }, [registeredAgents]);
  const vaultAgentById = useMemo(() => {
    const map = new Map<string, VaultAgent>();
    for (const agent of vaultAgents) map.set(agent.id, agent);
    return map;
  }, [vaultAgents]);
  const canManageRegistration = useCallback((registration: ChatAgentRegistration) => {
    const identity = registration.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    return Boolean(identity && identity.ownerUsername === currentUser);
  }, [currentUser, vaultAgentById]);
  const resolveMessageRegistration = (message: ChatMessage) =>
    message.registrationId
      ? registrationById.byId.get(message.registrationId)
      : registrationById.byAgentOrName.get(message.agentId ?? '') ?? registrationById.byAgentOrName.get(message.author);
  const getMessageAvatarKind = (message: ChatMessage): 'agent' | 'human' =>
    message.agentId || agentAuthors.has(message.author) ? 'agent' : 'human';
  const resolveHumanProfile = (author: string) => {
    const profiles = presence.profiles || {};
    if (profiles[author]) return profiles[author];
    // Profiles are keyed by username; some older rows used display names as author.
    return Object.values(profiles).find((profile) => profile.displayName === author);
  };
  const getMessageAvatarUrl = (message: ChatMessage) => {
    return resolveMessageRegistration(message)?.avatarUrl
      || resolveHumanProfile(message.author)?.avatarUrl
      || '';
  };
  const getMessageAuthorLabel = (message: ChatMessage) =>
    resolveMessageRegistration(message)?.displayName
      || resolveHumanProfile(message.author)?.displayName
      || message.author;
  const getMessageOwnerLabel = (message: ChatMessage) => {
    const registration = resolveMessageRegistration(message);
    const identity = registration?.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    return identity?.ownerUsername || '';
  };
  const getMessagePlanUsage = (message: ChatMessage) => {
    const registration = resolveMessageRegistration(message);
    const identity = registration?.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    // Runner usage is private to the assistant owner's local account. Do not
    // paint the viewer's limits onto another person's agent in a shared chat.
    if (!identity || identity.ownerUsername !== currentUser) return null;
    const agentId = message.agentId || registration?.agentId || '';
    return runnerHealth?.planUsage?.[planUsageProviderId(agentId)] || null;
  };
  const onlineUsers = useMemo(() => new Set(presence.online), [presence.online]);
  const humanMessageAuthors = useMemo(() => {
    const names = new Set<string>();
    for (const message of messages) {
      if (message.author === 'Cascade') continue;
      if (message.agentId || agentAuthors.has(message.author)) continue;
      if (message.author) names.add(message.author);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b)).join('\n');
  }, [agentAuthors, messages]);
  const humanUsers = useMemo(() => {
    const names = new Set<string>(presence.participants);
    if (currentUser) names.add(currentUser);
    for (const name of humanMessageAuthors.split('\n')) {
      if (name) names.add(name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [currentUser, humanMessageAuthors, presence.participants]);
  const mentionableAliases = useMemo(() => {
    const aliases = new Set<string>();
    for (const registration of registeredAgents) {
      const mention = normalizeMention(registration.mention || registration.agentId);
      if (mention) aliases.add(mention);
    }
    for (const name of humanUsers) {
      if (name) aliases.add(name);
    }
    return Array.from(aliases);
  }, [humanUsers, registeredAgents]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    // Only persist local (desktop) preference — mobile toolbar state is App-owned.
    if (!onMembersOpenChange) {
      localStorage.setItem('cascade_chat_users_collapsed', usersCollapsed ? '1' : '0');
    }
    if (usersCollapsed) {
      agentPanelRef.current?.closeChrome();
    }
  }, [usersCollapsed, onMembersOpenChange]);

  const openAgentSettingsFromMessage = useCallback((message: ChatMessage, event: React.MouseEvent) => {
    event.stopPropagation();
    const registration = message.registrationId
      ? registrationById.byId.get(message.registrationId)
      : registrationById.byAgentOrName.get(message.agentId ?? '')
        ?? registrationById.byAgentOrName.get(message.author);
    if (!registration) return;
    if (!canManageRegistration(registration)) return;
    agentPanelRef.current?.openMemberSettings(registration);
  }, [canManageRegistration, registrationById]);

  const startReply = useCallback((message: ChatMessage) => {
    closeContextMenu();
    // Focus after paint so the reply bar is mounted first (esp. mobile keyboard).
    composerRef.current?.startReply(buildReplyRef(message, registeredAgents));
  }, [closeContextMenu, registeredAgents]);
  const toggleMessageSelection = useCallback((id: string) => {
    setSelectedMessageId((current) => (current === id ? null : id));
  }, []);
  const loadedMessageIds = useMemo(
    () => new Set(sortedMessages.map((message) => message.id)),
    [sortedMessages],
  );

  return (
    <section className={`chat-view${sidebarMode === 'only' ? ' is-sidebar-only' : ''}${sidebarMode === 'hidden' ? ' is-sidebar-hidden' : ''}${directMessage ? ' is-direct-message' : ''}`}>
      {sidebarMode !== 'only' && <div className="chat-main">
        <ChatTranscript
          channelId={channelId}
          channelName={channelName}
          directMessage={directMessage}
          isLoadingMessages={isLoadingMessages}
          sortedMessages={sortedMessages}
          transcriptSegments={transcriptSegments}
          messagesRef={messagesRef}
          messagesContentRef={messagesContentRef}
          endRef={endRef}
          touchStartYRef={touchStartYRef}
          pendingSendFollowRef={pendingSendFollowRef}
          programmaticScrollRef={programmaticScrollRef}
          userScrollIntentUntilRef={userScrollIntentUntilRef}
          composerRef={composerRef}
          runningMessageState={runningMessageState}
          selectedMessageId={selectedMessageId}
          jumpHighlightMessageId={jumpHighlightMessageId}
          loadedMessageIds={loadedMessageIds}
          steeringPromptLabels={steeringPromptLabels}
          mentionableAliases={mentionableAliases}
          notes={notes}
          registeredAgents={registeredAgents}
          vaultId={vaultId}
          onOpenNote={onOpenNote}
          onOpenSharedNote={openSharedNote}
          onCancelRun={onCancelRun}
          onToggleSelect={toggleMessageSelection}
          onContextMenu={openMessageContextMenu}
          onReply={startReply}
          onJumpToMessage={runJumpToMessage}
          onLightbox={openLightbox}
          onImageLoad={scrollToBottomIfSticky}
          onHydrateMessage={onHydrateMessage}
          onAgentAvatarClick={openAgentSettingsFromMessage}
          resolveMessageRegistration={resolveMessageRegistration}
          getMessageAvatarKind={getMessageAvatarKind}
          getMessageAvatarUrl={getMessageAvatarUrl}
          getMessageAuthorLabel={getMessageAuthorLabel}
          getMessageOwnerLabel={getMessageOwnerLabel}
          getMessagePlanUsage={getMessagePlanUsage}
          onSendMessage={sendMessage}
          onMissionArchiveOpen={() => {
            setMissionArchiveOpen(true);
            void loadMissionArchive();
          }}
        />
      </div>}
      {sidebarMode !== 'hidden' && <aside className={`chat-users${usersCollapsed ? ' is-collapsed' : ''}`} aria-label="Chat users">
        <ChatSidebarButtons
          collapsed={usersCollapsed}
          inviteSelected={agentChrome.inviteOpen}
          agentSelected={agentChrome.agentMenuOpen}
          settingsSelected={channelSettingsOpen}
          onToggleCollapsed={() => setUsersCollapsed((value) => !value)}
          onInvite={() => agentPanelRef.current?.toggleInvite()}
          onAgent={() => agentPanelRef.current?.openMenu()}
          onSettings={() => {
            setUsersCollapsed(false);
            setChannelSettingsOpen((open) => !open);
          }}
        />
        {!usersCollapsed && channelSettingsOpen && (
          <ChatChannelSettings
            channelId={channelId}
            channelName={channelName}
            vaultId={vaultId}
            notes={notes}
            onOpenNote={onOpenNote}
            onCwdChange={setChannelCwd}
            onClose={() => setChannelSettingsOpen(false)}
          />
        )}
        {!usersCollapsed && (
          <ChatAgentPanel
            ref={agentPanelRef}
            channelId={channelId}
            currentUser={currentUser}
            availableAgents={availableAgents}
            registeredAgents={registeredAgents}
            registeredAgentRows={registeredAgentRows}
            vaultAgents={vaultAgents}
            runnerHealth={runnerHealth}
            onRegisterAgent={onRegisterAgent}
            onRemoveAgent={onRemoveAgent}
            onUpsertVaultAgent={onUpsertVaultAgent}
            onDeleteVaultAgent={onDeleteVaultAgent}
            onDeleteAgentProfile={onDeleteAgentProfile}
            onAddVaultAgentToChannel={onAddVaultAgentToChannel}
            onInviteUser={onInviteUser}
            canManageRegistration={canManageRegistration}
            onExpandRail={() => {
              setUsersCollapsed(false);
              setChannelSettingsOpen(false);
            }}
            onChromeChange={onAgentChromeChange}
          >
            <div className="chat-users-title">People in this vault</div>
            {humanUsers.map((name) => {
              const isSelf = name === currentUser;
              const isOnline = isSelf || onlineUsers.has(name);
              const isOwner = name === presence.owner;
              const roleLabel = isOwner ? 'owner' : isSelf ? 'you' : isOnline ? 'online' : 'offline';
              const participantActionKind = presence.owner === currentUser && !isSelf && onRemoveParticipant
                ? 'remove'
                : isSelf && !isOwner && onLeaveChannel ? 'leave' : null;
              return (
                <div
                  className={`chat-user chat-human${isOnline ? '' : ' is-offline'}${isSelf ? ' is-self' : ''}`}
                  key={name}
                  onContextMenu={participantActionKind
                    ? (event) => openParticipantContextMenu(event, name, participantActionKind)
                    : undefined}
                >
                  <div className="chat-user-row">
                    <ChatAvatar name={presence.profiles?.[name]?.displayName || name} kind="human" avatarUrl={presence.profiles?.[name]?.avatarUrl} size="sm" />
                    <div className="chat-user-copy">
                      <strong>{presence.profiles?.[name]?.displayName || name}</strong>
                      {presence.profiles?.[name]?.displayName && presence.profiles?.[name]?.displayName !== name && <span className="chat-user-handle">@{name}</span>}
                      <span className="chat-user-role">{roleLabel}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </ChatAgentPanel>
        )}
      </aside>}
      <ChatOverlays
        contextMenu={contextMenu}
        contextMenuRef={contextMenuRef}
        participantMenu={participantMenu}
        participantMenuRef={participantMenuRef}
        deleteArmed={deleteArmed}
        setDeleteArmed={setDeleteArmed}
        onReply={startReply}
        onStartCollaboration={startCollaboration}
        onStartForward={startForward}
        onAddToKanban={addToKanban}
        onReport={reportFromContext}
        onDeleteMessage={deleteMessage}
        onParticipantAction={participantAction}
        onCollaborateMessage={onCollaborateMessage}
        canCollaborate={canCollaborate}
        onForwardMessage={onForwardMessage}
        vaultId={vaultId}
        directMessage={directMessage}
        onDeleteMessageAvailable={Boolean(onDeleteMessage)}
        channelName={channelName}
        channelId={channelId}
        missionArchiveOpen={missionArchiveOpen}
        missionArchive={missionArchive}
        missionArchiveBusy={missionArchiveBusy}
        missionArchiveError={missionArchiveError}
        onRefreshMissionArchive={() => void loadMissionArchive()}
        onCloseMissionArchive={() => setMissionArchiveOpen(false)}
        collaborationSource={collaborationSource}
        collaborationTargetId={collaborationTargetId}
        collaborationTargets={collaborationSource ? targetsForCollaboration(collaborationSource) : []}
        collaborationRelationship={collaborationRelationship}
        collaborationInstruction={collaborationInstruction}
        collaborationBusy={collaborationBusy}
        collaborationError={collaborationError}
        onSetCollaborationTarget={setCollaborationTargetId}
        onSetCollaborationRelationship={(value) => {
          setCollaborationRelationship(value);
          setCollaborationInstruction(CHAT_RELATIONSHIP_INSTRUCTIONS[value]);
        }}
        onSetCollaborationInstruction={setCollaborationInstruction}
        onSubmitCollaboration={(event) => void submitCollaboration(event)}
        onCloseCollaboration={() => setCollaborationSource(null)}
        forwardSource={forwardSource}
        forwardQuery={forwardQuery}
        forwardTargets={forwardTargets}
        forwardingTo={forwardingTo}
        forwardError={forwardError}
        onSetForwardQuery={setForwardQuery}
        onForwardTo={(targetChannelId) => void forwardTo(targetChannelId)}
        onCloseForward={() => setForwardSource(null)}
        lightboxSrc={lightboxSrc}
        onCloseLightbox={() => setLightboxSrc(null)}
        sharedNote={sharedNote}
        onCloseSharedNote={() => setSharedNote(null)}
        reportMessage={reportMessage}
        onCloseReport={() => setReportMessage(null)}
      />
    </section>
  );
});
