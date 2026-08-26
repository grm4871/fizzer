import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Folder, NoteSummary, User } from '../api';
import type { ChatAgentRegistration, ChatChannelPresence, ChatMessage, SharedChatNote, VaultAgent } from '../chat/types';
import type { ChatState } from '../chat/session';
import type { Tab } from '../components/TabBar';
import { api } from '../api';
import { ensureDesktopRunnerHost } from '../desktopRunnerHost';
import { CHAT_NOTE_MARKER } from '../chat/shared';
import { agentsAfterLoadFailure } from '../chat/agents';
import { chatMessageStore } from '../chat/messageStore';
import { captureChatMessageSnapshotBaseline, reconcileChatMessageSnapshot, type ChatMessageSnapshotBaseline } from '../chat/runBlocks';
import { connectRunsSocket } from '../socket';

const vaultLoads = new Map<string, Promise<void>>();
const messageLoads = new Map<string, Promise<{ channelId: string; messages: ChatMessage[]; baseline: ChatMessageSnapshotBaseline }>>();

export interface ChatHydrationOptions {
  user: User | null; activeVaultId: string | null; vaultSidebarChannel?: string; openTabsRef: MutableRefObject<Tab[]>; focusedPaneRef: MutableRefObject<{ activeTabId: string | null }>; activeVaultIdRef: MutableRefObject<string | null>; notesRef: MutableRefObject<NoteSummary[]>; chatStateRef: MutableRefObject<ChatState>; runSocketsRef: MutableRefObject<Map<number, ReturnType<typeof connectRunsSocket>>>; vaultSocketRef: MutableRefObject<{ connected: boolean; connect: () => void } | null>;
  setFolders: Dispatch<SetStateAction<Folder[]>>; setNotes: Dispatch<SetStateAction<NoteSummary[]>>; setVaultAgents: Dispatch<SetStateAction<VaultAgent[]>>; setChatState: Dispatch<SetStateAction<ChatState>>; setChatPresenceByChannel: Dispatch<SetStateAction<Record<string, ChatChannelPresence>>>; setLoadingChatChannels: Dispatch<SetStateAction<Record<string, boolean>>>; setNotice: Dispatch<SetStateAction<string | null>>;
  readLegacyLocalChatAgentMembers: () => Record<string, ChatAgentRegistration[]>; readLegacyLocalChatMessages: () => Record<string, ChatMessage[]>;
}

