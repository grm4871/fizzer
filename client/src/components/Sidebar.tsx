/**
 * @file Sidebar.tsx — Folder tree navigation and vault controls
 *
 * Renders the left sidebar panel containing:
 * - Vault name header with collapse button
 * - Quick-action buttons (new note, new folder, search)
 * - Vault selector dropdown (when multiple vaults exist)
 * - Recursive folder tree with expandable folders and note items
 * - User info footer with logout
 *
 * Organisation gestures:
 * - Right-click a note or folder for a context menu (move/delete/rename/new).
 * - Drag a note or folder onto a folder (or the "Notes" header) to move it.
 *
 * Notes are grouped by folder, sorted pinned-first then by last updated.
 *
 * @component
 */

import { useState, useMemo, useEffect } from 'react';
import type { Vault, Folder, NoteSummary } from '../api';
import { CHAT_NOTE_MARKER } from './ChatView';
import {
  Folder as FolderIcon, FolderOpen, FileText, Pin, Gem, Edit2, FolderPlus,
  Search, ChevronRight, PanelLeftClose, LogOut, Trash2, FilePlus, FolderInput, Pencil, RefreshCw,
  Hash,
} from 'lucide-react';

const NOTE_DND_TYPE = 'application/x-cascade-note';
const FOLDER_DND_TYPE = 'application/x-cascade-folder';
const ROOT_DROP_ID = '__root__';

interface SidebarProps {
  user: { id: number; username: string };
  vaults: Vault[];
  activeVaultId: string | null;
  folders: Folder[];
  notes: NoteSummary[];
  activeNoteId: string | null;
  onSelectVault: (id: string) => void;
  onSelectNote: (id: string) => void;
  onOpenNoteInNewTab: (id: string) => void;
  onNewNote: () => void;
  onCreateChannel: (folderId?: string | null) => Promise<{ id: string; title: string } | undefined>;
  onNewNoteInFolder: (folderId: string | null) => void;
  onSearch: () => void;
  onCollapse: () => void;
  onLogout: () => void;
  onDeleteNote: (id: string) => void;
  onMoveNote: (id: string, folderId: string | null) => void;
  onMoveFolder: (id: string, parentId: string | null, position: number) => void;
  onCreateFolder: (parentId?: string | null) => Promise<Folder | undefined>;
  onRenameFolder: (id: string, name: string) => void;
  onRenameNote: (id: string, title: string) => Promise<void>;
  onDeleteFolder: (id: string) => void;
}

type ContextMenu =
  | { x: number; y: number; kind: 'note'; id: string }
  | { x: number; y: number; kind: 'folder'; id: string }
  | { x: number; y: number; kind: 'root' };

