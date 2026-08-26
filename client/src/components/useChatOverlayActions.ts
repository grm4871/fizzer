/**
 * State and async actions for ChatView menus/dialogs. Keeping these together
 * preserves the invariant that changing channels closes transient UI and that
 * failed collaboration/forward requests remain visible in their dialog.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NoteSummary } from '../api';
import { api } from '../api';
import { createChannelWorkItem } from '../chat/workItems';
import type { ChatAgentRegistration, ChatChannelPresence, ChatMessage, ChatMission, SharedChatNote } from '../chat/types';
import type { ChatRelationship } from '../chat/relationships';
import { CHAT_NOTE_MARKER } from '../chat/shared';
import { CHAT_RELATIONSHIP_INSTRUCTIONS } from '../chat/relationships';
import { usePopupMenu } from '../ui/popupMenu';

type Options = {
  channelId: string;
  vaultId?: string;
  currentUser: string;
  presence: ChatChannelPresence;
  registeredAgents: ChatAgentRegistration[];
  notes: NoteSummary[];
  channelCwd: string;
  directMessage: boolean;
  onCollaborateMessage?: (channelId: string, messageId: string, targetId: string, relationship: ChatRelationship, instruction: string) => Promise<void>;
  onForwardMessage?: (channelId: string, messageId: string, targetChannelId: string) => Promise<void>;
  onDeleteMessage?: (channelId: string, messageId: string) => Promise<void> | void;
  onRemoveParticipant?: (channelId: string, username: string) => Promise<void>;
  onLeaveChannel?: (channelId: string) => Promise<void>;
  onOpenSharedNote?: (channelId: string, messageId: string, title: string) => Promise<SharedChatNote | null>;
};

export function useChatOverlayActions({
  channelId, vaultId, currentUser, presence, registeredAgents, notes, channelCwd, directMessage,
  onCollaborateMessage, onForwardMessage, onDeleteMessage, onRemoveParticipant, onLeaveChannel, onOpenSharedNote,
}: Options) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; message: ChatMessage } | null>(null);
  const [participantMenu, setParticipantMenu] = useState<{ x: number; y: number; username: string; action: 'remove' | 'leave' } | null>(null);
  const contextMenuRef = usePopupMenu<HTMLDivElement>(contextMenu);
  const participantMenuRef = usePopupMenu<HTMLDivElement>(participantMenu);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [sharedNote, setSharedNote] = useState<SharedChatNote | null>(null);
  const [reportMessage, setReportMessage] = useState<ChatMessage | null>(null);
  const [collaborationSource, setCollaborationSource] = useState<ChatMessage | null>(null);
  const [collaborationTargetId, setCollaborationTargetId] = useState('');
  const [collaborationRelationship, setCollaborationRelationship] = useState<ChatRelationship>('review_request');
  const [collaborationInstruction, setCollaborationInstruction] = useState(CHAT_RELATIONSHIP_INSTRUCTIONS.review_request);
  const [collaborationBusy, setCollaborationBusy] = useState(false);
  const [collaborationError, setCollaborationError] = useState('');
  const [forwardSource, setForwardSource] = useState<ChatMessage | null>(null);
  const [forwardQuery, setForwardQuery] = useState('');
  const [forwardError, setForwardError] = useState('');
  const [forwardingTo, setForwardingTo] = useState<string | null>(null);
  const [missionArchiveOpen, setMissionArchiveOpen] = useState(false);
  const [missionArchive, setMissionArchive] = useState<ChatMission[]>([]);
  const [missionArchiveBusy, setMissionArchiveBusy] = useState(false);
  const [missionArchiveError, setMissionArchiveError] = useState('');

  const collaborationTargets = useMemo(() => {
    const profile = Object.values(presence.profiles || {}).find((item) => item.username.toLowerCase() === currentUser.toLowerCase());
    const currentUserId = profile?.id;
    const seen = new Set<string>();
    return registeredAgents.filter((registration) => {
      if (currentUserId != null && registration.ownerUserId != null && registration.ownerUserId !== currentUserId && !registration.pingableByOthers) return false;
      const key = registration.vaultAgentId || registration.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [currentUser, presence.profiles, registeredAgents]);
  const targetsForCollaboration = useCallback((message: ChatMessage) => collaborationTargets.filter((registration) => (
    registration.id !== message.registrationId
    && (!message.registrationId || registration.vaultAgentId !== registeredAgents.find((item) => item.id === message.registrationId)?.vaultAgentId)
  )), [collaborationTargets, registeredAgents]);
  const canCollaborate = useCallback((message: ChatMessage) => Boolean(
    onCollaborateMessage && (message.agentId || message.registrationId) && targetsForCollaboration(message).length > 0,
  ), [onCollaborateMessage, targetsForCollaboration]);

  const loadMissionArchive = useCallback(async () => {
    if (!vaultId) return;
    setMissionArchiveBusy(true);
    setMissionArchiveError('');
    try {
      const result = await api<{ missions?: ChatMission[] }>(`/api/vaults/${vaultId}/channels/${channelId}/missions`);
      setMissionArchive(result.missions || []);
    } catch (error) {
      setMissionArchiveError(error instanceof Error ? error.message : 'Could not load missions');
    } finally {
      setMissionArchiveBusy(false);
    }
  }, [channelId, vaultId]);
  useEffect(() => {
    setContextMenu(null);
    setParticipantMenu(null);
    setMissionArchiveOpen(false);
    setMissionArchive([]);
    setMissionArchiveError('');
    setCollaborationSource(null);
    setCollaborationError('');
  }, [channelId]);
  useEffect(() => {
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    if (!contextMenu) return;
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);
  useEffect(() => {
    const close = () => setParticipantMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    if (!participantMenu) return;
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [participantMenu]);
  useEffect(() => {
    if (!lightboxSrc) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [lightboxSrc]);

  const openSharedNote = useCallback(async (messageId: string, title: string) => {
    const note = await onOpenSharedNote?.(channelId, messageId, title);
    if (note) setSharedNote(note);
  }, [channelId, onOpenSharedNote]);
  const startCollaboration = useCallback((message: ChatMessage) => {
    const targets = targetsForCollaboration(message);
    if (!onCollaborateMessage || targets.length === 0) return;
    setContextMenu(null);
    setCollaborationSource(message);
    setCollaborationTargetId(targets[0].id);
    setCollaborationRelationship('review_request');
    setCollaborationInstruction(CHAT_RELATIONSHIP_INSTRUCTIONS.review_request);
    setCollaborationError('');
  }, [onCollaborateMessage, targetsForCollaboration]);
  const submitCollaboration = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!collaborationSource || !collaborationTargetId || !collaborationInstruction.trim() || !onCollaborateMessage) return;
    setCollaborationBusy(true);
    setCollaborationError('');
    try {
      await onCollaborateMessage(channelId, collaborationSource.id, collaborationTargetId, collaborationRelationship, collaborationInstruction.trim());
      setCollaborationSource(null);
    } catch (error) {
      setCollaborationError(error instanceof Error ? error.message : 'Could not ask agent');
    } finally {
      setCollaborationBusy(false);
    }
  }, [channelId, collaborationInstruction, collaborationRelationship, collaborationSource, collaborationTargetId, onCollaborateMessage]);
  const openMessageContextMenu = useCallback((event: React.MouseEvent, message: ChatMessage) => {
    event.preventDefault();
    event.stopPropagation();
    setDeleteArmed(false);
    setContextMenu({ x: event.clientX, y: event.clientY, message });
  }, []);
  const openParticipantContextMenu = useCallback((event: React.MouseEvent, username: string, action: 'remove' | 'leave') => {
    event.preventDefault();
    event.stopPropagation();
    setParticipantMenu({ x: event.clientX, y: event.clientY, username, action });
  }, []);
  const startForward = useCallback((message: ChatMessage) => {
    setContextMenu(null);
    setForwardQuery('');
    setForwardError('');
    setForwardSource(message);
  }, []);
  const openLightbox = useCallback((src: string) => setLightboxSrc(src), []);
  const forwardTargets = useMemo(() => {
    const query = forwardQuery.trim().toLowerCase();
    return notes.filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
      .filter((note) => note.id !== channelId)
      .filter((note) => !query || note.title.toLowerCase().includes(query)).slice(0, 50);
  }, [channelId, forwardQuery, notes]);
  const forwardTo = useCallback(async (targetChannelId: string) => {
    if (!forwardSource || !onForwardMessage) return;
    setForwardingTo(targetChannelId);
    setForwardError('');
    try {
      await onForwardMessage(forwardSource.channelId || channelId, forwardSource.id, targetChannelId);
      setForwardSource(null);
    } catch (error) {
      setForwardError(error instanceof Error ? error.message : 'Could not forward message');
    } finally {
      setForwardingTo(null);
    }
  }, [channelId, forwardSource, onForwardMessage]);
  const deleteMessage = useCallback((message: ChatMessage) => {
    setContextMenu(null);
    setDeleteArmed(false);
    void onDeleteMessage?.(message.channelId || channelId, message.id);
  }, [channelId, onDeleteMessage]);
  const addToKanban = useCallback((message: ChatMessage) => {
    setContextMenu(null);
    if (!vaultId || directMessage) return;
    void createChannelWorkItem(vaultId, {
      title: (message.body || 'Work item').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Work item',
      brief: message.body || '', channelId, sourceKind: 'message', sourceId: message.id,
      repository: channelCwd || '', workspaceMode: channelCwd ? 'isolated' : 'shared',
    }).catch(() => { /* settings panel shows work items on next open */ });
  }, [channelCwd, channelId, directMessage, vaultId]);
  const participantAction = useCallback((menu: { username: string; action: 'remove' | 'leave' }) => {
    setParticipantMenu(null);
    if (menu.action === 'remove') void onRemoveParticipant?.(channelId, menu.username);
    else void onLeaveChannel?.(channelId);
  }, [channelId, onLeaveChannel, onRemoveParticipant]);

  return {
    contextMenu, contextMenuRef, participantMenu, participantMenuRef, deleteArmed, setDeleteArmed,
    collaborationSource, collaborationTargetId, collaborationTargets, collaborationRelationship, collaborationInstruction,
    collaborationBusy, collaborationError, forwardSource, forwardQuery, forwardTargets, forwardingTo, forwardError,
    missionArchiveOpen, missionArchive, missionArchiveBusy, missionArchiveError, lightboxSrc, sharedNote, reportMessage,
    setMissionArchiveOpen, setCollaborationTargetId, setCollaborationRelationship, setCollaborationInstruction,
    setCollaborationSource, setForwardQuery, setForwardSource, setLightboxSrc, setSharedNote, setReportMessage,
    setMissionArchive, loadMissionArchive, openSharedNote, openLightbox, startCollaboration, submitCollaboration,
    openMessageContextMenu, openParticipantContextMenu, startForward, forwardTo, deleteMessage, addToKanban,
    reportFromContext: (message: ChatMessage) => { setReportMessage(message); setContextMenu(null); },
    participantAction, canCollaborate, targetsForCollaboration, closeContextMenu: () => setContextMenu(null),
  };
}
