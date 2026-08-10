import { useEffect, useState, useCallback, useRef, useMemo, lazy, Suspense, type CSSProperties, type ReactNode } from 'react';
import { Sidebar } from './components/Sidebar';
import { type Tab } from './components/TabBar';
import {
  acquireInteractionLock,
  bindDragGesture,
  installInteractionLockRecovery,
  releaseInteractionLock,
} from './ui/interactionLocks';

// CodeMirror (editor core plus every language mode via @codemirror/language-data)
// is the heaviest dependency in the app and is only needed once a note tab is
// actually open — keep it out of the initial chunk.
const NoteEditor = lazy(() =>
  import('./components/NoteEditor').then((m) => ({ default: m.NoteEditor })),
);
const ChatView = lazy(() =>
  import('./components/ChatView').then((m) => ({ default: m.ChatView })),
);
const SearchOverlay = lazy(() =>
  import('./components/SearchOverlay').then((m) => ({ default: m.SearchOverlay })),
);
const CommandPalette = lazy(() =>
  import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })),
);
const AdminPanel = lazy(() =>
  import('./components/AdminPanel').then((m) => ({ default: m.AdminPanel })),
);
const SessionManager = lazy(() =>
  import('./components/SessionManager').then((m) => ({ default: m.SessionManager })),
);
const SuperkanbanView = lazy(() =>
  import('./components/SuperkanbanView').then((m) => ({ default: m.SuperkanbanView })),
);
const AccountSettings = lazy(() =>
  import('./components/AccountSettings').then((m) => ({ default: m.AccountSettings })),
);
const DiscoveryDmsModal = lazy(() =>
  import('./components/DiscoveryDmsModal').then((m) => ({ default: m.DiscoveryDmsModal })),
);
const UpdatesModal = lazy(() =>
  import('./components/UpdatesModal').then((m) => ({ default: m.UpdatesModal })),
);
import type {
  ChatAgentRegistration,
  ChatBlock,
  ChatChannelPresence,
  ChatMediaAttachment,
  ChatMessage,
  ChatReplyRef,
  DesktopRunnerHealth,
  SharedChatNote,
  VaultAgent,
} from './components/ChatView';
import {
  canMergeChatMessages,
  CHAT_NOTE_MARKER,
  createChatAgentRegistrationId,
  dataUrlsToRunImages,
  mediaToRunImages,
  mergeChatPresence,
} from './chat/shared';
import { NewsTicker } from './components/NewsTicker';
import { PaneGrid, type TabDragPayload } from './components/PaneGrid';
import type { WorkItem } from './chat/workItems';
import type { DiscoveryTab } from './components/DiscoveryDmsModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import * as Layout from './layout/tree';
import type { LayoutNode } from './layout/tree';
import { api, ApiError, type CommunityUpdateItem, type CommunityUpdates, type User, type Vault, type VaultMember, type Folder, type NoteSummary, type Note } from './api';
import { connectRunsSocket, connectVaultSocket } from './socket';
import { isLocalRunId, cancelLocalAgentRun } from './localAgentRunner';
import { ensureDesktopRunnerHost, respondToAgentPermission, startDesktopRunnerHost } from './desktopRunnerHost';
import {
  agentsAfterLoadFailure,
  agentLabel,
  CHAT_AGENT_MODEL_PRESETS,
  CHAT_AGENTS,
  chatAgentConversation,
  formatAgentChatPrompt,
  needsCascadeWorkspaceContext,
  needsRecentChatContext,
  normalizeChatCwd,
  type AgentId,
} from './chat/agents';
import { buildQuotedReplyPrompt, getMentionedRegistrations, normalizeMention, precedingMessageBatch, precedingMessageBatchText, replyQuoteTargetsAgent, stripRegisteredAgentMentions } from './chat/mentions';
import type { ChatRelationship } from './chat/relationships';
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
  emptyWorkspace,
  loadChatState,
  loadPersistedSession,
  readLegacyLocalChatAgentMembers,
  readLegacyLocalChatMessages,
  SESSION_STORAGE_KEY,
  type ChatState,
  type PersistedSession,
  type PersistedWorkspace,
} from './chat/session';
import { chatMessageStore } from './chat/messageStore';
import { consumePendingSessionSteer, enqueueSessionTurn, findProjectedActiveSessionRun, forceReleasePriorSessionTurns, queuesBehindActiveSession, requestSessionSteer, shouldSteerActiveSession } from './chat/sessionTurns';
import { Activity, Bell, Download, PanelLeftOpen, Sparkles, Users } from 'lucide-react';
import { FizzerMark } from './components/FizzerMark';

type ChatAgentDispatch = {
  id: string;
  messageId: string;
  channelId: string;
  registration: ChatAgentRegistration;
  message: ChatMessage;
  runId: number | null;
  reasoningEffort?: string;
  createdAt: string;
};

type PersistedChatMessage = {
  message: ChatMessage;
  agents: ChatAgentRegistration[];
  dispatches: ChatAgentDispatch[];
};

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

// Module-level (not useRef): survives StrictMode remount and shares across any
// rapid remount so concurrent loadVaultData / message fetches coalesce to one
// network round-trip instead of stacking.
const loadVaultDataInflight = new Map<string, Promise<void>>();
const loadChatMessagesInflight = new Map<string, Promise<{ channelId: string; messages: ChatMessage[] }>>();

/** Stable empty so ChatView memo doesn't bust when a channel has no agents yet. */
const EMPTY_CHAT_AGENTS: ChatAgentRegistration[] = [];
const EMPTY_CHAT_PRESENCE: ChatChannelPresence = { participants: [], online: [], owner: '', profiles: {} };
const AVAILABLE_CHAT_AGENTS = CHAT_AGENTS.map((agent) => ({
  ...agent,
  models: CHAT_AGENT_MODEL_PRESETS[agent.id],
}));
const EMPTY_COMMUNITY_UPDATES: CommunityUpdates = {
  groups: [],
  counts: { total: 0, directMessages: 0, byVault: {}, byTarget: {} },
  truncated: false,
};

type AgentPermissionRequest = {
  runId: number;
  requestId: string;
  toolName: string;
  title: string;
  description?: string;
  blockedPath?: string;
};

