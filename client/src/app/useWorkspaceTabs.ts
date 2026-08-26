import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { NoteSummary } from '../api';
import type { NoteEntry } from './useAppState';
import * as Layout from '../layout/tree';
import type { Tab } from '../components/TabBar';
import type { TabDragPayload } from '../components/PaneGrid';
import { CHAT_NOTE_MARKER } from '../chat/shared';

export interface WorkspaceTabsOptions {
  activeVaultId: string | null;
  notesRef: MutableRefObject<NoteSummary[]>;
  openTabsRef: MutableRefObject<Tab[]>;
  layoutRef: MutableRefObject<Layout.LayoutNode>;
  focusedPaneRef: MutableRefObject<Layout.PaneNode>;
  noteContentsRef: MutableRefObject<Record<string, NoteEntry>>;
  setOpenTabs: Dispatch<SetStateAction<Tab[]>>;
  setLayout: Dispatch<SetStateAction<Layout.LayoutNode>>;
  setFocusedPaneId: Dispatch<SetStateAction<string>>;
  setNoteContents: Dispatch<SetStateAction<Record<string, NoteEntry>>>;
  loadNoteContent: (id: string) => Promise<void>;
  loadSuperkanban: () => Promise<void>;
  ensureChatChannelLoaded: (id: string) => void;
}


/** Encapsulates pane selection, drag docking, pop-out adoption, and hydration order. */
export function useWorkspaceTabs({ activeVaultId, notesRef, openTabsRef, layoutRef, focusedPaneRef, noteContentsRef, setOpenTabs, setLayout, setFocusedPaneId, setNoteContents, loadNoteContent, loadSuperkanban, ensureChatChannelLoaded }: WorkspaceTabsOptions) {
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
  return { selectTabInPane, handleDropTab, handleDropNote, handleResizeSplit, handleDetachTab, splitFocusedPane };
}
