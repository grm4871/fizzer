import { useCallback, useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Socket } from 'socket.io-client';
import type { Note, NoteSummary, User, Vault } from '../api';
import type { ChatChannelPresence, ChatAgentRegistration, ChatMessage, VaultAgent } from '../chat/types';
import type { Tab } from '../components/TabBar';
import type { ChatAgentDispatch } from '../chat/dispatch';
import type { ChatState } from '../chat/session';
import * as Layout from '../layout/tree';
import { connectVaultSocket } from '../socket';
import { mergeChatPresence } from '../chat/shared';
import { chatMessageStore } from '../chat/messageStore';
import { applyRemoteChatMessage } from '../chat/runBlocks';

export interface SocketReconciliationOptions {
  activeVaultId: string | null; user: User | null; authEpoch: number; layout: Layout.LayoutNode; openTabs: Tab[];
  activeVaultIdRef: MutableRefObject<string | null>; notesRef: MutableRefObject<NoteSummary[]>; noteContentsRef: MutableRefObject<Record<string, { note: Note; draft: string }>>; chatStateRef: MutableRefObject<ChatState>; vaultSocketRef: MutableRefObject<Socket | null>; joinedChatChannelsRef: MutableRefObject<Set<string>>; closeTabRef: MutableRefObject<(id: string) => void>; socketVaultReloadTimerRef: MutableRefObject<number | null>; pendingChatPatchRef: MutableRefObject<Map<string, ChatMessage>>; chatPatchTimerRef: MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>; streamingChatMessageIdsRef: MutableRefObject<Set<string>>;
  setChatState: Dispatch<SetStateAction<ChatState>>; setChatPresenceByChannel: Dispatch<SetStateAction<Record<string, ChatChannelPresence>>>; setVaultAgents: Dispatch<SetStateAction<VaultAgent[]>>; setVaults: Dispatch<SetStateAction<Vault[]>>; setUser: Dispatch<SetStateAction<User | null>>;
  loadVaultData: (id: string, options?: { soft?: boolean }) => Promise<void>; loadNoteContent: (id: string) => Promise<void>; loadChatAgentMembers: (id: string, notes: NoteSummary[], options?: { channelIds?: string[] }) => Promise<void>; loadChatMessages: (id: string, notes: NoteSummary[], options?: { silent?: boolean; channelIds?: string[] }) => Promise<void>; openChatTabIds: () => string[]; dispatchChatAgentIntents: (channelId: string, message: ChatMessage, registrations: ChatAgentRegistration[], dispatches: ChatAgentDispatch[], history: ChatMessage[]) => Promise<void>; recoverPendingChatAgentDispatches: (id: string) => Promise<void>; scheduleCommunityRefresh: (delay?: number) => void;
}

