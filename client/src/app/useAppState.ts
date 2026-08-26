import { useCallback, useRef, useState } from 'react';
import type { ChatChannelPresence, ChatMessage, DesktopRunnerHealth, VaultAgent } from '../chat/types';
import type { ChatState, PersistedSession, PersistedWorkspace } from '../chat/session';
import { loadChatState, loadPersistedSession } from '../chat/session';
import type { CommunityUpdates, Folder, Note, NoteSummary, User, Vault } from '../api';
import type { LayoutNode } from '../layout/tree';
import type { WorkItem } from '../chat/workItems';
import type { Tab } from '../components/TabBar';
import type { DiscoveryTab } from '../components/DiscoveryDmsModal';
import * as Layout from '../layout/tree';
import { connectVaultSocket, connectRunsSocket } from '../socket';
import { CHAT_NOTE_MARKER } from '../chat/shared';
import { emptyWorkspace } from '../chat/session';

export type NoteEntry = { note: Note; draft: string };

const EMPTY_COMMUNITY_UPDATES: CommunityUpdates = { groups: [], counts: { total: 0, directMessages: 0, byVault: {}, byTarget: {} }, truncated: false };
function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
}
/** Central state/ref store. Mirrors are updated synchronously on vault switches before async hydration starts. */
export function useAppState() {
  // ═══════════════════════════════════════════════════════════════

  const persistedSessionRef = useRef<PersistedSession>(loadPersistedSession());

  // Auth state. `user` starts null, so we must not treat "not yet checked"
  // as logged out or the desktop shell flashes the login form on every boot.
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [documentationAssistantOpen, setDocumentationAssistantOpen] = useState(false);
  const [accountInitialSection, setAccountInitialSection] = useState<'profile' | 'vault'>('profile');
  const [discoveryDmsOpen, setDiscoveryDmsOpen] = useState<DiscoveryTab | null>(null);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [orbitOpen, setOrbitOpen] = useState(false);
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
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
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
  }, []);

  return {
    persistedSessionRef, authReady, setAuthReady, user, setUser, isOwner, setIsOwner,
    adminOpen, setAdminOpen, accountOpen, setAccountOpen, documentationAssistantOpen, setDocumentationAssistantOpen,
    accountInitialSection, setAccountInitialSection, discoveryDmsOpen, setDiscoveryDmsOpen, updatesOpen, setUpdatesOpen,
    orbitOpen, setOrbitOpen, authEpoch, setAuthEpoch, authMode, setAuthMode, username, setUsername, password, setPassword,
    resetToken, setResetToken, authError, setAuthError, authNotice, setAuthNotice, vaults, setVaults, activeVaultId,
    setActiveVaultIdState, folders, setFolders, notes, setNotes, chatState, setChatState, loadingChatChannels,
    setLoadingChatChannels, chatPresenceByChannel, setChatPresenceByChannel, communityUpdates, setCommunityUpdates,
    communityUpdatesLoading, setCommunityUpdatesLoading, communityUpdatesError, setCommunityUpdatesError, showAgentMemory,
    setShowAgentMemory, openTabs, setOpenTabs, layout, setLayout, focusedPaneId, setFocusedPaneId, noteContents,
    setNoteContents, superkanbanNotes, setSuperkanbanNotes, superkanbanLiveWork, setSuperkanbanLiveWork,
    superkanbanLoading, setSuperkanbanLoading, superkanbanError, setSuperkanbanError, sidebarOpen, setSidebarOpen,
    sidebarWidth, setSidebarWidth, isResizing, setIsResizing, mobileSidebarSwipeRef, chatMembersOpen, setChatMembersOpen,
    searchOpen, setSearchOpen, chatJumpTarget, setChatJumpTarget, commandPaletteOpen, setCommandPaletteOpen, notice,
    setNotice, runnerHealth, setRunnerHealth, sessionManagerOpen, setSessionManagerOpen, focusSessionId, setFocusSessionId,
    vaultAgents, setVaultAgents, focusedPane, activeTabId, focusedTab, focusedIsChat, vaultSidebarChannel,
    currentUsername, layoutRef, focusedPaneRef, openTabsRef, noteContentsRef, activeVaultIdRef, notesRef, chatStateRef,
    vaultSocketRef, joinedChatChannelsRef, runSocketsRef, streamingChatMessageIdsRef, acceptedInviteTokenRef,
    serverOwnedChatMessageIdsRef, agentContextWatermarkRef, agentSessionTailRef, activeAgentSessionRunRef,
    interruptedAgentSessionRunRef, pendingAgentSteerRef, pendingChatPatchRef, chatPatchTimerRef,
    startingChatDispatchesRef, socketVaultReloadTimerRef, communityRefreshTimerRef, vaultWorkspacesRef, vaultNoteContentsRef,
    switchVaultWorkspace, resetVaultWorkspaces,
  };
}
