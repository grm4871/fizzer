import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { TabBar, type Tab } from './components/TabBar';
import { NoteEditor } from './components/NoteEditor';
import { WebView } from './components/WebView';
import { AIPanel } from './components/AIPanel';
import { SearchOverlay } from './components/SearchOverlay';
import { CommandPalette } from './components/CommandPalette';
import { api, type User, type Vault, type Folder, type NoteSummary, type Note } from './api';
import { connectVaultSocket } from './socket';
import { Gem, Sparkles, PanelLeftOpen, Columns } from 'lucide-react';

/**
 * @file App.tsx — Root component for Cascade Notes
 *
 * Orchestrates the entire application state and UI layout. Manages 16 state
 * variables spanning four concerns: authentication, vault/note data, tabbed
 * navigation, and UI panel visibility.
 *
 * **Data flow:** API calls → React state → props to child components.
 * The top-level grid layout uses inline `gridTemplateColumns` driven by
 * `sidebarOpen` / `aiPanelOpen` booleans. Socket.IO events trigger automatic
 * data reloads to keep the UI in sync with server-side changes.
 *
 * **Tab system:** Notes are opened as tabs; selecting a tab loads the note's
 * full content from the API. Dirty tracking compares draft content against
 * the last-saved snapshot.
 *
 * @component
 */

