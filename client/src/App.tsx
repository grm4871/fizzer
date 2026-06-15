import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { NoteEditor } from './components/NoteEditor';
import { AIPanel } from './components/AIPanel';
import { SearchOverlay } from './components/SearchOverlay';
import { CommandPalette } from './components/CommandPalette';
import { api, type User, type Vault, type Folder, type NoteSummary, type Note } from './api';
import { connectVaultSocket } from './socket';
import { Gem, Sparkles, PanelLeftOpen } from 'lucide-react';

export default function App() {
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
  const [openTabs, setOpenTabs] = useState<{ id: string; title: string; dirty: boolean }[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [draftContent, setDraftContent] = useState('');

  // UI panels state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);


  // Load vaults
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

  // Load folders and notes when active vault changes
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

  // Load a single note's full content
  const loadActiveNote = async (noteId: string) => {
    try {
      const data = await api<{ note: Note }>(`/api/notes/${noteId}`);
      setActiveNote(data.note);
      setDraftContent(data.note.content);

      // Add to open tabs if not already present
      setOpenTabs((prev) => {
        if (prev.some((t) => t.id === noteId)) return prev;
        return [...prev, { id: noteId, title: data.note.title, dirty: false }];
      });
      setActiveTabId(noteId);
    } catch (error) {
      console.error('Error loading note:', error);
    }
  };

  // Select tab
  const handleSelectTab = (tabId: string) => {
    void loadActiveNote(tabId);
  };

  // Open a note referenced by a [[wikilink]] (matched by title)
  const handleOpenWikilink = (title: string) => {
    const target = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
    if (target) {
      void loadActiveNote(target.id);
    }
  };

  // Close tab
  const handleCloseTab = (tabId: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        if (next.length > 0) {
          // Select last tab
          const lastTab = next[next.length - 1];
          void loadActiveNote(lastTab.id);
        } else {
          setActiveTabId(null);
          setActiveNote(null);
          setDraftContent('');
        }
      }
      return next;
    });
  };

  // Create new note
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

  // Save current note
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

  // Handle note content edits
  const handleContentChange = (newContent: string) => {
    setDraftContent(newContent);
    if (activeNote) {
      const isDirty = newContent !== activeNote.content;
      setOpenTabs((prev) =>
        prev.map((t) => (t.id === activeNote.id ? { ...t, dirty: isDirty } : t))
      );
    }
  };

  // Run AI directives in the active note
  const handleRunDirectives = async () => {
    if (!activeNote) return;
    try {
      // First save the current draft content so the directives are saved to disk
      await handleSaveNote();

      const data = await api<{ note: Note }>(`/api/notes/${activeNote.id}/run-directives`, {
        method: 'POST',
      });
      setActiveNote(data.note);
      setDraftContent(data.note.content);
      // Mark tab as clean and update title if it changed
      setOpenTabs((prev) =>
        prev.map((t) => (t.id === activeNote.id ? { ...t, title: data.note.title, dirty: false } : t))
      );
      if (activeVaultId) {
        void loadVaultData(activeVaultId);
      }
    } catch (error) {
      console.error('Error running directives:', error);
    }
  };

  // Handle login/register submit
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

  // Logout
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

  // Keyboard shortcuts listener
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
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeNote, draftContent, activeVaultId]);

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

  if (!user) {
    return (
      <main className="auth-shell">
        <form className="auth-panel" id="auth-panel" onSubmit={submitAuth}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
            <Gem size={28} /> Cascade Notes
          </h1>
          <p>An intelligent Obsidian-style editor with inline LLM directives.</p>
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
              onSelectTab={handleSelectTab}
              onCloseTab={handleCloseTab}
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

        <div className="flex-1" style={{ position: 'relative', overflow: 'hidden' }}>
          <NoteEditor
            note={activeNote}
            content={draftContent}
            onContentChange={handleContentChange}
            onSave={handleSaveNote}
            onRunDirectives={handleRunDirectives}
            onOpenWikilink={handleOpenWikilink}
          />
        </div>
      </div>

      {/* AI Panel */}
      {aiPanelOpen && (
        <AIPanel
          note={activeNote}
          vaultId={activeVaultId}
          onSave={handleSaveNote}
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
