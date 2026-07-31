import { useEffect, useState, useCallback, useRef, useMemo, lazy, Suspense, type CSSProperties, type ReactNode } from 'react';
import { Sidebar } from './components/Sidebar';
import { type Tab } from './components/TabBar';
import { perfMark, perfSpan, perfSpanAsync } from './perf';

// CodeMirror (editor core plus every language mode via @codemirror/language-data)
// is the heaviest dependency in the app and is only needed once a note tab is
// actually open — keep it out of the initial chunk.
const NoteEditor = lazy(() =>
  import('./components/NoteEditor').then((m) => ({ default: m.NoteEditor })),
);
import {
  canMergeChatMessages,
  CHAT_NOTE_MARKER,
  ChatView,
  createChatAgentRegistrationId,
  dataUrlsToRunImages,
  mediaToRunImages,
  type ChatAgentRegistration,
  type ChatBlock,
  type ChatChannelPresence,
  type ChatMediaAttachment,
  type ChatMessage,
  type ChatReplyRef,
  type DesktopRunnerHealth,
  type SharedChatNote,
  type VaultAgent,
} from './components/ChatView';
import { SearchOverlay } from './components/SearchOverlay';
import { CommandPalette } from './components/CommandPalette';
import { AdminPanel } from './components/AdminPanel';
import { SessionManager } from './components/SessionManager';
import { PaneGrid, type TabDragPayload } from './components/PaneGrid';
import * as Layout from './layout/tree';
import type { LayoutNode } from './layout/tree';
import { api, type User, type Vault, type Folder, type NoteSummary, type Note } from './api';
import { connectRunsSocket, connectVaultSocket } from './socket';
import { isLocalRunId, cancelLocalAgentRun } from './localAgentRunner';
import { ensureDesktopRunnerHost, startDesktopRunnerHost } from './desktopRunnerHost';
import {
  agentLabel,
  CHAT_AGENTS,
  formatAgentChatPrompt,
  isLightweightChatRequest,
  mergeAgentModelPresets,
  normalizeChatCwd,
  type AgentId,
} from './chat/agents';
import { buildQuotedReplyPrompt, getMentionedRegistrations, normalizeMention, precedingMessageBatch, precedingMessageBatchText, resolveAgentMessageRegistration, stripRegisteredAgentMentions } from './chat/mentions';
import {
  appendChatRunBlocks,
  appendHarnessLog,
  hasChatRunToolBlock,
  honestAgentChatBody,
  afterChatTimestamp,
  mergeRemoteChatMessage,
  newId,
  normalizeChatRunBlocks,
  textFromRunContent,
  toChatMessagePatch,
} from './chat/runBlocks';
import {
  CHAT_STORAGE_KEY,
  loadChatState,
  loadPersistedSession,
  readLegacyLocalChatAgentMembers,
  readLegacyLocalChatMessages,
  SESSION_STORAGE_KEY,
  type ChatState,
  type PersistedSession,
} from './chat/session';
import { enqueueSessionTurn } from './chat/sessionTurns';
import { Activity, Gem, PanelLeftOpen, Users } from 'lucide-react';

/**
 * @file App.tsx — Root component for Cascade
 *
 * Orchestrates application state and the tiling workspace. `openTabs` is the
 * global registry of tab content (notes and chat channels); a recursive
 * {@link LayoutNode} tree (see `layout/tree.ts`) describes how those tabs are
 * arranged into draggable, resizable panes. Note bodies are held per-tab in
 * `noteContents` so any number of note panes can be edited independently.
 *
 * Pure chat helpers live under `./chat/*` (session, agents, mentions, run blocks).
 *
 * @component
 */

type NoteEntry = { note: Note; draft: string };

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
}