export default function App() {
  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // App data state
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);

  // Tabbed navigation state
  const [openTabs, setOpenTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [draftContent, setDraftContent] = useState('');

  // Split screen state
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  const [splitNote, setSplitNote] = useState<Note | null>(null);
  const [splitDraftContent, setSplitDraftContent] = useState('');

  // UI panels state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  // A directive prompt queued from the editor for the AI panel to run (nonce makes repeats distinct).
  const [directivePrompt, setDirectivePrompt] = useState<{ text: string; nonce: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // ═══════════════════════════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fetch available vaults from the server. Selects the first vault if none is
   * active, or auto-creates a default "My Vault" when the user has zero vaults.
   */
  const loadVaults = useCallback(async () => {
    try {
      const data = await api<{ vaults: Vault[] }>('/api/vaults');
      setVaults(data.vaults);
      if (data.vaults.length > 0 && !activeVaultId) {
        setActiveVaultId(data.vaults[0].id);
      } else if (data.vaults.length === 0) {
        // Create a default vault if none exist
        const created = await api<{ vault: Vault }>('/api/vaults', {
          method: 'POST',
          body: JSON.stringify({
            // Omit root_path so the server places it in a persistent location.
            name: 'My Vault',
          }),
        });
        setVaults([created.vault]);
        setActiveVaultId(created.vault.id);
      }
    } catch (error) {
      console.error('Error loading vaults:', error);
    }
  }, [activeVaultId]);

  // Check login on mount
  useEffect(() => {
    const token = localStorage.getItem('docs_token');
    if (!token) return;
    api<{ user: User }>('/api/me')
      .then((data) => {
        setUser(data.user);
        void loadVaults();
      })
      .catch(() => localStorage.removeItem('docs_token'));
  }, [loadVaults]);

  /**
   * Load the folder tree and notes list for a given vault.
   * Called when `activeVaultId` changes or when a socket event signals a data change.
   */
  const loadVaultData = useCallback(async (vaultId: string) => {
    try {
      const [folderData, noteData] = await Promise.all([
        api<{ folders: Folder[] }>(`/api/vaults/${vaultId}/folders`),
        api<{ notes: NoteSummary[] }>(`/api/vaults/${vaultId}/notes`),
      ]);
      setFolders(folderData.folders || []);
      setNotes(noteData.notes || []);
    } catch (error) {
      console.error('Error loading vault data:', error);
    }
  }, []);

  useEffect(() => {
    if (activeVaultId) {
      void loadVaultData(activeVaultId);
    } else {
      setFolders([]);
      setNotes([]);
      setOpenTabs([]);
      setActiveTabId(null);
      setActiveNote(null);
      setDraftContent('');
    }
  }, [activeVaultId, loadVaultData]);

  // ═══════════════════════════════════════════════════════════════
  // SOCKET SETUP
  // ═══════════════════════════════════════════════════════════════

  // Join/leave socket room
  useEffect(() => {
    if (!activeVaultId) return;
    const socket = connectVaultSocket();
    socket.emit('joinVault', activeVaultId);

    const handleNoteChanged = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId === activeVaultId) {
        void loadVaultData(activeVaultId);
        if (activeNote && activeNote.id === data.noteId) {
          // If the changed note is currently active and not dirty, reload it
          const tab = openTabs.find((t) => t.id === data.noteId);
          if (!tab || !tab.dirty) {
            void loadActiveNote(data.noteId);
          }
        }
      }
    };

    const handleNoteCreated = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId === activeVaultId) {
        void loadVaultData(activeVaultId);
      }
    };

    const handleNoteDeleted = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId === activeVaultId) {
        void loadVaultData(activeVaultId);
        // Close tab if deleted note is open
        setOpenTabs((prev) => prev.filter((t) => t.id !== data.noteId));
        if (activeTabId === data.noteId) {
          setActiveTabId(null);
          setActiveNote(null);
          setDraftContent('');
        }
      }
    };

    socket.on('vault:noteChanged', handleNoteChanged);
    socket.on('vault:noteCreated', handleNoteCreated);
    socket.on('vault:noteDeleted', handleNoteDeleted);

    return () => {
      socket.emit('leaveVault', activeVaultId);
      socket.off('vault:noteChanged', handleNoteChanged);
      socket.off('vault:noteCreated', handleNoteCreated);
      socket.off('vault:noteDeleted', handleNoteDeleted);
      socket.disconnect();
    };
  }, [activeVaultId, activeNote, openTabs, activeTabId, loadVaultData]);

  // ═══════════════════════════════════════════════════════════════
  // NOTE OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fetch a single note's full content by ID, set it as the active note,
   * and ensure it has an open tab.
   */
  const loadActiveNote = async (noteId: string) => {
    try {
      const data = await api<{ note: Note }>(`/api/notes/${noteId}`);
      setActiveNote(data.note);
      setDraftContent(data.note.content);

      // Add to open tabs if not already present
      setOpenTabs((prev) => {
        if (prev.some((t) => t.id === noteId)) return prev;
        return [...prev, { id: noteId, title: data.note.title, type: 'note', dirty: false }];
      });
      setActiveTabId(noteId);
    } catch (error) {
      console.error('Error loading note:', error);
    }
  };

  /**
   * Create a new "Untitled Note" in the active vault, refresh the sidebar,
   * and open it in a new tab.
   */
  const handleCreateNote = async () => {
    if (!activeVaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${activeVaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({
          title: 'Untitled Note',
          content: '# Untitled Note\n\nStart typing...',
        }),
      });
      // Refresh notes list
      await loadVaultData(activeVaultId);
      // Open new note
      void loadActiveNote(data.note.id);
    } catch (error) {
      console.error('Error creating note:', error);
    }
  };

  /**
   * Persist the current `draftContent` to the server for the active note.
   * Updates the tab's dirty flag and title, then refreshes the sidebar.
   * @returns The saved Note object.
   */
  const handleSaveNote = async () => {
    if (!activeNote) return;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${activeNote.id}`, {
        method: 'PUT',
        body: JSON.stringify({ content: draftContent }),
      });
      setActiveNote(data.note);
      // Mark tab as clean
      setOpenTabs((prev) =>
        prev.map((t) => (t.id === activeNote.id ? { ...t, title: data.note.title, dirty: false } : t))
      );
      // Refresh notes list
      if (activeVaultId) {
        void loadVaultData(activeVaultId);
      }
      return data.note;
    } catch (error) {
      console.error('Error saving note:', error);
      throw error;
    }
  };

  /**
   * Track edits to the note body. Compares against the saved snapshot to
   * determine dirty state for the active tab's unsaved-changes indicator.
   */
  const handleContentChange = (newContent: string) => {
    setDraftContent(newContent);
    if (activeNote) {
      const isDirty = newContent !== activeNote.content;
      setOpenTabs((prev) =>
        prev.map((t) => (t.id === activeNote.id ? { ...t, dirty: isDirty } : t))
      );
    }
  };

  /**
   * Rename the active note (title + on-disk file + wikilink references).
   * Shows an alert on failure; throws so the editor can revert its title draft.
   */
  const handleRenameNote = async (title: string) => {
    if (!activeNote) return;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${activeNote.id}/rename`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      setActiveNote(data.note);
      setOpenTabs((prev) => prev.map((t) => (t.id === data.note.id ? { ...t, title: data.note.title } : t)));
      if (activeVaultId) void loadVaultData(activeVaultId);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not rename note');
      throw error; // let the editor revert its title draft
    }
  };

  /**
   * Run an inline `{{ai: …}}` directive: open the AI panel and queue
   * the directive text as a prompt for the agent.
   */
  const handleExecuteDirective = (text: string) => {
    setAiPanelOpen(true);
    setDirectivePrompt({ text, nonce: Date.now() });
  };

  /** Open a website in a new web view tab. */
  const handleOpenWebView = (url: string) => {
    const existing = openTabs.find((t) => t.type === 'web' && t.url === url);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const newTabId = `web-${Date.now()}`;
    const domain = extractDomain(url);
    setOpenTabs((prev) => [
      ...prev,
      { id: newTabId, title: domain || url, type: 'web', dirty: false, url }
    ]);
    setActiveTabId(newTabId);
  };

  const updateTabUrl = (tabId: string, url: string) => {
    setOpenTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, url, title: extractDomain(url) } : t))
    );
  };

  const updateTabTitle = (tabId: string, title: string) => {
    setOpenTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, title } : t))
    );
  };

  /** Load a note's content for the split pane. */
  const loadSplitNote = async (noteId: string) => {
    try {
      const data = await api<{ note: Note }>(`/api/notes/${noteId}`);
      setSplitNote(data.note);
      setSplitDraftContent(data.note.content);
    } catch (error) {
      console.error('Error loading split note:', error);
    }
  };

  /** Open a tab in the split pane. */
  const handleSplitTab = (tabId: string) => {
    setSplitTabId(tabId);
    const tab = openTabs.find((t) => t.id === tabId);
    if (tab && tab.type === 'note') {
      void loadSplitNote(tabId);
    }
  };

  /** Track edits to the split note body. Syncs with main note if they are the same note. */
  const handleSplitContentChange = (newContent: string) => {
    setSplitDraftContent(newContent);
    if (splitNote) {
      const isDirty = newContent !== splitNote.content;
      setOpenTabs((prev) =>
        prev.map((t) => (t.id === splitNote.id ? { ...t, dirty: isDirty } : t))
      );
      if (activeNote && activeNote.id === splitNote.id) {
        setDraftContent(newContent);
      }
    }
  };

  /** Save the note open in the split pane. */
  const handleSaveSplitNote = async () => {
    if (!splitNote) return;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${splitNote.id}`, {
        method: 'PUT',
        body: JSON.stringify({ content: splitDraftContent }),
      });
      setSplitNote(data.note);
      if (activeNote && activeNote.id === splitNote.id) {
        setActiveNote(data.note);
      }
      setOpenTabs((prev) =>
        prev.map((t) => (t.id === splitNote.id ? { ...t, title: data.note.title, dirty: false } : t))
      );
      if (activeVaultId) {
        void loadVaultData(activeVaultId);
      }
      return data.note;
    } catch (error) {
      console.error('Error saving split note:', error);
      throw error;
    }
  };

  function extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TAB MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /** Switch the active tab and load the corresponding note if it is a note tab. */
  const handleSelectTab = (tabId: string) => {
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab || tab.type === 'note') {
      void loadActiveNote(tabId);
    } else {
      setActiveTabId(tabId);
    }
  };

  /**
   * Navigate to a note referenced by a `[[wikilink]]` (matched by title,
   * case-insensitive). No-op if no matching note is found.
   */
  const handleOpenWikilink = (title: string) => {
    const target = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
    if (target) {
      void loadActiveNote(target.id);
    }
  };

  /**
   * Close a tab. If the closed tab was active, activate the last remaining tab
   * or clear the editor if no tabs remain.
   */
  const handleCloseTab = (tabId: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);

      // If closed tab was in split pane, close split view
      if (splitTabId === tabId) {
        setSplitTabId(null);
        setSplitNote(null);
        setSplitDraftContent('');
      }

      if (activeTabId === tabId) {
        if (next.length > 0) {
          // Select last tab that is not the split tab, or just select any remaining
          const remaining = next.filter((t) => t.id !== splitTabId);
          if (remaining.length > 0) {
            const lastTab = remaining[remaining.length - 1];
            if (lastTab.type === 'note') {
              void loadActiveNote(lastTab.id);
            } else {
              setActiveTabId(lastTab.id);
            }
          } else {
            // If only the split tab remains, we make it the active tab and close split
            const lastTab = next[next.length - 1];
            if (lastTab.type === 'note') {
              void loadActiveNote(lastTab.id);
            } else {
              setActiveTabId(lastTab.id);
            }
            setSplitTabId(null);
            setSplitNote(null);
            setSplitDraftContent('');
          }
        } else {
          setActiveTabId(null);
          setActiveNote(null);
          setDraftContent('');
        }
      }
      return next;
    });
  };

  // ═══════════════════════════════════════════════════════════════
  // UI HANDLERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Handle login or registration form submission. On success, stores the JWT
   * token and loads the user's vaults.
   */
  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthError('');
    try {
      const data = await api<{ user: User; token: string }>(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem('docs_token', data.token);
      setUser(data.user);
      setPassword('');
      await loadVaults();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed');
    }
  }

  /** Log out: clear token and reset all application state to defaults. */
  const handleLogout = () => {
    localStorage.removeItem('docs_token');
    setUser(null);
    setVaults([]);
    setActiveVaultId(null);
    setFolders([]);
    setNotes([]);
    setOpenTabs([]);
    setActiveTabId(null);
    setActiveNote(null);
    setDraftContent('');
  };

  // ═══════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════════

  /*
   * ┌─────────────────────────┬─────────────────────────────────────┐
   * │ Shortcut                │ Action                              │
   * ├─────────────────────────┼─────────────────────────────────────┤
   * │ Ctrl/Cmd + P            │ Toggle command palette              │
   * │ Ctrl/Cmd + Shift + F    │ Toggle full-text search overlay     │
   * │ Ctrl/Cmd + \            │ Toggle sidebar                      │
   * │ Ctrl/Cmd + N            │ Create new note                     │
   * │ Ctrl/Cmd + S            │ Save current note                   │
   * │ Ctrl/Cmd + B            │ Bold (handled in NoteEditor)        │
   * │ Ctrl/Cmd + I            │ Italic (handled in NoteEditor)      │
   * │ Ctrl/Cmd + K            │ Insert link (handled in NoteEditor) │
   * │ Ctrl/Cmd + Enter        │ Run AI directive (NoteEditor)       │
   * └─────────────────────────┴─────────────────────────────────────┘
   */

  // Global keyboard shortcuts listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+P / Cmd+P - Command Palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
      // Ctrl+Shift+F / Cmd+Shift+F - Search
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
      // Ctrl+\ / Cmd+\ - Sidebar Toggle
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
      }
      // Ctrl+N / Cmd+N - New Note
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'n') {
        e.preventDefault();
        void handleCreateNote();
      }
      // Ctrl+S / Cmd+S - Save Note
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void handleSaveNote();
      }
      // Ctrl+Alt+\ or Ctrl+Shift+\ - Toggle Split View
      if ((e.ctrlKey || e.metaKey) && (e.altKey || e.shiftKey) && (e.key === '\\' || e.key === '|')) {
        e.preventDefault();
        if (splitTabId) {
          setSplitTabId(null);
          setSplitNote(null);
          setSplitDraftContent('');
        } else if (activeTabId) {
          const otherTab = openTabs.find((t) => t.id !== activeTabId);
          if (otherTab) {
            handleSplitTab(otherTab.id);
          } else {
            handleSplitTab(activeTabId);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeNote, draftContent, activeVaultId, splitTabId, activeTabId, openTabs]);

  // Shortcuts that Chromium reserves (Ctrl+N, Ctrl+\) never reach the renderer,
  // so the Electron main process intercepts them and forwards them here.
  useEffect(() => {
    const electronAPI = (window as unknown as {
      electronAPI?: { onShortcut?: (cb: (action: string) => void) => () => void };
    }).electronAPI;
    if (!electronAPI?.onShortcut) return;
    return electronAPI.onShortcut((action) => {
      if (action === 'new-note') {
        void handleCreateNote();
      } else if (action === 'toggle-sidebar') {
        setSidebarOpen((prev) => !prev);
      }
    });
  }, [activeVaultId]);

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  if (!user) {
    return (
      <main className="auth-shell">
        <form className="auth-panel" id="auth-panel" onSubmit={submitAuth}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
            <Gem size={28} /> Cascade Notes
          </h1>
          <p>An intelligent Obsidian-style editor with an AI agent assistant.</p>
          <label htmlFor="username">
            Username
            <input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoFocus
            />
          </label>
          <label htmlFor="password">
            Password
            <input
              id="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
            />
          </label>
          {authError && <div className="error">{authError}</div>}
          <button id="auth-submit" type="submit">
            {authMode === 'login' ? 'Log in' : 'Create account'}
          </button>
          <button
            id="auth-toggle-mode"
            type="button"
            className="link-button"
            onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
          >
            {authMode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'}
          </button>
        </form>
      </main>
    );
  }

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const splitTab = openTabs.find((t) => t.id === splitTabId);

  return (
    <main
      className="app-shell"
      style={{
        display: 'grid',
        gridTemplateColumns: `${sidebarOpen ? '280px' : '0px'} minmax(0, 1fr) ${aiPanelOpen ? '340px' : '0px'}`,
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      {/* Sidebar */}
      {sidebarOpen && (
        <Sidebar
          user={user}
          vaults={vaults}
          activeVaultId={activeVaultId}
          folders={folders}
          notes={notes}
          activeNoteId={activeTabId}
          onSelectVault={setActiveVaultId}
          onSelectNote={handleSelectTab}
          onNewNote={handleCreateNote}
          onSearch={() => setSearchOpen(true)}
          onCollapse={() => setSidebarOpen(false)}
          onLogout={handleLogout}
        />
      )}

      {/* Editor & Tabs pane */}
      <div className="flex flex-col flex-1" style={{ height: '100%', overflow: 'hidden', gridColumn: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-surface)' }}>
          {!sidebarOpen && (
            <button
              id="sidebar-expand-btn"
              className="btn-icon"
              style={{ margin: '0 8px 0 12px' }}
              onClick={() => setSidebarOpen(true)}
              title="Expand sidebar"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <TabBar
              tabs={openTabs}
              activeTabId={activeTabId}
              splitTabId={splitTabId}
              onSelectTab={handleSelectTab}
              onCloseTab={handleCloseTab}
              onOpenSplitTab={handleSplitTab}
            />
          </div>
          {!aiPanelOpen && activeNote && (
            <button
              id="ai-panel-expand-btn"
              className="btn-icon"
              style={{ margin: '0 12px 0 8px' }}
              onClick={() => setAiPanelOpen(true)}
              title="Open AI assistant"
            >
              <Sparkles size={16} />
            </button>
          )}
        </div>

        <div className="flex-1" style={{ position: 'relative', display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
          {/* Main Pane */}
          <div className="editor-pane" style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {activeTab?.type === 'web' ? (
              <WebView
                url={activeTab.url || ''}
                onNavigate={(url) => updateTabUrl(activeTab.id, url)}
                onTitleChange={(title) => updateTabTitle(activeTab.id, title)}
              />
            ) : (
              <NoteEditor
                note={activeNote}
                content={draftContent}
                onContentChange={handleContentChange}
                onSave={handleSaveNote}
                onRename={handleRenameNote}
                onExecuteDirective={handleExecuteDirective}
                onOpenWikilink={handleOpenWikilink}
                onOpenWebView={handleOpenWebView}
              />
            )}
          </div>

          {/* Split Pane */}
          {splitTabId && (
            <>
              <div className="split-divider" />
              <div className="editor-pane split-pane" style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: '1px solid var(--border-color)', position: 'relative' }}>
                <button
                  className="btn-icon"
                  style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 10, background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: '4px', width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => {
                    setSplitTabId(null);
                    setSplitNote(null);
                    setSplitDraftContent('');
                  }}
                  title="Close split view"
                >
                  ✕
                </button>
                {splitTab?.type === 'web' ? (
                  <WebView
                    url={splitTab.url || ''}
                    onNavigate={(url) => updateTabUrl(splitTab.id, url)}
                    onTitleChange={(title) => updateTabTitle(splitTab.id, title)}
                  />
                ) : (
                  <NoteEditor
                    note={splitNote}
                    content={splitDraftContent}
                    onContentChange={handleSplitContentChange}
                    onSave={handleSaveSplitNote}
                    onRename={handleRenameNote}
                    onExecuteDirective={handleExecuteDirective}
                    onOpenWikilink={handleOpenWikilink}
                    onOpenWebView={handleOpenWebView}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* AI Panel */}
      {aiPanelOpen && (
        <AIPanel
          note={activeNote}
          vaultId={activeVaultId}
          onSave={handleSaveNote}
          pendingPrompt={directivePrompt}
          onPromptConsumed={() => setDirectivePrompt(null)}
          onClose={() => setAiPanelOpen(false)}
        />
      )}

      {/* Search overlay modal */}
      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        vaultId={activeVaultId}
        onSelectNote={handleSelectTab}
      />

      {/* Command palette modal */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        notes={notes}
        onSelectNote={handleSelectTab}
        onCreateNote={handleCreateNote}
      />
    </main>
  );
}
