import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Folder, Note, NoteSummary } from '../api';
import type { NoteEntry } from './useAppState';
import type { Tab } from '../components/TabBar';
import * as Layout from '../layout/tree';
import { api } from '../api';
import { CHAT_NOTE_MARKER } from '../chat/shared';
import { chatMessageStore } from '../chat/messageStore';

export interface NoteFolderOperationsOptions {
  activeVaultIdRef: MutableRefObject<string | null>;
  notesRef: MutableRefObject<NoteSummary[]>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setOpenTabs: Dispatch<SetStateAction<Tab[]>>;
  setLayout: Dispatch<SetStateAction<Layout.LayoutNode>>;
  setFocusedPaneId: Dispatch<SetStateAction<string>>;
  setNoteContents: Dispatch<SetStateAction<Record<string, NoteEntry>>>;
  loadVaultData: (id: string) => Promise<void>;
  openChatChannel: (id: string, title: string) => void;
  layoutRef: MutableRefObject<Layout.LayoutNode>;
  focusedPaneRef: MutableRefObject<Layout.PaneNode>;
  closeTabRef: MutableRefObject<(id: string) => void>;
  handleSendChatMessage: (channel: string, body: string) => void;
}

/** Owns note/folder CRUD and converts directive links into workspace actions. */
export function useNoteFolderOperations({
  activeVaultIdRef, notesRef, setNotice, setOpenTabs, setLayout, setFocusedPaneId, setNoteContents,
  loadVaultData, openChatChannel, layoutRef, focusedPaneRef, closeTabRef, handleSendChatMessage,
}: NoteFolderOperationsOptions) {
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
  const handleReportProductFeedback = useCallback(async (body: string) => {
    await api('/api/product-feedback', {
      method: 'POST',
      body: JSON.stringify({
        body,
        source: 'documentation-assistant',
        surface: 'guide-assistant',
      }),
    });
  }, []);

  return {
    createAndOpenNote, handleCreateNote, handleCreateNoteInPane, handleCreateTabInPane,
    handleCreateChatInPane, handleDeleteNote, handleMoveNote, handleUnlistNote,
    handleCreateFolder, handleRenameFolder, handleMoveFolder, handleDeleteFolder,
    handleCreateNoteInFolder, handleExecuteDirective, handleReportProductFeedback,
  };
}
