import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { Folder as FolderIcon, FolderOpen, FileText, Hash, ChevronRight, Pin } from 'lucide-react';
import { NOTE_DND_TYPE, noteEmbedMarkdown } from '../../docEmbeds';
import { CHAT_NOTE_MARKER } from '../../chat/shared';
import type { Folder, NoteSummary, CommunityUpdates } from '../../api';
import { SidebarContextMenu } from './SidebarContextMenu';
import { buildSidebarTreeModel } from './treeModel';
import { FOLDER_DND_TYPE, ROOT_DROP_ID, type DropPlacement, isInvalidFolderTarget, nextFolderPosition, rowPlacement, sidebarInsertionIndex } from './dragAndDrop';
import type { ContextMenu } from './types';
/** Imperative root actions used by the header quick-action toolbar. */
export interface SidebarTreeHandle {
  createFolder: (parentId: string | null) => Promise<Folder | undefined>;
  createChannel: (parentId: string | null) => Promise<void>;
}

interface SidebarTreeProps {
  folders: Folder[];
  notes: NoteSummary[];
  activeNoteId: string | null;
  updateCounts: CommunityUpdates['counts'];
  showAgentMemory: boolean;
  onSelectNote: (id: string) => void;
  onOpenNoteInNewTab: (id: string) => void;
  onNewNote: () => void;
  onCreateChannel: (folderId?: string | null) => Promise<{ id: string; title: string } | undefined>;
  onNewNoteInFolder: (folderId: string | null) => void;
  onDeleteNote: (id: string) => void;
  onMoveNote: (id: string, folderId: string | null, position?: number) => void;
  onUnlistNote: (id: string) => void;
  onMoveFolder: (id: string, parentId: string | null, position: number) => void;
  onCreateFolder: (parentId?: string | null) => Promise<Folder | undefined> | void;
  onRenameFolder: (id: string, name: string) => void;
  onRenameNote: (id: string, title: string) => Promise<void>;
  onDeleteFolder: (id: string) => void;
}