/** Hydrates transcripts progressively: focused chat first, then agents/presence and background tabs. */
export function useChatHydration({ user, activeVaultId, vaultSidebarChannel, openTabsRef, focusedPaneRef, activeVaultIdRef, notesRef, chatStateRef, runSocketsRef, vaultSocketRef, setFolders, setNotes, setVaultAgents, setChatState, setChatPresenceByChannel, setLoadingChatChannels, setNotice, readLegacyLocalChatAgentMembers, readLegacyLocalChatMessages }: ChatHydrationOptions) {
  const loadVaultDataInflight = vaultLoads;
  const loadChatMessagesInflight = messageLoads;
  /** Chat channels currently open as tabs (not every chat note in the vault). */
  const openChatTabIds = useCallback((): string[] => {
    return openTabsRef.current.filter((tab) => tab.type === 'chat').map((tab) => tab.id);
  }, []);

  /**
   * Resolve which chat channels a load call should touch: an explicit
   * `channelIds` list when given, otherwise only the open chat tabs that are
   * actually chat notes — never every channel note in the vault.
   */
  const resolveChatChannelIds = useCallback((
    noteList: NoteSummary[],
    channelIds?: string[],
  ): string[] => {
    if (channelIds?.length) return channelIds;
    const chatNoteIds = new Set(
      noteList
        .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
        .map((note) => note.id),
    );
    return openChatTabIds().filter((id) => chatNoteIds.has(id));
  }, [openChatTabIds]);

  const loadChatAgentMembers = useCallback(async (
    vaultId: string,
    noteList: NoteSummary[],
    opts?: { channelIds?: string[] },
  ) => {
    // Always include every chat note in the vault — not just open tabs.
    // Per-channel membership is the sticky source of "different agent counts";
    // the server projects the vault-wide roster on each GET, so we must hit
    // every channel or unopened rooms stay stale.
    const allChatIds = noteList
      .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
      .map((note) => note.id);
    const finalIds = [...new Set([
      ...resolveChatChannelIds(noteList, opts?.channelIds),
      ...allChatIds,
    ])];
    if (finalIds.length === 0) return;

    const legacyAgents = readLegacyLocalChatAgentMembers();
    const results = await Promise.all(finalIds.map(async (channelId) => {
      try {
        const data = await api<{ agents: ChatAgentRegistration[] }>(`/api/vaults/${vaultId}/channels/${channelId}/agents`);
        let agents = data.agents ?? [];
        const local = legacyAgents[channelId] ?? [];
        if (agents.length === 0 && local.length > 0) {
          for (const registration of local) {
            try {
              await api(`/api/vaults/${vaultId}/channels/${channelId}/agents`, {
                method: 'PUT',
                body: JSON.stringify(registration),
              });
            } catch {
              // Best-effort migration from pre-network agent member storage.
            }
          }
          const refreshed = await api<{ agents: ChatAgentRegistration[] }>(`/api/vaults/${vaultId}/channels/${channelId}/agents`);
          agents = refreshed.agents ?? [];
        }
        return { channelId, agents };
      } catch {
        // A transient deploy/socket gap must not erase registrations that were
        // already loaded. Reply refs can still display an author-derived @name
        // without this list, but routing then finds no agent and silently posts
        // a reply with no run.
        return {
          channelId,
          agents: agentsAfterLoadFailure(
            chatStateRef.current.registeredAgentsByChannel[channelId],
            legacyAgents[channelId],
          ),
        };
      }
    }));

    setChatState((prev) => {
      const registeredAgentsByChannel = { ...prev.registeredAgentsByChannel };
      for (const { channelId, agents } of results) {
        registeredAgentsByChannel[channelId] = agents;
      }
      return { ...prev, registeredAgentsByChannel };
    });
  }, [resolveChatChannelIds]);

  const loadChatPresence = useCallback(async (
    vaultId: string,
    noteList: NoteSummary[],
    opts?: { channelIds?: string[] },
  ) => {
    const finalIds = resolveChatChannelIds(noteList, opts?.channelIds);
    if (finalIds.length === 0) return;

    const results = await Promise.all(finalIds.map(async (channelId) => {
      try {
        const data = await api<ChatChannelPresence>(`/api/vaults/${vaultId}/channels/${channelId}/presence`);
        return { channelId, participants: data.participants ?? [], online: data.online ?? [], owner: data.owner ?? '', profiles: data.profiles ?? {} };
      } catch {
        return { channelId, participants: [], online: [], owner: '', profiles: {} };
      }
    }));

    setChatPresenceByChannel((prev) => {
      const next = { ...prev };
      for (const { channelId, participants, online, owner, profiles } of results) {
        next[channelId] = { participants, online, owner, profiles };
      }
      return next;
    });
  }, [resolveChatChannelIds]);

  const loadChatMessages = useCallback(async (
    vaultId: string,
    noteList: NoteSummary[],
    opts?: { silent?: boolean; channelIds?: string[] },
  ) => {
    const channelIds = resolveChatChannelIds(noteList, opts?.channelIds);
    if (channelIds.length === 0) return;

    const legacyMessages = readLegacyLocalChatMessages();
    const silent = opts?.silent === true;
    // Only show "Loading…" for channels with no cached transcript. Silent
    // refreshes (app resume / focus) must never blank the open channel.
    if (!silent) {
      setLoadingChatChannels((prev) => {
        const next = { ...prev };
        for (const id of channelIds) {
          const cached = chatMessageStore.getChannel(id);
          if (cached.length === 0) next[id] = true;
        }
        return next;
      });
    }
    const loadChannels = async (ids: string[]) => {
      // Apply each channel as it lands so the focused tab can leave
      // "Loading messages…" without waiting on other open chat tabs.
      await Promise.all(ids.map(async (channelId) => {
        const inflightKey = `${vaultId}:${channelId}`;
        let fetchOne = loadChatMessagesInflight.get(inflightKey);
        if (!fetchOne) {
          fetchOne = (async (): Promise<{
            channelId: string;
            messages: ChatMessage[];
            baseline: ChatMessageSnapshotBaseline;
          }> => {
            const baseline = captureChatMessageSnapshotBaseline(chatMessageStore.getChannel(channelId));
            try {
              // Slim list payload (no harness logs) — mobile cold load stays small.
              const data = await api<{ messages: ChatMessage[] }>(
                `/api/vaults/${vaultId}/channels/${channelId}/messages?detail=list&limit=120`,
              );
              let messages = data.messages ?? [];
              const local = legacyMessages[channelId] ?? [];
              if (messages.length === 0 && local.length > 0) {
                for (const message of local) {
                  try {
                    await api(`/api/vaults/${vaultId}/channels/${channelId}/messages`, {
                      method: 'POST', body: JSON.stringify(message),
                    });
                  } catch { /* Best-effort legacy migration. */ }
                }
                const refreshed = await api<{ messages: ChatMessage[] }>(
                  `/api/vaults/${vaultId}/channels/${channelId}/messages?detail=list&limit=120`,
                );
                messages = refreshed.messages ?? [];
              }
              return { channelId, messages, baseline };
            } catch {
              // Keep whatever we already have on soft failure (resume offline).
              const cached = chatMessageStore.hasChannel(channelId)
                ? chatMessageStore.getChannel(channelId)
                : undefined;
              return { channelId, messages: cached ?? legacyMessages[channelId] ?? [], baseline };
            } finally {
              loadChatMessagesInflight.delete(inflightKey);
            }
          })();
          loadChatMessagesInflight.set(inflightKey, fetchOne);
        }

        const { messages, baseline } = await fetchOne;
        chatMessageStore.update(channelId, (existing) => {
          if (existing === messages) return existing;
          // Reconnect reconciliation intentionally fetches the slim transcript,
          // where data-URL images are represented only by `hasImages`. Merge it
          // over the live cache so a refresh cannot erase hydrated media or a
          // human/agent row that arrived after this request began.
          return reconcileChatMessageSnapshot(existing, messages, baseline);
        });
        setLoadingChatChannels((prev) => {
          if (!prev[channelId]) return prev;
          const next = { ...prev };
          delete next[channelId];
          return next;
        });
      }));
    };

    // Focused channel first so progressive apply paints the visible tab ASAP.
    const focusedId = focusedPaneRef.current.activeTabId;
    const ordered = focusedId && channelIds.includes(focusedId)
      ? [focusedId, ...channelIds.filter((id) => id !== focusedId)]
      : channelIds;
    await loadChannels(ordered);
  }, [resolveChatChannelIds]);

  const persistChatAgentMemberToServer = useCallback(async (vaultId: string, channelId: string, registration: ChatAgentRegistration) => {
    try {
      const data = await api<{ registration: ChatAgentRegistration }>(`/api/vaults/${vaultId}/channels/${channelId}/agents`, {
        method: 'PUT',
        body: JSON.stringify(registration),
      });
      return data.registration;
    } catch (error) {
      console.error('Failed to persist chat agent member:', error);
      setNotice(error instanceof Error ? error.message : 'Could not save agent member');
      return null;
    }
  }, []);

  const removeChatAgentMemberOnServer = useCallback(async (vaultId: string, channelId: string, registrationId: string) => {
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/agents/${registrationId}`, {
        method: 'DELETE',
      });
    } catch (error) {
      console.error('Failed to remove chat agent member:', error);
      setNotice(error instanceof Error ? error.message : 'Could not remove agent member');
    }
  }, []);

  const loadVaultAgents = useCallback(async (vaultId: string) => {
    try {
      const data = await api<{ agents: VaultAgent[] }>(`/api/vaults/${vaultId}/vault-agents`);
      if (activeVaultIdRef.current === vaultId) setVaultAgents(data.agents ?? []);
    } catch {
      if (activeVaultIdRef.current === vaultId) setVaultAgents([]);
    }
  }, []);

  const loadVaultData = useCallback(async (vaultId: string, opts?: { soft?: boolean }) => {
    const soft = opts?.soft === true;
    // Soft can ride a hard load already in flight (hard is a superset). Hard
    // only joins another hard — a soft in flight may have skipped loading UI.
    const hardKey = `${vaultId}:hard`;
    const softKey = `${vaultId}:soft`;
    const hardInflight = loadVaultDataInflight.get(hardKey);
    if (hardInflight) return hardInflight;
    if (soft) {
      const softInflight = loadVaultDataInflight.get(softKey);
      if (softInflight) return softInflight;
    }
    const inflightKey = soft ? softKey : hardKey;

    const run = (async () => {
      try {
        // Prefer the focused chat tab first so cold start paints useful
        // transcript ASAP; other open tabs hydrate after the shell settles.
        const openChats = openChatTabIds();
        const focusedChatId = openTabsRef.current.find((t) => t.type === 'chat' && t.id === focusedPaneRef.current.activeTabId)?.id
          ?? openChats[0];
        const primaryChats = focusedChatId ? [focusedChatId] : [];
        const secondaryChats = openChats.filter((id) => id !== focusedChatId);
        const silent = soft;

        const foldersP = api<{ folders: Folder[] }>(`/api/vaults/${vaultId}/folders`);
        const notesP = api<{ notes: NoteSummary[] }>(`/api/vaults/${vaultId}/notes`);
        // Primary chat + vault agents must not gate notes-tree paint.
        const primaryChatP = primaryChats.length > 0
          ? Promise.all([
              loadChatMessages(vaultId, [], { silent, channelIds: primaryChats }),
              loadChatAgentMembers(vaultId, [], { channelIds: primaryChats }),
              loadChatPresence(vaultId, [], { channelIds: primaryChats }),
            ])
          : Promise.resolve();
        const vaultAgentsP = loadVaultAgents(vaultId);

        const [folderData, noteData] = await Promise.all([foldersP, notesP]);
        // A slower response from the vault we just left must never repaint the
        // newly-selected vault's tree.
        if (activeVaultIdRef.current !== vaultId) return;
        const nextNotes = noteData.notes || [];
        notesRef.current = nextNotes;
        setFolders(folderData.folders || []);
        setNotes(nextNotes);
        void primaryChatP.catch(() => undefined);
        void vaultAgentsP.catch(() => undefined);
        if (secondaryChats.length > 0) {
          // Defer background tabs one frame so the active channel can paint.
          window.setTimeout(() => {
            if (activeVaultIdRef.current !== vaultId) return;
            void loadChatMessages(vaultId, nextNotes, { silent: true, channelIds: secondaryChats }).catch(() => undefined);
            void loadChatAgentMembers(vaultId, nextNotes, { channelIds: secondaryChats }).catch(() => undefined);
            void loadChatPresence(vaultId, nextNotes, { channelIds: secondaryChats }).catch(() => undefined);
          }, 0);
        }
      } catch (error) {
        console.error('Error loading vault data:', error);
      } finally {
        loadVaultDataInflight.delete(inflightKey);
      }
    })();

    loadVaultDataInflight.set(inflightKey, run);
    return run;
  }, [loadChatMessages, loadChatAgentMembers, loadChatPresence, loadVaultAgents, openChatTabIds]);

  /** Hydrate one chat channel when the user focuses its tab (skip if cached). */
  const ensureChatChannelLoaded = useCallback((channelId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    const notesList = notesRef.current;
    // Restored chat tabs are typed in session before notes hydrate — don't wait
    // for the notes list to admit this is a channel.
    const isOpenChatTab = openTabsRef.current.some((t) => t.id === channelId && t.type === 'chat');
    const isChatNote = notesList.some(
      (n) => n.id === channelId && n.content_preview.trim().startsWith(CHAT_NOTE_MARKER),
    );
    if (!isOpenChatTab && !isChatNote) return;

    // Cold-start vault load already hydrates every open chat tab. Joining that
    // work (via message inflight) is fine, but skip kicking a parallel
    // agents/presence wave that only races the same endpoints.
    if (
      isOpenChatTab
      && (loadVaultDataInflight.has(`${vaultId}:hard`) || loadVaultDataInflight.has(`${vaultId}:soft`))
    ) {
      return;
    }

    // Key presence (not length): empty channels are a valid cached result.
    // length===0 used to re-fetch on every notes/focus tick.
    const messagesCached = chatMessageStore.hasChannel(channelId);
    const agentsCached = Object.prototype.hasOwnProperty.call(
      chatStateRef.current.registeredAgentsByChannel,
      channelId,
    );
    // Messages already fetching for this channel (e.g. vault load) — don't
    // start a second agents/presence pass; vault load covers those too.
    if (!messagesCached && loadChatMessagesInflight.has(`${vaultId}:${channelId}`)) {
      return;
    }
    if (messagesCached && agentsCached) return;

    const ids = [channelId];
    if (!messagesCached) {
      void loadChatMessages(vaultId, notesList, { channelIds: ids });
    }
    if (!agentsCached) {
      void loadChatAgentMembers(vaultId, notesList, { channelIds: ids });
    }
    void loadChatPresence(vaultId, notesList, { channelIds: ids });
  }, [loadChatMessages, loadChatAgentMembers, loadChatPresence]);

  // Hydrate the active chat channel whenever it's the focused tab and its
  // messages aren't loaded. Chat transcripts aren't persisted to localStorage
  // (mobile perf), so a backgrounded webview that reloads on resume — or any
  // cold load with a chat tab already restored from the layout — comes back
  // with no messages and never calls openChatChannel. Without this, the empty
  // "#channel" placeholder shows until the user interacts. ensureChatChannelLoaded
  // is idempotent (skips when already cached) and flags the channel as loading,
  // so ChatView shows "Loading messages…" instead of the empty state.
  useEffect(() => {
    if (!user || !activeVaultId) return;
    if (vaultSidebarChannel) ensureChatChannelLoaded(vaultSidebarChannel);
  }, [user, activeVaultId, vaultSidebarChannel, ensureChatChannelLoaded]);

  /** Merge full message detail (harness log) after expand-fetch. */
  const handleOpenSharedChatNote = useCallback(async (
    channelId: string,
    messageId: string,
    title: string,
  ): Promise<SharedChatNote | null> => {
    try {
      const data = await api<{ notes: SharedChatNote[] }>(
        `/api/vaults/${activeVaultIdRef.current || 'none'}/channels/${channelId}/messages/${messageId}/embeds`,
      );
      return data.notes.find((note) => note.title.toLowerCase() === title.trim().toLowerCase()) ?? null;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open shared note');
      return null;
    }
  }, []);

  // Normal resume: do NOT soft-reload the vault on every window focus (that was
  // thrashing network + React on alt-tab). Page Visibility only, and a soft
  // fetch only after a real background stretch or when data is missing.
  useEffect(() => {
    if (!user) return;

    /** How long away before a soft vault refresh is worth it. */
    const STALE_AFTER_MS = 60_000;
    let hiddenAt: number | null =
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
        ? Date.now()
        : null;
    let lastSoftRefreshAt = 0;
    let resumeTimer: number | null = null;

    const reconnectSocketsIfNeeded = () => {
      // Never clearRunnerToken here — resume must not tear down /runners mid-agent.
      ensureDesktopRunnerHost();

      const vaultId = activeVaultIdRef.current;
      const vaultSocket = vaultSocketRef.current;
      if (vaultSocket && vaultId && !vaultSocket.connected) {
        vaultSocket.connect();
      }
      for (const [, socket] of runSocketsRef.current) {
        if (!socket.connected) socket.connect();
      }
    };

    const hydrateActiveChatIfEmpty = () => {
      // Chat transcripts aren't in localStorage; a cold/backgrounded resume can
      // restore the tab with an empty channel. ensureChatChannelLoaded is a
      // no-op when messages+agents are already cached.
      const activeId = focusedPaneRef.current.activeTabId;
      if (activeId && openTabsRef.current.some((t) => t.id === activeId && t.type === 'chat')) {
        ensureChatChannelLoaded(activeId);
      }
    };

    const softRefreshIfStale = (awayMs: number) => {
      const vaultId = activeVaultIdRef.current;
      if (!vaultId) return;
      const now = Date.now();
      if (awayMs < STALE_AFTER_MS && now - lastSoftRefreshAt < STALE_AFTER_MS) return;
      lastSoftRefreshAt = now;
      void loadVaultData(vaultId, { soft: true });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      // visible
      const awayMs = hiddenAt != null ? Date.now() - hiddenAt : 0;
      hiddenAt = null;
      reconnectSocketsIfNeeded();
      hydrateActiveChatIfEmpty();
      // Coalesce with any twin focus/pageshow events in the same tick.
      if (resumeTimer != null) window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        resumeTimer = null;
        softRefreshIfStale(awayMs);
      }, 100);
    };

    const onOnline = () => {
      reconnectSocketsIfNeeded();
      softRefreshIfStale(STALE_AFTER_MS);
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      if (resumeTimer != null) window.clearTimeout(resumeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [user, loadVaultData, ensureChatChannelLoaded]);

  useEffect(() => {
    if (activeVaultId) {
      void loadVaultData(activeVaultId);
    } else {
      setFolders([]);
      setNotes([]);
      setVaultAgents([]);
    }
  }, [activeVaultId, loadVaultData]);
  return {
    openChatTabIds, loadChatAgentMembers, loadChatPresence, loadChatMessages, loadVaultAgents,
    loadVaultData, ensureChatChannelLoaded, handleOpenSharedChatNote,
    persistChatAgentMemberToServer, removeChatAgentMemberOnServer,
  };
}
