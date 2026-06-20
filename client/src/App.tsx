import { useEffect, useState, useCallback, useRef, useLayoutEffect, type ReactNode } from 'react';
import { Sidebar } from './components/Sidebar';
import { type Tab } from './components/TabBar';
import { NoteEditor } from './components/NoteEditor';
import { WebView } from './components/WebView';
import { TerminalWindow } from './components/TerminalWindow';
import { AIPanel } from './components/AIPanel';
import { SearchOverlay } from './components/SearchOverlay';
import { CommandPalette } from './components/CommandPalette';
import { PaneGrid, type TabDragPayload } from './components/PaneGrid';
import * as Layout from './layout/tree';
import type { LayoutNode } from './layout/tree';
import { api, type User, type Vault, type Folder, type NoteSummary, type Note } from './api';
import { connectVaultSocket } from './socket';
import { Gem, Bot, PanelLeftOpen, SquareTerminal } from 'lucide-react';

/**
 * @file App.tsx — Root component for Cascade
 *
 * Orchestrates application state and the tiling workspace. `openTabs` is the
 * global registry of tab content (notes, web views, terminals); a recursive
 * {@link LayoutNode} tree (see `layout/tree.ts`) describes how those tabs are
 * arranged into draggable, resizable panes. Note bodies are held per-tab in
 * `noteContents` so any number of note panes can be edited independently.
 *
 * Web tabs render once into a persistent overlay positioned over whichever pane
 * currently shows them, so switching/tiling never reloads them.
 *
 * @component
 */

function sanitizeRestoredTabs(value: unknown): Tab[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tab): tab is Partial<Tab> => Boolean(tab) && typeof tab === 'object')
    .map((tab): Tab | null => {
      if (typeof tab.id !== 'string' || typeof tab.title !== 'string') return null;
      if (tab.type === 'web') {
        return {
          id: tab.id,
          title: tab.title,
          type: 'web',
          dirty: false,
          url: typeof tab.url === 'string' ? tab.url : 'about:blank',
          isChatNote: typeof tab.isChatNote === 'boolean' ? tab.isChatNote : undefined
        };
      }
      if (tab.type === 'terminal') {
        return { id: tab.id, title: tab.title || 'Terminal', type: 'terminal', dirty: false, terminalHistory: typeof tab.terminalHistory === 'string' ? tab.terminalHistory : '' };
      }
      if (tab.type === 'note') {
        return { id: tab.id, title: tab.title, type: 'note', dirty: false };
      }
      return null;
    })
    .filter((tab): tab is Tab => Boolean(tab));
}

/**
 * Session persisted to localStorage so a reload restores the workspace: the open
 * tabs, the pane layout tree, and which pane was focused. Note bodies are
 * re-fetched on restore; web tabs reload from their persisted URL.
 */
interface PersistedSession {
  activeVaultId: string | null;
  openTabs: Tab[];
  layout: LayoutNode;
  focusedPaneId: string;
}

const SESSION_STORAGE_KEY = 'cascade_session';

function emptySession(): PersistedSession {
  const pane = Layout.createPane();
  return { activeVaultId: null, openTabs: [], layout: pane, focusedPaneId: pane.id };
}

function loadPersistedSession(): PersistedSession {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return emptySession();
    const parsed = JSON.parse(raw) as Partial<PersistedSession> & { activeTabId?: string; splitTabId?: string };
    const openTabs = sanitizeRestoredTabs(parsed.openTabs);
    const validIds = new Set(openTabs.map((t) => t.id));

    let layout: LayoutNode;
    if (parsed.layout) {
      layout = Layout.ensureValid(parsed.layout, validIds);
    } else {
      // Migrate the pre-grid single/split-pane session into a layout tree.
      const activeTabId = typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null;
      const splitTabId = typeof parsed.splitTabId === 'string' ? parsed.splitTabId : null;
      layout = Layout.migrateFromLegacy(openTabs.map((t) => t.id), activeTabId, splitTabId);
    }

    const focusedPaneId =
      parsed.focusedPaneId && Layout.findPane(layout, parsed.focusedPaneId)
        ? parsed.focusedPaneId
        : Layout.getFirstPane(layout).id;

    return { activeVaultId: parsed.activeVaultId ?? null, openTabs, layout, focusedPaneId };
  } catch {
    return emptySession();
  }
}

