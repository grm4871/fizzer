import { useEffect, useCallback, useRef, lazy, Suspense, type ReactNode } from 'react';
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
const SuperkanbanView = lazy(() =>
  import('./components/SuperkanbanView').then((m) => ({ default: m.SuperkanbanView })),
);
import { CHAT_NOTE_MARKER, applyLocalUserProfile } from './chat/shared';
import { CHAT_AGENTS, CHAT_AGENT_MODEL_PRESETS } from './chat/agents';
import type { ChatAgentRegistration, ChatChannelPresence } from './chat/types';
import { useChatDispatch } from './chat/dispatch';
import { ErrorBoundary } from './components/ErrorBoundary';
import * as Layout from './layout/tree';
import { api, type User } from './api';
import { stopDesktopRunnerHost } from './desktopRunnerHost';
import {
  CHAT_STORAGE_KEY,
  readLegacyLocalChatAgentMembers,
  readLegacyLocalChatMessages,
  SESSION_STORAGE_KEY,
  type PersistedSession,
  type PersistedWorkspace,
} from './chat/session';
import { useNoteFolderOperations } from './app/useNoteFolderOperations';
import { useWorkspaceTabs } from './app/useWorkspaceTabs';
import { useNoteWorkspace } from './app/useNoteWorkspace';
import { useSocketReconciliation } from './app/useSocketReconciliation';
import { useVaultData } from './app/useVaultData';
import { useChatHydration } from './app/useChatHydration';
import { useAppState } from './app/useAppState';
import { WorkspaceView } from './app/WorkspaceView';
import { useChatChannelOperations } from './app/useChatChannelOperations';
import { Sparkles } from 'lucide-react';
import { FizzerMark } from './components/FizzerMark';
const EMPTY_CHAT_PRESENCE: ChatChannelPresence = { participants: [], online: [] };
const EMPTY_CHAT_AGENTS: ChatAgentRegistration[] = [];
const AVAILABLE_CHAT_AGENTS = CHAT_AGENTS.map((agent) => ({
  ...agent,
  models: CHAT_AGENT_MODEL_PRESETS[agent.id],
}));




function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
}



