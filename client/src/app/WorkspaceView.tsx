import type { ReactNode, CSSProperties, MutableRefObject } from 'react';
import { Suspense } from 'react';
import type { User, Vault, Folder, NoteSummary, CommunityUpdates, CommunityUpdateItem, Note } from '../api';
import type { Tab } from '../components/TabBar';
import type { LayoutNode, DropSide } from '../layout/tree';
import type { ChatState } from '../chat/session';
import type { ChatAgentRegistration, ChatChannelPresence, DesktopRunnerHealth, VaultAgent } from '../chat/types';
import type { WorkItem } from '../chat/workItems';
import { Sidebar } from '../components/Sidebar';
import { NewsTicker } from '../components/NewsTicker';
import { PaneGrid, type TabDragPayload } from '../components/PaneGrid';
import { ChatView } from '../components/ChatView';
import { SessionManager } from '../components/SessionManager';
import { DocumentationAssistant } from '../components/DocumentationAssistant';
import { AccountSettings } from '../components/AccountSettings';
import { DiscoveryDmsModal } from '../components/DiscoveryDmsModal';
import { SearchOverlay } from '../components/SearchOverlay';
import { CommandPalette } from '../components/CommandPalette';
import { UpdatesModal } from '../components/UpdatesModal';
import { OrbitGraph } from '../components/OrbitGraph';
import { AdminPanel } from '../components/AdminPanel';
import { ModalShell } from '../components/ModalShell';
import { AndroidUpdatePrompt } from '../components/AndroidUpdatePrompt';
import { PanelLeftOpen, Download, Bell, Activity, Users } from 'lucide-react';
import { applyLocalUserProfile } from '../chat/shared';
import { CHAT_AGENTS, CHAT_AGENT_MODEL_PRESETS } from '../chat/agents';
const EMPTY_CHAT_PRESENCE: ChatChannelPresence = { participants: [], online: [] };



function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
}