type PaneRect = { left: number; top: number; width: number; height: number };
type NoteEntry = { note: Note; draft: string };

export default function App() {
  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════

  const persistedSessionRef = useRef<PersistedSession>(loadPersistedSession());

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // App data state
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(persistedSessionRef.current.activeVaultId);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);

  // Tabs + tiling layout
  const [openTabs, setOpenTabs] = useState<Tab[]>(persistedSessionRef.current.openTabs);
  const [layout, setLayout] = useState<LayoutNode>(persistedSessionRef.current.layout);
  const [focusedPaneId, setFocusedPaneId] = useState<string>(persistedSessionRef.current.focusedPaneId);
  // Note bodies, keyed by tab id, so each note pane edits independently.
  const [noteContents, setNoteContents] = useState<Record<string, NoteEntry>>({});

  // UI panels state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('cascade_sidebar_w')) || 280);
  const [aiPanelWidth, setAiPanelWidth] = useState(() => Number(localStorage.getItem('cascade_aipanel_w')) || 340);
  const [isResizing, setIsResizing] = useState(false);

  const [directivePrompt, setDirectivePrompt] = useState<{ text: string; nonce: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // True while a tab is being dragged, so the <webview> overlay lets drops
  // fall through to the panes underneath it.
  const [isDraggingTab, setIsDraggingTab] = useState(false);

  // ─── Derived focus state ────────────────────────────────────────
  const focusedPane = Layout.findPane(layout, focusedPaneId) ?? Layout.getFirstPane(layout);
  const activeTabId = focusedPane.activeTabId;
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const activeNoteEntry = activeTabId ? noteContents[activeTabId] : undefined;
  const activeNote = activeNoteEntry?.note ?? null;

  // Refs mirror the latest state so event handlers stay stable (no dep churn)
  // and never read a stale closure during drags / async work.
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const focusedPaneRef = useRef(focusedPane); focusedPaneRef.current = focusedPane;
  const openTabsRef = useRef(openTabs); openTabsRef.current = openTabs;
  const noteContentsRef = useRef(noteContents); noteContentsRef.current = noteContents;
  const activeVaultIdRef = useRef(activeVaultId); activeVaultIdRef.current = activeVaultId;
  const notesRef = useRef(notes); notesRef.current = notes;

  // ─── Persistent web-tab geometry ────────────────────────────────
  // Each pane registers its content element so we can position the persistent
  // <webview> overlay over the pane that currently shows a given web tab.
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const paneElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [paneRects, setPaneRects] = useState<Record<string, PaneRect>>({});

  const registerPaneContent = useCallback((paneId: string, el: HTMLDivElement | null) => {
    if (el) paneElsRef.current.set(paneId, el);
    else paneElsRef.current.delete(paneId);
  }, []);

  const measurePanes = useCallback(() => {
    const area = editorAreaRef.current;
    if (!area) return;
    const areaRect = area.getBoundingClientRect();
    const next: Record<string, PaneRect> = {};
    paneElsRef.current.forEach((el, id) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      next[id] = { left: r.left - areaRect.left, top: r.top - areaRect.top, width: r.width, height: r.height };
    });
    setPaneRects(next);
  }, []);

  useLayoutEffect(() => {
    measurePanes();
    const observer = new ResizeObserver(() => measurePanes());
    if (editorAreaRef.current) observer.observe(editorAreaRef.current);
    paneElsRef.current.forEach((el) => observer.observe(el));
    window.addEventListener('resize', measurePanes);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measurePanes);
    };
  }, [measurePanes, layout, sidebarOpen, aiPanelOpen, sidebarWidth, aiPanelWidth, openTabs]);

  // Repair focus if the focused pane disappears (e.g. after collapsing a split).
  useEffect(() => {
    if (!Layout.findPane(layout, focusedPaneId)) {
      setFocusedPaneId(Layout.getFirstPane(layout).id);
    }
  }, [layout, focusedPaneId]);

  useEffect(() => { localStorage.setItem('cascade_sidebar_w', String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => { localStorage.setItem('cascade_aipanel_w', String(aiPanelWidth)); }, [aiPanelWidth]);

  // Persist the workspace session.
  useEffect(() => {
    const session: PersistedSession = { activeVaultId, openTabs, layout, focusedPaneId };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }, [activeVaultId, openTabs, layout, focusedPaneId]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  /** Drag a side-panel divider (sidebar / AI panel widths). */
  const startResize = useCallback((panel: 'sidebar' | 'ai', event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startSidebar = sidebarWidth;
    const startAi = aiPanelWidth;
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      if (panel === 'sidebar') setSidebarWidth(clamp(startSidebar + delta, 180, 480));
      else setAiPanelWidth(clamp(startAi - delta, 260, 560));
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
  }, [sidebarWidth, aiPanelWidth]);

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
    api<{ user: User }>('/api/me')
      .then((data) => { setUser(data.user); void loadVaults(); })
      .catch(() => localStorage.removeItem('docs_token'));
  }, [loadVaults]);

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
  // WEB / TERMINAL TAB OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  function extractDomain(url: string): string {
    try { return new URL(url).hostname; } catch { return url; }
  }

  /** Add a tab to the registry and place it (active) into a pane. */
  const addTabToPane = useCallback((tab: Tab, paneId: string) => {
    setOpenTabs((prev) => [...prev, tab]);
    setLayout(Layout.simplify(Layout.addTabToPane(layoutRef.current, paneId, tab.id)));
    setFocusedPaneId(paneId);
  }, []);

  /** Create a fresh browser tab in the given (or focused) pane. */
  const handleCreateWebTab = useCallback((paneId?: string) => {
    const id = `web-${Date.now()}`;
    addTabToPane({ id, title: 'New Tab', type: 'web', dirty: false, url: 'about:blank' }, paneId ?? focusedPaneRef.current.id);
  }, [addTabToPane]);

  /** Open a URL: focus an existing matching web tab, else open a new one. */
  const handleOpenWebView = useCallback((url: string, isChatNote?: boolean) => {
    const shouldBeChatNote = isChatNote || url.includes('#chatNote') || url.includes('chatNote=true');
    const cleanUrl = url.replace('#chatNote', '').replace(/[?&]chatNote=true/, '');

    const existing = openTabsRef.current.find((t) => t.type === 'web' && (t.url === cleanUrl || t.url === url));
    if (existing) {
      if (shouldBeChatNote && !existing.isChatNote) {
        setOpenTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, isChatNote: true } : t)));
      }
      const pane = Layout.findPaneByTab(layoutRef.current, existing.id);
      if (pane) { setLayout(Layout.setActiveTab(layoutRef.current, pane.id, existing.id)); setFocusedPaneId(pane.id); }
      return;
    }
    const id = `web-${Date.now()}`;
    addTabToPane({
      id,
      title: extractDomain(cleanUrl) || cleanUrl,
      type: 'web',
      dirty: false,
      url: cleanUrl,
      isChatNote: shouldBeChatNote,
    }, focusedPaneRef.current.id);
  }, [addTabToPane]);

  const handleCreateChatNote = useCallback(async (tabId: string) => {
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (!tab || tab.type !== 'web') return;

    // Promote the tab locally to be a chat note
    setOpenTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, isChatNote: true } : t))
    );

    // Call electron to update its chat note state
    const electronAPI = (window as unknown as {
      electronAPI?: { setChatNote?: (id: string, isChatNote: boolean) => Promise<{ success: boolean }> };
    }).electronAPI;
    if (electronAPI?.setChatNote) {
      void electronAPI.setChatNote(tabId, true);
    }

    // Create the shortcut note in the vault
    if (!activeVaultIdRef.current) return;
    try {
      const urlWithHash = `${tab.url || 'about:blank'}#chatNote`;
      const title = tab.title || 'Chat Note';
      await api<{ note: Note }>(`/api/vaults/${activeVaultIdRef.current}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title, content: urlWithHash }),
      });
      setNotice(`Created chat note shortcut: ${title}`);
      await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      console.error('Error creating chat note shortcut:', error);
    }
  }, [loadVaultData]);

  // ═══════════════════════════════════════════════════════════════
  // TERMINAL HELPERS
  // ═══════════════════════════════════════════════════════════════

  const stopTerminalTab = useCallback((tabId: string) => {
    const electronAPI = (window as unknown as {
      electronAPI?: { stopTerminal?: (id: string) => Promise<{ success: boolean; error?: string }> };
    }).electronAPI;
    void electronAPI?.stopTerminal?.(tabId);
  }, []);

  /** Close a tab from anywhere: drop it from the registry, content, and tree. */
  const closeTab = useCallback((tabId: string) => {
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (tab?.type === 'terminal') stopTerminalTab(tabId);
    setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
    setNoteContents((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setLayout(Layout.simplify(Layout.removeTab(layoutRef.current, tabId)));
  }, [stopTerminalTab]);

  // Stable handle so socket/delete callbacks can close tabs without re-subscribing.
  const closeTabRef = useRef(closeTab); closeTabRef.current = closeTab;

  // ═══════════════════════════════════════════════════════════════
  // NOTE CONTENT
  // ═══════════════════════════════════════════════════════════════

  /** Fetch a note body into `noteContents` (no layout change). Self-heals stale tabs. */
  const loadNoteContent = useCallback(async (noteId: string) => {
    try {
      const data = await api<{ note: Note }>(`/api/notes/${noteId}`);

      // Shortcut URL check
      const content = data.note.content.trim();
      const match = content.match(/^(https?:\/\/[^\s]+)$/);
      if (match) {
        const url = match[1];
        closeTab(noteId);
        handleOpenWebView(url);
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
  }, [loadVaultData, closeTab, handleOpenWebView]);

  /**
   * Open a note: ensure it has a tab, place it in the focused pane (or focus the
   * pane that already shows it), then load its body. `replace` swaps the focused
   * pane's active tab for this note (used by single-click in the sidebar).
   */
  const openNote = useCallback((noteId: string, mode: 'open' | 'replace' = 'open') => {
    // Check if the note is a shortcut URL in the summary list
    const summary = notesRef.current.find((n) => n.id === noteId);
    if (summary) {
      const preview = summary.content_preview.trim();
      const match = preview.match(/^(https?:\/\/[^\s]+)$/);
      if (match) {
        handleOpenWebView(match[1]);
        return;
      }
    }

    setOpenTabs((prev) =>
      prev.some((t) => t.id === noteId) ? prev : [...prev, { id: noteId, title: 'Untitled Note', type: 'note', dirty: false }],
    );

    const prev = layoutRef.current;
    const focused = focusedPaneRef.current;
    const existingPane = Layout.findPaneByTab(prev, noteId);

    if (mode !== 'replace' && existingPane) {
      setLayout(Layout.setActiveTab(prev, existingPane.id, noteId));
      setFocusedPaneId(existingPane.id);
    } else {
      let next = Layout.addTabToPane(Layout.removeTab(prev, noteId), focused.id, noteId);
      const oldId = focused.activeTabId;
      if (mode === 'replace' && oldId && oldId !== noteId) {
        next = Layout.removeTab(next, oldId);
        setOpenTabs((p) => p.filter((t) => t.id !== oldId));
        setNoteContents((p) => { const copy = { ...p }; delete copy[oldId]; return copy; });
        if (openTabsRef.current.find((t) => t.id === oldId)?.type === 'terminal') stopTerminalTab(oldId);
      }
      setLayout(Layout.simplify(next));
      setFocusedPaneId(focused.id);
    }

    void loadNoteContent(noteId);
  }, [loadNoteContent, stopTerminalTab, handleOpenWebView]);

  /** Save a specific note tab's draft. */
  const saveNoteTab = useCallback(async (tabId: string) => {
    const entry = noteContentsRef.current[tabId];
    if (!entry) return;
    try {
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
      setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title: data.note.title } : t)));
      if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not rename note');
      throw error; // let the editor revert its title draft
    }
  }, [loadVaultData]);

  // ═══════════════════════════════════════════════════════════════
  // SOCKET SETUP
  // ═══════════════════════════════════════════════════════════════

  useEffect(() => {
    if (!activeVaultId) return;
    const socket = connectVaultSocket();
    socket.emit('joinVault', activeVaultId);

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

    socket.on('vault:noteChanged', handleNoteChanged);
    socket.on('vault:noteCreated', handleNoteCreated);
    socket.on('vault:noteDeleted', handleNoteDeleted);
    socket.on('vault:feedNotify', handleFeedNotify);
    return () => {
      socket.emit('leaveVault', activeVaultId);
      socket.off('vault:noteChanged', handleNoteChanged);
      socket.off('vault:noteCreated', handleNoteCreated);
      socket.off('vault:noteDeleted', handleNoteDeleted);
      socket.off('vault:feedNotify', handleFeedNotify);
      socket.disconnect();
    };
  }, [activeVaultId, loadVaultData, loadNoteContent, openNote]);

  // ═══════════════════════════════════════════════════════════════
  // NOTE / FOLDER OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  const handleCreateNote = useCallback(async () => {
    if (!activeVaultIdRef.current) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${activeVaultIdRef.current}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled Note', content: '' }),
      });
      await loadVaultData(activeVaultIdRef.current);
      openNote(data.note.id);
    } catch (error) {
      console.error('Error creating note:', error);
    }
  }, [loadVaultData, openNote]);

  const handleDeleteNote = useCallback(async (noteId: string) => {
    if (!window.confirm('Delete this note? This cannot be undone.')) return;
    try {
      await api(`/api/notes/${noteId}`, { method: 'DELETE' });
      closeTabRef.current(noteId);
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

  const handleCreateNoteInFolder = useCallback(async (folderId: string | null) => {
    if (!activeVaultIdRef.current) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${activeVaultIdRef.current}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled Note', content: '', folder_id: folderId ?? undefined }),
      });
      await loadVaultData(activeVaultIdRef.current);
      openNote(data.note.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create note');
    }
  }, [loadVaultData, openNote]);

  const handleExecuteDirective = useCallback((text: string) => {
    setAiPanelOpen(true);
    setDirectivePrompt({ text, nonce: Date.now() });
  }, []);

  const handleLinkifyTerm = useCallback(async (term: string, _context: string, sourceTitle?: string) => {
    if (!activeVaultIdRef.current) return;
    try {
      const data = await api<{ note: Note; matched: boolean }>(
        `/api/vaults/${activeVaultIdRef.current}/notes/linkify`,
        { method: 'POST', body: JSON.stringify({ term }) },
      );
      await loadVaultData(activeVaultIdRef.current);
      const canonical = data.note.title;
      const linkedFrom = sourceTitle ? ` it was linked from the note "${sourceTitle}", which you can read if you desire context.` : '';
      const prompt = data.matched
        ? `the existing note "${canonical} was linked from ${linkedFrom}. if this provides additional context, please update ${canonical} to match."`
        : `please fill in the new note titled "${canonical}". move the note into the folder that feels most appropriate, or create a new folder.${linkedFrom}`;
      handleExecuteDirective(prompt);
      setNotice(data.matched ? `Linking “${term}” to “${canonical}” — agent is updating it…` : `Created “${canonical}” — agent is filling it in…`);
      return { title: canonical, matched: data.matched };
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not link term');
      throw error;
    }
  }, [loadVaultData, handleExecuteDirective]);

  // ═══════════════════════════════════════════════════════════════
  // WEB / TERMINAL TAB STATE UPDATES
  // ═══════════════════════════════════════════════════════════════

  const updateTabUrl = useCallback((tabId: string, url: string) => {
    setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, url, title: extractDomain(url) } : t)));
  }, []);

  const updateTabTitle = useCallback((tabId: string, title: string) => {
    setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title } : t)));
  }, []);

  const updateTerminalHistory = useCallback((tabId: string, terminalHistory: string) => {
    setOpenTabs((prev) => prev.map((t) => (t.id === tabId && t.type === 'terminal' ? { ...t, terminalHistory } : t)));
  }, []);

  /** Turn the focused pane's active tab into a terminal (or open a new one). */
  const handleUpgradeActiveTabToTerminal = useCallback(() => {
    const focused = focusedPaneRef.current;
    const activeId = focused.activeTabId;
    const termId = activeId ?? `terminal-${Date.now()}`;
    const termTab: Tab = { id: termId, title: 'Terminal', type: 'terminal', dirty: false, terminalHistory: '' };
    setOpenTabs((prev) => (activeId ? prev.map((t) => (t.id === activeId ? termTab : t)) : [...prev, termTab]));
    setNoteContents((prev) => { const next = { ...prev }; delete next[termId]; return next; });
    if (!activeId) setLayout(Layout.simplify(Layout.addTabToPane(layoutRef.current, focused.id, termId)));
  }, []);

  // ═══════════════════════════════════════════════════════════════
  // TAB / PANE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /** Select a tab inside a specific pane (per-pane strip click). */
  const selectTabInPane = useCallback((paneId: string, tabId: string) => {
    setLayout(Layout.setActiveTab(layoutRef.current, paneId, tabId));
    setFocusedPaneId(paneId);
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (tab?.type === 'note' && !noteContentsRef.current[tabId]) void loadNoteContent(tabId);
  }, [loadNoteContent]);

  /** Handle a tab dropped onto a pane (drag-tile). */
  const handleDropTab = useCallback((payload: TabDragPayload, targetPaneId: string, side: Layout.DropSide, index?: number) => {
    const prev = layoutRef.current;
    const next = side === 'center'
      ? Layout.moveTab(prev, payload.tabId, targetPaneId, index)
      : Layout.splitPaneWithTab(prev, targetPaneId, side, payload.tabId);
    setLayout(next);
    const landed = Layout.findPaneByTab(next, payload.tabId);
    setFocusedPaneId(landed?.id ?? targetPaneId);
    // The dropped tab's button unmounts as the layout rebuilds, so its
    // onDragEnd never fires. Clear the drag flag here, otherwise the webview
    // wrapper stays at pointer-events:none and the page becomes unclickable.
    setIsDraggingTab(false);
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
    void electronAPI.popOutTab({ tab, screenX, screenY }).then((res) => {
      if (!res?.popped) return;
      // Remove from this window but DON'T stop a terminal's PTY — the popped-out
      // window reconnects to the same live shell by id (terminal:start reuses it).
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
    if (focused.tabIds.length >= 2 && focused.activeTabId) {
      const next = Layout.splitPaneWithTab(layoutRef.current, focused.id, 'right', focused.activeTabId);
      setLayout(next);
      const landed = Layout.findPaneByTab(next, focused.activeTabId);
      if (landed) setFocusedPaneId(landed.id);
    } else {
      const id = `web-${Date.now()}`;
      setOpenTabs((prev) => [...prev, { id, title: 'New Tab', type: 'web', dirty: false, url: 'about:blank' }]);
      const next = Layout.splitPaneWithTab(layoutRef.current, focused.id, 'right', id);
      setLayout(next);
      const landed = Layout.findPaneByTab(next, id);
      if (landed) setFocusedPaneId(landed.id);
    }
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

  const handleLogout = () => {
    const pane = Layout.createPane();
    localStorage.removeItem('docs_token');
    setUser(null);
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

  /** Render the content of a tab inside its pane (web tabs draw via the overlay). */
  const renderTabContent = useCallback((tab: Tab): ReactNode => {
    if (tab.type === 'web') return null;
    if (tab.type === 'terminal') {
      return (
        <TerminalWindow
          id={tab.id}
          history={tab.terminalHistory || ''}
          onHistoryChange={(history) => updateTerminalHistory(tab.id, history)}
          onTitleChange={(title) => updateTabTitle(tab.id, title)}
        />
      );
    }
    const entry = noteContents[tab.id];
    return (
      <NoteEditor
        note={entry?.note ?? null}
        content={entry?.draft ?? ''}
        onContentChange={(c) => handleNoteChange(tab.id, c)}
        onSave={() => saveNoteTab(tab.id)}
        onRename={(title) => renameNoteTab(tab.id, title)}
        onExecuteDirective={handleExecuteDirective}
        onOpenWikilink={(title) => {
          const target = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
          if (target) openNote(target.id);
        }}
        onOpenWebView={handleOpenWebView}
        onLinkifySelection={(term, context) => handleLinkifyTerm(term, context, entry?.note?.title)}
      />
    );
  }, [noteContents, notes, updateTerminalHistory, updateTabTitle, handleNoteChange, saveNoteTab, renameNoteTab, handleExecuteDirective, handleOpenWebView, handleLinkifyTerm, openNote]);

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
            <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </label>
          <label htmlFor="password">
            Password
            <input id="password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
          </label>
          {authError && <div className="error">{authError}</div>}
          <button id="auth-submit" type="submit">{authMode === 'login' ? 'Log in' : 'Create account'}</button>
          <button id="auth-toggle-mode" type="button" className="link-button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
            {authMode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'}
          </button>
        </form>
      </main>
    );
  }

  const webTabs = openTabs.filter((t) => t.type === 'web');

  return (
    <main
      className="app-shell"
      style={{
        display: 'grid',
        gridTemplateColumns: `${sidebarOpen ? `${sidebarWidth}px` : '0px'} minmax(0, 1fr) ${aiPanelOpen ? `${aiPanelWidth}px` : '0px'}`,
        height: '100vh',
        overflow: 'hidden',
        position: 'relative',
        transition: isResizing ? 'none' : undefined,
      }}
    >
      {sidebarOpen && (
        <div className="resize-handle" style={{ left: sidebarWidth - 3 }} onMouseDown={(e) => startResize('sidebar', e)} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize" />
      )}
      {aiPanelOpen && (
        <div className="resize-handle" style={{ right: aiPanelWidth - 3 }} onMouseDown={(e) => startResize('ai', e)} role="separator" aria-orientation="vertical" aria-label="Resize assistant panel" title="Drag to resize" />
      )}

      {sidebarOpen && (
        <Sidebar
          user={user}
          vaults={vaults}
          activeVaultId={activeVaultId}
          folders={folders}
          notes={notes}
          activeNoteId={activeTabId}
          onSelectVault={setActiveVaultId}
          onSelectNote={(id) => openNote(id, 'replace')}
          onOpenNoteInNewTab={(id) => openNote(id)}
          onNewNote={handleCreateNote}
          onNewNoteInFolder={handleCreateNoteInFolder}
          onSearch={() => setSearchOpen(true)}
          onCollapse={() => setSidebarOpen(false)}
          onLogout={handleLogout}
          onDeleteNote={handleDeleteNote}
          onMoveNote={handleMoveNote}
          onMoveFolder={handleMoveFolder}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onRenameNote={renameNoteTab}
          onDeleteFolder={handleDeleteFolder}
        />
      )}

      {/* Workspace */}
      <div className="flex flex-col flex-1" style={{ height: '100%', overflow: 'hidden', gridColumn: 2 }}>
        <div className="workspace-toolbar" style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-surface)', padding: '4px 8px', gap: 4, borderBottom: '1px solid var(--border)' }}>
          {!sidebarOpen && (
            <button id="sidebar-expand-btn" className="btn-icon" onClick={() => setSidebarOpen(true)} title="Expand sidebar">
              <PanelLeftOpen size={16} />
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }} />
          {activeTab?.type !== 'terminal' && (
            <button className="btn-icon" onClick={handleUpgradeActiveTabToTerminal} title={activeTab ? 'Turn current tab into a terminal' : 'Open terminal'}>
              <SquareTerminal size={16} />
            </button>
          )}
          {!aiPanelOpen && (
            <button id="ai-panel-expand-btn" className="btn-icon" onClick={() => setAiPanelOpen(true)} title="Open agent">
              <Bot size={16} />
            </button>
          )}
        </div>

        <div ref={editorAreaRef} className="flex-1" style={{ position: 'relative', display: 'flex', overflow: 'hidden' }}>
          <PaneGrid
            node={layout}
            openTabs={openTabs}
            focusedPaneId={focusedPaneId}
            onFocusPane={setFocusedPaneId}
            onSelectTab={selectTabInPane}
            onCloseTab={closeTab}
            onNewTab={handleCreateWebTab}
            onDropTab={handleDropTab}
            onResize={handleResizeSplit}
            onDetachTab={handleDetachTab}
            onDragStateChange={setIsDraggingTab}
            registerPaneContent={registerPaneContent}
            renderContent={renderTabContent}
            onCreateChatNote={handleCreateChatNote}
          />

          {/* Persistent web tabs: every web tab stays mounted and is positioned
              over whichever pane currently shows it, so switching or tiling never
              reloads it. Hidden tabs sleep (muted, display:none). These render as
              direct children of the (position:relative) editor area rather than
              inside a pointer-events:none layer — Electron's <webview> guest does
              not receive mouse input when any ancestor has pointer-events:none,
              which made the page render but ignore every click. Each wrapper only
              covers its own pane, so empty regions fall through to PaneGrid. */}
          {webTabs.map((tab) => {
            const pane = Layout.findPaneByTab(layout, tab.id);
            const visible = Boolean(pane && pane.activeTabId === tab.id && paneRects[pane.id]);
            const rect = visible && pane ? paneRects[pane.id] : null;
            return (
              <div
                key={tab.id}
                style={{
                  position: 'absolute',
                  left: rect?.left ?? 0,
                  top: rect?.top ?? 0,
                  width: rect?.width ?? 0,
                  height: rect?.height ?? 0,
                  display: visible ? 'flex' : 'none',
                  flexDirection: 'column',
                  // During a tab drag, let drops pass through to the pane beneath.
                  pointerEvents: isDraggingTab ? 'none' : 'auto',
                }}
              >
                <WebView
                  tabId={tab.id}
                  url={tab.url || ''}
                  active={visible}
                  onNavigate={(url) => updateTabUrl(tab.id, url)}
                  onTitleChange={(title) => updateTabTitle(tab.id, title)}
                  isChatNote={tab.isChatNote}
                />
              </div>
            );
          })}
        </div>
      </div>

      {aiPanelOpen && (
        <AIPanel
          note={activeNote}
          vaultId={activeVaultId}
          onSave={handleSaveActiveNote}
          pendingPrompt={directivePrompt}
          onPromptConsumed={() => setDirectivePrompt(null)}
          onClose={() => setAiPanelOpen(false)}
        />
      )}

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} vaultId={activeVaultId} onSelectNote={(id) => openNote(id)} />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} notes={notes} onSelectNote={(id) => openNote(id)} onCreateNote={handleCreateNote} />

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