export default function App() {
  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════

  const persistedSessionRef = useRef<PersistedSession>(loadPersistedSession());

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'reset'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');

  // App data state
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(persistedSessionRef.current.activeVaultId);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [chatState, setChatState] = useState<ChatState>(loadChatState);
  const [loadingChatChannels, setLoadingChatChannels] = useState<Record<string, boolean>>({});
  const [chatPresenceByChannel, setChatPresenceByChannel] = useState<Record<string, ChatChannelPresence>>({});

  // Tabs + tiling layout
  const [openTabs, setOpenTabs] = useState<Tab[]>(persistedSessionRef.current.openTabs);
  const [layout, setLayout] = useState<LayoutNode>(persistedSessionRef.current.layout);
  const [focusedPaneId, setFocusedPaneId] = useState<string>(persistedSessionRef.current.focusedPaneId);
  // Note bodies, keyed by tab id, so each note pane edits independently.
  const [noteContents, setNoteContents] = useState<Record<string, NoteEntry>>({});

  // UI panels state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('cascade_sidebar_w')) || 280);
  const [isResizing, setIsResizing] = useState(false);
  // Members panel open. Mobile starts closed (toolbar opens it like the folder
  // sidebar); desktop restores the previous expanded/collapsed rail preference.
  const [chatMembersOpen, setChatMembersOpen] = useState(() => {
    if (isMobileViewport()) {
      return false;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('cascade_chat_users_collapsed') !== '1';
    }
    return true;
  });

  const [searchOpen, setSearchOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [runnerHealth, setRunnerHealth] = useState<DesktopRunnerHealth | null>(null);
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);
  const [vaultAgents, setVaultAgents] = useState<VaultAgent[]>([]);
  // ─── Derived focus state ────────────────────────────────────────
  const focusedPane = Layout.findPane(layout, focusedPaneId) ?? Layout.getFirstPane(layout);
  const activeTabId = focusedPane.activeTabId;
  const focusedTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const focusedIsChat = focusedTab?.type === 'chat';
  const currentUsername = user?.username ?? '';
  const availableChatAgents = useMemo(() => CHAT_AGENTS.map((agent) => ({
    id: agent.id,
    label: agent.label,
    models: mergeAgentModelPresets(
      agent.id,
      runnerHealth?.models?.[agent.id] ?? null,
    ),
  })), [runnerHealth?.models]);

  // Refs mirror the latest state so event handlers stay stable (no dep churn)
  // and never read a stale closure during drags / async work.
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const focusedPaneRef = useRef(focusedPane); focusedPaneRef.current = focusedPane;
  const openTabsRef = useRef(openTabs); openTabsRef.current = openTabs;
  const noteContentsRef = useRef(noteContents); noteContentsRef.current = noteContents;
  const activeVaultIdRef = useRef(activeVaultId); activeVaultIdRef.current = activeVaultId;
  // Ids of new notes that exist only in the client until the user writes
  // something and saves — deferred so opening a blank tab doesn't litter the
  // vault. The real (server) id is minted here up front, so no remap on save.
  const unsavedNoteIdsRef = useRef<Set<string>>(new Set());
  const notesRef = useRef(notes); notesRef.current = notes;
  const desktopRunnerStopRef = useRef<(() => void) | null>(null);
  const chatStateRef = useRef(chatState); chatStateRef.current = chatState;
  const vaultSocketRef = useRef<ReturnType<typeof connectVaultSocket> | null>(null);
  const joinedChatChannelsRef = useRef<Set<string>>(new Set());
  const runSocketsRef = useRef<Map<number, ReturnType<typeof connectRunsSocket>>>(new Map());
  const streamingChatMessageIdsRef = useRef<Set<string>>(new Set());
  const acceptedInviteTokenRef = useRef<string | null>(null);
  // Agent messages whose persistence is owned by the server (the run is linked to
  // them server-side). We skip our own PATCH for these to avoid duplicate writes.
  const serverOwnedChatMessageIdsRef = useRef<Set<string>>(new Set());
  // Per agent session (keyed by registration id + conversationId), the id of the
  // last chat message already folded into the agent's resumed CLI session. The
  // next turn feeds only messages after this watermark instead of the whole
  // history — the resumed session already holds everything up to it. A `/clear`
  // rotates the conversationId, so the new key has no watermark and the agent
  // gets a fresh full-context priming.
  const agentContextWatermarkRef = useRef<Map<string, string>>(new Map());
  // A CLI session cannot safely handle two top-level prompts concurrently.
  // Keep follow-up pings visible immediately, but do not dispatch the next run
  // until the preceding run in this exact member conversation has settled and
  // persisted its session id. This is real steering/continuation, rather than
  // two cold processes that merely look connected in the transcript.
  const agentSessionTailRef = useRef<Map<string, Promise<void>>>(new Map());
  const pendingChatPatchRef = useRef<Map<string, ChatMessage>>(new Map());
  const chatPatchTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const startAgentChatRunRef = useRef<((channelId: string, registration: ChatAgentRegistration, prompt: string, triggeringMessage: ChatMessage) => void) | null>(null);
  // Direct `cascade-chat send` replies arrive as a new message, rather than as
  // streamed run text. Keep handoffs idempotent across socket reconnects.
  const chainedAgentMessageIdsRef = useRef<Set<string>>(new Set());

  // Repair focus if the focused pane disappears (e.g. after collapsing a split).
  useEffect(() => {
    if (!Layout.findPane(layout, focusedPaneId)) {
      setFocusedPaneId(Layout.getFirstPane(layout).id);
    }
  }, [layout, focusedPaneId]);

  useEffect(() => {
    const id = window.setTimeout(() => localStorage.setItem('cascade_sidebar_w', String(sidebarWidth)), 150);
    return () => clearTimeout(id);
  }, [sidebarWidth]);

  useEffect(() => {
    if (isMobileViewport()) {
      setSidebarOpen(false);
      setChatMembersOpen(false);
    }
  }, []);

  // Mobile: members only while a chat is focused. Desktop keeps rail preference.
  useEffect(() => {
    if (!focusedIsChat && isMobileViewport()) {
      setChatMembersOpen(false);
    }
  }, [focusedIsChat]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    // Desktop rail preference; mobile always starts closed so skip overwriting
    // with false when the user is on a phone.
    if (isMobileViewport()) return;
    localStorage.setItem('cascade_chat_users_collapsed', chatMembersOpen ? '0' : '1');
  }, [chatMembersOpen]);

  // Persist the workspace session.
  useEffect(() => {
    const id = window.setTimeout(() => {
    const session: PersistedSession = { activeVaultId, openTabs, layout, focusedPaneId };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }, 250);
    return () => clearTimeout(id);
  }, [activeVaultId, openTabs, layout, focusedPaneId]);

  useEffect(() => {
    const id = window.setTimeout(() => {
    const { messagesByChannel: _messages, registeredAgentsByChannel: _agents, ...persistedChat } = chatState;
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(persistedChat));
    }, 250);
    return () => clearTimeout(id);
  }, [chatState]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (notes.length === 0) return;
    setOpenTabs((prev) => prev.map((tab) => {
      if (tab.type !== 'chat') return tab;
      const note = notes.find((item) => item.id === tab.id && item.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      return note ? { ...tab, title: `#${note.title}` } : tab;
    }));
  }, [notes]);

  /** Drag the sidebar divider. */
  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startSidebar = sidebarWidth;
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      setSidebarWidth(clamp(startSidebar + delta, 180, 480));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsResizing(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  // ═══════════════════════════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════════════════════════

  const loadVaults = useCallback(async () => {
    try {
      const data = await api<{ vaults: Vault[] }>('/api/vaults');
      setVaults(data.vaults);
      const restoredVaultValid = activeVaultId && data.vaults.some((v) => v.id === activeVaultId);
      if (data.vaults.length > 0 && !restoredVaultValid) {
        setActiveVaultId(data.vaults[0].id);
      } else if (data.vaults.length === 0) {
        const created = await api<{ vault: Vault }>('/api/vaults', {
          method: 'POST',
          body: JSON.stringify({ name: 'My Vault' }),
        });
        setVaults([created.vault]);
        setActiveVaultId(created.vault.id);
      }
    } catch (error) {
      console.error('Error loading vaults:', error);
    }
  }, [activeVaultId]);

  useEffect(() => {
    const token = localStorage.getItem('docs_token');
    if (!token) return;
    let cancelled = false;
    let succeeded = false;
    let attempt = 0;
    let timer: number | null = null;
    const tryAuth = () => {
      api<{ user: User; owner?: boolean }>('/api/me')
        .then((data) => {
          if (cancelled) return;
          succeeded = true;
          setUser(data.user);
          setIsOwner(Boolean(data.owner));
          void loadVaults();
        })
        .catch(() => {
          if (cancelled) return;
          // A real 401 means the token is invalid/expired — api() already cleared
          // it, so stop and show the login screen. But a *transient* failure
          // (offline, mobile cold-start before the network is up, server mid-
          // deploy) leaves the token in place: keep the session and retry with
          // backoff instead of logging the user out on a blip.
          if (!localStorage.getItem('docs_token')) return;
          attempt += 1;
          if (attempt > 6) return;
          timer = window.setTimeout(tryAuth, Math.min(1000 * 2 ** (attempt - 1), 15000));
        });
    };
    // If connectivity returns after the retries gave up, try again — a valid
    // token shouldn't strand the user on the login screen.
    const onReconnect = () => {
      if (cancelled || succeeded || !localStorage.getItem('docs_token')) return;
      attempt = 0;
      if (timer != null) window.clearTimeout(timer);
      tryAuth();
    };
    tryAuth();
    window.addEventListener('online', onReconnect);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener('online', onReconnect);
    };
  }, [loadVaults]);

  useEffect(() => {
    desktopRunnerStopRef.current?.();
    desktopRunnerStopRef.current = user ? startDesktopRunnerHost() : null;
    return () => {
      desktopRunnerStopRef.current?.();
      desktopRunnerStopRef.current = null;
    };
  }, [user]);

  // Poll desktop runner health for the chat agent sidebar.
  // Only commit setState when the payload actually changes — identical JSON
  // every 5s was re-rendering the whole chat tree and made idle hover laggy.
  useEffect(() => {
    if (!user) {
      setRunnerHealth(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const OFFLINE: DesktopRunnerHealth = {
      online: false,
      activeRuns: 0,
      lastError: null,
      lastErrorAt: null,
      lastSeenAt: null,
      models: null,
      planUsage: null,
    };
    const sameHealth = (a: DesktopRunnerHealth | null, b: DesktopRunnerHealth): boolean => {
      if (!a) return false;
      if (a.online !== b.online) return false;
      if (a.activeRuns !== b.activeRuns) return false;
      if (a.lastError !== b.lastError) return false;
      if (a.lastErrorAt !== b.lastErrorAt) return false;
      if (a.lastSeenAt !== b.lastSeenAt) return false;
      try {
        return JSON.stringify(a.models) === JSON.stringify(b.models)
          && JSON.stringify(a.planUsage) === JSON.stringify(b.planUsage);
      } catch {
        return false;
      }
    };
    const apply = (data: DesktopRunnerHealth) => {
      setRunnerHealth((prev) => (sameHealth(prev, data) ? prev : data));
    };
    const tick = async () => {
      // Skip network work while the tab is hidden; resume on visibilitychange.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const data = await api<DesktopRunnerHealth>('/api/me/desktop-runner');
        if (!cancelled) apply(data);
      } catch {
        if (!cancelled) apply(OFFLINE);
      }
    };
    void tick();
    // 12s is plenty for a status pill; was 5s and forced full tree work.
    timer = window.setInterval(tick, 12_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user]);

  /** Chat channels currently open as tabs (not every chat note in the vault). */
  const openChatTabIds = useCallback((): string[] => {
    return openTabsRef.current.filter((tab) => tab.type === 'chat').map((tab) => tab.id);
  }, []);

  const loadChatAgentMembers = useCallback(async (
    vaultId: string,
    noteList: NoteSummary[],
    opts?: { channelIds?: string[] },
  ) => {
    const chatNoteIds = new Set(
      noteList
        .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
        .map((note) => note.id),
    );
    // Default: only open chat tabs — not every channel in the vault.
    const finalIds = opts?.channelIds?.length
      ? opts.channelIds
      : openChatTabIds().filter((id) => chatNoteIds.has(id));
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
        return { channelId, agents: legacyAgents[channelId] ?? [] };
      }
    }));

    setChatState((prev) => {
      const registeredAgentsByChannel = { ...prev.registeredAgentsByChannel };
      for (const { channelId, agents } of results) {
        registeredAgentsByChannel[channelId] = agents;
      }
      return { ...prev, registeredAgentsByChannel };
    });
  }, [openChatTabIds]);

  const loadChatPresence = useCallback(async (
    vaultId: string,
    noteList: NoteSummary[],
    opts?: { channelIds?: string[] },
  ) => {
    const chatNoteIds = new Set(
      noteList
        .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
        .map((note) => note.id),
    );
    const finalIds = opts?.channelIds?.length
      ? opts.channelIds
      : openChatTabIds().filter((id) => chatNoteIds.has(id));
    if (finalIds.length === 0) return;

    const results = await Promise.all(finalIds.map(async (channelId) => {
      try {
        const data = await api<ChatChannelPresence>(`/api/vaults/${vaultId}/channels/${channelId}/presence`);
        return { channelId, participants: data.participants ?? [], online: data.online ?? [], owner: data.owner ?? '' };
      } catch {
        return { channelId, participants: [], online: [], owner: '' };
      }
    }));

    setChatPresenceByChannel((prev) => {
      const next = { ...prev };
      for (const { channelId, participants, online, owner } of results) {
        next[channelId] = { participants, online, owner };
      }
      return next;
    });
  }, [openChatTabIds]);

  const loadChatMessages = useCallback(async (
    vaultId: string,
    noteList: NoteSummary[],
    opts?: { silent?: boolean; channelIds?: string[] },
  ) => {
    const chatNoteIds = new Set(
      noteList
        .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
        .map((note) => note.id),
    );
    // Condense: only open chat tabs (or an explicit list) — never every channel note.
    const requested = opts?.channelIds?.length
      ? opts.channelIds
      : openChatTabIds().filter((id) => chatNoteIds.has(id));
    const channelIds = requested.filter((id) => chatNoteIds.has(id) || opts?.channelIds?.includes(id));
    if (channelIds.length === 0) return;

    const legacyMessages = readLegacyLocalChatMessages();
    const silent = opts?.silent === true;
    // Only show "Loading…" for channels with no cached transcript. Silent
    // refreshes (app resume / focus) must never blank the open channel.
    if (!silent) {
      setLoadingChatChannels((prev) => {
        const next = { ...prev };
        for (const id of channelIds) {
          const cached = chatStateRef.current.messagesByChannel[id];
          if (!cached || cached.length === 0) next[id] = true;
        }
        return next;
      });
    }
    const loadChannels = async (ids: string[]) => {
      const results = await Promise.all(ids.map(async (channelId) => {
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
          return { channelId, messages };
        } catch {
          // Keep whatever we already have on soft failure (resume offline).
          const cached = chatStateRef.current.messagesByChannel[channelId];
          return { channelId, messages: cached ?? legacyMessages[channelId] ?? [] };
        }
      }));
      setChatState((prev) => ({
        ...prev,
        messagesByChannel: Object.fromEntries([
          ...Object.entries(prev.messagesByChannel),
          ...results.map(({ channelId, messages }) => [channelId, messages]),
        ]),
      }));
      setLoadingChatChannels((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
    };

    // Focused/open channels first (usually one); no fan-out to the whole vault.
    await loadChannels(channelIds);
  }, [openChatTabIds]);

  const persistChatMessageToServer = useCallback(async (
    vaultId: string,
    channelId: string,
    message: ChatMessage,
  ): Promise<ChatMessage | null> => {
    try {
      const data = await api<{ message: ChatMessage }>(`/api/vaults/${vaultId}/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify(message),
      });
      if (!data.message) return null;
      const merged = mergeRemoteChatMessage(message, data.message);
      setChatState((prev) => {
        const existing = prev.messagesByChannel[channelId] ?? [];
        const index = existing.findIndex((item) => item.id === data.message.id);
        if (index === -1) return prev;
        const next = [...existing];
        next[index] = mergeRemoteChatMessage(existing[index], data.message);
        return {
          ...prev,
          messagesByChannel: {
            ...prev.messagesByChannel,
            [channelId]: next,
          },
        };
      });
      return merged;
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

  const persistChatAgentMemberToServer = useCallback(async (vaultId: string, channelId: string, registration: ChatAgentRegistration) => {
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/agents`, {
        method: 'PUT',
        body: JSON.stringify(registration),
      });
    } catch (error) {
      console.error('Failed to persist chat agent member:', error);
      setNotice(error instanceof Error ? error.message : 'Could not save agent member');
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
      setVaultAgents(data.agents ?? []);
    } catch {
      setVaultAgents([]);
    }
  }, []);

  const loadVaultData = useCallback(async (vaultId: string, opts?: { soft?: boolean }) => {
    try {
      await perfSpanAsync(
        'vault.loadVaultData',
        async () => {
          const [folderData, noteData] = await Promise.all([
            api<{ folders: Folder[] }>(`/api/vaults/${vaultId}/folders`),
            api<{ notes: NoteSummary[] }>(`/api/vaults/${vaultId}/notes`),
          ]);
          const nextNotes = noteData.notes || [];
          setFolders(folderData.folders || []);
          setNotes(nextNotes);
          // Chat payloads only for open tabs — switching into a tab hydrates on demand.
          const openChats = openChatTabIds().filter((id) =>
            nextNotes.some((n) => n.id === id && n.content_preview.trim().startsWith(CHAT_NOTE_MARKER)),
          );
          await Promise.all([
            loadChatMessages(vaultId, nextNotes, { silent: opts?.soft === true, channelIds: openChats }),
            loadChatAgentMembers(vaultId, nextNotes, { channelIds: openChats }),
            loadChatPresence(vaultId, nextNotes, { channelIds: openChats }),
            loadVaultAgents(vaultId),
          ]);
        },
        {
          vaultId,
          soft: opts?.soft === true,
          openChats: openChatTabIds().length,
        },
        200,
      );
    } catch (error) {
      console.error('Error loading vault data:', error);
    }
  }, [loadChatMessages, loadChatAgentMembers, loadChatPresence, loadVaultAgents, openChatTabIds]);

  /** Hydrate one chat channel when the user focuses its tab (skip if cached). */
  const ensureChatChannelLoaded = useCallback((channelId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    const notesList = notesRef.current;
    const isChat = notesList.some(
      (n) => n.id === channelId && n.content_preview.trim().startsWith(CHAT_NOTE_MARKER),
    );
    if (!isChat) return;

    const hasMessages = (chatStateRef.current.messagesByChannel[channelId]?.length ?? 0) > 0;
    const hasAgents = (chatStateRef.current.registeredAgentsByChannel[channelId]?.length ?? 0) > 0;
    if (hasMessages && hasAgents) return;

    const ids = [channelId];
    if (!hasMessages) {
      void loadChatMessages(vaultId, notesList, { channelIds: ids });
    }
    if (!hasAgents) {
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
    if (focusedTab?.type === 'chat') ensureChatChannelLoaded(focusedTab.id);
  }, [user, activeVaultId, notes, focusedTab?.id, focusedTab?.type, ensureChatChannelLoaded]);

  /** Merge full message detail (harness log) after expand-fetch. */
  const handleHydrateChatMessage = useCallback((message: ChatMessage) => {
    const channelId = message.channelId;
    if (!channelId) return;
    setChatState((prev) => {
      const existing = prev.messagesByChannel[channelId] ?? [];
      const index = existing.findIndex((item) => item.id === message.id);
      if (index === -1) {
        return {
          ...prev,
          messagesByChannel: {
            ...prev.messagesByChannel,
            [channelId]: [...existing, message],
          },
        };
      }
      const next = [...existing];
      next[index] = mergeRemoteChatMessage(existing[index], {
        ...message,
        // Prefer full harness/blocks/images from the expand/hydrate fetch.
        harnessLog: message.harnessLog || existing[index].harnessLog,
        blocks: message.blocks?.length ? message.blocks : existing[index].blocks,
        hasHarness: message.hasHarness ?? existing[index].hasHarness,
        images: message.images?.length ? message.images : existing[index].images,
      });
      return {
        ...prev,
        messagesByChannel: {
          ...prev.messagesByChannel,
          [channelId]: next,
        },
      };
    });
  }, []);

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
      perfMark('vault.softRefresh', { awayMs, vaultId }, true);
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
      const pane = Layout.createPane();
      setFolders([]);
      setNotes([]);
      setOpenTabs([]);
      setLayout(pane);
      setFocusedPaneId(pane.id);
      setNoteContents({});
    }
  }, [activeVaultId, loadVaultData]);

  // ═══════════════════════════════════════════════════════════════
  // CHAT CHANNEL OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  const openChatChannel = useCallback((channelId: string, title: string, mode: 'open' | 'replace' = 'open') => {
    const name = title.trim() || 'chat';
    const tab: Tab = { id: channelId, title: `#${name}`, type: 'chat', dirty: false };

    setOpenTabs((prev) =>
      prev.some((t) => t.id === channelId)
        ? prev.map((t) => (t.id === channelId ? { ...t, title: tab.title, type: 'chat' } : t))
        : [...prev, tab],
    );

    const prev = layoutRef.current;
    const focused = focusedPaneRef.current;
    const existingPane = Layout.findPaneByTab(prev, channelId);

    if (existingPane) {
      setLayout(Layout.setActiveTab(prev, existingPane.id, channelId));
      setFocusedPaneId(existingPane.id);
      ensureChatChannelLoaded(channelId);
      return;
    }

    let next = Layout.addTabToPane(Layout.removeTab(prev, channelId), focused.id, channelId);
    const oldId = focused.activeTabId;
    if (mode === 'replace' && oldId && oldId !== channelId) {
      next = Layout.removeTab(next, oldId);
      setOpenTabs((p) => p.filter((t) => t.id !== oldId || t.id === channelId));
      setNoteContents((p) => { const copy = { ...p }; delete copy[oldId]; return copy; });
    }
    setLayout(Layout.simplify(next));
    setFocusedPaneId(focused.id);
    ensureChatChannelLoaded(channelId);
  }, [ensureChatChannelLoaded]);

  useEffect(() => {
    const match = window.location.pathname.match(/^\/invite\/([^/]+)$/);
    const token = match ? decodeURIComponent(match[1]) : '';
    if (!token || !user || acceptedInviteTokenRef.current === token) return;
    acceptedInviteTokenRef.current = token;
    (async () => {
      try {
        const data = await api<{ vaultId: string; channelId: string; title: string }>(`/api/chat-invites/${encodeURIComponent(token)}/accept`, {
          method: 'POST',
        });
        await loadVaults();
        setActiveVaultId(data.vaultId);
        await loadVaultData(data.vaultId);
        openChatChannel(data.channelId, data.title || 'shared-chat', 'replace');
        window.history.replaceState({}, '', '/app.html');
        setNotice(`Added #${data.title || 'shared-chat'} to your vault.`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not accept invite link');
      }
    })();
  }, [loadVaultData, loadVaults, openChatChannel, user]);

  const handleCreateChannel = useCallback(async (folderId: string | null = null) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return undefined;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'new-channel', content: CHAT_NOTE_MARKER, folder_id: folderId ?? undefined }),
      });
      await loadVaultData(vaultId);
      openChatChannel(data.note.id, data.note.title);
      return { id: data.note.id, title: data.note.title };
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create channel');
      return undefined;
    }
  }, [loadVaultData, openChatChannel]);

  const appendChatMessage = useCallback((channelId: string, message: ChatMessage) => {
    setChatState((prev) => ({
      ...prev,
      messagesByChannel: {
        ...prev.messagesByChannel,
        [channelId]: [...(prev.messagesByChannel[channelId] ?? []), message],
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId) void persistChatMessageToServer(vaultId, channelId, message);
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
      ?? (chatStateRef.current.messagesByChannel[channelId] ?? []).find((message) => message.id === messageId);
    if (!base) return;
    const patched = updater(base);
    setChatState((prev) => ({
      ...prev,
      messagesByChannel: {
        ...prev.messagesByChannel,
        [channelId]: (prev.messagesByChannel[channelId] ?? []).map((message) => (
          message.id === messageId ? patched : message
        )),
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId && !serverOwnedChatMessageIdsRef.current.has(messageId)) {
      const immediate = !patched.status || patched.status === 'failed' || patched.status === 'canceled';
      scheduleChatMessagePatch(vaultId, channelId, messageId, patched, immediate);
    }
  }, [scheduleChatMessagePatch]);

  const handleRegisterChatAgent = useCallback((channelId: string, registration: ChatAgentRegistration) => {
    const normalized = {
      ...registration,
      id: registration.id || createChatAgentRegistrationId(),
      vaultAgentId: registration.vaultAgentId || '',
      displayName: registration.displayName.trim() || agentLabel(registration.agentId as AgentId),
      mention: normalizeMention(registration.mention || registration.agentId),
      cwd: normalizeChatCwd(registration.cwd),
      replyToEveryMessage: registration.replyToEveryMessage === true,
      conversationId: registration.conversationId || newId('conv'),
    };
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: [
          ...(prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== normalized.id),
          normalized,
        ],
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId) {
      void persistChatAgentMemberToServer(vaultId, channelId, normalized).then(() => {
        void loadVaultAgents(vaultId);
      });
    }
  }, [persistChatAgentMemberToServer, loadVaultAgents]);

  const handleRemoveChatAgent = useCallback((channelId: string, registrationId: string) => {
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: (prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== registrationId),
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId) {
      void removeChatAgentMemberOnServer(vaultId, channelId, registrationId).then(() => {
        void loadVaultAgents(vaultId);
      });
    }
  }, [removeChatAgentMemberOnServer, loadVaultAgents]);

  const handleUpsertVaultAgent = useCallback(async (input: Partial<VaultAgent> & { agentId: string }) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const data = await api<{ agent: VaultAgent }>(`/api/vaults/${vaultId}/vault-agents`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    const agent = data.agent;
    setVaultAgents((prev) => {
      const rest = prev.filter((a) => a.id !== agent.id);
      return [...rest, agent].sort((a, b) => (a.displayName || a.mention).localeCompare(b.displayName || b.mention));
    });
    // Sync identity into any loaded channel memberships
    setChatState((prev) => {
      const next = { ...prev.registeredAgentsByChannel };
      for (const [chId, regs] of Object.entries(next)) {
        next[chId] = regs.map((r) => (
          r.vaultAgentId === agent.id
            ? {
                ...r,
                agentId: agent.agentId,
                displayName: agent.displayName,
                mention: agent.mention,
                model: agent.model,
                cwd: agent.cwd,
                contextPrompt: agent.contextPrompt,
              }
            : r
        ));
      }
      return { ...prev, registeredAgentsByChannel: next };
    });
    return agent;
  }, []);

  const handleDeleteVaultAgent = useCallback(async (vaultAgentId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    await api(`/api/vaults/${vaultId}/vault-agents/${vaultAgentId}`, { method: 'DELETE' });
    setVaultAgents((prev) => prev.filter((a) => a.id !== vaultAgentId));
    setChatState((prev) => {
      const next: Record<string, ChatAgentRegistration[]> = {};
      for (const [chId, regs] of Object.entries(prev.registeredAgentsByChannel)) {
        next[chId] = regs.filter((r) => r.vaultAgentId !== vaultAgentId);
      }
      return { ...prev, registeredAgentsByChannel: next };
    });
  }, []);

  const handleAddVaultAgentToChannel = useCallback(async (channelId: string, vaultAgentId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const data = await api<{ registration: ChatAgentRegistration }>(
      `/api/vaults/${vaultId}/channels/${channelId}/agents/from-vault`,
      {
        method: 'POST',
        body: JSON.stringify({ vaultAgentId }),
      },
    );
    const reg = data.registration;
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: [
          ...(prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== reg.id && item.vaultAgentId !== vaultAgentId),
          reg,
        ],
      },
    }));
    void loadVaultAgents(vaultId);
  }, [loadVaultAgents]);

  const handleInviteChatUser = useCallback(async (channelId: string, username: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    await api(`/api/vaults/${vaultId}/channels/${channelId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  }, []);

  const handleCreateChatInviteLink = useCallback(async (channelId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const data = await api<{ url: string }>(`/api/vaults/${vaultId}/channels/${channelId}/invite-link`, {
      method: 'POST',
    });
    return data.url;
  }, []);

  const handleRemoveChatParticipant = useCallback(async (channelId: string, username: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    await api(`/api/vaults/${vaultId}/channels/${channelId}/members/${encodeURIComponent(username)}`, { method: 'DELETE' });
  }, []);

  const handleLeaveChatChannel = useCallback(async (channelId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId || !window.confirm('Leave this channel?')) return;
    await api(`/api/vaults/${vaultId}/channels/${channelId}/members/me`, { method: 'DELETE' });
    closeTabRef.current(channelId);
    await loadVaultData(vaultId);
  }, [loadVaultData]);

  const startAgentChatRun = useCallback(async (
    channelId: string,
    registration: ChatAgentRegistration,
    prompt: string,
    triggeringMessage: ChatMessage,
    runImages: Array<{ media_type: string; data: string }> = [],
  ) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;

    const agentId = registration.agentId as AgentId;
    if (!CHAT_AGENTS.some((agent) => agent.id === agentId)) return;
    const channelName = notesRef.current.find((note) => note.id === channelId)?.title || 'chat';
    const watermarkKey = `${registration.id}:${registration.conversationId || ''}`;
    const sessionTurn = enqueueSessionTurn(agentSessionTailRef.current, watermarkKey);
    const agentMessageId = `agent-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      let harnessChars = 0;
      if (pendingHarnessChunks) {
        const chunk = pendingHarnessChunks;
        const harnessRunId = pendingHarnessRunId;
        harnessChars = chunk.length;
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
      perfSpan(
        'chat.flushMessageUpdates',
        () => {
          updateChatMessage(channelId, agentMessageId, (message) =>
            updates.reduce((next, update) => update(next), message));
        },
        { channelId, updates: updates.length, harnessChars },
        24,
      );
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
      body: 'Thinking...',
      createdAt: afterChatTimestamp(triggeringMessage.createdAt),
      status: 'running',
      agentId,
      registrationId: registration.id,
    });

    try {
      // The prior terminal event is published only after its session id is
      // stored server-side. Waiting here therefore guarantees /runs can resume
      // that same backing session instead of racing into a duplicate cold boot.
      await sessionTurn.preceding;
      // One sticky session per agent: the run resumes (and extends) the member's
      // conversation, so its earlier turns are already in context. A `/clear`
      // rotates conversationId, so a fresh key here has no watermark.
      const watermark = agentContextWatermarkRef.current.get(watermarkKey);
      const continuation = Boolean(watermark);
      const runPrompt = formatAgentChatPrompt(channelName, registration, prompt, triggeringMessage.author, continuation);
      // Conversation id groups runs for backend session resume (findPriorSession).
      // The actual CLI session_id is resolved server-side — not this value.
      const conversationId = registration.conversationId || undefined;
      let assistantText = '';
      let bufferedBlocks: ChatBlock[] = [];
      const processedSeqs = new Set<number>();

      const finishRun = (runId: number, cleanup: () => void) => {
        cleanup();
        sessionTurn.release();
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
              // Dual-post suppress: drop the Thinking placeholder entirely so the
              // live UI never leaves an empty "(message)" shell after cascade-chat
              // send. (Server list already filters empty terminal agent rows.)
              if (terminal === 'completed' && suppressChatBody) {
                setChatState((prev) => {
                  const existing = prev.messagesByChannel[channelId] ?? [];
                  const next = existing.filter((message) => message.id !== agentMessageId);
                  if (next.length === existing.length) return prev;
                  return {
                    ...prev,
                    messagesByChannel: {
                      ...prev.messagesByChannel,
                      [channelId]: next,
                    },
                  };
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
              // Chain agent→agent mentions from the cleaned final body, not raw stream.
              // Skip when body was suppressed (real reply already went out via cascade-chat send).
              if (terminal === 'completed' && finalBody.trim() && !suppressChatBody) {
                const registrations = (chatStateRef.current.registeredAgentsByChannel[channelId] ?? [])
                  .filter((item) => item.id !== registration.id);
                const mentionedAgents = getMentionedRegistrations(finalBody, registrations, true);
                const chainPrompt = stripRegisteredAgentMentions(finalBody, registrations) || finalBody;
                const triggeringAgentMessage: ChatMessage = {
                  id: agentMessageId,
                  channelId,
                  author: registration.displayName || agentLabel(agentId),
                  body: finalBody,
                  createdAt: new Date().toISOString(),
                  agentId,
                  registrationId: registration.id,
                };
                for (const mentionedRegistration of mentionedAgents) {
                  startAgentChatRunRef.current?.(channelId, mentionedRegistration, chainPrompt, triggeringAgentMessage);
                }
              }
              finishRun(runId, cleanup);
            }
          } else if (event.type === 'text') {
            const payload = JSON.parse(event.payload_json);
            const blocks = normalizeChatRunBlocks(payload.message?.content);
            const text = textFromRunContent(payload.message?.content);
            const hasToolBlock = hasChatRunToolBlock(payload.message?.content);
            if (!text && blocks.length === 0 && !hasToolBlock) return;
            // Accumulate final-answer candidates, but do not write intermediate
            // stream monologue into the chat bubble — that leaked plan/thinking
            // traces into the transcript. Body stays "Thinking..." until status.
            if (text) assistantText += text;
            bufferedBlocks = appendChatRunBlocks(bufferedBlocks, blocks);
            queueMessageUpdate((message) => ({
              ...message,
              body: message.status === 'running' || message.body === 'Thinking...' || !message.body?.trim()
                ? 'Thinking...'
                : message.body,
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

      runSocket = connectRunsSocket();
      // Wait for a successful transport only. engine.io may emit connect_error
      // while falling back (websocket → polling); rejecting on the first one
      // is what wrote the raw "websocket error" string into chat.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Runs socket connect timeout')), 15000);
        runSocket!.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      const res = await api<{ run: { id: number; status: string; conversation_id: string } }>(`/api/vaults/${vaultId}/runs`, {
        method: 'POST',
        body: JSON.stringify({
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
          // Link the run to this chat message so the server persists/broadcasts
          // the streamed reply to all clients (see serverOwnedChatMessageIdsRef).
          chat: {
            channelId,
            messageId: agentMessageId,
            triggeringMessageId: triggeringMessage.id,
            author: registration.displayName || agentLabel(agentId),
            // Server skips heavy memory injection for simple pings.
            lightweight: isLightweightChatRequest(prompt),
          },
        }),
      });

      activeRunId = res.run.id;
      // The run is registered server-side; the server now owns persistence of this
      // message's streamed updates. Skip our own debounced PATCH to avoid duplicate
      // writes — we still update local state for instant display.
      serverOwnedChatMessageIdsRef.current.add(agentMessageId);
      // Legacy members predate per-member sessions: adopt the conversation the
      // server just minted and persist it so later turns resume the same session.
      if (!registration.conversationId && res.run.conversation_id) {
        handleRegisterChatAgent(channelId, { ...registration, conversationId: res.run.conversation_id });
      }

      queueMessageUpdate((message) => ({
        ...message,
        runId: res.run.id,
      }));

      runSocketsRef.current.set(res.run.id, runSocket);
      joinRunRoom = () => runSocket!.emit('joinRun', res.run.id);
      runSocket.on('connect', joinRunRoom);
      runSocket.emit('joinRun', res.run.id);
      const cleanup = () => {};
      runSocket.on('event', (event) => processRunEvent(event, res.run.id, cleanup));

      try {
        const history = await api<{ events: Array<{ seq: number; type: string; payload_json: string }> }>(`/api/runs/${res.run.id}/events`);
        for (const event of history.events) processRunEvent(event, res.run.id, cleanup);
      } catch {
        // Best-effort backfill; live events will still populate going forward.
      }
    } catch (error) {
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
      applyMessageUpdateNow((message) => ({
        ...message,
        body: error instanceof Error ? error.message : 'Failed to start agent.',
        status: 'failed',
      }));
      sessionTurn.release();
    }
  }, [appendChatMessage, updateChatMessage, handleRegisterChatAgent]);
  startAgentChatRunRef.current = startAgentChatRun;

  const handleCancelChatRun = useCallback((runId: number) => {
    void (async () => {
      try {
        if (isLocalRunId(runId)) {
          // Negative run ids are legacy client-local runs (no longer started here).
          const cancelled = await cancelLocalAgentRun(runId);
          if (!cancelled) {
            setNotice('Could not cancel run');
            return;
          }
        } else {
          const res = await api<{ success: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' });
          const socket = runSocketsRef.current.get(runId);
          if (socket) {
            socket.disconnect();
            runSocketsRef.current.delete(runId);
          }
          if (!res.success) {
            setNotice('Could not cancel run');
            return;
          }
        }
        setChatState((prev) => ({
          ...prev,
          messagesByChannel: Object.fromEntries(
            Object.entries(prev.messagesByChannel).map(([channelId, messages]) => [
              channelId,
              messages.map((message) => (
                message.runId === runId && message.status === 'running'
                  ? {
                      ...message,
                      body: message.body === 'Thinking...' ? 'Run canceled by user.' : message.body,
                      status: 'canceled',
                    }
                  : message
              )),
            ]),
          ),
        }));
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not cancel run');
      }
    })();
  }, []);

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

    const messages = chatStateRef.current.messagesByChannel[channelId] ?? [];
    const last = messages[messages.length - 1];
    let outgoingMessage = candidate;
    let mergeTargetId: string | null = null;
    if (last && canMergeChatMessages(last, candidate)) {
      mergeTargetId = last.id;
      outgoingMessage = {
        ...last,
        body: `${last.body}\n${trimmed}`,
        createdAt: candidate.createdAt,
      };
    }

    setChatState((prev) => {
      const channelMessages = prev.messagesByChannel[channelId] ?? [];
      if (mergeTargetId) {
        return {
          ...prev,
          messagesByChannel: {
            ...prev.messagesByChannel,
            [channelId]: [...channelMessages.slice(0, -1), outgoingMessage],
          },
        };
      }
      return {
        ...prev,
        messagesByChannel: {
          ...prev.messagesByChannel,
          [channelId]: [...channelMessages, candidate],
        },
      };
    });

    const vaultId = activeVaultIdRef.current;
    // Persist the user prompt *before* starting agents. If the agent shell is
    // inserted first it gets a lower rowid/seq and survives reloads as
    // "response then prompt" even when the UI briefly looked correct.
    void (async () => {
      let trigger = outgoingMessage;
      if (vaultId) {
        if (mergeTargetId) {
          scheduleChatMessagePatch(vaultId, channelId, mergeTargetId, outgoingMessage, true);
        } else {
          const saved = await persistChatMessageToServer(vaultId, channelId, candidate);
          if (saved) trigger = saved;
        }
      }

      const registrations = chatStateRef.current.registeredAgentsByChannel[channelId] ?? [];
      const implicitMention = replyTo?.mention ? `@${replyTo.mention}` : '';
      // What the sender actually typed. Kept apart from `implicitMention`, which
      // exists only to route a reply back to its author: when that author is a
      // person the "@name" is not part of the ask, and folding it into the prompt
      // leaves the agent with a bare handle and no question.
      const typedSource = [trimmed, attachments.map((item) => item.name).join(' ')].filter(Boolean).join(' ');
      const mentionSource = [implicitMention, typedSource].filter(Boolean).join(' ');
      const mentionedAgents = getMentionedRegistrations(mentionSource, registrations, false);
      const targetAgents = [
        ...mentionedAgents,
        ...registrations.filter((registration) =>
          registration.replyToEveryMessage
          && !mentionedAgents.some((mentioned) => mentioned.id === registration.id)
        ),
      ];
      if (targetAgents.length === 0) return;
      const directPrompt = stripRegisteredAgentMentions(typedSource, registrations);
      // A reply carries its ask in the quote, so hand the quoted message to the
      // agent. Without it a bare "@agent" reply arrives as an empty prompt and
      // the agent answers "no new ask" at the thing you were pointing at.
      const quotedPrompt = replyTo ? buildQuotedReplyPrompt(replyTo, messages) : '';
      // A bare @agent after a same-author message batch means "handle that batch".
      // Usually plain text has already merged into outgoingMessage; the explicit
      // fallback also covers grouped messages that could not be physically merged.
      // A quote is the more precise pointer, so it wins over the batch guess.
      const batchPrompt = directPrompt || quotedPrompt ? '' : precedingMessageBatchText(messages, candidate);
      const prompt = [quotedPrompt, directPrompt || batchPrompt].filter(Boolean).join('\n\n')
        || typedSource || 'Please review the attached media.';
      // "@agent diagnose this" carries no media of its own — the screenshot is on
      // another message: the one being replied to, or the same-author batch just
      // before it (the same pointer rule the batch prompt already uses). Without
      // this the agent gets the words, none of the evidence, and guesses at what
      // it cannot see.
      const ownImages = mediaToRunImages(media);
      const quotedMessage = replyTo ? messages.find((message) => message.id === replyTo.messageId) : undefined;
      const imageSources = ownImages.length > 0
        ? []
        : (quotedMessage ? [quotedMessage] : precedingMessageBatch(messages, candidate));
      const carriedImages: Array<{ media_type: string; data: string }> = [];
      for (const source of imageSources) {
        let images = dataUrlsToRunImages(source.images);
        if (images.length === 0 && source.hasImages && vaultId) {
          // The list payload strips heavy data URLs; refetch the one message we need.
          try {
            const full = await api<{ message: ChatMessage }>(
              `/api/vaults/${vaultId}/channels/${channelId}/messages/${encodeURIComponent(source.id)}`,
            );
            images = dataUrlsToRunImages(full.message?.images);
          } catch { /* the quoted/batch text still carries the ask */ }
        }
        carriedImages.push(...images);
      }
      // Keep the most recent few: a long screenshot batch would otherwise blow up
      // the request without adding much the agent can act on.
      const runImages = [...ownImages, ...carriedImages.slice(-4)];
      const agentsWithoutImages = new Set<AgentId>(['grok', 'antigravity', 'copilot', 'hermes', 'akron-grok']);
      for (const registration of targetAgents) {
        const blind = agentsWithoutImages.has(registration.agentId as AgentId);
        // Tell a text-only agent an image exists rather than let it answer as if
        // the message were complete.
        const promptForRun = blind && runImages.length > 0
          ? `${prompt}\n\n(This message carries ${runImages.length} image(s) you cannot receive — say so instead of guessing.)`
          : prompt;
        void startAgentChatRun(channelId, registration, promptForRun, trigger, blind ? [] : runImages);
      }
    })();
  }, [scheduleChatMessagePatch, persistChatMessageToServer, startAgentChatRun, user, handleRegisterChatAgent, appendChatMessage]);

  /** Close a tab from anywhere: drop it from the registry, content, and tree. */
  const closeTab = useCallback((tabId: string) => {
    // An unsaved draft was never persisted — just drop it (this is the point:
    // closing a blank new note leaves nothing behind).
    unsavedNoteIdsRef.current.delete(tabId);
    setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
    setNoteContents((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setLayout(Layout.simplify(Layout.removeTab(layoutRef.current, tabId)));
  }, []);

  // Stable handle so socket/delete callbacks can close tabs without re-subscribing.
  const closeTabRef = useRef(closeTab); closeTabRef.current = closeTab;

  // ═══════════════════════════════════════════════════════════════
  // NOTE CONTENT
  // ═══════════════════════════════════════════════════════════════

  /** Fetch a note body into `noteContents` (no layout change). Self-heals stale tabs. */
  const loadNoteContent = useCallback(async (noteId: string) => {
    // A not-yet-persisted draft lives only in the client; don't fetch it (404).
    if (unsavedNoteIdsRef.current.has(noteId)) return;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${noteId}`);

      // Shortcut URL check
      const content = data.note.content.trim();
      if (content.startsWith(CHAT_NOTE_MARKER)) {
        closeTab(noteId);
        openChatChannel(noteId, data.note.title);
        return;
      }

      setNoteContents((prev) => {
        const existing = prev[noteId];
        const isDirty = existing ? existing.draft !== existing.note.content : false;
        return { ...prev, [noteId]: { note: data.note, draft: isDirty ? existing!.draft : data.note.content } };
      });
      setOpenTabs((prev) => prev.map((t) => (t.id === noteId ? { ...t, title: data.note.title, type: 'note' } : t)));
    } catch (error) {
      console.error('Error loading note:', error);
      setOpenTabs((prev) => prev.filter((t) => t.id !== noteId));
      setNoteContents((prev) => { const next = { ...prev }; delete next[noteId]; return next; });
      setLayout((prev) => Layout.simplify(Layout.removeTab(prev, noteId)));
      setNotice('That note could not be opened — it may have been moved or deleted. Refreshing the list.');
      if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current);
    }
  }, [loadVaultData, closeTab, openChatChannel]);

  /**
   * Open a note: ensure it has a tab, focus the pane that already shows it, or
   * place it in the focused pane. `replace` swaps the focused pane's active tab
   * only when the note is not already open (used by single-click in the sidebar).
   */
  const openNote = useCallback((noteId: string, mode: 'open' | 'replace' = 'open') => {
    // Check if the note is a shortcut URL in the summary list
    const summary = notesRef.current.find((n) => n.id === noteId);
    if (summary) {
      const preview = summary.content_preview.trim();
      if (preview.startsWith(CHAT_NOTE_MARKER)) {
        openChatChannel(noteId, summary.title, mode);
        return;
      }
    }

    setOpenTabs((prev) =>
      prev.some((t) => t.id === noteId) ? prev : [...prev, { id: noteId, title: 'Untitled Note', type: 'note', dirty: false }],
    );

    const prev = layoutRef.current;
    const focused = focusedPaneRef.current;
    const existingPane = Layout.findPaneByTab(prev, noteId);

    if (existingPane) {
      setLayout(Layout.setActiveTab(prev, existingPane.id, noteId));
      setFocusedPaneId(existingPane.id);
    } else {
      let next = Layout.addTabToPane(Layout.removeTab(prev, noteId), focused.id, noteId);
      const oldId = focused.activeTabId;
      if (mode === 'replace' && oldId && oldId !== noteId) {
        next = Layout.removeTab(next, oldId);
        setOpenTabs((p) => p.filter((t) => t.id !== oldId));
        setNoteContents((p) => { const copy = { ...p }; delete copy[oldId]; return copy; });
      }
      setLayout(Layout.simplify(next));
      setFocusedPaneId(focused.id);
    }

    void loadNoteContent(noteId);
  }, [loadNoteContent, openChatChannel]);

  /** Save a specific note tab's draft. */
  const saveNoteTab = useCallback(async (tabId: string) => {
    const entry = noteContentsRef.current[tabId];
    if (!entry) return;
    try {
      if (unsavedNoteIdsRef.current.has(tabId)) {
        // Deferred creation: only persist a new note once it has real content,
        // so blank tabs never reach the vault. Created under the id already in
        // use by the tab/layout, so nothing needs remapping.
        if (!entry.draft.trim()) return;
        const vaultId = activeVaultIdRef.current;
        if (!vaultId) return;
        const created = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
          method: 'POST',
          body: JSON.stringify({
            id: tabId,
            title: 'Untitled Note',
            content: entry.draft,
            folder_id: entry.note.folder_id ?? undefined,
            // Human-authored drafts stay listed unless this draft was unlisted.
            is_listed: entry.note.is_listed !== 0,
          }),
        });
        unsavedNoteIdsRef.current.delete(tabId);
        setNoteContents((prev) => ({ ...prev, [tabId]: { note: created.note, draft: created.note.content } }));
        setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title: created.note.title, dirty: false } : t)));
        if (vaultId) void loadVaultData(vaultId);
        return created.note;
      }
      const data = await api<{ note: Note }>(`/api/notes/${tabId}`, {
        method: 'PUT',
        body: JSON.stringify({ content: entry.draft }),
      });
      setNoteContents((prev) => ({ ...prev, [tabId]: { note: data.note, draft: data.note.content } }));
      setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title: data.note.title, dirty: false } : t)));
      if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current);
      return data.note;
    } catch (error) {
      console.error('Error saving note:', error);
      throw error;
    }
  }, [loadVaultData]);

  /** Save whichever note is in the focused pane (Ctrl+S, AI panel). */
  const handleSaveActiveNote = useCallback(() => {
    const tabId = focusedPaneRef.current.activeTabId;
    return tabId ? saveNoteTab(tabId) : Promise.resolve(undefined);
  }, [saveNoteTab]);

  /** Track edits to a note tab's body and update its dirty flag. */
  const handleNoteChange = useCallback((tabId: string, newContent: string) => {
    setNoteContents((prev) => {
      const entry = prev[tabId];
      if (!entry) return prev;
      return { ...prev, [tabId]: { ...entry, draft: newContent } };
    });
    setOpenTabs((prev) => prev.map((t) => {
      if (t.id !== tabId) return t;
      const entry = noteContentsRef.current[tabId];
      return { ...t, dirty: entry ? newContent !== entry.note.content : false };
    }));
  }, []);

  /** Rename a note tab (title + on-disk file + wikilink references). */
  const renameNoteTab = useCallback(async (tabId: string, title: string) => {
    try {
      const data = await api<{ note: Note }>(`/api/notes/${tabId}/rename`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      setNoteContents((prev) => (prev[tabId] ? { ...prev, [tabId]: { ...prev[tabId], note: data.note } } : prev));
      setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title: t.type === 'chat' ? `#${data.note.title}` : data.note.title } : t)));
      if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not rename note');
      throw error; // let the editor revert its title draft
    }
  }, [loadVaultData]);

  // Per-tab callback caches so NoteEditor (React.memo'd) gets a referentially
  // stable onContentChange/onSave/onRename each render instead of a fresh
  // closure — otherwise every App re-render (e.g. on chat stream ticks) busts
  // the memo for every open note tab, not just the one that changed.
  const noteChangeHandlers = useRef(new Map<string, (content: string) => void>());
  const getNoteChangeHandler = useCallback((tabId: string) => {
    let fn = noteChangeHandlers.current.get(tabId);
    if (!fn) {
      fn = (content: string) => handleNoteChange(tabId, content);
      noteChangeHandlers.current.set(tabId, fn);
    }
    return fn;
  }, [handleNoteChange]);

  const noteSaveHandlers = useRef(new Map<string, () => void>());
  const getNoteSaveHandler = useCallback((tabId: string) => {
    let fn = noteSaveHandlers.current.get(tabId);
    if (!fn) {
      fn = () => { void saveNoteTab(tabId); };
      noteSaveHandlers.current.set(tabId, fn);
    }
    return fn;
  }, [saveNoteTab]);

  const noteRenameHandlers = useRef(new Map<string, (title: string) => Promise<void>>());
  const getNoteRenameHandler = useCallback((tabId: string) => {
    let fn = noteRenameHandlers.current.get(tabId);
    if (!fn) {
      fn = (title: string) => renameNoteTab(tabId, title);
      noteRenameHandlers.current.set(tabId, fn);
    }
    return fn;
  }, [renameNoteTab]);

  const handleOpenWikilink = useCallback((title: string) => {
    const target = notesRef.current.find((n) => n.title.toLowerCase() === title.toLowerCase());
    if (target) openNote(target.id);
  }, [openNote]);

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
    joinActiveVault();
    socket.on('connect', joinActiveVault);
    syncChatPresenceRooms(socket);

    const handleNoteChanged = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      void loadVaultData(activeVaultId);
      // Refresh the body only if the note is open and has no unsaved edits.
      const entry = noteContentsRef.current[data.noteId];
      if (entry && entry.draft === entry.note.content) void loadNoteContent(data.noteId);
    };
    const handleNoteCreated = (data: { vaultId: string }) => {
      if (data.vaultId === activeVaultId) void loadVaultData(activeVaultId);
    };
    const handleNoteDeleted = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      void loadVaultData(activeVaultId);
      closeTabRef.current(data.noteId);
    };
    const handleFeedNotify = (data: { noteId: string; feedTitle: string; item?: { title?: string } }) => {
      const title = data.item?.title || 'New feed item';
      setNotice(`${data.feedTitle}: ${title}`);
      if (!('Notification' in window)) return;
      const show = () => {
        const n = new Notification(data.feedTitle || 'Cascade feed update', { body: title });
        n.onclick = () => { window.focus(); openNote(data.noteId); };
      };
      if (Notification.permission === 'granted') show();
      else if (Notification.permission === 'default') void Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
    };

    const handleChatMessageCreated = (data: { vaultId: string; channelId: string; message: ChatMessage }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatState((prev) => {
        const existing = prev.messagesByChannel[data.channelId] ?? [];
        if (existing.some((message) => message.id === data.message.id)) return prev;
        return {
          ...prev,
          messagesByChannel: {
            ...prev.messagesByChannel,
            [data.channelId]: [...existing, data.message],
          },
        };
      });

      // Agents normally post their real reply through `cascade-chat send`.
      // Those messages bypass the run-completion chain below because the run
      // bubble is suppressed to avoid a duplicate reply. Chain from this
      // settled, agent-authored message instead; never from "Thinking...".
      if (data.message.status) return;
      const registrations = chatStateRef.current.registeredAgentsByChannel[data.channelId] ?? [];
      const source = resolveAgentMessageRegistration(data.message, registrations);
      if (!source) return;
      const targets = getMentionedRegistrations(
        data.message.body,
        registrations.filter((item) => item.id !== source.id),
        true,
      );
      const prompt = stripRegisteredAgentMentions(data.message.body, registrations) || data.message.body;
      for (const target of targets) {
        const key = `${data.message.id}:${target.id}`;
        if (chainedAgentMessageIdsRef.current.has(key)) continue;
        chainedAgentMessageIdsRef.current.add(key);
        startAgentChatRunRef.current?.(data.channelId, target, prompt, data.message);
      }
    };
    const handleChatMessageUpdated = (data: { vaultId: string; channelId: string; message: ChatMessage }) => {
      if (data.vaultId !== activeVaultId) return;
      // Terminal empty agent shells (dual-post suppress after cascade-chat send)
      // must not stick around as blank "(message)" bubbles in the live UI.
      const remoteBody = String(data.message.body || '').trim();
      const isEmptyAgentShell = Boolean(
        data.message.agentId
        && data.message.status !== 'running'
        && (!remoteBody || remoteBody === 'Thinking...'),
      );
      setChatState((prev) => {
        const existing = prev.messagesByChannel[data.channelId] ?? [];
        if (isEmptyAgentShell) {
          const next = existing.filter((message) => message.id !== data.message.id);
          if (next.length === existing.length && !existing.some((m) => m.id === data.message.id)) {
            return prev; // never insert an empty shell
          }
          return {
            ...prev,
            messagesByChannel: {
              ...prev.messagesByChannel,
              [data.channelId]: next,
            },
          };
        }
        const index = existing.findIndex((message) => message.id === data.message.id);
        if (index === -1) {
          return {
            ...prev,
            messagesByChannel: {
              ...prev.messagesByChannel,
              [data.channelId]: [...existing, data.message],
            },
          };
        }
        const next = [...existing];
        const local = existing[index];
        if (streamingChatMessageIdsRef.current.has(data.message.id)) {
          if (data.message.status === 'running') return prev;
          next[index] = mergeRemoteChatMessage(local, data.message);
        } else {
          next[index] = mergeRemoteChatMessage(local, data.message);
        }
        return {
          ...prev,
          messagesByChannel: {
            ...prev.messagesByChannel,
            [data.channelId]: next,
          },
        };
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
    const handleChatPresence = (data: { vaultId: string; channelId: string; participants: string[]; online: string[]; owner?: string }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatPresenceByChannel((prev) => ({
        ...prev,
        [data.channelId]: {
          participants: data.participants ?? [],
          online: data.online ?? [],
          owner: data.owner ?? '',
        },
      }));
    };

    socket.on('vault:noteChanged', handleNoteChanged);
    socket.on('vault:noteCreated', handleNoteCreated);
    socket.on('vault:noteDeleted', handleNoteDeleted);
    socket.on('vault:feedNotify', handleFeedNotify);
    socket.on('vault:chatMessageCreated', handleChatMessageCreated);
    socket.on('vault:chatMessageUpdated', handleChatMessageUpdated);
    socket.on('vault:chatAgentMemberUpserted', handleChatAgentMemberUpserted);
    socket.on('vault:chatAgentMemberRemoved', handleChatAgentMemberRemoved);
    socket.on('vault:chatPresence', handleChatPresence);
    return () => {
      socket.off('connect', joinActiveVault);
      for (const channelId of [...joinedChatChannelsRef.current]) {
        socket.emit('leaveChatChannel', channelId);
      }
      joinedChatChannelsRef.current.clear();
      socket.emit('leaveVault', activeVaultId);
      vaultSocketRef.current = null;
      socket.off('vault:noteChanged', handleNoteChanged);
      socket.off('vault:noteCreated', handleNoteCreated);
      socket.off('vault:noteDeleted', handleNoteDeleted);
      socket.off('vault:feedNotify', handleFeedNotify);
      socket.off('vault:chatMessageCreated', handleChatMessageCreated);
      socket.off('vault:chatMessageUpdated', handleChatMessageUpdated);
      socket.off('vault:chatAgentMemberUpserted', handleChatAgentMemberUpserted);
      socket.off('vault:chatAgentMemberRemoved', handleChatAgentMemberRemoved);
      socket.off('vault:chatPresence', handleChatPresence);
      socket.disconnect();
    };
  }, [activeVaultId, loadVaultData, loadNoteContent, openNote, syncChatPresenceRooms]);

  useEffect(() => {
    const socket = vaultSocketRef.current;
    if (!socket?.connected || !activeVaultId) return;
    syncChatPresenceRooms(socket);
  }, [activeVaultId, syncChatPresenceRooms]);

  // ═══════════════════════════════════════════════════════════════
  // NOTE / FOLDER OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Open a brand-new note as a client-only draft in `paneId` (or the focused
   * pane). Nothing is written to the server until the user types content and
   * saves — see saveNoteTab. The id is a real UUID minted here, so persisting
   * later needs no tab/layout remap.
   */
  const openDraftNote = useCallback((paneId: string | null, folderId: string | null) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const note: Note = {
      id, vault_id: vaultId, folder_id: folderId, title: 'Untitled Note',
      content_preview: '', is_pinned: 0, is_archived: 0, is_listed: 1, word_count: 0,
      created_at: now, updated_at: now, tags: [], content: '', file_path: '',
    };
    unsavedNoteIdsRef.current.add(id);
    setNoteContents((prev) => ({ ...prev, [id]: { note, draft: '' } }));
    setOpenTabs((prev) => [...prev, { id, title: 'Untitled Note', type: 'note', dirty: false }]);
    const targetPane = paneId ?? focusedPaneRef.current.id;
    setLayout(Layout.simplify(Layout.addTabToPane(Layout.removeTab(layoutRef.current, id), targetPane, id)));
    setFocusedPaneId(targetPane);
  }, []);

  const handleCreateNote = useCallback(() => openDraftNote(null, null), [openDraftNote]);

  const handleCreateNoteInPane = useCallback((paneId: string) => openDraftNote(paneId, null), [openDraftNote]);

  const handleCreateChatInPane = useCallback(async (paneId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'new-channel', content: CHAT_NOTE_MARKER }),
      });
      await loadVaultData(vaultId);
      const tab: Tab = { id: data.note.id, title: `#${data.note.title || 'new-channel'}`, type: 'chat', dirty: false };
      setOpenTabs((prev) =>
        prev.some((t) => t.id === tab.id)
          ? prev.map((t) => (t.id === tab.id ? { ...t, ...tab } : t))
          : [...prev, tab],
      );
      setLayout(Layout.simplify(Layout.addTabToPane(Layout.removeTab(layoutRef.current, tab.id), paneId, tab.id)));
      setFocusedPaneId(paneId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create channel');
    }
  }, [loadVaultData]);

  const handleDeleteNote = useCallback(async (noteId: string) => {
    if (!window.confirm('Delete this note? This cannot be undone.')) return;
    try {
      const wasChatChannel = notesRef.current.find((note) => note.id === noteId)?.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
      await api(`/api/notes/${noteId}`, { method: 'DELETE' });
      closeTabRef.current(noteId);
      if (wasChatChannel) {
        setChatState((prev) => {
          const messagesByChannel = { ...prev.messagesByChannel };
          delete messagesByChannel[noteId];
          return { ...prev, messagesByChannel };
        });
      }
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete note');
    }
  }, [loadVaultData]);

  const handleMoveNote = useCallback(async (noteId: string, folderId: string | null) => {
    try {
      await api(`/api/notes/${noteId}/move`, { method: 'POST', body: JSON.stringify({ folder_id: folderId }) });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not move note');
    }
  }, [loadVaultData]);

  const handleUnlistNote = useCallback(async (noteId: string) => {
    try {
      await api(`/api/notes/${noteId}/unlist`, { method: 'POST' });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not unlink note');
    }
  }, [loadVaultData]);

  const handleCreateFolder = useCallback(async (parentId: string | null = null) => {
    if (!activeVaultIdRef.current) return undefined;
    try {
      const data = await api<{ folder: Folder }>(`/api/vaults/${activeVaultIdRef.current}/folders`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Folder', parent_id: parentId ?? undefined }),
      });
      await loadVaultData(activeVaultIdRef.current);
      return data.folder;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create folder');
      return undefined;
    }
  }, [loadVaultData]);

  const handleRenameFolder = useCallback(async (folderId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await api(`/api/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ name: trimmed }) });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not rename folder');
    }
  }, [loadVaultData]);

  const handleMoveFolder = useCallback(async (folderId: string, parentId: string | null, position: number) => {
    try {
      await api(`/api/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ parent_id: parentId, position }) });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not move folder');
    }
  }, [loadVaultData]);

  const handleDeleteFolder = useCallback(async (folderId: string) => {
    if (!window.confirm('Delete this folder? Notes inside it move to the parent folder.')) return;
    try {
      await api(`/api/folders/${folderId}`, { method: 'DELETE' });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete folder');
    }
  }, [loadVaultData]);

  const handleCreateNoteInFolder = useCallback((folderId: string | null) => openDraftNote(null, folderId), [openDraftNote]);

  const handleExecuteDirective = useCallback((text: string) => {
    const run = async () => {
      const vaultId = activeVaultIdRef.current;
      if (!vaultId) return;
      let channel = notesRef.current.find((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      let channelInfo = channel ? { id: channel.id, title: channel.title } : null;
      if (!channel) {
        const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
          method: 'POST',
          body: JSON.stringify({ title: 'agent-chat', content: CHAT_NOTE_MARKER }),
        });
        await loadVaultData(vaultId);
        channelInfo = { id: data.note.id, title: data.note.title };
      }
      if (!channelInfo) return;
      openChatChannel(channelInfo.id, channelInfo.title);
      handleSendChatMessage(channelInfo.id, `@claude ${text}`);
    };
    void run().catch((error) => {
      setNotice(error instanceof Error ? error.message : 'Could not start agent chat');
    });
  }, [handleSendChatMessage, loadVaultData, openChatChannel]);

  // ═══════════════════════════════════════════════════════════════
  // TAB / PANE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /** Select a tab inside a specific pane (per-pane strip click). */
  const selectTabInPane = useCallback((paneId: string, tabId: string) => {
    setLayout(Layout.setActiveTab(layoutRef.current, paneId, tabId));
    setFocusedPaneId(paneId);
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (tab?.type === 'note' && !noteContentsRef.current[tabId]) void loadNoteContent(tabId);
    if (tab?.type === 'chat') ensureChatChannelLoaded(tabId);
  }, [loadNoteContent, ensureChatChannelLoaded]);

  /** Handle a tab dropped onto a pane (drag-tile). */
  const handleDropTab = useCallback((payload: TabDragPayload, targetPaneId: string, side: Layout.DropSide, index?: number) => {
    const prev = layoutRef.current;
    const next = side === 'center'
      ? Layout.moveTab(prev, payload.tabId, targetPaneId, index)
      : Layout.splitPaneWithTab(prev, targetPaneId, side, payload.tabId);
    setLayout(next);
    const landed = Layout.findPaneByTab(next, payload.tabId);
    setFocusedPaneId(landed?.id ?? targetPaneId);
  }, []);

  const handleResizeSplit = useCallback((splitId: string, sizes: number[]) => {
    setLayout(Layout.setSplitSizes(layoutRef.current, splitId, sizes));
  }, []);

  /**
   * A tab was dragged out of the window. Ask the main process to pop it into a
   * new OS window at the cursor; if it did (drop was outside this window), drop
   * the tab from this window's layout so it lives in exactly one place.
   */
  const handleDetachTab = useCallback((tabId: string, screenX: number, screenY: number) => {
    const electronAPI = (window as unknown as {
      electronAPI?: { popOutTab?: (input: { tab: Tab; screenX: number; screenY: number }) => Promise<{ success: boolean; popped?: boolean }> };
    }).electronAPI;
    if (!electronAPI?.popOutTab) return;
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.type !== 'note') return;
    void electronAPI.popOutTab({ tab, screenX, screenY }).then((res) => {
      if (!res?.popped) return;
      setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
      setNoteContents((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
      setLayout(Layout.simplify(Layout.removeTab(layoutRef.current, tabId)));
    });
  }, []);

  // Adopt a tab merged back in from a popped-out window (it was dragged onto
  // this window). Dock it into the focused pane and load its body if a note.
  useEffect(() => {
    const electronAPI = (window as unknown as {
      electronAPI?: { onAdoptTab?: (cb: (tab: Tab) => void) => () => void };
    }).electronAPI;
    if (!electronAPI?.onAdoptTab) return;
    return electronAPI.onAdoptTab((tab) => {
      if (!tab || typeof tab.id !== 'string') return;
      if (tab.type !== 'note') return;
      setOpenTabs((prev) =>
        prev.some((t) => t.id === tab.id) ? prev.map((t) => (t.id === tab.id ? { ...t, ...tab } : t)) : [...prev, tab],
      );
      const paneId = focusedPaneRef.current.id;
      setLayout(Layout.simplify(Layout.addTabToPane(Layout.removeTab(layoutRef.current, tab.id), paneId, tab.id)));
      setFocusedPaneId(paneId);
      if (tab.type === 'note') void loadNoteContent(tab.id);
    });
  }, [loadNoteContent]);

  /** Split the focused pane to the right (Ctrl/Cmd+Shift+\). */
  const splitFocusedPane = useCallback(() => {
    const focused = focusedPaneRef.current;
    if (!focused.activeTabId) return;
    const next = Layout.splitPaneWithTab(layoutRef.current, focused.id, 'right', focused.activeTabId);
    setLayout(next);
    const landed = Layout.findPaneByTab(next, focused.activeTabId);
    if (landed) setFocusedPaneId(landed.id);
  }, []);

  // After login/reload, fetch bodies for the note tabs that are visible in panes.
  const didRestoreSessionRef = useRef(false);
  useEffect(() => {
    if (didRestoreSessionRef.current || !activeVaultId) return;
    didRestoreSessionRef.current = true;
    Layout.getActiveTabIds(layoutRef.current).forEach((id) => {
      if (openTabsRef.current.find((t) => t.id === id)?.type === 'note') void loadNoteContent(id);
    });
  }, [activeVaultId, loadNoteContent]);

  // ═══════════════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════════════

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthError('');
    setAuthNotice('');
    try {
      if (authMode === 'reset') {
        // Redeem an owner-issued reset token; the server logs us straight in.
        const data = await api<{ user: User; token: string; owner?: boolean }>('/api/auth/reset', {
          method: 'POST',
          body: JSON.stringify({ token: resetToken.trim(), newPassword: password }),
        });
        localStorage.setItem('docs_token', data.token);
        setUser(data.user);
        setIsOwner(Boolean(data.owner));
        setPassword('');
        setResetToken('');
        await loadVaults();
        return;
      }
      const inviteMatch = window.location.pathname.match(/^\/invite\/([^/]+)$/);
      const inviteToken = inviteMatch ? decodeURIComponent(inviteMatch[1]) : '';
      const data = await api<{ user: User; token: string; owner?: boolean }>(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password, ...(authMode === 'register' && inviteToken ? { inviteToken } : {}) }),
      });
      localStorage.setItem('docs_token', data.token);
      setUser(data.user);
      setIsOwner(Boolean(data.owner));
      setPassword('');
      await loadVaults();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed');
    }
  }

  const handleLogout = () => {
    const pane = Layout.createPane();
    runSocketsRef.current.forEach((socket) => socket.disconnect());
    runSocketsRef.current.clear();
    localStorage.removeItem('docs_token');
    setUser(null);
    setIsOwner(false);
    setAdminOpen(false);
    setVaults([]);
    setActiveVaultId(null);
    setFolders([]);
    setNotes([]);
    setOpenTabs([]);
    setLayout(pane);
    setFocusedPaneId(pane.id);
    setNoteContents({});
  };

  // ═══════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════════

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'p') { e.preventDefault(); setCommandPaletteOpen((v) => !v); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearchOpen((v) => !v); }
      if (mod && e.key === '\\' && !(e.altKey || e.shiftKey)) { e.preventDefault(); setSidebarOpen((v) => !v); }
      if (mod && !e.shiftKey && e.key === 'n') { e.preventDefault(); void handleCreateNote(); }
      if (mod && e.key === 's') { e.preventDefault(); void handleSaveActiveNote(); }
      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const id = focusedPaneRef.current.activeTabId;
        if (id) closeTab(id);
      }
      if (mod && (e.altKey || e.shiftKey) && (e.key === '\\' || e.key === '|')) { e.preventDefault(); splitFocusedPane(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCreateNote, handleSaveActiveNote, closeTab, splitFocusedPane]);

  // Chromium-reserved shortcuts forwarded from the Electron main process.
  useEffect(() => {
    const electronAPI = (window as unknown as { electronAPI?: { onShortcut?: (cb: (a: string) => void) => () => void } }).electronAPI;
    if (!electronAPI?.onShortcut) return;
    return electronAPI.onShortcut((action) => {
      if (action === 'new-note') void handleCreateNote();
      else if (action === 'toggle-sidebar') setSidebarOpen((v) => !v);
    });
  }, [handleCreateNote]);

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  /** Render the content of a tab inside its pane. */
  const renderTabContent = useCallback((tab: Tab): ReactNode => {
    if (tab.type === 'chat') {
      const channel = notes.find((note) => note.id === tab.id && note.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      if (!channel) return <div className="pane-empty">Channel not found</div>;
      return (
        <ChatView
          channelId={channel.id}
          channelName={channel.title}
          messages={chatState.messagesByChannel[channel.id] ?? []}
          isLoadingMessages={loadingChatChannels[channel.id] === true}
          currentUser={currentUsername}
          presence={chatPresenceByChannel[channel.id] ?? { participants: [], online: [] }}
          availableAgents={availableChatAgents}
          registeredAgents={chatState.registeredAgentsByChannel[channel.id] ?? []}
          vaultAgents={vaultAgents}
          runnerHealth={runnerHealth}
          onRegisterAgent={handleRegisterChatAgent}
          onRemoveAgent={handleRemoveChatAgent}
          onUpsertVaultAgent={handleUpsertVaultAgent}
          onDeleteVaultAgent={handleDeleteVaultAgent}
          onAddVaultAgentToChannel={handleAddVaultAgentToChannel}
          onCreateInviteLink={handleCreateChatInviteLink}
          onInviteUser={handleInviteChatUser}
          onRemoveParticipant={handleRemoveChatParticipant}
          onLeaveChannel={handleLeaveChatChannel}
          onSendMessage={handleSendChatMessage}
          onCancelRun={handleCancelChatRun}
          notes={notes}
          onOpenNote={openNote}
          onOpenSharedNote={handleOpenSharedChatNote}
          membersOpen={chatMembersOpen}
          onMembersOpenChange={setChatMembersOpen}
          vaultId={activeVaultId || undefined}
          onHydrateMessage={handleHydrateChatMessage}
        />
      );
    }
    const entry = noteContents[tab.id];
    return (
      <Suspense fallback={<div className="editor-loading" />}>
        <NoteEditor
          note={entry?.note ?? null}
          content={entry?.draft ?? ''}
          onContentChange={getNoteChangeHandler(tab.id)}
          onSave={getNoteSaveHandler(tab.id)}
          onRename={getNoteRenameHandler(tab.id)}
          onExecuteDirective={handleExecuteDirective}
          onOpenWikilink={handleOpenWikilink}
          notes={notes}
          onOpenNote={openNote}
        />
      </Suspense>
    );
  }, [availableChatAgents, chatState.messagesByChannel, chatState.registeredAgentsByChannel, chatPresenceByChannel, currentUsername, loadingChatChannels, runnerHealth, vaultAgents, handleCancelChatRun, handleCreateChatInviteLink, handleInviteChatUser, handleRemoveChatParticipant, handleLeaveChatChannel, handleRegisterChatAgent, handleRemoveChatAgent, handleUpsertVaultAgent, handleDeleteVaultAgent, handleAddVaultAgentToChannel, handleSendChatMessage, noteContents, notes, getNoteChangeHandler, getNoteSaveHandler, getNoteRenameHandler, handleExecuteDirective, handleOpenWikilink, openNote, chatMembersOpen, activeVaultId, handleHydrateChatMessage, handleOpenSharedChatNote]);

  if (!user) {
    const hasInvite = /^\/invite\/[^/]+$/.test(window.location.pathname);
    return (
      <main className="auth-shell">
        <form className="auth-panel" id="auth-panel" onSubmit={submitAuth}>
          <div className="auth-brand" aria-label="Cascade Notes">
            <Gem size={24} aria-hidden="true" />
            <h1>Cascade</h1>
          </div>
          <div className="auth-decal" aria-hidden="true" />
          {authMode === 'reset' ? (
            <>
              <p className="auth-hint">Paste the reset token the server owner gave you, then choose a new password.</p>
              <label htmlFor="reset-token">
                Reset token
                <input id="reset-token" value={resetToken} onChange={(e) => setResetToken(e.target.value)} autoComplete="off" autoFocus />
              </label>
              <label htmlFor="password">
                New password
                <input id="password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" />
              </label>
            </>
          ) : (
            <>
              <label htmlFor="username">
                Username
                <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
              </label>
              <label htmlFor="password">
                Password
                <input id="password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} />
              </label>
            </>
          )}
          {authNotice && <div className="auth-notice">{authNotice}</div>}
          {authError && <div className="error">{authError}</div>}
          <button id="auth-submit" type="submit">
            {authMode === 'login' ? 'Log in' : authMode === 'register' ? 'Create account' : 'Set new password'}
          </button>
          <button id="auth-toggle-mode" type="button" className="link-button" onClick={() => { setAuthError(''); setAuthNotice(''); setAuthMode(authMode === 'login' ? 'register' : 'login'); }}>
            {authMode === 'login' ? (hasInvite ? 'Create account for this invite' : 'Create account') : 'Already have an account? Log in'}
          </button>
          {authMode === 'login' && (
            <button type="button" className="link-button" onClick={() => { setAuthError(''); setAuthNotice(''); setAuthMode('reset'); }}>
              Forgot password?
            </button>
          )}
          {authMode === 'reset' && (
            <button type="button" className="link-button" onClick={() => { setAuthError(''); setAuthNotice(''); setAuthMode('login'); }}>
              Back to log in
            </button>
          )}
        </form>
      </main>
    );
  }

  return (
    <main
      className={`app-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}
      style={{
        display: 'grid',
        '--sidebar-width': `${sidebarWidth}px`,
        overflow: 'hidden',
        position: 'relative',
        transition: isResizing ? 'none' : undefined,
      } as CSSProperties}
    >
      {sidebarOpen && (
        <div className="resize-handle" style={{ left: sidebarWidth - 3 }} onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize" />
      )}

      {sidebarOpen && (
        <Sidebar
          user={user}
          isOwner={isOwner}
          onOpenAdmin={() => setAdminOpen(true)}
          vaults={vaults}
          activeVaultId={activeVaultId}
          folders={folders}
          notes={notes}
          activeNoteId={activeTabId}
          onSelectVault={setActiveVaultId}
          onSelectNote={(id) => {
            openNote(id, 'replace');
            if (isMobileViewport()) setSidebarOpen(false);
          }}
          onOpenNoteInNewTab={(id) => {
            openNote(id);
            if (isMobileViewport()) setSidebarOpen(false);
          }}
          onNewNote={() => {
            void handleCreateNote();
            if (isMobileViewport()) setSidebarOpen(false);
          }}
          onCreateChannel={async (folderId) => {
            const channel = await handleCreateChannel(folderId);
            if (isMobileViewport()) setSidebarOpen(false);
            return channel;
          }}
          onNewNoteInFolder={(folderId) => {
            void handleCreateNoteInFolder(folderId);
            if (isMobileViewport()) setSidebarOpen(false);
          }}
          onSearch={() => setSearchOpen(true)}
          onCollapse={() => setSidebarOpen(false)}
          onLogout={handleLogout}
          onDeleteNote={handleDeleteNote}
          onMoveNote={handleMoveNote}
          onUnlistNote={handleUnlistNote}
          onMoveFolder={handleMoveFolder}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onRenameNote={renameNoteTab}
          onDeleteFolder={handleDeleteFolder}
        />
      )}

      {/* Workspace */}
      <div className="workspace flex flex-col flex-1" style={{ height: '100%', overflow: 'hidden' }}>
        <div className="workspace-toolbar" style={{ alignItems: 'center', background: 'var(--bg-surface)', padding: '4px 8px', paddingTop: 'calc(4px + env(safe-area-inset-top))', gap: 4, borderBottom: '1px solid var(--border)' }}>
            {!sidebarOpen && (
              <button id="sidebar-expand-btn" className="btn-icon" onClick={() => { setSidebarOpen(true); setChatMembersOpen(false); }} title="Expand sidebar">
                <PanelLeftOpen size={16} />
              </button>
            )}
            <div style={{ flex: 1, minWidth: 0 }} />
            <button
              id="session-manager-btn"
              type="button"
              className="btn-icon workspace-session-btn"
              onClick={() => setSessionManagerOpen(true)}
              title="Inspect running AI sessions"
              aria-label="Inspect running AI sessions"
            >
              <Activity size={16} />
              {Boolean(runnerHealth?.activeRuns) && (
                <span className="workspace-session-badge">{runnerHealth!.activeRuns}</span>
              )}
            </button>
            {focusedIsChat && !chatMembersOpen && <button
              id="chat-members-expand-btn"
              type="button"
              className="btn-icon chat-members-toolbar-btn"
              onClick={() => {
                setChatMembersOpen(true);
                if (isMobileViewport()) setSidebarOpen(false);
              }}
              title="Show channel members"
              aria-label="Show channel members"
            >
              <Users size={16} />
            </button>}
          </div>

        <div className="flex-1" style={{ position: 'relative', display: 'flex', overflow: 'hidden' }}>
          <PaneGrid
            node={layout}
            openTabs={openTabs}
            focusedPaneId={focusedPaneId}
            onFocusPane={setFocusedPaneId}
            onSelectTab={selectTabInPane}
            onCloseTab={closeTab}
            onDropTab={handleDropTab}
            onResize={handleResizeSplit}
            onCreateNote={handleCreateNoteInPane}
            onCreateChat={handleCreateChatInPane}
            onDetachTab={handleDetachTab}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => {
              setSidebarOpen((open) => {
                const next = !open;
                if (next && isMobileViewport()) setChatMembersOpen(false);
                return next;
              });
            }}
            renderContent={renderTabContent}
          />
        </div>
      </div>
      <SessionManager
        open={sessionManagerOpen}
        vaultId={activeVaultId}
        runnerOnline={Boolean(runnerHealth?.online)}
        onClose={() => setSessionManagerOpen(false)}
        onOpenChat={(channelId) => {
          openNote(channelId);
          setSessionManagerOpen(false);
        }}
        onCancel={handleCancelChatRun}
        onInterrogate={(channelId, message) => handleSendChatMessage(channelId, message)}
      />

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} vaultId={activeVaultId} onSelectNote={(id) => openNote(id)} />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} notes={notes} onSelectNote={(id) => openNote(id)} onCreateNote={handleCreateNote} />
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