export default function App() {
  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════

  const persistedSessionRef = useRef<PersistedSession>(loadPersistedSession());

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [discoveryDmsOpen, setDiscoveryDmsOpen] = useState<DiscoveryTab | null>(null);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [authEpoch, setAuthEpoch] = useState(0);
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'reset'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');

  // App data state
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activeVaultId, setActiveVaultIdState] = useState<string | null>(persistedSessionRef.current.activeVaultId);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [chatState, setChatState] = useState<ChatState>(loadChatState);
  const [loadingChatChannels, setLoadingChatChannels] = useState<Record<string, boolean>>({});
  const [chatPresenceByChannel, setChatPresenceByChannel] = useState<Record<string, ChatChannelPresence>>({});
  const [communityUpdates, setCommunityUpdates] = useState<CommunityUpdates>(EMPTY_COMMUNITY_UPDATES);
  const [communityUpdatesLoading, setCommunityUpdatesLoading] = useState(false);
  const [communityUpdatesError, setCommunityUpdatesError] = useState('');
  const [showAgentMemory, setShowAgentMemory] = useState(() => localStorage.getItem('cascade_show_agent_memory') === '1');

  // Tabs + tiling layout
  const [openTabs, setOpenTabs] = useState<Tab[]>(persistedSessionRef.current.openTabs);
  const [layout, setLayout] = useState<LayoutNode>(persistedSessionRef.current.layout);
  const [focusedPaneId, setFocusedPaneId] = useState<string>(persistedSessionRef.current.focusedPaneId);
  // Note bodies, keyed by tab id, so each note pane edits independently.
  const [noteContents, setNoteContents] = useState<Record<string, NoteEntry>>({});
  const [superkanbanNotes, setSuperkanbanNotes] = useState<Note[]>([]);
  const [superkanbanLiveWork, setSuperkanbanLiveWork] = useState<WorkItem[]>([]);
  const [superkanbanLoading, setSuperkanbanLoading] = useState(false);
  const [superkanbanError, setSuperkanbanError] = useState<string | null>(null);

  // UI panels state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('cascade_sidebar_w')) || 268);
  const [isResizing, setIsResizing] = useState(false);
  const mobileSidebarSwipeRef = useRef<{ x: number; y: number; at: number; pointerId: number } | null>(null);
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
  // Pending "jump to this chat message" target set when a chat search result is
  // opened; consumed by the matching ChatView, which scrolls to and highlights it.
  const [chatJumpTarget, setChatJumpTarget] = useState<{ channelId: string; messageId: string } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [runnerHealth, setRunnerHealth] = useState<DesktopRunnerHealth | null>(null);
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);
  const [agentPermissions, setAgentPermissions] = useState<AgentPermissionRequest[]>([]);
  const [vaultAgents, setVaultAgents] = useState<VaultAgent[]>([]);
  // ─── Derived focus state ────────────────────────────────────────
  const focusedPane = Layout.findPane(layout, focusedPaneId) ?? Layout.getFirstPane(layout);
  const activeTabId = focusedPane.activeTabId;
  const focusedTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const focusedIsChat = focusedTab?.type === 'chat';
  const vaultSidebarChannel = focusedIsChat
    ? focusedTab.id
    : notes.find((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))?.id;
  const currentUsername = user?.username ?? '';
  // Refs mirror the latest state so event handlers stay stable (no dep churn)
  // and never read a stale closure during drags / async work.
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const focusedPaneRef = useRef(focusedPane); focusedPaneRef.current = focusedPane;
  const openTabsRef = useRef(openTabs); openTabsRef.current = openTabs;
  const noteContentsRef = useRef(noteContents); noteContentsRef.current = noteContents;
  const activeVaultIdRef = useRef(activeVaultId); activeVaultIdRef.current = activeVaultId;
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
  // The actual run currently extending each backing session. A follow-up ping
  // interrupts this turn, then resumes its early-persisted CLI session from the
  // new message. Extra pings remain queued in order and interrupt the next turn.
  const activeAgentSessionRunRef = useRef<Map<string, number>>(new Map());
  const interruptedAgentSessionRunRef = useRef<Map<string, number>>(new Map());
  const pendingAgentSteerRef = useRef<Set<string>>(new Set());
  const pendingChatPatchRef = useRef<Map<string, ChatMessage>>(new Map());
  const chatPatchTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // One renderer can observe its own message POST over Socket.IO before the
  // response arrives. Keep durable dispatch recovery single-flight locally;
  // the server's unique dispatch key is the cross-renderer backstop.
  const startingChatDispatchesRef = useRef<Set<string>>(new Set());
  // Debounce socket-driven soft vault reloads (note create/change/delete bursts).
  const socketVaultReloadTimerRef = useRef<number | null>(null);
  const communityRefreshTimerRef = useRef<number | null>(null);
  const vaultWorkspacesRef = useRef<Record<string, PersistedWorkspace>>({
    ...persistedSessionRef.current.workspacesByVault,
  });
  // Draft bodies stay isolated with their vault while the app is open. They are
  // deliberately not written to localStorage; persisted tabs re-fetch bodies.
  const vaultNoteContentsRef = useRef<Record<string, Record<string, NoteEntry>>>({});

  const switchVaultWorkspace = useCallback((nextVaultId: string | null) => {
    const previousVaultId = activeVaultIdRef.current;
    if (previousVaultId === nextVaultId) return;

    if (previousVaultId) {
      vaultWorkspacesRef.current = {
        ...vaultWorkspacesRef.current,
        [previousVaultId]: {
          openTabs: openTabsRef.current,
          layout: layoutRef.current,
          focusedPaneId: focusedPaneRef.current.id,
        },
      };
      vaultNoteContentsRef.current = {
        ...vaultNoteContentsRef.current,
        [previousVaultId]: noteContentsRef.current,
      };
    }

    const workspace = nextVaultId
      ? vaultWorkspacesRef.current[nextVaultId] ?? emptyWorkspace()
      : emptyWorkspace();
    if (nextVaultId && !vaultWorkspacesRef.current[nextVaultId]) {
      vaultWorkspacesRef.current = { ...vaultWorkspacesRef.current, [nextVaultId]: workspace };
    }
    const nextNoteContents = nextVaultId ? vaultNoteContentsRef.current[nextVaultId] ?? {} : {};
    const nextFocusedPane = Layout.findPane(workspace.layout, workspace.focusedPaneId)
      ?? Layout.getFirstPane(workspace.layout);

    // Update the mirrors synchronously: invite/deep-link flows load the new
    // vault immediately after switching and must not read the previous tabs.
    activeVaultIdRef.current = nextVaultId;
    openTabsRef.current = workspace.openTabs;
    layoutRef.current = workspace.layout;
    focusedPaneRef.current = nextFocusedPane;
    noteContentsRef.current = nextNoteContents;
    notesRef.current = [];

    setActiveVaultIdState(nextVaultId);
    setOpenTabs(workspace.openTabs);
    setLayout(workspace.layout);
    setFocusedPaneId(nextFocusedPane.id);
    setNoteContents(nextNoteContents);
    setFolders([]);
    setNotes([]);
    setVaultAgents([]);
    setSuperkanbanNotes([]);
    setSuperkanbanLiveWork([]);
    setSuperkanbanLoading(false);
    setSuperkanbanError(null);
    setChatJumpTarget(null);
  }, []);

  const resetVaultWorkspaces = useCallback(() => {
    const workspace = emptyWorkspace();
    const firstPane = Layout.getFirstPane(workspace.layout);
    vaultWorkspacesRef.current = {};
    vaultNoteContentsRef.current = {};
    activeVaultIdRef.current = null;
    openTabsRef.current = [];
    layoutRef.current = workspace.layout;
    focusedPaneRef.current = firstPane;
    noteContentsRef.current = {};
    notesRef.current = [];
    setActiveVaultIdState(null);
    setOpenTabs([]);
    setLayout(workspace.layout);
    setFocusedPaneId(firstPane.id);
    setNoteContents({});
    setFolders([]);
    setNotes([]);
    setVaultAgents([]);
    setSuperkanbanNotes([]);
    setSuperkanbanLiveWork([]);
    setSuperkanbanLoading(false);
    setSuperkanbanError(null);
    setChatJumpTarget(null);
  }, []);

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
      const activeWorkspace: PersistedWorkspace = { openTabs, layout, focusedPaneId };
      if (activeVaultId) {
        vaultWorkspacesRef.current = {
          ...vaultWorkspacesRef.current,
          [activeVaultId]: activeWorkspace,
        };
      }
      const session: PersistedSession = {
        activeVaultId,
        ...activeWorkspace,
        workspacesByVault: vaultWorkspacesRef.current,
      };
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }, 250);
    return () => clearTimeout(id);
  }, [activeVaultId, openTabs, layout, focusedPaneId]);

  useEffect(() => {
    const id = window.setTimeout(() => {
    const { registeredAgentsByChannel: _agents, ...persistedChat } = chatState;
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
      return note ? { ...tab, title: note.title } : tab;
    }));
  }, [notes]);

  // Stuck body cursor/user-select (lost mouseup mid-resize) used to freeze
  // selection/clicks until a full app restart — recover on blur/Escape.
  useEffect(() => installInteractionLockRecovery(), []);

  /** Drag the sidebar divider. */
  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startSidebar = sidebarWidth;
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    setIsResizing(true);
    acquireInteractionLock({ cursor: 'col-resize' });
    bindDragGesture({
      onMove: (e) => {
        const delta = e.clientX - startX;
        setSidebarWidth(clamp(startSidebar + delta, 180, 480));
      },
      onEnd: () => {
        releaseInteractionLock();
        setIsResizing(false);
      },
    });
  }, [sidebarWidth]);

  // A left-edge gesture is deliberate enough to avoid stealing normal chat
  // swipes, but makes the hidden mobile drawer discoverable without hunting
  // for the tiny expand button.
  const beginMobileSidebarSwipe = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!isMobileViewport() || sidebarOpen) return;
    if (event.pointerType !== 'touch') return;
    mobileSidebarSwipeRef.current = { x: event.clientX, y: event.clientY, at: Date.now(), pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [sidebarOpen]);
  const finishMobileSidebarSwipe = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const start = mobileSidebarSwipeRef.current;
    mobileSidebarSwipeRef.current = null;
    if (!start || start.pointerId !== event.pointerId || !isMobileViewport() || sidebarOpen) return;
    const dx = event.clientX - start.x;
    const dy = Math.abs(event.clientY - start.y);
    if (Date.now() - start.at < 800 && dx >= 72 && dx > dy * 1.5) {
      setSidebarOpen(true);
      setChatMembersOpen(false);
    }
  }, [sidebarOpen]);

  // ═══════════════════════════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════════════════════════

  const loadVaults = useCallback(async () => {
    try {
      const data = await api<{ vaults: Vault[] }>('/api/vaults');
      let nextVaults = data.vaults;
      if (nextVaults.length === 0) {
        const created = await api<{ vault: Vault }>('/api/vaults', {
          method: 'POST',
          body: JSON.stringify({ name: 'My Vault' }),
        });
        nextVaults = [created.vault];
      }
      setVaults(nextVaults);
      const restoredVaultId = activeVaultIdRef.current;
      const restoredVaultValid = restoredVaultId && nextVaults.some((vault) => vault.id === restoredVaultId);
      if (!restoredVaultValid) {
        switchVaultWorkspace(nextVaults[0].id);
      }

      // Drop workspaces the signed-in account can no longer access. This also
      // prevents an invalid persisted vault from surviving an account change.
      const accessibleIds = new Set(nextVaults.map((vault) => vault.id));
      vaultWorkspacesRef.current = Object.fromEntries(
        Object.entries(vaultWorkspacesRef.current).filter(([vaultId]) => accessibleIds.has(vaultId)),
      );
      vaultNoteContentsRef.current = Object.fromEntries(
        Object.entries(vaultNoteContentsRef.current).filter(([vaultId]) => accessibleIds.has(vaultId)),
      );
    } catch (error) {
      console.error('Error loading vaults:', error);
    }
  }, [switchVaultWorkspace]);

  const loadCommunityUpdates = useCallback(async (quiet = false) => {
    if (!quiet) setCommunityUpdatesLoading(true);
    try {
      const data = await api<CommunityUpdates>(`/api/community/updates?limit=80${showAgentMemory ? '&includeAgentMemory=1' : ''}`);
      setCommunityUpdates(data);
      setCommunityUpdatesError('');
    } catch (error) {
      if (!quiet) setCommunityUpdatesError(error instanceof Error ? error.message : 'Could not load updates');
    } finally {
      if (!quiet) setCommunityUpdatesLoading(false);
    }
  }, [showAgentMemory]);

  const updateShowAgentMemory = useCallback((show: boolean) => {
    setShowAgentMemory(show);
    localStorage.setItem('cascade_show_agent_memory', show ? '1' : '0');
  }, []);

  const scheduleCommunityRefresh = useCallback((delay = 350) => {
    if (communityRefreshTimerRef.current != null) return;
    communityRefreshTimerRef.current = window.setTimeout(() => {
      communityRefreshTimerRef.current = null;
      void loadCommunityUpdates(true);
    }, delay);
  }, [loadCommunityUpdates]);

  const markCommunityTargetRead = useCallback(async (targetId: string) => {
    if (!targetId) return;
    try {
      await api('/api/community/updates/read', {
        method: 'POST',
        body: JSON.stringify({ targetId }),
      });
      await loadCommunityUpdates(true);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        console.error('Could not mark update read:', error);
      }
    }
  }, [loadCommunityUpdates]);

  const markAllCommunityUpdatesRead = useCallback(async () => {
    try {
      await api('/api/community/updates/read-all', { method: 'POST' });
      setCommunityUpdates(EMPTY_COMMUNITY_UPDATES);
      await loadCommunityUpdates(true);
    } catch (error) {
      setCommunityUpdatesError(error instanceof Error ? error.message : 'Could not mark updates read');
    }
  }, [loadCommunityUpdates]);

  useEffect(() => {
    if (!user) {
      setCommunityUpdates(EMPTY_COMMUNITY_UPDATES);
      return;
    }
    void loadCommunityUpdates();
    const timer = window.setInterval(() => void loadCommunityUpdates(true), 60_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleCommunityRefresh(150);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (communityRefreshTimerRef.current != null) {
        window.clearTimeout(communityRefreshTimerRef.current);
        communityRefreshTimerRef.current = null;
      }
    };
  }, [loadCommunityUpdates, scheduleCommunityRefresh, user]);

  const handleCreateVault = useCallback(async (name: string): Promise<boolean> => {
    if (!name.trim()) return false;
    try {
      const data = await api<{ vault: Vault }>('/api/vaults', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setVaults((current) => [...current, data.vault]);
      switchVaultWorkspace(data.vault.id);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create vault');
      return false;
    }
  }, [switchVaultWorkspace]);

  const handleRenameVault = useCallback(async (id: string, name: string): Promise<boolean> => {
    const next = name.trim();
    if (!next) return false;
    try {
      const data = await api<{ vault: Vault }>(`/api/vaults/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: next }),
      });
      setVaults((current) => current.map((vault) => (
        vault.id === id ? { ...vault, name: data.vault.name } : vault
      )));
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not rename vault');
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let succeeded = false;
    let unauthorized = false;
    let attempt = 0;
    let timer: number | null = null;
    const tryAuth = () => {
      api<{ authenticated: boolean; user?: User; owner?: boolean }>('/api/session')
        .then((data) => {
          if (cancelled) return;
          if (!data.authenticated || !data.user) {
            unauthorized = true;
            return;
          }
          succeeded = true;
          setUser(data.user);
          setIsOwner(Boolean(data.owner));
          void loadVaults();
        })
        .catch((error) => {
          if (cancelled) return;
          // A real 401 means no session. Transient network/deploy failures keep
          // retrying so an HttpOnly cookie is not mistaken for a logout.
          if (error instanceof ApiError && error.status === 401) {
            unauthorized = true;
            return;
          }
          attempt += 1;
          if (attempt > 6) return;
          timer = window.setTimeout(tryAuth, Math.min(1000 * 2 ** (attempt - 1), 15000));
        });
    };
    // If connectivity returns after the retries gave up, try again — a valid
    // token shouldn't strand the user on the login screen.
    const onReconnect = () => {
      if (cancelled || succeeded || unauthorized) return;
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

  useEffect(() => {
    const receivePermission = (event: Event) => {
      const request = (event as CustomEvent<AgentPermissionRequest>).detail;
      if (!request?.requestId) return;
      setAgentPermissions((current) => current.some((item) => item.requestId === request.requestId)
        ? current
        : [...current, request]);
    };
    window.addEventListener('cascade:agent-permission', receivePermission);
    return () => window.removeEventListener('cascade:agent-permission', receivePermission);
  }, []);

  const answerAgentPermission = useCallback(async (requestId: string, decision: 'allow' | 'deny') => {
    const answered = await respondToAgentPermission(requestId, decision).catch(() => false);
    if (!answered) setNotice('That permission request is no longer active.');
    setAgentPermissions((current) => current.filter((item) => item.requestId !== requestId));
  }, []);

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
    const sameHealth = (a: DesktopRunnerHealth | null, b: DesktopRunnerHealth): boolean => {
      if (!a) return false;
      if (a.online !== b.online) return false;
      if (a.activeRuns !== b.activeRuns) return false;
      if (a.lastError !== b.lastError) return false;
      if (a.lastErrorAt !== b.lastErrorAt) return false;
      // lastSeenAt ticks on every runner socket event — ignore for UI identity
      // or the 12s health poll re-renders the whole chat tree while streaming.
      if (a.planUsage === b.planUsage) return true;
      try {
        return JSON.stringify(a.planUsage) === JSON.stringify(b.planUsage);
      } catch {
        return false;
      }
    };
    const mergePlanUsage = (
      prev: DesktopRunnerHealth['planUsage'],
      next: DesktopRunnerHealth['planUsage'],
    ): DesktopRunnerHealth['planUsage'] => {
      // Keep last good per-provider snapshot so meters don't vanish on a miss.
      const merged: NonNullable<DesktopRunnerHealth['planUsage']> = { ...(prev || {}) };
      if (!next) return Object.keys(merged).length ? merged : null;
      for (const [key, value] of Object.entries(next)) {
        if (value?.status === 'ok') merged[key] = value;
        else if (!merged[key]) merged[key] = value;
      }
      return merged;
    };
    const apply = (data: DesktopRunnerHealth) => {
      setRunnerHealth((prev) => {
        const withUsage: DesktopRunnerHealth = {
          ...data,
          planUsage: mergePlanUsage(prev?.planUsage ?? null, data.planUsage),
        };
        return sameHealth(prev, withUsage) ? prev : withUsage;
      });
    };
    const tick = async () => {
      // Skip network work while the tab is hidden; resume on visibilitychange.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const data = await api<DesktopRunnerHealth>('/api/me/desktop-runner');
        if (!cancelled) apply(data);
      } catch {
        // A failed status request is transport-unknown, not proof that the
        // runner is offline. Keep the last confirmed snapshot (or null during
        // cold start) so a server/network blip cannot manufacture status UI.
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
          fetchOne = (async (): Promise<{ channelId: string; messages: ChatMessage[] }> => {
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
              const cached = chatMessageStore.hasChannel(channelId)
                ? chatMessageStore.getChannel(channelId)
                : undefined;
              return { channelId, messages: cached ?? legacyMessages[channelId] ?? [] };
            } finally {
              loadChatMessagesInflight.delete(inflightKey);
            }
          })();
          loadChatMessagesInflight.set(inflightKey, fetchOne);
        }

        const { messages } = await fetchOne;
        chatMessageStore.update(channelId, (existing) => {
          if (existing === messages) return existing;
          const cachedById = new Map(existing.map((message) => [message.id, message]));
          // Reconnect reconciliation intentionally fetches the slim transcript,
          // where data-URL images are represented only by `hasImages`. Merge it
          // over the live cache so a refresh cannot erase already hydrated media.
          return messages.map((message) => {
            const cached = cachedById.get(message.id);
            return cached ? mergeRemoteChatMessage(cached, message) : message;
          });
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
      chatMessageStore.update(channelId, (existing) => {
        const index = existing.findIndex((item) => item.id === data.message.id);
        if (index === -1) return existing;
        const next = [...existing];
        next[index] = mergeRemoteChatMessage(existing[index], data.message);
        return next;
      });
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
  }, [user, activeVaultId, notes, vaultSidebarChannel, ensureChatChannelLoaded]);

  /** Merge full message detail (harness log) after expand-fetch. */
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

  // ═══════════════════════════════════════════════════════════════
  // CHAT CHANNEL OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  const openChatChannel = useCallback((channelId: string, title: string, mode: 'open' | 'replace' = 'open') => {
    const name = title.trim() || 'chat';
    const tab: Tab = { id: channelId, title: name, type: 'chat', dirty: false };

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
        switchVaultWorkspace(data.vaultId);
        await loadVaultData(data.vaultId);
        openChatChannel(data.channelId, data.title || 'shared-chat', 'replace');
        window.history.replaceState({}, '', '/app.html');
        setNotice(`Added #${data.title || 'shared-chat'} to your vault.`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not accept invite link');
      }
    })();
  }, [loadVaultData, loadVaults, openChatChannel, switchVaultWorkspace, user]);

  const acceptVaultInvite = useCallback(async (token: string): Promise<boolean> => {
    try {
      const data = await api<{ vaultId: string; name: string; role: string; alreadyMember?: boolean }>(
        `/api/vault-invites/${encodeURIComponent(token)}/accept`,
        { method: 'POST' },
      );
      await loadVaults();
      switchVaultWorkspace(data.vaultId);
      await loadVaultData(data.vaultId);
      setNotice(data.alreadyMember
        ? `You already have access to ${data.name}.`
        : `Joined ${data.name} as ${data.role}.`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not accept invite link');
      return false;
    }
  }, [loadVaultData, loadVaults, switchVaultWorkspace]);

  const handleJoinVault = useCallback(async (inviteLink: string): Promise<boolean> => {
    try {
      const parsed = new URL(inviteLink, window.location.origin);
      const match = parsed.pathname.match(/^\/vault-invite\/([^/]+)$/);
      if (!match) throw new Error('Paste a valid vault invite link');
      return await acceptVaultInvite(decodeURIComponent(match[1]));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Paste a valid vault invite link');
      return false;
    }
  }, [acceptVaultInvite]);

  // Redeem a vault share link. Unlike the chat invite above this joins the
  // vault itself, so the whole vault appears in the switcher.
  useEffect(() => {
    const match = window.location.pathname.match(/^\/vault-invite\/([^/]+)$/);
    const token = match ? decodeURIComponent(match[1]) : '';
    if (!token || !user || acceptedInviteTokenRef.current === token) return;
    acceptedInviteTokenRef.current = token;
    (async () => {
      if (await acceptVaultInvite(token)) {
        window.history.replaceState({}, '', '/app.html');
      }
    })();
  }, [acceptVaultInvite, user]);

  const handleCreateChannel = useCallback(async (folderId: string | null = null) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return undefined;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'new-channel', content: CHAT_NOTE_MARKER, folder_id: folderId ?? undefined }),
      });
      await loadVaultData(vaultId);
      if (activeVaultIdRef.current !== vaultId) return undefined;
      openChatChannel(data.note.id, data.note.title);
      return { id: data.note.id, title: data.note.title };
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create channel');
      return undefined;
    }
  }, [loadVaultData, openChatChannel]);

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

  const handleRegisterChatAgent = useCallback((channelId: string, registration: ChatAgentRegistration, sourceVaultId?: string) => {
    const normalized = {
      ...registration,
      id: registration.id || createChatAgentRegistrationId(),
      vaultAgentId: registration.vaultAgentId || '',
      displayName: registration.displayName.trim() || agentLabel(registration.agentId as AgentId),
      mention: normalizeMention(registration.mention || registration.agentId),
      cwd: normalizeChatCwd(registration.cwd),
      orchestrator: registration.orchestrator === true,
      replyToEveryMessage: registration.replyToEveryMessage === true || registration.orchestrator === true,
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
    // A run may finish after the user has switched vaults. Persist session
    // adoption back to the vault that launched it, never whichever vault is
    // currently visible.
    const vaultId = sourceVaultId || activeVaultIdRef.current;
    if (vaultId) {
      void persistChatAgentMemberToServer(vaultId, channelId, normalized).then((saved) => {
        if (saved) {
          setChatState((prev) => ({
            ...prev,
            registeredAgentsByChannel: {
              ...prev.registeredAgentsByChannel,
              [channelId]: [
                ...(prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => (
                  item.id !== normalized.id
                  && item.id !== saved.id
                  && (!saved.vaultAgentId || item.vaultAgentId !== saved.vaultAgentId)
                )),
                saved,
              ],
            },
          }));
        }
        void loadVaultAgents(vaultId);
        // Re-project vault-wide so every room picks up the new member.
        void loadChatAgentMembers(vaultId, notesRef.current);
      });
    }
  }, [persistChatAgentMemberToServer, loadVaultAgents, loadChatAgentMembers]);

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
                avatarUrl: agent.avatarUrl,
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
    // PUT vault-agents projects into every channel server-side; refresh client
    // maps so no room keeps a stale shorter roster.
    void loadChatAgentMembers(vaultId, notesRef.current);
    return agent;
  }, [loadChatAgentMembers]);

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
    // from-vault only seats the agent on one channel; reload all rooms so the
    // vault-wide projection (server ensure) lands in client state everywhere.
    void loadChatAgentMembers(vaultId, notesRef.current);
  }, [loadVaultAgents, loadChatAgentMembers]);

  const handleInviteChatUser = useCallback(async (channelId: string, username: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    await api(`/api/vaults/${vaultId}/members`, {
      method: 'POST',
      body: JSON.stringify({ username, role: 'editor' }),
    });
    await loadVaultData(vaultId, { soft: true });
  }, [loadVaultData]);

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
    const data = await api<{ members: VaultMember[] }>(`/api/vaults/${vaultId}/members`);
    const member = data.members.find((item) => item.username.toLowerCase() === username.toLowerCase());
    if (!member) throw new Error('Vault member not found');
    await api(`/api/vaults/${vaultId}/members/${member.userId}`, { method: 'DELETE' });
    await loadVaultData(vaultId, { soft: true });
  }, [loadVaultData]);

  const handleLeaveChatChannel = useCallback(async (channelId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId || !user || !window.confirm('Leave this vault?')) return;
    await api(`/api/vaults/${vaultId}/members/${user.id}`, { method: 'DELETE' });
    switchVaultWorkspace(null);
    const { [vaultId]: _removedWorkspace, ...remainingWorkspaces } = vaultWorkspacesRef.current;
    const { [vaultId]: _removedDrafts, ...remainingDrafts } = vaultNoteContentsRef.current;
    vaultWorkspacesRef.current = remainingWorkspaces;
    vaultNoteContentsRef.current = remainingDrafts;
    await loadVaults();
  }, [user, loadVaults, switchVaultWorkspace]);

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
      const runPrompt = formatAgentChatPrompt(channelName, registration, steeredPrompt, triggeringMessage.author, continuation);
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
            const data = await api<{ message: ChatMessage }>(
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

  const handleCancelChatRun = useCallback(async (runId: number): Promise<boolean> => {
    try {
      if (isLocalRunId(runId)) {
        // Negative run ids are legacy client-local runs (no longer started here).
        const cancelled = await cancelLocalAgentRun(runId);
        if (!cancelled) {
          setNotice('Could not cancel run');
          return false;
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
          return false;
        }
      }
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
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not cancel run');
      return false;
    }
  }, []);

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

  /** Close a tab from anywhere: drop it from the registry, content, and tree. */
  const closeTab = useCallback((tabId: string) => {
    setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
    setNoteContents((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setLayout(Layout.simplify(Layout.removeTab(layoutRef.current, tabId)));
  }, []);

  /** Keep the chosen tab and close every sibling in its current pane. */
  const closeOtherTabs = useCallback((tabIds: string[], keepTabId: string) => {
    const closingIds = new Set(tabIds.filter((id) => id !== keepTabId));
    if (closingIds.size === 0) return;
    setOpenTabs((prev) => prev.filter((tab) => !closingIds.has(tab.id)));
    setNoteContents((prev) => {
      const next = { ...prev };
      closingIds.forEach((id) => delete next[id]);
      return next;
    });
    setLayout((prev) => Layout.simplify(
      [...closingIds].reduce((next, id) => Layout.removeTab(next, id), prev),
    ));
  }, []);

  // Stable handle so socket/delete callbacks can close tabs without re-subscribing.
  const closeTabRef = useRef(closeTab); closeTabRef.current = closeTab;

  // ═══════════════════════════════════════════════════════════════
  // NOTE CONTENT
  // ═══════════════════════════════════════════════════════════════

  /** Fetch a note body into `noteContents` (no layout change). Self-heals stale tabs. */
  const loadNoteContent = useCallback(async (noteId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${noteId}`);
      if (activeVaultIdRef.current !== vaultId) return;

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
      if (activeVaultIdRef.current !== vaultId) return;
      console.error('Error loading note:', error);
      setOpenTabs((prev) => prev.filter((t) => t.id !== noteId));
      setNoteContents((prev) => { const next = { ...prev }; delete next[noteId]; return next; });
      setLayout((prev) => Layout.simplify(Layout.removeTab(prev, noteId)));
      setNotice('That note could not be opened — it may have been moved or deleted. Refreshing the list.');
      if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current);
    }
  }, [loadVaultData, closeTab, openChatChannel]);

  /** Fetch every board body + live mission/work items for the aggregate tab. */
  const loadSuperkanban = useCallback(async () => {
    // Previews are whitespace-collapsed by the API, so detect the marker here
    // and validate the complete note body again inside mergeKanbanSources.
    const boardSummaries = notesRef.current.filter((note) => (
      /kanban-plugin\s*:/.test(note.content_preview)
      && (/superkanban\s*:\s*true/i.test(note.content_preview) || /cascade-channel\s*:/i.test(note.content_preview))
    ));
    const vaultId = activeVaultIdRef.current;
    setSuperkanbanLoading(true);
    setSuperkanbanError(null);
    try {
      const [fetched, live] = await Promise.all([
        Promise.all(boardSummaries.map(async (summary) => {
          const data = await api<{ note: Note }>(`/api/notes/${summary.id}`);
          return data.note;
        })),
        vaultId
          ? api<{ items: WorkItem[] }>(
            `/api/vaults/${vaultId}/work-items`,
          ).then((data) => data.items || []).catch(() => [] as WorkItem[])
          : Promise.resolve([] as WorkItem[]),
      ]);
      if (activeVaultIdRef.current !== vaultId) return;
      setSuperkanbanNotes(fetched);
      setSuperkanbanLiveWork(live);
    } catch (error) {
      if (activeVaultIdRef.current !== vaultId) return;
      console.error('Error loading Superkanban:', error);
      setSuperkanbanError('Could not load all Kanban boards. Try reopening this tab.');
    } finally {
      if (activeVaultIdRef.current === vaultId) setSuperkanbanLoading(false);
    }
  }, []);

  const openSuperkanban = useCallback((paneId: string) => {
    const id = `superkanban:${activeVaultIdRef.current ?? 'current'}`;
    const tab: Tab = { id, title: 'Superkanban', type: 'superkanban', dirty: false };
    setOpenTabs((prev) => prev.some((item) => item.id === id) ? prev : [...prev, tab]);
    setLayout(Layout.simplify(Layout.addTabToPane(Layout.removeTab(layoutRef.current, id), paneId, id)));
    setFocusedPaneId(paneId);
    void loadSuperkanban();
  }, [loadSuperkanban]);

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

  useEffect(() => {
    if (!user || !focusedTab || (focusedTab.type !== 'note' && focusedTab.type !== 'chat')) return;
    if (!(communityUpdates.counts.byTarget[focusedTab.id] > 0)) return;
    void markCommunityTargetRead(focusedTab.id);
  }, [communityUpdates.counts.byTarget, focusedTab?.id, focusedTab?.type, markCommunityTargetRead, user]);

  const openCommunityUpdate = useCallback(async (item: CommunityUpdateItem) => {
    await markCommunityTargetRead(item.targetId);
    setUpdatesOpen(false);
    if (activeVaultIdRef.current !== item.vaultId) {
      switchVaultWorkspace(item.vaultId);
      await loadVaultData(item.vaultId);
    }
    if (item.kind === 'note') {
      openNote(item.targetId);
      return;
    }
    openChatChannel(item.targetId, item.targetTitle);
    if (item.messageId) setChatJumpTarget({ channelId: item.targetId, messageId: item.messageId });
  }, [loadVaultData, markCommunityTargetRead, openChatChannel, openNote, switchVaultWorkspace]);

  /** Save a specific note tab's draft. */
  const saveNoteTab = useCallback(async (tabId: string) => {
    const vaultId = activeVaultIdRef.current;
    const entry = noteContentsRef.current[tabId];
    if (!vaultId || !entry) return;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${tabId}`, {
        method: 'PUT',
        body: JSON.stringify({ content: entry.draft }),
      });
      if (activeVaultIdRef.current !== vaultId) {
        const cachedNotes = vaultNoteContentsRef.current[vaultId] ?? {};
        vaultNoteContentsRef.current = {
          ...vaultNoteContentsRef.current,
          [vaultId]: { ...cachedNotes, [tabId]: { note: data.note, draft: data.note.content } },
        };
        const cachedWorkspace = vaultWorkspacesRef.current[vaultId];
        if (cachedWorkspace) {
          vaultWorkspacesRef.current = {
            ...vaultWorkspacesRef.current,
            [vaultId]: {
              ...cachedWorkspace,
              openTabs: cachedWorkspace.openTabs.map((tab) => (
                tab.id === tabId ? { ...tab, title: data.note.title, dirty: false } : tab
              )),
            },
          };
        }
        return data.note;
      }
      setNoteContents((prev) => ({ ...prev, [tabId]: { note: data.note, draft: data.note.content } }));
      setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title: data.note.title, dirty: false } : t)));
      void loadVaultData(vaultId);
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
      setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title: data.note.title } : t)));
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

  const noteSaveHandlers = useRef(new Map<string, () => Promise<Note | undefined>>());
  const getNoteSaveHandler = useCallback((tabId: string) => {
    let fn = noteSaveHandlers.current.get(tabId);
    if (!fn) {
      fn = () => saveNoteTab(tabId);
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
      // Terminal empty agent shells (dual-post suppress after cascade-chat send)
      // must not stick around as blank "(message)" bubbles in the live UI.
      const remoteBody = String(data.message.body || '').trim();
      const isEmptyAgentShell = Boolean(
        data.message.agentId
        && data.message.status !== 'running'
        && (!remoteBody || remoteBody === 'Thinking...'),
      );
      chatMessageStore.update(data.channelId, (existing) => {
        if (isEmptyAgentShell) {
          const next = existing.filter((message) => message.id !== data.message.id);
          if (next.length === existing.length && !existing.some((m) => m.id === data.message.id)) {
            return existing; // never insert an empty shell
          }
          return next;
        }
        const index = existing.findIndex((message) => message.id === data.message.id);
        if (index === -1) return [...existing, data.message];
        const local = existing[index];
        if (streamingChatMessageIdsRef.current.has(data.message.id) && data.message.status === 'running') {
          return existing;
        }
        const next = [...existing];
        next[index] = mergeRemoteChatMessage(local, data.message);
        return next;
      });
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
  }, [activeVaultId, user?.id, authEpoch, loadVaultData, loadNoteContent, loadChatAgentMembers, loadChatMessages, openChatTabIds, openNote, syncChatPresenceRooms, dispatchChatAgentIntents, recoverPendingChatAgentDispatches, scheduleCommunityRefresh]);

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

  // ═══════════════════════════════════════════════════════════════
  // NOTE / FOLDER OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  const createAndOpenNote = useCallback(async (paneId: string | null, folderId: string | null) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled Note', content: '', folder_id: folderId ?? undefined }),
      });
      await loadVaultData(vaultId);
      if (activeVaultIdRef.current !== vaultId) return data.note;
      const targetPane = paneId ?? focusedPaneRef.current.id;
      const tab: Tab = { id: data.note.id, title: data.note.title, type: 'note', dirty: false };
      setNoteContents((prev) => ({ ...prev, [data.note.id]: { note: data.note, draft: data.note.content } }));
      setOpenTabs((prev) => prev.some((item) => item.id === tab.id) ? prev : [...prev, tab]);
      setLayout(Layout.simplify(Layout.addTabToPane(Layout.removeTab(layoutRef.current, tab.id), targetPane, tab.id)));
      setFocusedPaneId(targetPane);
      return data.note;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create note');
      return undefined;
    }
  }, [loadVaultData]);

  const handleCreateNote = useCallback(() => createAndOpenNote(null, null), [createAndOpenNote]);

  const handleCreateNoteInPane = useCallback((paneId: string) => { void createAndOpenNote(paneId, null); }, [createAndOpenNote]);

  const handleCreateTabInPane = useCallback((paneId: string) => {
    const id = `new:${crypto.randomUUID()}`;
    const tab: Tab = { id, title: 'New tab', type: 'new', dirty: false };
    setOpenTabs((prev) => [...prev, tab]);
    setLayout(Layout.simplify(Layout.addTabToPane(layoutRef.current, paneId, id)));
    setFocusedPaneId(paneId);
  }, []);

  const handleCreateChatInPane = useCallback(async (paneId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'new-channel', content: CHAT_NOTE_MARKER }),
      });
      await loadVaultData(vaultId);
      if (activeVaultIdRef.current !== vaultId) return;
      const tab: Tab = { id: data.note.id, title: data.note.title || 'new-channel', type: 'chat', dirty: false };
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
      if (wasChatChannel) chatMessageStore.remove(noteId);
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete note');
    }
  }, [loadVaultData]);

  const handleMoveNote = useCallback(async (noteId: string, folderId: string | null, position?: number) => {
    try {
      await api(`/api/notes/${noteId}/move`, {
        method: 'POST',
        body: JSON.stringify({ folder_id: folderId, ...(position === undefined ? {} : { position }) }),
      });
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

  const handleCreateNoteInFolder = useCallback((folderId: string | null) => { void createAndOpenNote(null, folderId); }, [createAndOpenNote]);

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
    if (tab?.type === 'superkanban') void loadSuperkanban();
  }, [loadNoteContent, ensureChatChannelLoaded, loadSuperkanban]);

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

  /** Turn a sidebar note drag into a real tab, then dock or split it. */
  const handleDropNote = useCallback((noteId: string, targetPaneId: string, side: Layout.DropSide, index?: number) => {
    const summary = notesRef.current.find((note) => note.id === noteId);
    if (!summary) return;
    const isChat = summary.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
    const tab: Tab = { id: noteId, title: summary.title || (isChat ? 'Channel' : 'Untitled Note'), type: isChat ? 'chat' : 'note', dirty: false };
    setOpenTabs((prev) => prev.some((item) => item.id === noteId)
      ? prev.map((item) => item.id === noteId ? { ...item, ...tab } : item)
      : [...prev, tab]);
    const prev = layoutRef.current;
    const next = side === 'center'
      ? Layout.addTabToPane(Layout.removeTab(prev, noteId), targetPaneId, noteId, index)
      : Layout.splitPaneWithTab(prev, targetPaneId, side, noteId);
    setLayout(Layout.simplify(next));
    const landed = Layout.findPaneByTab(next, noteId);
    setFocusedPaneId(landed?.id ?? targetPaneId);
    if (isChat) ensureChatChannelLoaded(noteId);
    else void loadNoteContent(noteId);
  }, [ensureChatChannelLoaded, loadNoteContent]);

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

  // After login/reload and every vault switch, hydrate the visible note tabs in
  // that vault's restored workspace.
  useEffect(() => {
    if (!activeVaultId) return;
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
        const data = await api<{ user: User; owner?: boolean }>('/api/auth/reset', {
          method: 'POST',
          body: JSON.stringify({ token: resetToken.trim(), newPassword: password }),
        });
        // Drop any prior user's workspace pointer so we never open their vault id.
        localStorage.removeItem(SESSION_STORAGE_KEY);
        resetVaultWorkspaces();
        localStorage.removeItem('docs_token');
        setUser(data.user);
        setIsOwner(Boolean(data.owner));
        setPassword('');
        setResetToken('');
        await loadVaults();
        return;
      }
      const inviteMatch = window.location.pathname.match(/^\/(?:invite|vault-invite)\/([^/]+)$/);
      const inviteToken = inviteMatch ? decodeURIComponent(inviteMatch[1]) : '';
      const data = await api<{ user: User; owner?: boolean }>(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password, ...(authMode === 'register' && inviteToken ? { inviteToken } : {}) }),
      });
      // Account switch: never restore another user's activeVaultId / open tabs.
      localStorage.removeItem(SESSION_STORAGE_KEY);
      resetVaultWorkspaces();
      localStorage.removeItem('docs_token');
      setUser(data.user);
      setIsOwner(Boolean(data.owner));
      setPassword('');
      await loadVaults();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed');
    }
  }

  const handleLogout = () => {
    runSocketsRef.current.forEach((socket) => socket.disconnect());
    runSocketsRef.current.clear();
    void api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('docs_token');
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setUser(null);
    setIsOwner(false);
    setAdminOpen(false);
    setVaults([]);
    resetVaultWorkspaces();
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

  // Stable identity so ChatView's memo is not defeated every render by an inline arrow.
  const handleChatJumpHandled = useCallback(() => setChatJumpTarget(null), []);

  /** Render the content of a tab inside its pane. */
  const renderTabContent = useCallback((tab: Tab): ReactNode => {
    if (tab.type === 'new') {
      return (
        <div className="new-tab-page">
          <div className="new-tab-mark"><Sparkles size={22} aria-hidden="true" /></div>
          <span className="surface-kicker">Open canvas</span>
          <strong>Make this space yours</strong>
          <span>Choose a note from the sidebar, or drag one onto an edge to work side by side.</span>
          <div className="new-tab-shortcuts" aria-label="Useful shortcuts">
            <span><kbd>Ctrl P</kbd> Open anything</span>
            <span><kbd>Ctrl N</kbd> New note</span>
          </div>
        </div>
      );
    }
    if (tab.type === 'superkanban') {
      return (
        <Suspense fallback={<div className="pane-empty">Loading board…</div>}>
          <SuperkanbanView
            notes={superkanbanNotes}
            loading={superkanbanLoading}
            error={superkanbanError}
            onOpenNote={openNote}
            liveWorkItems={superkanbanLiveWork}
          />
        </Suspense>
      );
    }
    if (tab.type === 'chat') {
      const channel = notes.find((note) => note.id === tab.id && note.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      if (!channel) {
        // Cold start: vault notes not hydrated yet — avoid a flash of "not found".
        const vaultLoading = activeVaultId
          && (loadVaultDataInflight.has(`${activeVaultId}:hard`)
            || loadVaultDataInflight.has(`${activeVaultId}:soft`));
        if (notes.length === 0 || vaultLoading || loadingChatChannels[tab.id]) {
          return (
            <div className="pane-empty chat-loading-empty">
              <strong>Loading messages…</strong>
            </div>
          );
        }
        return <div className="pane-empty">Channel not found</div>;
      }
      return (
        <Suspense fallback={<div className="pane-empty chat-loading-empty"><strong>Loading chat…</strong></div>}>
          <ChatView
            channelId={channel.id}
            channelName={channel.title}
            isLoadingMessages={loadingChatChannels[channel.id] === true}
            currentUser={currentUsername}
            presence={chatPresenceByChannel[channel.id] ?? EMPTY_CHAT_PRESENCE}
            availableAgents={AVAILABLE_CHAT_AGENTS}
            registeredAgents={chatState.registeredAgentsByChannel[channel.id] ?? EMPTY_CHAT_AGENTS}
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
            onCollaborateMessage={handleCollaborateChatMessage}
            onDeleteMessage={handleDeleteChatMessage}
            onForwardMessage={handleForwardChatMessage}
            onCancelRun={handleCancelChatRun}
            notes={notes}
            onOpenNote={openNote}
            onOpenSharedNote={handleOpenSharedChatNote}
            membersOpen={chatMembersOpen}
            onMembersOpenChange={setChatMembersOpen}
            vaultId={activeVaultId || undefined}
            onHydrateMessage={handleHydrateChatMessage}
            jumpToMessageId={chatJumpTarget?.channelId === channel.id ? chatJumpTarget.messageId : undefined}
            onJumpHandled={handleChatJumpHandled}
            sidebarMode="hidden"
          />
        </Suspense>
      );
    }
    const entry = noteContents[tab.id];
    return (
      <ErrorBoundary label="Note">
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
      </ErrorBoundary>
    );
  }, [chatState.registeredAgentsByChannel, chatPresenceByChannel, currentUsername, loadingChatChannels, runnerHealth, vaultAgents, handleCancelChatRun, handleCreateChatInviteLink, handleInviteChatUser, handleRemoveChatParticipant, handleLeaveChatChannel, handleRegisterChatAgent, handleRemoveChatAgent, handleUpsertVaultAgent, handleDeleteVaultAgent, handleAddVaultAgentToChannel, handleSendChatMessage, handleCollaborateChatMessage, handleForwardChatMessage, noteContents, notes, getNoteChangeHandler, getNoteSaveHandler, getNoteRenameHandler, handleExecuteDirective, handleOpenWikilink, openNote, chatMembersOpen, activeVaultId, handleHydrateChatMessage, handleOpenSharedChatNote, superkanbanNotes, superkanbanLiveWork, superkanbanLoading, superkanbanError, chatJumpTarget, handleChatJumpHandled]);

  if (!user) {
    const hasInvite = /^\/invite\/[^/]+$/.test(window.location.pathname);
    const inDesktopApp = Boolean((window as unknown as { electronAPI?: unknown }).electronAPI);
    return (
      <main className="auth-shell">
        <form className="auth-panel" id="auth-panel" onSubmit={submitAuth}>
          <div className="auth-brand" aria-label="Fizzer">
            <FizzerMark size={28} />
            <h1>Fizzer</h1>
          </div>
          <div className="auth-decal" aria-hidden="true" />
          <div className="auth-intro">
            <span className="surface-kicker">Shared intelligence</span>
            <strong>{authMode === 'register' ? 'Create your workspace' : authMode === 'reset' ? 'Recover your account' : 'Welcome back'}</strong>
            <p>One calm place for your team, notes, and local agents.</p>
          </div>
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
          <p className="auth-desktop-note">
            {inDesktopApp
              ? 'This desktop app can run your local agents after you sign in.'
              : 'Fizzer agents run on your own desktop app. You can join this invite here, then open it in Fizzer desktop to run agents.'}
            {!inDesktopApp && <> <a href="/download">Get Fizzer desktop</a></>}
          </p>
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

  const inDesktopApp = Boolean((window as unknown as { electronAPI?: unknown }).electronAPI);
  const showDesktopDownload = !inDesktopApp && runnerHealth != null && !runnerHealth.online;

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
      {!sidebarOpen && (
        <div
          className="mobile-sidebar-swipe-edge"
          aria-hidden="true"
          onPointerDown={beginMobileSidebarSwipe}
          onPointerUp={finishMobileSidebarSwipe}
          onPointerCancel={() => { mobileSidebarSwipeRef.current = null; }}
        />
      )}
      {sidebarOpen && (
        <div className="resize-handle" style={{ left: sidebarWidth - 3 }} onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize" />
      )}

      {/* Mobile only: dimmed stage dismisses the drawer on outside tap. */}
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar
          user={user}
          isOwner={isOwner}
          onOpenAdmin={() => setAdminOpen(true)}
          vaults={vaults}
          activeVaultId={activeVaultId}
          folders={folders}
          notes={notes}
          activeNoteId={activeTabId}
          updateCounts={communityUpdates.counts}
          showAgentMemory={showAgentMemory}
          onSelectVault={switchVaultWorkspace}
          onCreateVault={handleCreateVault}
          onRenameVault={handleRenameVault}
          onJoinVault={handleJoinVault}
          onOpenPublicVaults={() => setDiscoveryDmsOpen('public')}
          onOpenDirectMessages={() => setDiscoveryDmsOpen('dms')}
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
          onOpenAccount={() => setAccountOpen(true)}
          onDeleteNote={handleDeleteNote}
          onMoveNote={handleMoveNote}
          onUnlistNote={handleUnlistNote}
          onMoveFolder={handleMoveFolder}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onRenameNote={renameNoteTab}
          onDeleteFolder={handleDeleteFolder}
      />

      {accountOpen && user && (
        <Suspense fallback={null}>
          <AccountSettings
            user={user}
            vaultId={activeVaultId}
            vaultName={vaults.find((vault) => vault.id === activeVaultId)?.name}
            showAgentMemory={showAgentMemory}
            onShowAgentMemoryChange={updateShowAgentMemory}
            onClose={() => setAccountOpen(false)}
            onUserChanged={setUser}
            onSessionChanged={() => setAuthEpoch((value) => value + 1)}
            onMembershipChanged={() => { void loadVaults(); }}
          />
        </Suspense>
      )}

      {discoveryDmsOpen && (
        <Suspense fallback={null}>
          <DiscoveryDmsModal
            initialTab={discoveryDmsOpen}
            updateCounts={communityUpdates.counts}
            onClose={() => setDiscoveryDmsOpen(null)}
            onVaultsChanged={loadVaults}
            onOpenLocation={async (vaultId, channelId, title) => {
              switchVaultWorkspace(vaultId);
              if (channelId) {
                await loadVaultData(vaultId);
                openChatChannel(channelId, title || 'Direct message');
              }
            }}
          />
        </Suspense>
      )}

      {/* Workspace */}
      <div className="workspace flex flex-col flex-1" style={{ height: '100%', overflow: 'hidden' }}>
        <div className="workspace-toolbar" style={{ alignItems: 'center', background: 'var(--bg-surface)', padding: '4px 8px', paddingTop: 'calc(4px + env(safe-area-inset-top))', gap: 4, borderBottom: '1px solid var(--border)' }}>
            {!sidebarOpen && (
              <button
                id="sidebar-expand-btn"
                type="button"
                className="btn-icon"
                onClick={() => { setSidebarOpen(true); setChatMembersOpen(false); }}
                title="Expand sidebar"
                aria-label="Expand sidebar"
              >
                <PanelLeftOpen size={16} />
              </button>
            )}
            <NewsTicker />
            {showDesktopDownload && (
              <a
                className="workspace-desktop-action"
                href="/download"
                title="Run local agents with Fizzer desktop"
                aria-label="Get desktop"
              >
                <Download size={13} aria-hidden="true" />
                <span>Get desktop</span>
              </a>
            )}
            <button
              id="community-updates-btn"
              type="button"
              className="btn-icon workspace-updates-btn"
              onClick={() => {
                setUpdatesOpen(true);
                void loadCommunityUpdates();
              }}
              title="Updates"
              aria-label={`${communityUpdates.counts.total || 'No'} unread updates`}
            >
              <Bell size={16} />
              {communityUpdates.counts.total > 0 && (
                <span className="workspace-updates-badge">
                  {communityUpdates.counts.total >= 99 ? '99+' : communityUpdates.counts.total}
                </span>
              )}
            </button>
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
            {activeVaultId && vaultSidebarChannel && !chatMembersOpen && <button
              id="chat-members-expand-btn"
              type="button"
              className="btn-icon chat-members-toolbar-btn"
              onClick={() => {
                setChatMembersOpen(true);
                if (isMobileViewport()) setSidebarOpen(false);
              }}
              title="Show vault members"
              aria-label="Show vault members"
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
            onCloseOtherTabs={closeOtherTabs}
            onDropTab={handleDropTab}
            onDropNote={handleDropNote}
            onResize={handleResizeSplit}
            onCreateNote={handleCreateNoteInPane}
            onCreateTab={handleCreateTabInPane}
            onCreateChat={handleCreateChatInPane}
            onOpenSuperkanban={openSuperkanban}
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
          {activeVaultId && vaultSidebarChannel && (
            <Suspense fallback={null}>
              <ChatView
                channelId={vaultSidebarChannel}
                channelName={notes.find((note) => note.id === vaultSidebarChannel)?.title || 'Vault'}
                currentUser={currentUsername}
                presence={chatPresenceByChannel[vaultSidebarChannel] ?? EMPTY_CHAT_PRESENCE}
                availableAgents={AVAILABLE_CHAT_AGENTS}
                registeredAgents={chatState.registeredAgentsByChannel[vaultSidebarChannel] ?? EMPTY_CHAT_AGENTS}
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
                onCollaborateMessage={handleCollaborateChatMessage}
                onCancelRun={handleCancelChatRun}
                notes={notes}
                onOpenNote={openNote}
                membersOpen={chatMembersOpen}
                onMembersOpenChange={setChatMembersOpen}
                vaultId={activeVaultId}
                sidebarMode="only"
              />
            </Suspense>
          )}
        </div>
      </div>
      {sessionManagerOpen && (
        <Suspense fallback={null}>
          <SessionManager
            open
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
        </Suspense>
      )}

      {searchOpen && (
        <Suspense fallback={null}>
          <SearchOverlay
            open
            onClose={() => setSearchOpen(false)}
            vaultId={activeVaultId}
            onSelectNote={(id, messageId) => {
              openNote(id);
              if (messageId) setChatJumpTarget({ channelId: id, messageId });
            }}
          />
        </Suspense>
      )}
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette open onClose={() => setCommandPaletteOpen(false)} notes={notes} onSelectNote={(id) => openNote(id)} onCreateNote={handleCreateNote} />
        </Suspense>
      )}
      {updatesOpen && (
        <Suspense fallback={null}>
          <UpdatesModal
            open
            loading={communityUpdatesLoading}
            updates={communityUpdates}
            error={communityUpdatesError}
            onClose={() => setUpdatesOpen(false)}
            onRefresh={() => void loadCommunityUpdates()}
            onMarkAllRead={() => void markAllCommunityUpdatesRead()}
            onOpenItem={(item) => void openCommunityUpdate(item)}
          />
        </Suspense>
      )}
      {adminOpen && (
        <Suspense fallback={null}>
          <AdminPanel onClose={() => setAdminOpen(false)} />
        </Suspense>
      )}

      {agentPermissions[0] && (
        <section className="agent-permission-card" role="dialog" aria-modal="false" aria-labelledby="agent-permission-title" onClick={(event) => event.stopPropagation()}>
          <div className="agent-permission-eyebrow">Agent permission</div>
          <strong id="agent-permission-title">{agentPermissions[0].title}</strong>
          {agentPermissions[0].description && <p>{agentPermissions[0].description}</p>}
          {agentPermissions[0].blockedPath && <code>{agentPermissions[0].blockedPath}</code>}
          <div className="agent-permission-actions">
            <button className="btn btn-ghost" type="button" onClick={() => void answerAgentPermission(agentPermissions[0].requestId, 'deny')}>Deny</button>
            <button className="btn btn-primary" type="button" onClick={() => void answerAgentPermission(agentPermissions[0].requestId, 'allow')}>Allow once</button>
          </div>
          {agentPermissions.length > 1 && <span className="agent-permission-queue">{agentPermissions.length - 1} more request{agentPermissions.length === 2 ? '' : 's'} waiting</span>}
        </section>
      )}

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