export default function App() {
  const {
    authReady, setAuthReady, user, setUser, isOwner, setIsOwner, adminOpen, setAdminOpen,
    accountOpen, setAccountOpen, documentationAssistantOpen, setDocumentationAssistantOpen, accountInitialSection,
    setAccountInitialSection, discoveryDmsOpen, setDiscoveryDmsOpen, updatesOpen, setUpdatesOpen, orbitOpen, setOrbitOpen,
    authEpoch, setAuthEpoch, authMode, setAuthMode, username, setUsername, password, setPassword, resetToken, setResetToken,
    authError, setAuthError, authNotice, setAuthNotice, vaults, setVaults, activeVaultId, folders,
    setFolders, notes, setNotes, chatState, setChatState, loadingChatChannels, setLoadingChatChannels,
    chatPresenceByChannel, setChatPresenceByChannel, communityUpdates, setCommunityUpdates, communityUpdatesLoading,
    setCommunityUpdatesLoading, communityUpdatesError, setCommunityUpdatesError, showAgentMemory, setShowAgentMemory,
    openTabs, setOpenTabs, layout, setLayout, focusedPaneId, setFocusedPaneId, noteContents, setNoteContents,
    superkanbanNotes, setSuperkanbanNotes, superkanbanLiveWork, setSuperkanbanLiveWork, superkanbanLoading,
    setSuperkanbanLoading, superkanbanError, setSuperkanbanError, sidebarOpen, setSidebarOpen, sidebarWidth,
    setSidebarWidth, isResizing, setIsResizing, mobileSidebarSwipeRef, chatMembersOpen, setChatMembersOpen, searchOpen,
    setSearchOpen, chatJumpTarget, setChatJumpTarget, commandPaletteOpen, setCommandPaletteOpen, notice, setNotice,
    runnerHealth, setRunnerHealth, sessionManagerOpen, setSessionManagerOpen, focusSessionId, setFocusSessionId,
    vaultAgents, setVaultAgents, activeTabId, focusedTab, vaultSidebarChannel,
    currentUsername, layoutRef, focusedPaneRef, openTabsRef, noteContentsRef, activeVaultIdRef, notesRef, chatStateRef,
    vaultSocketRef, joinedChatChannelsRef, runSocketsRef, streamingChatMessageIdsRef, acceptedInviteTokenRef,
    serverOwnedChatMessageIdsRef, agentContextWatermarkRef, agentSessionTailRef, activeAgentSessionRunRef,
    interruptedAgentSessionRunRef, pendingAgentSteerRef, pendingChatPatchRef, chatPatchTimerRef,
    startingChatDispatchesRef, socketVaultReloadTimerRef, communityRefreshTimerRef, vaultWorkspacesRef, vaultNoteContentsRef,
    switchVaultWorkspace, resetVaultWorkspaces,
  } = useAppState();

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
    if (isMobileViewport()) return;
    localStorage.setItem('cascade_chat_users_collapsed', chatMembersOpen ? '0' : '1');
  }, [chatMembersOpen]);

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

  useEffect(() => installInteractionLockRecovery(), []);

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




  const {
    loadVaults, loadCommunityUpdates, updateShowAgentMemory, scheduleCommunityRefresh,
    markCommunityTargetRead, markAllCommunityUpdatesRead, handleCreateVault,
    handleRenameVault, handleDeleteVault,
  } = useVaultData({
    user, vaults, showAgentMemory, activeVaultIdRef, vaultWorkspacesRef, vaultNoteContentsRef,
    communityRefreshTimerRef, setVaults, setUser, setIsOwner, setAuthReady, setRunnerHealth,
    setCommunityUpdates, setCommunityUpdatesLoading, setCommunityUpdatesError, setNotice,
    setShowAgentMemory, switchVaultWorkspace,
  });
  const {
    openChatTabIds, loadChatAgentMembers, loadChatMessages, loadVaultAgents, loadVaultData,
    ensureChatChannelLoaded, handleOpenSharedChatNote, persistChatAgentMemberToServer,
    removeChatAgentMemberOnServer,
  } = useChatHydration({
    user, activeVaultId, vaultSidebarChannel, openTabsRef, focusedPaneRef, activeVaultIdRef,
    notesRef, chatStateRef, runSocketsRef, vaultSocketRef, setFolders, setNotes, setVaultAgents,
    setChatState, setChatPresenceByChannel, setLoadingChatChannels, setNotice,
    readLegacyLocalChatAgentMembers, readLegacyLocalChatMessages,
  });

  const {
    openChatChannel, handleJoinVault, handleCreateChannel, handleRegisterChatAgent,
    handleRemoveChatAgent, handleUpsertVaultAgent, handleDeleteVaultAgent,
    handleDeleteAgentProfile, handleAddVaultAgentToChannel, handleInviteChatUser,
    handleRemoveChatParticipant, handleLeaveChatChannel,
  } = useChatChannelOperations({
    activeVaultIdRef, notesRef, user, acceptedInviteTokenRef, vaultWorkspacesRef, vaultNoteContentsRef,
    layoutRef, focusedPaneRef, ensureChatChannelLoaded, setOpenTabs, setLayout, setFocusedPaneId,
    setNoteContents, setNotice, setChatState, setVaultAgents, loadVaults, loadVaultData,
    switchVaultWorkspace, loadVaultAgents, loadChatAgentMembers, persistChatAgentMemberToServer,
    removeChatAgentMemberOnServer,
  });
  const {
    dispatchChatAgentIntents,
    recoverPendingChatAgentDispatches,
    handleHydrateChatMessage,
    handleDeleteChatMessage,
    handleForwardChatMessage,
    handleCancelChatRun,
    handleCollaborateChatMessage,
    handleSendChatMessage,
  } = useChatDispatch({
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
  });

  const closeTab = useCallback((tabId: string) => {
    setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
    setNoteContents((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setLayout(Layout.simplify(Layout.removeTab(layoutRef.current, tabId)));
  }, []);
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;

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




  const {
    loadNoteContent, loadSuperkanban, openSuperkanban, openNote, openCommunityUpdate,
    handleSaveActiveNote, renameNoteTab, getNoteChangeHandler, getNoteSaveHandler,
    getNoteRenameHandler, handleOpenWikilink,
  } = useNoteWorkspace({
    activeVaultIdRef, notesRef, layoutRef, focusedPaneRef, noteContentsRef, vaultWorkspacesRef, vaultNoteContentsRef,
    setNoteContents, setOpenTabs, setLayout, setFocusedPaneId, setSuperkanbanNotes, setSuperkanbanLiveWork,
    setSuperkanbanLoading, setSuperkanbanError, setNotice, setUpdatesOpen, setChatJumpTarget,
    loadVaultData, closeTab, openChatChannel, switchVaultWorkspace, markCommunityTargetRead,
    user, focusedTab, communityUpdates,
  });

  useSocketReconciliation({
    activeVaultId, user, authEpoch, layout, openTabs,
    activeVaultIdRef, notesRef, noteContentsRef, chatStateRef, vaultSocketRef,
    joinedChatChannelsRef, closeTabRef, socketVaultReloadTimerRef, pendingChatPatchRef,
    chatPatchTimerRef, streamingChatMessageIdsRef, setChatState, setChatPresenceByChannel,
    setVaultAgents, setVaults, setUser, loadVaultData, loadNoteContent, loadChatAgentMembers,
    loadChatMessages, openChatTabIds, dispatchChatAgentIntents,
    recoverPendingChatAgentDispatches, scheduleCommunityRefresh,
  });
  const {
    handleCreateNote, handleCreateNoteInPane, handleCreateTabInPane,
    handleCreateChatInPane, handleDeleteNote, handleMoveNote, handleUnlistNote,
    handleCreateFolder, handleRenameFolder, handleMoveFolder, handleDeleteFolder,
    handleCreateNoteInFolder, handleExecuteDirective, handleReportProductFeedback,
  } = useNoteFolderOperations({
    activeVaultIdRef, notesRef, setNotice, setOpenTabs, setLayout, setFocusedPaneId, setNoteContents,
    loadVaultData, openChatChannel, layoutRef, focusedPaneRef, closeTabRef, handleSendChatMessage,
  });

  const {
    selectTabInPane, handleDropTab, handleDropNote, handleResizeSplit, handleDetachTab, splitFocusedPane,
  } = useWorkspaceTabs({
    activeVaultId, notesRef, openTabsRef, layoutRef, focusedPaneRef, noteContentsRef,
    setOpenTabs, setLayout, setFocusedPaneId, setNoteContents, loadNoteContent,
    loadSuperkanban, ensureChatChannelLoaded,
  });
  const handleChatJumpHandled = useCallback(() => setChatJumpTarget(null), []);


  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthError('');
    setAuthNotice('');
    try {
      if (authMode === 'reset') {
        const data = await api<{ user: User; owner?: boolean }>('/api/auth/reset', {
          method: 'POST',
          body: JSON.stringify({ token: resetToken.trim(), newPassword: password }),
        });
        localStorage.removeItem(SESSION_STORAGE_KEY);
        resetVaultWorkspaces();
        localStorage.removeItem('docs_token');
        setUser(data.user);
        setIsOwner(Boolean(data.owner));
        setPassword('');
        setResetToken('');
        await loadVaults();
        setAuthReady(true);
        return;
      }
      const inviteMatch = window.location.pathname.match(/^\/(?:invite|vault-invite)\/([^/]+)$/);
      const inviteToken = inviteMatch ? decodeURIComponent(inviteMatch[1]) : '';
      const data = await api<{ user: User; owner?: boolean }>(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password, ...(authMode === 'register' && inviteToken ? { inviteToken } : {}) }),
      });
      localStorage.removeItem(SESSION_STORAGE_KEY);
      resetVaultWorkspaces();
      localStorage.removeItem('docs_token');
      setUser(data.user);
      setIsOwner(Boolean(data.owner));
      setPassword('');
      await loadVaults();
      setAuthReady(true);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed');
    }
  }

  const handleLogout = () => {
    runSocketsRef.current.forEach((socket) => socket.disconnect());
    runSocketsRef.current.clear();
    stopDesktopRunnerHost();
    void api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('docs_token');
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setUser(null);
    setIsOwner(false);
    setAdminOpen(false);
    setVaults([]);
    resetVaultWorkspaces();
  };


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

  useEffect(() => {
    const electronAPI = (window as unknown as { electronAPI?: { onShortcut?: (cb: (a: string) => void) => () => void } }).electronAPI;
    if (!electronAPI?.onShortcut) return;
    return electronAPI.onShortcut((action) => {
      if (action === 'new-note') void handleCreateNote();
      else if (action === 'toggle-sidebar') setSidebarOpen((v) => !v);
    });
  }, [handleCreateNote]);

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
      const channelGone = notes.length > 0 && !channel && !loadingChatChannels[tab.id];
      if (channelGone) {
        return <div className="pane-empty">Channel not found</div>;
      }
      return (
        <Suspense fallback={<div className="pane-empty chat-loading-empty"><strong>Loading chat…</strong></div>}>
          <ChatView
            channelId={tab.id}
            channelName={channel?.title || tab.title}
            isLoadingMessages={loadingChatChannels[tab.id] === true}
            currentUser={currentUsername}
            presence={applyLocalUserProfile(chatPresenceByChannel[tab.id] ?? EMPTY_CHAT_PRESENCE, user)}
            availableAgents={AVAILABLE_CHAT_AGENTS}
            registeredAgents={chatState.registeredAgentsByChannel[tab.id] ?? EMPTY_CHAT_AGENTS}
            vaultAgents={vaultAgents}
            runnerHealth={runnerHealth}
            onRegisterAgent={handleRegisterChatAgent}
            onRemoveAgent={handleRemoveChatAgent}
            onUpsertVaultAgent={handleUpsertVaultAgent}
            onDeleteVaultAgent={handleDeleteVaultAgent}
            onDeleteAgentProfile={handleDeleteAgentProfile}
            onAddVaultAgentToChannel={handleAddVaultAgentToChannel}
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
            jumpToMessageId={chatJumpTarget?.channelId === tab.id ? chatJumpTarget.messageId : undefined}
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
  }, [chatState.registeredAgentsByChannel, chatPresenceByChannel, currentUsername, user, loadingChatChannels, runnerHealth, vaultAgents, handleCancelChatRun, handleInviteChatUser, handleRemoveChatParticipant, handleLeaveChatChannel, handleRegisterChatAgent, handleRemoveChatAgent, handleUpsertVaultAgent, handleDeleteVaultAgent, handleDeleteAgentProfile, handleAddVaultAgentToChannel, handleSendChatMessage, handleCollaborateChatMessage, handleForwardChatMessage, noteContents, notes, getNoteChangeHandler, getNoteSaveHandler, getNoteRenameHandler, handleExecuteDirective, handleOpenWikilink, openNote, chatMembersOpen, activeVaultId, handleHydrateChatMessage, handleOpenSharedChatNote, superkanbanNotes, superkanbanLiveWork, superkanbanLoading, superkanbanError, chatJumpTarget, handleChatJumpHandled]);

  if (!authReady) return <main className="auth-shell" id="auth-pending" />;

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
  return (
    <WorkspaceView {...{
      user, isOwner, vaults, activeVaultId, activeVaultIdRef, folders, notes, activeTabId,
      showAgentMemory, layout, focusedPaneId, openTabs, sidebarOpen, sidebarWidth, isResizing,
      chatMembersOpen, currentUsername, chatPresenceByChannel, chatState, vaultAgents,
      runnerHealth, loadingChatChannels, noteContents, superkanbanNotes, superkanbanLiveWork,
      superkanbanLoading, superkanbanError, chatJumpTarget, communityUpdates,
      communityUpdatesLoading, communityUpdatesError, adminOpen, accountOpen,
      accountInitialSection, documentationAssistantOpen, setDocumentationAssistantOpen,
      discoveryDmsOpen, setDiscoveryDmsOpen, updatesOpen, orbitOpen, sessionManagerOpen,
      focusSessionId, searchOpen, commandPaletteOpen, notice, renderTabContent,
      mobileSidebarSwipeRef, vaultSidebarChannel, setAdminOpen, setFocusedPaneId, setUser,
      switchVaultWorkspace, startResize, beginMobileSidebarSwipe, finishMobileSidebarSwipe,
      handleCreateVault, handleRenameVault, handleDeleteVault, handleJoinVault,
      handleCreateChannel, handleCreateNote, handleCreateNoteInFolder, handleCreateNoteInPane,
      handleCreateTabInPane, handleCreateChatInPane, handleLogout, handleReportProductFeedback,
      updateShowAgentMemory, markCommunityTargetRead, loadVaults, loadVaultData,
      loadCommunityUpdates, markAllCommunityUpdatesRead, openCommunityUpdate, openNote,
      openChatChannel, handleSaveActiveNote, renameNoteTab, openSuperkanban, setAuthEpoch,
      setAccountInitialSection, setAccountOpen, setSidebarOpen, setChatMembersOpen,
      setUpdatesOpen, setOrbitOpen, setSessionManagerOpen, setFocusSessionId, setSearchOpen,
      setCommandPaletteOpen, setChatJumpTarget, handleRegisterChatAgent, handleRemoveChatAgent,
      handleUpsertVaultAgent, handleDeleteVaultAgent, handleDeleteAgentProfile,
      handleAddVaultAgentToChannel, handleInviteChatUser, handleRemoveChatParticipant,
      handleLeaveChatChannel, handleSendChatMessage, handleCollaborateChatMessage,
      handleDeleteChatMessage, handleForwardChatMessage, handleCancelChatRun,
      handleHydrateChatMessage, handleOpenSharedChatNote, closeTab, closeOtherTabs,
      selectTabInPane, handleDropTab, handleDropNote, handleResizeSplit, handleDetachTab,
      handleCreateFolder, handleMoveFolder, handleRenameFolder, handleDeleteFolder,
      handleDeleteNote, handleMoveNote, handleUnlistNote,
    }} />
  );
}