/** Reconciles vault sockets into the local transcript; socket events never outrank newer local edits. */
export function useSocketReconciliation({
  activeVaultId, user, authEpoch, layout, openTabs, activeVaultIdRef, notesRef,
  noteContentsRef, chatStateRef, vaultSocketRef, joinedChatChannelsRef, closeTabRef,
  socketVaultReloadTimerRef, pendingChatPatchRef, chatPatchTimerRef,
  streamingChatMessageIdsRef, setChatState, setChatPresenceByChannel, setVaultAgents,
  setVaults, setUser, loadVaultData, loadNoteContent, loadChatAgentMembers, loadChatMessages,
  openChatTabIds, dispatchChatAgentIntents, recoverPendingChatAgentDispatches,
  scheduleCommunityRefresh,
}: SocketReconciliationOptions) {
  const visibleChatChannelIds = useMemo(() => {
    const tabIds = Layout.getActiveTabIds(layout);
    return tabIds.filter((tabId) => openTabs.some((tab) => tab.id === tabId && tab.type === 'chat'));
  }, [layout, openTabs]);

  const syncChatPresenceRooms = useCallback((socket: ReturnType<typeof connectVaultSocket>) => {
    const joined = joinedChatChannelsRef.current;
    const visible = new Set(visibleChatChannelIds);
    for (const channelId of [...joined]) {
      if (!visible.has(channelId)) {
        socket.emit('leaveChatChannel', channelId);
        joined.delete(channelId);
      }
    }
    for (const channelId of visibleChatChannelIds) {
      if (!joined.has(channelId)) {
        socket.emit('joinChatChannel', channelId);
        joined.add(channelId);
      }
    }
  }, [visibleChatChannelIds]);

  // ═══════════════════════════════════════════════════════════════
  // SOCKET SETUP
  // ═══════════════════════════════════════════════════════════════

  useEffect(() => {
    if (!activeVaultId) return;
    const socket = connectVaultSocket();
    vaultSocketRef.current = socket;
    const joinActiveVault = () => {
      socket.emit('joinVault', activeVaultId);
      syncChatPresenceRooms(socket);
    };
    const handleConnect = () => {
      joinActiveVault();
      scheduleCommunityRefresh(150);
      // Socket.IO rooms do not replay events emitted while this renderer was
      // disconnected. Reconcile every open transcript after a successful
      // (re)connect so a phone-started run cannot remain phone-only merely
      // because the desktop missed its create/update broadcasts.
      const channelIds = openChatTabIds();
      if (channelIds.length > 0) {
        void Promise.all([
          loadChatMessages(activeVaultId, notesRef.current, {
            silent: true,
            channelIds,
          }),
          loadChatAgentMembers(activeVaultId, notesRef.current, { channelIds }),
        ]).then(() => Promise.all(
          channelIds.map((channelId) => recoverPendingChatAgentDispatches(channelId)),
        ));
      }
    };
    socket.on('connect', handleConnect);
    if (socket.connected) handleConnect();

    // Soft + debounced: note events often arrive in bursts (agent saves, multi-
    // user edits). A hard full reload per event re-stacked cold-start work and
    // stretched "Loading messages…". Soft keeps the open transcript visible.
    const scheduleSoftVaultReload = () => {
      if (socketVaultReloadTimerRef.current != null) return;
      socketVaultReloadTimerRef.current = window.setTimeout(() => {
        socketVaultReloadTimerRef.current = null;
        if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current, { soft: true });
      }, 80);
    };
    const handleNoteChanged = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      scheduleSoftVaultReload();
      // Refresh the body only if the note is open and has no unsaved edits.
      const entry = noteContentsRef.current[data.noteId];
      if (entry && entry.draft === entry.note.content) void loadNoteContent(data.noteId);
    };
    const handleNoteCreated = (data: { vaultId: string }) => {
      if (data.vaultId === activeVaultId) scheduleSoftVaultReload();
    };
    const handleNoteDeleted = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      scheduleSoftVaultReload();
      closeTabRef.current(data.noteId);
    };
    const handleChatMessageCreated = (data: { vaultId: string; channelId: string; message: ChatMessage; dispatches?: ChatAgentDispatch[] }) => {
      if (data.vaultId !== activeVaultId) return;
      chatMessageStore.update(data.channelId, (existing) => (
        existing.some((message) => message.id === data.message.id)
          ? existing
          : [...existing, data.message]
      ));

      const dispatches = data.dispatches ?? [];
      if (dispatches.length > 0) {
        const cached = chatStateRef.current.registeredAgentsByChannel[data.channelId] ?? [];
        const registrations = cached.length > 0 ? cached : dispatches.map((dispatch) => dispatch.registration);
        void dispatchChatAgentIntents(
          data.channelId,
          data.message,
          registrations,
          dispatches,
          chatMessageStore.getChannel(data.channelId),
        );
      }
    };
    const handleChatMessageUpdated = (data: { vaultId: string; channelId: string; message: ChatMessage; dispatches?: ChatAgentDispatch[] }) => {
      if (data.vaultId !== activeVaultId) return;
      chatMessageStore.update(data.channelId, (existing) => applyRemoteChatMessage(existing, data.message));
      const dispatches = data.dispatches ?? [];
      if (dispatches.length > 0) {
        const cached = chatStateRef.current.registeredAgentsByChannel[data.channelId] ?? [];
        const registrations = cached.length > 0 ? cached : dispatches.map((dispatch) => dispatch.registration);
        void dispatchChatAgentIntents(
          data.channelId,
          data.message,
          registrations,
          dispatches,
          chatMessageStore.getChannel(data.channelId),
        );
      }
    };
    const handleChatMessageDeleted = (data: { vaultId: string; channelId: string; messageId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      // A mission can remove a queued synthetic wake while its last streamed
      // renderer patch is still throttled. Cancel that local write so deletion
      // remains authoritative and the client never emits a predictable 404.
      pendingChatPatchRef.current.delete(data.messageId);
      const pendingTimer = chatPatchTimerRef.current.get(data.messageId);
      if (pendingTimer) window.clearTimeout(pendingTimer);
      chatPatchTimerRef.current.delete(data.messageId);
      streamingChatMessageIdsRef.current.delete(data.messageId);
      if (!chatMessageStore.hasChannel(data.channelId)) return;
      chatMessageStore.update(data.channelId, (existing) => {
        const next = existing.filter((message) => message.id !== data.messageId);
        return next.length === existing.length ? existing : next;
      });
    };
    const handleChatAgentMemberUpserted = (data: { vaultId: string; channelId: string; registration: ChatAgentRegistration }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatState((prev) => {
        const existing = prev.registeredAgentsByChannel[data.channelId] ?? [];
        const filtered = existing.filter((item) => item.id !== data.registration.id);
        return {
          ...prev,
          registeredAgentsByChannel: {
            ...prev.registeredAgentsByChannel,
            [data.channelId]: [...filtered, data.registration],
          },
        };
      });
    };
    const handleVaultAgentUpserted = (data: { agent: VaultAgent }) => {
      const agent = data.agent;
      if (!agent || agent.vaultId !== activeVaultId) return;
      setVaultAgents((prev) => {
        const rest = prev.filter((item) => item.id !== agent.id);
        return [...rest, agent].sort((a, b) => (a.displayName || a.mention).localeCompare(b.displayName || b.mention));
      });
      setChatState((prev) => {
        const next = { ...prev.registeredAgentsByChannel };
        for (const [channelId, registrations] of Object.entries(next)) {
          next[channelId] = registrations.map((registration) => (
            registration.vaultAgentId === agent.id
              ? {
                  ...registration,
                  agentId: agent.agentId,
                  displayName: agent.displayName,
                  avatarUrl: agent.avatarUrl,
                  mention: agent.mention,
                  model: agent.model,
                  cwd: agent.cwd,
                  contextPrompt: agent.contextPrompt,
                }
              : registration
          ));
        }
        return { ...prev, registeredAgentsByChannel: next };
      });
    };
    const handleVaultAgentRemoved = (data: { agentId: string }) => {
      if (!data.agentId) return;
      setVaultAgents((prev) => prev.filter((agent) => agent.id !== data.agentId));
      setChatState((prev) => {
        const next: Record<string, ChatAgentRegistration[]> = {};
        for (const [channelId, registrations] of Object.entries(prev.registeredAgentsByChannel)) {
          next[channelId] = registrations.filter((registration) => registration.vaultAgentId !== data.agentId);
        }
        return { ...prev, registeredAgentsByChannel: next };
      });
    };
    const handleChatAgentMemberRemoved = (data: { vaultId: string; channelId: string; registrationId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatState((prev) => ({
        ...prev,
        registeredAgentsByChannel: {
          ...prev.registeredAgentsByChannel,
          [data.channelId]: (prev.registeredAgentsByChannel[data.channelId] ?? []).filter((item) => item.id !== data.registrationId),
        },
      }));
    };
    const handleChatPresence = (data: ChatChannelPresence & { vaultId: string; channelId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatPresenceByChannel((prev) => ({
        ...prev,
        [data.channelId]: mergeChatPresence(prev[data.channelId], data),
      }));
    };
    const handleUserProfileUpdated = (profile: User) => {
      if (profile.id === user?.id) setUser(profile);
      setChatPresenceByChannel((prev) => Object.fromEntries(Object.entries(prev).map(([channelId, presence]) => [
        channelId,
        {
          ...presence,
          profiles: { ...(presence.profiles || {}), [profile.username]: profile },
        },
      ])));
    };

    const handleCommunityChanged = () => scheduleCommunityRefresh();

    // Another member renamed the vault we are in; update the label in place.
    const handleVaultRenamed = (payload: { vaultId: string; name: string }) => {
      if (!payload?.vaultId || !payload.name) return;
      setVaults((current) => current.map((vault) => (
        vault.id === payload.vaultId ? { ...vault, name: payload.name } : vault
      )));
    };

    socket.on('community:changed', handleCommunityChanged);
    socket.on('vault:renamed', handleVaultRenamed);
    socket.on('vault:noteChanged', handleNoteChanged);
    socket.on('vault:noteCreated', handleNoteCreated);
    socket.on('vault:noteDeleted', handleNoteDeleted);
    socket.on('vault:chatMessageCreated', handleChatMessageCreated);
    socket.on('vault:chatMessageUpdated', handleChatMessageUpdated);
    socket.on('vault:chatMessageDeleted', handleChatMessageDeleted);
    socket.on('vault:chatAgentMemberUpserted', handleChatAgentMemberUpserted);
    socket.on('vault:chatAgentMemberRemoved', handleChatAgentMemberRemoved);
    socket.on('vault:vaultAgentUpserted', handleVaultAgentUpserted);
    socket.on('vault:vaultAgentRemoved', handleVaultAgentRemoved);
    socket.on('vault:chatPresence', handleChatPresence);
    socket.on('vault:userProfileUpdated', handleUserProfileUpdated);
    return () => {
      if (socketVaultReloadTimerRef.current != null) {
        window.clearTimeout(socketVaultReloadTimerRef.current);
        socketVaultReloadTimerRef.current = null;
      }
      socket.off('connect', handleConnect);
      for (const channelId of [...joinedChatChannelsRef.current]) {
        socket.emit('leaveChatChannel', channelId);
      }
      joinedChatChannelsRef.current.clear();
      socket.emit('leaveVault', activeVaultId);
      vaultSocketRef.current = null;
      socket.off('community:changed', handleCommunityChanged);
      socket.off('vault:renamed', handleVaultRenamed);
      socket.off('vault:noteChanged', handleNoteChanged);
      socket.off('vault:noteCreated', handleNoteCreated);
      socket.off('vault:noteDeleted', handleNoteDeleted);
      socket.off('vault:chatMessageCreated', handleChatMessageCreated);
      socket.off('vault:chatMessageUpdated', handleChatMessageUpdated);
      socket.off('vault:chatMessageDeleted', handleChatMessageDeleted);
      socket.off('vault:chatAgentMemberUpserted', handleChatAgentMemberUpserted);
      socket.off('vault:chatAgentMemberRemoved', handleChatAgentMemberRemoved);
      socket.off('vault:vaultAgentUpserted', handleVaultAgentUpserted);
      socket.off('vault:vaultAgentRemoved', handleVaultAgentRemoved);
      socket.off('vault:chatPresence', handleChatPresence);
      socket.off('vault:userProfileUpdated', handleUserProfileUpdated);
      socket.disconnect();
    };
  }, [activeVaultId, user?.id, authEpoch, loadVaultData, loadNoteContent, loadChatAgentMembers, loadChatMessages, openChatTabIds, syncChatPresenceRooms, dispatchChatAgentIntents, recoverPendingChatAgentDispatches, scheduleCommunityRefresh]);

  useEffect(() => {
    const socket = vaultSocketRef.current;
    if (!socket?.connected || !activeVaultId) return;
    syncChatPresenceRooms(socket);
    for (const channelId of visibleChatChannelIds) {
      void recoverPendingChatAgentDispatches(channelId);
    }
  }, [activeVaultId, syncChatPresenceRooms, visibleChatChannelIds, recoverPendingChatAgentDispatches]);

  // The dispatch outbox is durable, but a desktop/provider launch can fail
  // after the create event has been delivered (or while this renderer is
  // otherwise perfectly connected). Reconcile visible channels periodically
  // so long-running mission work retries from that durable intent instead of
  // waiting for a renderer reload, tab switch, or socket reconnect.
  useEffect(() => {
    if (!activeVaultId || visibleChatChannelIds.length === 0) return;
    const retryPending = () => {
      for (const channelId of visibleChatChannelIds) {
        void recoverPendingChatAgentDispatches(channelId);
      }
    };
    const timer = window.setInterval(retryPending, 10_000);
    return () => window.clearInterval(timer);
  }, [activeVaultId, visibleChatChannelIds, recoverPendingChatAgentDispatches]);
  return { visibleChatChannelIds, syncChatPresenceRooms };
}