export function Sidebar({
  user,
  vaults,
  activeVaultId,
  folders,
  notes,
  activeNoteId,
  onSelectVault,
  onSelectNote,
  onOpenNoteInNewTab,
  onNewNote,
  onCreateChannel,
  onNewNoteInFolder,
  onSearch,
  onCollapse,
  onLogout,
  onDeleteNote,
  onMoveNote,
  onMoveFolder,
  onCreateFolder,
  onRenameFolder,
  onRenameNote,
  onDeleteFolder,
}: SidebarProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  // When the context menu shows the "Move to…" folder picker for a note.
  const [moveMenu, setMoveMenu] = useState(false);
  // Folder currently being renamed inline (also used right after creation).
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [updating, setUpdating] = useState(false);
  // Drop target highlight: a folder id, or ROOT_DROP_ID for the root area.
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const activeVault = useMemo(
    () => vaults.find((v) => v.id === activeVaultId) ?? null,
    [vaults, activeVaultId],
  );

  const rootFolders = useMemo(
    () => folders.filter((f) => f.parent_id === null).sort((a, b) => a.position - b.position),
    [folders],
  );

  const notesByFolder = useMemo(() => {
    const map = new Map<string | null, NoteSummary[]>();
    for (const note of notes) {
      const key = note.folder_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(note);
    }
    for (const [, arr] of map) {
      arr.sort((a, b) => {
        if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
    }
    return map;
  }, [notes]);

  const childFolders = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const key = f.parent_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    for (const [, arr] of map) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [folders]);

  // Flattened folder list (with depth) for the "Move to…" picker.
  const flatFolders = useMemo(() => {
    const out: { folder: Folder; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of childFolders.get(parentId) ?? []) {
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [childFolders]);

  const rootNotes = notesByFolder.get(null) ?? [];

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => { setContextMenu(null); setMoveMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  function toggleFolder(folderId: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function expandFolder(folderId: string) {
    setExpandedFolders((prev) => new Set(prev).add(folderId));
  }

  function openMenu(e: React.MouseEvent, menu: ContextMenu) {
    e.preventDefault();
    e.stopPropagation();
    setMoveMenu(false);
    // Clamp so the menu stays on-screen.
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 220);
    setContextMenu({ ...menu, x, y });
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

  async function createFolder(parentId: string | null) {
    setContextMenu(null);
    if (parentId) expandFolder(parentId);
    const folder = await onCreateFolder(parentId);
    if (folder) startRename(folder);
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

  // ─── Drag and drop ──────────────────────────────────────
  function noteDragProps(noteId: string) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(NOTE_DND_TYPE, noteId);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => setDragOverId(null),
    };
  }

  function folderDragProps(folderId: string) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(FOLDER_DND_TYPE, folderId);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => setDragOverId(null),
    };
  }

  function isInvalidFolderTarget(folderId: string, targetFolderId: string | null) {
    if (folderId === targetFolderId) return true;
    let current = targetFolderId ? folders.find((f) => f.id === targetFolderId) : undefined;
    while (current) {
      if (current.parent_id === folderId) return true;
      current = current.parent_id ? folders.find((f) => f.id === current!.parent_id) : undefined;
    }
    return false;
  }

  function nextFolderPosition(parentId: string | null, movingFolderId: string) {
    return (childFolders.get(parentId) ?? []).filter((f) => f.id !== movingFolderId).length;
  }

  function dropTargetProps(targetFolderId: string | null) {
    const key = targetFolderId ?? ROOT_DROP_ID;
    return {
      onDragOver: (e: React.DragEvent) => {
        const isNote = e.dataTransfer.types.includes(NOTE_DND_TYPE);
        const isFolder = e.dataTransfer.types.includes(FOLDER_DND_TYPE);
        if (!isNote && !isFolder) return;
        if (isFolder) {
          const folderId = e.dataTransfer.getData(FOLDER_DND_TYPE);
          if (folderId && isInvalidFolderTarget(folderId, targetFolderId)) return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragOverId !== key) setDragOverId(key);
      },
      onDragLeave: () => setDragOverId((cur) => (cur === key ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
        const folderId = e.dataTransfer.getData(FOLDER_DND_TYPE);
        setDragOverId(null);
        if (noteId) {
          const note = notes.find((n) => n.id === noteId);
          if (!note || note.folder_id === targetFolderId) return;
          onMoveNote(noteId, targetFolderId);
          if (targetFolderId) expandFolder(targetFolderId);
          return;
        }
        if (folderId && !isInvalidFolderTarget(folderId, targetFolderId)) {
          const folder = folders.find((f) => f.id === folderId);
          if (!folder || folder.parent_id === targetFolderId) return;
          onMoveFolder(folderId, targetFolderId, nextFolderPosition(targetFolderId, folderId));
          if (targetFolderId) expandFolder(targetFolderId);
        }
      },
    };
  }

  /** Recursively render a folder row with its children. */
  function renderFolder(folder: Folder, depth: number) {
    const isExpanded = expandedFolders.has(folder.id);
    const folderNotes = notesByFolder.get(folder.id) ?? [];
    const subFolders = childFolders.get(folder.id) ?? [];
    const paddingLeft = 12 + depth * 14;
    const childCount = folderNotes.length + subFolders.length;

    return (
      <div key={folder.id}>
        {editingFolderId === folder.id ? (
          <div className="tree-item tree-editing" style={{ paddingLeft }}>
            <span className="tree-chevron"><ChevronRight size={14} /></span>
            <span className="tree-icon"><FolderIcon size={16} /></span>
            <input
              className="tree-rename-input"
              value={editingValue}
              autoFocus
              spellCheck={false}
              onChange={(e) => setEditingValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                else if (e.key === 'Escape') { e.preventDefault(); setEditingFolderId(null); }
              }}
            />
          </div>
        ) : (
          <button
            id={`folder-${folder.id}`}
            className={`tree-item ${dragOverId === folder.id ? 'drag-over' : ''}`}
            style={{ paddingLeft }}
            onClick={() => toggleFolder(folder.id)}
            onContextMenu={(e) => openMenu(e, { x: 0, y: 0, kind: 'folder', id: folder.id })}
            {...folderDragProps(folder.id)}
            {...dropTargetProps(folder.id)}
          >
            <span className={`tree-chevron ${isExpanded ? 'expanded' : ''}`}><ChevronRight size={14} /></span>
            <span className="tree-icon">{isExpanded ? <FolderOpen size={16} /> : <FolderIcon size={16} />}</span>
            <span className="tree-label">{folder.name}</span>
            <span className="tree-count">{childCount || ''}</span>
          </button>
        )}
        {isExpanded && (
          <div className="tree-children">
            {subFolders.map((sf) => renderFolder(sf, depth + 1))}
            {folderNotes.map((note) => renderNote(note, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  /** Render a single note item in the sidebar tree. */
  function renderNote(note: NoteSummary, depth: number) {
    const paddingLeft = 12 + depth * 14 + 16;
    const isChatChannel = note.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
    if (editingNoteId === note.id) {
      return (
        <div key={note.id} className="tree-item tree-editing" style={{ paddingLeft }}>
          <span className="tree-icon">{isChatChannel ? <Hash size={16} /> : <FileText size={16} />}</span>
          <input
            className="tree-rename-input"
            value={editingValue}
            autoFocus
            spellCheck={false}
            onChange={(e) => setEditingValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditingNoteId(null); }
            }}
          />
        </div>
      );
    }
    return (
      <button
        key={note.id}
        id={`note-${note.id}`}
        className={`tree-item ${note.id === activeNoteId ? 'active' : ''}`}
        style={{ paddingLeft }}
        onClick={() => onSelectNote(note.id)}
        onContextMenu={(e) => openMenu(e, { x: 0, y: 0, kind: 'note', id: note.id })}
        {...noteDragProps(note.id)}
      >
        <span className="tree-icon">{isChatChannel ? <Hash size={16} /> : <FileText size={16} />}</span>
        <span className="tree-label">{note.title || 'Untitled'}</span>
        {note.is_pinned ? <span className="pin-icon"><Pin size={12} fill="currentColor" /></span> : null}
        {note.tags.length > 0 && (
          <span className="tree-tags">
            {note.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="tag-dot" title={tag} />
            ))}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="sidebar" id="sidebar" style={{ gridColumn: 1 }}>
      {/* Header */}
      <div className="sidebar-header">
        <div className="vault-name">
          <span className="vault-icon"><Gem size={20} /></span>
        </div>
        <button id="sidebar-collapse-btn" className="btn-icon" onClick={onCollapse} title="Collapse sidebar">
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* Quick actions */}
      <div className="sidebar-actions">
        <button id="new-note-btn" className="btn-icon" onClick={onNewNote} title="New note">
          <Edit2 size={16} />
        </button>
        <button id="new-folder-btn" className="btn-icon" onClick={() => createFolder(null)} title="New folder">
          <FolderPlus size={16} />
        </button>
        <button id="new-channel-btn" className="btn-icon" onClick={() => void createChannel(null)} title="New channel">
          <Hash size={16} />
        </button>
        <button id="search-btn" className="btn-icon" onClick={onSearch} title="Search">
          <Search size={16} />
        </button>
      </div>

      {/* Vault selector */}
      {vaults.length > 1 && (
        <div className="sidebar-vault-select">
          <select id="vault-select" value={activeVaultId ?? ''} onChange={(e) => onSelectVault(e.target.value)}>
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Folder tree. The "Notes" header doubles as the move-to-root drop target. */}
      <div
        className={`sidebar-section-label ${dragOverId === ROOT_DROP_ID ? 'drag-over' : ''}`}
        onContextMenu={(e) => openMenu(e, { x: 0, y: 0, kind: 'root' })}
        {...dropTargetProps(null)}
      >
        Notes
      </div>
      <div
        className="folder-tree"
        id="folder-tree"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) openMenu(e, { x: 0, y: 0, kind: 'root' });
        }}
      >
        {rootFolders.map((folder) => renderFolder(folder, 0))}
        {rootNotes.map((note) => renderNote(note, 0))}

        {notes.length === 0 && folders.length === 0 && (
          <div className="palette-empty" style={{ padding: '24px 16px' }}>
            No notes yet. Create one to get started.
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="sidebar-footer">
        <div className="user-info">
          <div className="user-avatar">{user.username.charAt(0).toUpperCase()}</div>
          <span className="truncate">{user.username}</span>
        </div>
        <button
          className="btn-icon"
          title="Update from git and restart"
          disabled={updating}
          onClick={async () => {
            const api = (window as unknown as { electronAPI?: { updateAndRestart?: () => Promise<{ success: boolean; error?: string }> } }).electronAPI;
            if (!api?.updateAndRestart) return;
            setUpdating(true);
            const result = await api.updateAndRestart();
            if (!result.success) {
              alert('Update failed: ' + (result.error || 'Unknown error'));
              setUpdating(false);
            }
          }}
        >
          <RefreshCw size={16} className={updating ? 'spin' : ''} />
        </button>
        <button id="logout-btn" className="btn-icon" onClick={onLogout} title="Log out">
          <LogOut size={16} />
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="tree-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.kind === 'note' && !moveMenu && (
            <>
              {(() => {
                const note = notes.find((x) => x.id === contextMenu.id);
                const isChatChannel = note?.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
                return (
                  <>
                    <button onClick={() => { setContextMenu(null); onSelectNote(contextMenu.id); }}>
                      {isChatChannel ? <Hash size={14} /> : <FileText size={14} />} {isChatChannel ? 'Open channel' : 'Open'}
                    </button>
                    <button onClick={() => { setContextMenu(null); onOpenNoteInNewTab(contextMenu.id); }}>
                      <FilePlus size={14} /> Open in new tab
                    </button>
                  </>
                );
              })()}
              <button onClick={() => { const n = notes.find((x) => x.id === contextMenu.id); if (n) startRenameNote(n); }}>
                <Pencil size={14} /> Rename
              </button>
              <button onClick={() => setMoveMenu(true)}>
                <FolderInput size={14} /> Move to…
              </button>
              <div className="menu-divider" />
              <button className="menu-danger" onClick={() => { setContextMenu(null); onDeleteNote(contextMenu.id); }}>
                <Trash2 size={14} /> Delete
              </button>
            </>
          )}

          {contextMenu.kind === 'note' && moveMenu && (
            <div className="menu-scroll">
              <button onClick={() => { setContextMenu(null); onMoveNote(contextMenu.id, null); }}>
                <FolderIcon size={14} /> Root
              </button>
              {flatFolders.map(({ folder, depth }) => (
                <button
                  key={folder.id}
                  style={{ paddingLeft: 12 + depth * 12 }}
                  onClick={() => { setContextMenu(null); onMoveNote(contextMenu.id, folder.id); expandFolder(folder.id); }}
                >
                  <FolderIcon size={14} /> {folder.name}
                </button>
              ))}
            </div>
          )}

          {contextMenu.kind === 'folder' && (
            <>
              <button onClick={() => { setContextMenu(null); expandFolder(contextMenu.id); onNewNoteInFolder(contextMenu.id); }}>
                <FilePlus size={14} /> New note
              </button>
              <button onClick={() => void createChannel(contextMenu.id)}>
                <Hash size={14} /> New channel
              </button>
              <button onClick={() => createFolder(contextMenu.id)}>
                <FolderPlus size={14} /> New subfolder
              </button>
              <button onClick={() => { const f = folders.find((x) => x.id === contextMenu.id); if (f) startRename(f); }}>
                <Pencil size={14} /> Rename
              </button>
              <div className="menu-divider" />
              <button className="menu-danger" onClick={() => { setContextMenu(null); onDeleteFolder(contextMenu.id); }}>
                <Trash2 size={14} /> Delete folder
              </button>
            </>
          )}

          {contextMenu.kind === 'root' && (
            <>
              <button onClick={() => { setContextMenu(null); onNewNote(); }}>
                <FilePlus size={14} /> New note
              </button>
              <button onClick={() => void createChannel(null)}>
                <Hash size={14} /> New channel
              </button>
              <button onClick={() => createFolder(null)}>
                <FolderPlus size={14} /> New folder
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