export interface WorkspaceViewModel {
  user: User; isOwner: boolean; vaults: Vault[]; activeVaultId: string | null; activeVaultIdRef: MutableRefObject<string | null>; folders: Folder[]; notes: NoteSummary[]; activeTabId: string | null; showAgentMemory: boolean; layout: LayoutNode; focusedPaneId: string; openTabs: Tab[]; sidebarOpen: boolean; sidebarWidth: number; isResizing: boolean; chatMembersOpen: boolean; currentUsername: string; chatPresenceByChannel: Record<string, ChatChannelPresence>; chatState: ChatState; vaultAgents: VaultAgent[]; runnerHealth: DesktopRunnerHealth | null; loadingChatChannels: Record<string, boolean>; noteContents: Record<string, { note: Note; draft: string }>; superkanbanNotes: Note[]; superkanbanLiveWork: WorkItem[]; superkanbanLoading: boolean; superkanbanError: string | null; chatJumpTarget: { channelId: string; messageId: string } | null; communityUpdates: CommunityUpdates; communityUpdatesLoading: boolean; communityUpdatesError: string; adminOpen: boolean; accountOpen: boolean; accountInitialSection: 'profile' | 'vault'; documentationAssistantOpen: boolean; discoveryDmsOpen: 'public' | 'dms' | null; updatesOpen: boolean; orbitOpen: boolean; sessionManagerOpen: boolean; focusSessionId: string | null; searchOpen: boolean; commandPaletteOpen: boolean; notice: string | null; renderTabContent: (tab: Tab) => ReactNode; mobileSidebarSwipeRef: { current: { x: number; y: number; at: number; pointerId: number } | null };
  [key: string]: unknown;
}
export function WorkspaceView(model: WorkspaceViewModel) {
  const {
    user, isOwner, vaults, activeVaultId, activeVaultIdRef, folders, notes, activeTabId,
    showAgentMemory, layout, focusedPaneId, openTabs, sidebarOpen, sidebarWidth, isResizing,
    chatMembersOpen, currentUsername, chatPresenceByChannel, chatState, vaultAgents,
    runnerHealth, communityUpdates, communityUpdatesLoading, communityUpdatesError, adminOpen,
    accountOpen, accountInitialSection, documentationAssistantOpen, discoveryDmsOpen,
    updatesOpen, orbitOpen, sessionManagerOpen, focusSessionId, searchOpen,
    commandPaletteOpen, notice, renderTabContent, mobileSidebarSwipeRef,
  } = model;
  const inDesktopApp = Boolean((window as unknown as { electronAPI?: unknown }).electronAPI);
  const showDesktopDownload = !inDesktopApp && runnerHealth != null && !runnerHealth.online;
  const on = (name: string): unknown => model[name];
  const vaultSidebarChannel = model.vaultSidebarChannel as string | null;
  const setAdminOpen = on('setAdminOpen') as (open: boolean) => void;
  const setFocusedPaneId = on('setFocusedPaneId') as (id: string) => void;
  const selectTabInPane = on('selectTabInPane') as (paneId: string, tabId: string) => void;
  const handleJoinVault = on('handleJoinVault') as (token: string) => Promise<boolean>;
  const loadVaultData = on('loadVaultData') as (vaultId: string) => Promise<void>;
  const switchVaultWorkspace = on('switchVaultWorkspace') as (id: string | null) => void;
  const startResize = on('startResize') as (event: React.MouseEvent<HTMLDivElement>) => void;
  const beginMobileSidebarSwipe = on('beginMobileSidebarSwipe') as (event: React.PointerEvent<HTMLElement>) => void;
  const finishMobileSidebarSwipe = on('finishMobileSidebarSwipe') as (event: React.PointerEvent<HTMLElement>) => void;
  const handleCreateVault = on('handleCreateVault') as (name: string) => Promise<boolean>;
  const handleRenameVault = on('handleRenameVault') as (id: string, name: string) => Promise<boolean>;
  const handleDeleteVault = on('handleDeleteVault') as (id: string) => Promise<boolean>;
  const handleCreateChannel = on('handleCreateChannel') as (folderId?: string | null) => Promise<{ id: string; title: string } | undefined>;
  const handleCreateNote = on('handleCreateNote') as () => void;
  const handleCreateNoteInFolder = on('handleCreateNoteInFolder') as (id: string | null) => void;
  const handleCreateNoteInPane = on('handleCreateNoteInPane') as (id: string) => void;
  const handleCreateTabInPane = on('handleCreateTabInPane') as (id: string) => void;
  const handleCreateChatInPane = on('handleCreateChatInPane') as (id: string) => Promise<void>;
  const handleLogout = on('handleLogout') as () => void;
  const handleReportProductFeedback = on('handleReportProductFeedback') as (body: string) => Promise<void>;
  const updateShowAgentMemory = on('updateShowAgentMemory') as (show: boolean) => void;
  const markCommunityTargetRead = on('markCommunityTargetRead') as (id: string) => Promise<void>;
  const loadVaults = on('loadVaults') as () => Promise<void>;
  const loadCommunityUpdates = on('loadCommunityUpdates') as () => Promise<void>;
  const markAllCommunityUpdatesRead = on('markAllCommunityUpdatesRead') as () => Promise<void>;
  const openCommunityUpdate = on('openCommunityUpdate') as (item: CommunityUpdateItem) => Promise<void>;
  const openNote = on('openNote') as (id: string, mode?: 'open' | 'replace') => void;
  const openChatChannel = on('openChatChannel') as (id: string, title: string) => void;
  const renameNoteTab = on('renameNoteTab') as (id: string, title: string) => Promise<void>;
  const openSuperkanban = on('openSuperkanban') as (id: string) => void;
  const setAuthEpoch = on('setAuthEpoch') as (value: number | ((current: number) => number)) => void;
  const setDocumentationAssistantOpen = on('setDocumentationAssistantOpen') as (open: boolean) => void;
  const setDiscoveryDmsOpen = on('setDiscoveryDmsOpen') as (tab: 'public' | 'dms' | null) => void;
  const setAccountInitialSection = on('setAccountInitialSection') as (section: 'profile' | 'vault') => void;
  const setAccountOpen = on('setAccountOpen') as (open: boolean) => void;
  const setSidebarOpen = on('setSidebarOpen') as (open: boolean | ((value: boolean) => boolean)) => void;
  const setChatMembersOpen = on('setChatMembersOpen') as (open: boolean | ((value: boolean) => boolean)) => void;
  const setUpdatesOpen = on('setUpdatesOpen') as (open: boolean) => void;
  const setOrbitOpen = on('setOrbitOpen') as (open: boolean) => void;
  const setSessionManagerOpen = on('setSessionManagerOpen') as (open: boolean) => void;
  const setFocusSessionId = on('setFocusSessionId') as (id: string | null) => void;
  const setSearchOpen = on('setSearchOpen') as (open: boolean) => void;
  const setCommandPaletteOpen = on('setCommandPaletteOpen') as (open: boolean) => void;
  const setChatJumpTarget = on('setChatJumpTarget') as (target: { channelId: string; messageId: string } | null) => void;
  const handleRegisterChatAgent = on('handleRegisterChatAgent') as (channelId: string, registration: ChatAgentRegistration) => void;
  const handleRemoveChatAgent = on('handleRemoveChatAgent') as (channelId: string, id: string) => void;
  const handleUpsertVaultAgent = on('handleUpsertVaultAgent') as (input: Partial<VaultAgent> & { agentId: string }) => Promise<VaultAgent>;
  const handleDeleteVaultAgent = on('handleDeleteVaultAgent') as (id: string) => Promise<void>;
  const handleDeleteAgentProfile = on('handleDeleteAgentProfile') as (id: string) => Promise<void>;
  const handleAddVaultAgentToChannel = on('handleAddVaultAgentToChannel') as (channelId: string, id: string) => Promise<void>;
  const handleInviteChatUser = on('handleInviteChatUser') as (channelId: string, username: string) => Promise<void>;
  const handleRemoveChatParticipant = on('handleRemoveChatParticipant') as (channelId: string, username: string) => Promise<void>;
  const handleLeaveChatChannel = on('handleLeaveChatChannel') as (channelId: string) => Promise<void>;
  const setUser = on('setUser') as (user: User) => void;
  const handleSendChatMessage = on('handleSendChatMessage') as (channelId: string, body: string, media?: unknown[], replyTo?: unknown) => void;
  const handleCollaborateChatMessage = on('handleCollaborateChatMessage') as (channelId: string, source: string, target: string, relationship: string, instruction: string) => Promise<void>;
  const handleCancelChatRun = on('handleCancelChatRun') as (runId: number) => Promise<boolean>;
  const closeTab = on('closeTab') as (id: string) => void;
  const closeOtherTabs = on('closeOtherTabs') as (ids: string[], keep: string) => void;
  const handleDropTab = on('handleDropTab') as (payload: TabDragPayload, targetPaneId: string, side: DropSide, index?: number) => void;
  const handleDropNote = on('handleDropNote') as (noteId: string, targetPaneId: string, side: DropSide, index?: number) => void;
  const handleResizeSplit = on('handleResizeSplit') as (splitId: string, sizes: number[]) => void;
  const handleDetachTab = on('handleDetachTab') as (tabId: string, screenX: number, screenY: number) => void;
  const EMPTY_CHAT_AGENTS: ChatAgentRegistration[] = [];
  const AVAILABLE_CHAT_AGENTS = CHAT_AGENTS.map((agent) => ({ ...agent, models: CHAT_AGENT_MODEL_PRESETS[agent.id] }));
  const handleCreateFolder = on('handleCreateFolder') as (parentId?: string | null) => Promise<Folder | undefined>;
  const handleMoveFolder = on('handleMoveFolder') as (id: string, parentId: string | null, position: number) => void;
  const handleRenameFolder = on('handleRenameFolder') as (id: string, name: string) => void;
  const handleDeleteFolder = on('handleDeleteFolder') as (id: string) => void;
  const handleDeleteNote = on('handleDeleteNote') as (id: string) => void;
  const handleMoveNote = on('handleMoveNote') as (id: string, folderId: string | null, position?: number) => void;
  const handleUnlistNote = on('handleUnlistNote') as (id: string) => void;
  return (
    <main
      className={`app-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}
      style={{
        display: 'grid',
        '--sidebar-width': `${sidebarWidth}px`,
        overflow: 'hidden',
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
          onDeleteVault={handleDeleteVault}
          onManageVault={(vaultId) => {
            switchVaultWorkspace(vaultId);
            setAccountInitialSection('vault');
            setAccountOpen(true);
          }}
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
          onOpenAccount={() => {
            setAccountInitialSection('profile');
            setAccountOpen(true);
          }}
          onDeleteNote={handleDeleteNote}
          onMoveNote={handleMoveNote}
          onUnlistNote={handleUnlistNote}
          onMoveFolder={handleMoveFolder}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onRenameNote={renameNoteTab}
          onDeleteFolder={handleDeleteFolder}
      />
      <Suspense fallback={null}>
        <DocumentationAssistant
          open={documentationAssistantOpen}
          onOpen={() => setDocumentationAssistantOpen(true)}
          onClose={() => setDocumentationAssistantOpen(false)}
          vaultId={activeVaultId ?? vaults[0]?.id ?? null}
          runnerHealth={runnerHealth}
          onReportFeedback={handleReportProductFeedback}
        />
      </Suspense>

      {accountOpen && user && (
        <Suspense fallback={null}>
          <AccountSettings
            user={user}
            vaultId={activeVaultId}
            vaultName={vaults.find((vault) => vault.id === activeVaultId)?.name}
            initialSection={accountInitialSection}
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
            currentUsername={currentUsername}
            currentUser={user}
            updateCounts={communityUpdates.counts}
            onMarkRead={markCommunityTargetRead}
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
              id="orbit-btn"
              type="button"
              className="btn-icon"
              onClick={() => setOrbitOpen(true)}
              title="Orbit"
              aria-label="Orbit"
            >
              <svg width="16" height="16" viewBox="0 0 200 200" fill="none" stroke="currentColor" strokeWidth={10} aria-hidden="true">
                <mask id="orbit-cut">
                  <rect width="200" height="200" fill="white" />
                  <circle cx="160" cy="100" r="20" fill="black" />
                  <circle cx="100" cy="40" r="20" fill="black" />
                  <circle cx="40" cy="100" r="20" fill="black" />
                  <circle cx="100" cy="160" r="20" fill="black" />
                </mask>
                <circle cx="100" cy="100" r="60" mask="url(#orbit-cut)" />
                <circle cx="160" cy="100" r="20" />
                <circle cx="100" cy="40" r="20" />
                <circle cx="40" cy="100" r="20" />
                <circle cx="100" cy="160" r="20" />
              </svg>
            </button>
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
                presence={applyLocalUserProfile(chatPresenceByChannel[vaultSidebarChannel] ?? EMPTY_CHAT_PRESENCE, user)}
                availableAgents={AVAILABLE_CHAT_AGENTS}
                registeredAgents={chatState.registeredAgentsByChannel[vaultSidebarChannel] ?? EMPTY_CHAT_AGENTS}
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
            runnerOnline={Boolean(runnerHealth?.online)}
            focusSessionId={focusSessionId}
            onFocusHandled={() => setFocusSessionId(null)}
            onClose={() => { setFocusSessionId(null); setSessionManagerOpen(false); }}
            onOpenChat={async (vaultId, channelId, channelTitle) => {
              if (activeVaultIdRef.current !== vaultId) {
                switchVaultWorkspace(vaultId);
                await loadVaultData(vaultId);
              }
              openChatChannel(channelId, channelTitle);
              setSessionManagerOpen(false);
            }}
            onCancel={handleCancelChatRun}
            onInterrogate={async (vaultId, channelId, message) => {
              if (activeVaultIdRef.current !== vaultId) {
                switchVaultWorkspace(vaultId);
                await loadVaultData(vaultId);
              }
              await handleSendChatMessage(channelId, message);
            }}
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
      {orbitOpen && (
        <Suspense fallback={null}>
          <ModalShell
            backdropClassName="overlay-backdrop orbit-backdrop"
            dialogClassName="orbit-modal"
            ariaLabel="Orbit"
            onClose={() => setOrbitOpen(false)}
          >
            <OrbitGraph
              promptNoteId={notes.find((note) => note.title.toLowerCase() === 'prompt')?.id}
              captionLogNoteId={notes.find((note) => note.title.toLowerCase() === 'orbit caption log')?.id}
              onOpenActivity={(activity) => {
                setOrbitOpen(false);
                setFocusSessionId(activity.sessionId);
                setSessionManagerOpen(true);
              }}
            />
          </ModalShell>
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
      <Suspense fallback={null}><AndroidUpdatePrompt /></Suspense>

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
