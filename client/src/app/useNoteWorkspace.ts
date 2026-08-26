import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Note, NoteSummary, CommunityUpdateItem, CommunityUpdates, User } from '../api';
import { api } from '../api';
import * as Layout from '../layout/tree';
import type { Tab } from '../components/TabBar';
import type { WorkItem } from '../chat/workItems';
import type { NoteEntry } from './useAppState';
import type { PersistedWorkspace } from '../chat/session';
import { CHAT_NOTE_MARKER } from '../chat/shared';
export interface NoteWorkspaceOptions {
  activeVaultIdRef: MutableRefObject<string | null>; notesRef: MutableRefObject<NoteSummary[]>; layoutRef: MutableRefObject<Layout.LayoutNode>; focusedPaneRef: MutableRefObject<Layout.PaneNode>; noteContentsRef: MutableRefObject<Record<string, NoteEntry>>; vaultWorkspacesRef: MutableRefObject<Record<string, PersistedWorkspace>>; vaultNoteContentsRef: MutableRefObject<Record<string, Record<string, NoteEntry>>>;
  setNoteContents: Dispatch<SetStateAction<Record<string, NoteEntry>>>; setOpenTabs: Dispatch<SetStateAction<Tab[]>>; setLayout: Dispatch<SetStateAction<Layout.LayoutNode>>; setFocusedPaneId: Dispatch<SetStateAction<string>>; setSuperkanbanNotes: Dispatch<SetStateAction<Note[]>>; setSuperkanbanLiveWork: Dispatch<SetStateAction<WorkItem[]>>; setSuperkanbanLoading: Dispatch<SetStateAction<boolean>>; setSuperkanbanError: Dispatch<SetStateAction<string | null>>; setNotice: Dispatch<SetStateAction<string | null>>; setUpdatesOpen: Dispatch<SetStateAction<boolean>>; setChatJumpTarget: Dispatch<SetStateAction<{ channelId: string; messageId: string } | null>>;
  loadVaultData: (id: string) => Promise<void>; closeTab: (id: string) => void; openChatChannel: (id: string, title: string, mode?: 'open' | 'replace') => void; switchVaultWorkspace: (id: string | null) => void; markCommunityTargetRead: (id: string) => Promise<void>;
  user: User | null; focusedTab: Tab | null; communityUpdates: CommunityUpdates;
}

export function useNoteWorkspace({
  activeVaultIdRef, notesRef, layoutRef, focusedPaneRef, noteContentsRef, vaultWorkspacesRef, vaultNoteContentsRef, setNoteContents, setOpenTabs, setLayout, setFocusedPaneId, setSuperkanbanNotes, setSuperkanbanLiveWork, setSuperkanbanLoading, setSuperkanbanError, setNotice, setUpdatesOpen, setChatJumpTarget, loadVaultData, closeTab, openChatChannel, switchVaultWorkspace, markCommunityTargetRead, user, focusedTab, communityUpdates,
}: NoteWorkspaceOptions) {
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
  return {
    loadNoteContent, loadSuperkanban, openSuperkanban, openNote, openCommunityUpdate,
    saveNoteTab, handleSaveActiveNote, handleNoteChange, renameNoteTab,
    getNoteChangeHandler, getNoteSaveHandler, getNoteRenameHandler, handleOpenWikilink,
  };
}