export const SidebarTree = forwardRef<SidebarTreeHandle, SidebarTreeProps>(function SidebarTree({ folders, notes, activeNoteId, updateCounts, showAgentMemory, onSelectNote, onOpenNoteInNewTab, onNewNote, onCreateChannel, onNewNoteInFolder, onDeleteNote, onMoveNote, onUnlistNote, onMoveFolder, onCreateFolder, onRenameFolder, onRenameNote, onDeleteFolder }, ref) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [moveMenu, setMoveMenu] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; placement: DropPlacement } | null>(null);
  const model = useMemo(() => buildSidebarTreeModel(folders, notes, showAgentMemory), [folders, notes, showAgentMemory]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => { setContextMenu(null); setMoveMenu(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [contextMenu]);

  function toggleFolder(folderId: string) {
    setExpandedFolders((previous) => {
      const next = new Set(previous);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function expandFolder(folderId: string) {
    setExpandedFolders((previous) => new Set(previous).add(folderId));
  }

  function openMenu(event: MouseEvent, menu: ContextMenu) {
    event.preventDefault();
    event.stopPropagation();
    setMoveMenu(false);
    setContextMenu({ ...menu, x: event.clientX, y: event.clientY });
  }

  function startRename(folder: Folder) {
    setContextMenu(null);
    setEditingValue(folder.name);
    setEditingFolderId(folder.id);
  }

  function startRenameNote(note: NoteSummary) {
    setContextMenu(null);
    setEditingValue(note.title);
    setEditingNoteId(note.id);
  }

  function commitRename() {
    if (editingFolderId) {
      onRenameFolder(editingFolderId, editingValue);
      setEditingFolderId(null);
    } else if (editingNoteId) {
      void onRenameNote(editingNoteId, editingValue);
      setEditingNoteId(null);
    }
  }

  async function createFolder(parentId: string | null): Promise<Folder | undefined> {
    setContextMenu(null);
    if (parentId) expandFolder(parentId);
    const folder = await onCreateFolder(parentId);
    if (folder) {
      setEditingValue(folder.name);
      setEditingFolderId(folder.id);
    }
    return folder || undefined;
  }

  async function createChannel(parentId: string | null) {
    setContextMenu(null);
    if (parentId) expandFolder(parentId);
    const channel = await onCreateChannel(parentId);
    if (channel) {
      setEditingValue(channel.title);
      setEditingNoteId(channel.id);
    }
  }

  useImperativeHandle(ref, () => ({ createFolder, createChannel }), [onCreateFolder, onCreateChannel]);

  function noteDragProps(noteId: string) {
    return {
      draggable: true,
      onDragStart: (event: DragEvent) => {
        const note = notes.find((item) => item.id === noteId);
        event.dataTransfer.setData(NOTE_DND_TYPE, noteId);
        if (note) event.dataTransfer.setData('text/plain', noteEmbedMarkdown(note));
        event.dataTransfer.effectAllowed = 'copyMove';
      },
      onDragEnd: () => { setDragOverId(null); setDropHint(null); },
    };
  }

  function folderDragProps(folderId: string) {
    return {
      draggable: true,
      onDragStart: (event: DragEvent) => {
        event.dataTransfer.setData(FOLDER_DND_TYPE, folderId);
        event.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => { setDragOverId(null); setDropHint(null); },
    };
  }

  function noteDropProps(targetNote: NoteSummary, siblings: NoteSummary[]) {
    return {
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(NOTE_DND_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setDragOverId(null);
        setDropHint({ id: targetNote.id, placement: rowPlacement(event, false) });
      },
      onDragLeave: (event: DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropHint((current) => current?.id === targetNote.id ? null : current);
      },
      onDrop: (event: DragEvent) => {
        const noteId = event.dataTransfer.getData(NOTE_DND_TYPE);
        if (!noteId) return;
        event.preventDefault();
        event.stopPropagation();
        if (noteId === targetNote.id) { setDropHint(null); return; }
        const placement = rowPlacement(event, false) as Exclude<DropPlacement, 'inside'>;
        const position = sidebarInsertionIndex(siblings.map((note) => note.id), noteId, targetNote.id, placement);
        setDropHint(null);
        onMoveNote(noteId, targetNote.folder_id, position);
      },
    };
  }

  function folderDropProps(targetFolder: Folder, siblings: Folder[]) {
    return {
      onDragOver: (event: DragEvent) => {
        const isNote = event.dataTransfer.types.includes(NOTE_DND_TYPE);
        const isFolder = event.dataTransfer.types.includes(FOLDER_DND_TYPE);
        if (!isNote && !isFolder) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const placement = isNote ? 'inside' : rowPlacement(event, true);
        setDragOverId(placement === 'inside' ? targetFolder.id : null);
        setDropHint({ id: targetFolder.id, placement });
      },
      onDragLeave: (event: DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragOverId((current) => current === targetFolder.id ? null : current);
        setDropHint((current) => current?.id === targetFolder.id ? null : current);
      },
      onDrop: (event: DragEvent) => {
        const noteId = event.dataTransfer.getData(NOTE_DND_TYPE);
        const folderId = event.dataTransfer.getData(FOLDER_DND_TYPE);
        if (!noteId && !folderId) return;
        event.preventDefault();
        event.stopPropagation();
        const placement = noteId ? 'inside' : rowPlacement(event, true);
        setDragOverId(null);
        setDropHint(null);
        if (noteId) {
          const targetNotes = model.notesByFolder.get(targetFolder.id) ?? [];
          onMoveNote(noteId, targetFolder.id, targetNotes.filter((note) => note.id !== noteId).length);
          expandFolder(targetFolder.id);
          return;
        }
        if (!folderId) return;
        if (placement === 'inside') {
          if (isInvalidFolderTarget(folderId, targetFolder.id, folders)) return;
          onMoveFolder(folderId, targetFolder.id, nextFolderPosition(model.childFolders, targetFolder.id, folderId));
          expandFolder(targetFolder.id);
          return;
        }
        const position = sidebarInsertionIndex(siblings.map((folder) => folder.id), folderId, targetFolder.id, placement);
        onMoveFolder(folderId, targetFolder.parent_id, position);
      },
    };
  }

  function rootDropProps() {
    return {
      onDragOver: (event: DragEvent) => {
        const isNote = event.dataTransfer.types.includes(NOTE_DND_TYPE);
        const isFolder = event.dataTransfer.types.includes(FOLDER_DND_TYPE);
        if (!isNote && !isFolder) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropHint(null);
        setDragOverId(ROOT_DROP_ID);
      },
      onDragLeave: () => setDragOverId((current) => current === ROOT_DROP_ID ? null : current),
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        const noteId = event.dataTransfer.getData(NOTE_DND_TYPE);
        const folderId = event.dataTransfer.getData(FOLDER_DND_TYPE);
        setDragOverId(null);
        if (noteId) onMoveNote(noteId, null, model.rootNotes.filter((note) => note.id !== noteId).length);
        else if (folderId) onMoveFolder(folderId, null, nextFolderPosition(model.childFolders, null, folderId));
      },
    };
  }

  const rootDrop = rootDropProps();
  const dropClass = (id: string) => dropHint?.id === id ? ` is-drop-${dropHint.placement}` : '';

  function renameInput(onCancel: () => void) {
    return <input className="tree-rename-input" value={editingValue} autoFocus spellCheck={false} onChange={(event) => setEditingValue(event.target.value)} onBlur={commitRename} onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
      else if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    }} />;
  }

  function renderNote(note: NoteSummary, depth: number) {
    const paddingLeft = 12 + depth * 14 + 16;
    const isChatChannel = note.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
    if (editingNoteId === note.id) return <div key={note.id} className="tree-item tree-editing" style={{ paddingLeft }}><span className="tree-icon">{isChatChannel ? <Hash size={16} /> : <FileText size={16} />}</span>{renameInput(() => setEditingNoteId(null))}</div>;
    return <button key={note.id} id={`note-${note.id}`} className={`tree-item${isChatChannel ? ' is-channel' : ' is-note'}${note.id === activeNoteId ? ' active' : ''}${dropClass(note.id)}`} style={{ paddingLeft }} onClick={(event) => (event.metaKey || event.ctrlKey ? onOpenNoteInNewTab(note.id) : onSelectNote(note.id))} onContextMenu={(event) => openMenu(event, { x: 0, y: 0, kind: 'note', id: note.id })} {...noteDragProps(note.id)} {...noteDropProps(note, model.notesByFolder.get(note.folder_id) ?? [])}>
      <span className="tree-icon">{isChatChannel ? <Hash size={15} /> : <FileText size={15} />}</span><span className="tree-label">{note.title || 'Untitled'}</span>
      {(updateCounts.byTarget[note.id] || 0) > 0 && <span className="tree-update-badge" aria-label={`${updateCounts.byTarget[note.id] >= 99 ? '99+' : updateCounts.byTarget[note.id]} unread updates`}>{updateCounts.byTarget[note.id] >= 99 ? '99+' : updateCounts.byTarget[note.id]}</span>}
      {note.is_pinned ? <span className="pin-icon"><Pin size={11} fill="currentColor" /></span> : null}
      {note.tags.length > 0 && <span className="tree-tags">{note.tags.slice(0, 3).map((tag) => <span key={tag} className="tag-dot" title={tag} />)}</span>}
    </button>;
  }

  function renderFolder(folder: Folder, depth: number): ReactNode {
    const isExpanded = expandedFolders.has(folder.id);
    const folderNotes = model.notesByFolder.get(folder.id) ?? [];
    const subFolders = model.childFolders.get(folder.id) ?? [];
    const paddingLeft = 12 + depth * 14;
    const childCount = folderNotes.length + subFolders.length;
    return <div key={folder.id}>
      {editingFolderId === folder.id ? <div className="tree-item tree-editing" style={{ paddingLeft }}><span className="tree-chevron"><ChevronRight size={14} /></span><span className="tree-icon"><FolderIcon size={16} /></span>{renameInput(() => setEditingFolderId(null))}</div> : <button id={`folder-${folder.id}`} className={`tree-item is-folder${dragOverId === folder.id ? ' drag-over' : ''}${dropClass(folder.id)}`} style={{ paddingLeft }} onClick={() => toggleFolder(folder.id)} onContextMenu={(event) => openMenu(event, { x: 0, y: 0, kind: 'folder', id: folder.id })} {...folderDragProps(folder.id)} {...folderDropProps(folder, model.childFolders.get(folder.parent_id) ?? [])}><span className={`tree-chevron ${isExpanded ? 'expanded' : ''}`}><ChevronRight size={14} /></span><span className="tree-icon">{isExpanded ? <FolderOpen size={16} /> : <FolderIcon size={16} />}</span><span className="tree-label">{folder.name}</span>{childCount > 0 && <span className="tree-count">{childCount}</span>}</button>}
      {isExpanded && <div className="tree-children">{subFolders.map((child) => renderFolder(child, depth + 1))}{folderNotes.map((note) => renderNote(note, depth + 1))}</div>}
    </div>;
  }

  return <>
    <div className={`sidebar-section-label ${dragOverId === ROOT_DROP_ID ? 'drag-over' : ''}`} onContextMenu={(event) => openMenu(event, { x: 0, y: 0, kind: 'root' })} {...rootDrop}>Notes</div>
    <div className={`folder-tree ${dragOverId === ROOT_DROP_ID ? 'drag-over' : ''}`} id="folder-tree" onContextMenu={(event) => { if (event.target === event.currentTarget) openMenu(event, { x: 0, y: 0, kind: 'root' }); }} onDragOver={(event) => { if (event.target === event.currentTarget) rootDrop.onDragOver(event); }} onDragLeave={rootDrop.onDragLeave} onDrop={(event) => { if (event.target === event.currentTarget) rootDrop.onDrop(event); }}>
      {model.rootFolders.map((folder) => renderFolder(folder, 0))}
      {model.rootNotes.map((note) => renderNote(note, 0))}
      {notes.length === 0 && folders.length === 0 && <div className="palette-empty" style={{ padding: '24px 16px' }}>No notes yet. Create one to get started.</div>}
    </div>
    {contextMenu && <SidebarContextMenu contextMenu={contextMenu} moveMenu={moveMenu} notes={notes} folders={folders} flatFolders={model.flatFolders} onClose={() => { setContextMenu(null); setMoveMenu(false); }} onSetMoveMenu={setMoveMenu} onSelectNote={onSelectNote} onOpenNoteInNewTab={onOpenNoteInNewTab} onStartRenameNote={startRenameNote} onStartRenameFolder={startRename} onMoveNote={onMoveNote} onDeleteNote={onDeleteNote} onUnlistNote={onUnlistNote} onNewNote={onNewNote} onNewNoteInFolder={onNewNoteInFolder} onCreateChannel={createChannel} onCreateFolder={createFolder} onDeleteFolder={onDeleteFolder} onExpandFolder={expandFolder} />}
  </>;
});
