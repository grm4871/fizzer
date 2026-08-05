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
 * Notes and folders keep their explicit drag order within each parent.
 *
 * @component
 */

import { memo, useState, useMemo, useEffect, useRef } from 'react';
import { isSharedVault, type Vault, type Folder, type NoteSummary, type User } from '../api';
import { NOTE_DND_TYPE, noteEmbedMarkdown } from '../docEmbeds';
import { usePopupMenu } from '../ui/popupMenu';
import { CHAT_NOTE_MARKER } from './ChatView';
import {
  Folder as FolderIcon, FolderOpen, FileText, Pin, Gem, Edit2, FolderPlus,
  Search, ChevronRight, PanelLeftClose, LogOut, Trash2, FilePlus, FolderInput, Pencil, RefreshCw,
  Hash, Unlink, ShieldCheck, SkipBack, Play, Pause, SkipForward, Music2, Users,
} from 'lucide-react';

/** Switcher label: "Team notes · shared · 3" so shared vaults are obvious. */
export function vaultOptionLabel(vault: Vault): string {
  if (!isSharedVault(vault)) return vault.name;
  return `${vault.name} · shared · ${vault.memberCount}`;
}

const FOLDER_DND_TYPE = 'application/x-cascade-folder';
const ROOT_DROP_ID = '__root__';

interface SidebarProps {
  user: User;
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
  onOpenAccount: () => void;
  isOwner?: boolean;
  onOpenAdmin?: () => void;
  onDeleteNote: (id: string) => void;
  onMoveNote: (id: string, folderId: string | null, position?: number) => void;
  onUnlistNote: (id: string) => void;
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

type ElectronUpdateAPI = {
  updateAndRestart?: () => Promise<{ success: boolean; refreshing?: boolean; error?: string }>;
  onUpdateFailed?: (callback: (payload: { error?: string }) => void) => () => void;
};

type DropPlacement = 'before' | 'inside' | 'after';

/** Final insertion index after removing the dragged item from its old slot. */
export function sidebarInsertionIndex(
  orderedIds: string[],
  movingId: string,
  targetId: string,
  placement: Exclude<DropPlacement, 'inside'>,
) {
  const withoutMoving = orderedIds.filter((id) => id !== movingId);
  const targetIndex = withoutMoving.indexOf(targetId);
  if (targetIndex < 0) return withoutMoving.length;
  return targetIndex + (placement === 'after' ? 1 : 0);
}

export function sortSidebarNotes(notes: NoteSummary[]) {
  return [...notes].sort((a, b) =>
    a.position - b.position
    || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    || a.title.localeCompare(b.title),
  );
}

export function isMp3Link(label: string, href: string) {
  const normalizedLabel = label.trim().toLowerCase();
  const normalizedHref = href.toLowerCase();
  return normalizedLabel.endsWith('.mp3')
    || normalizedHref.includes('audio/mpeg')
    || normalizedHref.split(/[?#]/)[0].endsWith('.mp3');
}

export const Sidebar = memo(function Sidebar({
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
  onOpenAccount,
  isOwner,
  onOpenAdmin,
  onDeleteNote,
  onMoveNote,
  onUnlistNote,
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
  const contextMenuRef = usePopupMenu<HTMLDivElement>(contextMenu, moveMenu);
  // Folder currently being renamed inline (also used right after creation).
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [updating, setUpdating] = useState(false);
  const [audioTracks, setAudioTracks] = useState<Array<{ name: string; url: string }>>([]);
  const [audioTrackIndex, setAudioTrackIndex] = useState(0);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const autoplayAudioRef = useRef(false);
  // Drop target highlight: a folder id, or ROOT_DROP_ID for the root area.
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; placement: DropPlacement } | null>(null);

  const activeVault = useMemo(
    () => vaults.find((v) => v.id === activeVaultId),
    [vaults, activeVaultId],
  );

  const rootFolders = useMemo(
    () => folders.filter((f) => f.parent_id === null).sort((a, b) => a.position - b.position),
    [folders],
  );

  const listedNotes = useMemo(() => notes.filter((note) => note.is_listed !== 0), [notes]);

  const notesByFolder = useMemo(() => {
    const map = new Map<string | null, NoteSummary[]>();
    for (const note of listedNotes) {
      const key = note.folder_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(note);
    }
    for (const [key, arr] of map) map.set(key, sortSidebarNotes(arr));
    return map;
  }, [listedNotes]);

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

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: ElectronUpdateAPI }).electronAPI;
    if (!api?.onUpdateFailed) return;
    return api.onUpdateFailed((payload) => {
      setUpdating(false);
      alert('Desktop update failed: ' + (payload?.error || 'Unknown error'));
    });
  }, []);

  useEffect(() => {
    const isAudioAnchor = (anchor: HTMLAnchorElement) => isMp3Link(anchor.textContent || '', anchor.href);
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a') : null;
      if (!(target instanceof HTMLAnchorElement) || !isAudioAnchor(target)) return;
      event.preventDefault();
      event.stopPropagation();
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a')).filter(isAudioAnchor);
      const seen = new Set<string>();
      const tracks = links.flatMap((anchor) => {
        if (!anchor.href || seen.has(anchor.href)) return [];
        seen.add(anchor.href);
        return [{
          name: (anchor.textContent || 'Audio').trim().replace(/\.mp3$/i, ''),
          url: anchor.href,
        }];
      });
      const index = Math.max(0, tracks.findIndex((track) => track.url === target.href));
      audioRef.current?.pause();
      autoplayAudioRef.current = true;
      setAudioTrackIndex(index);
      setAudioTracks(tracks);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioTracks[audioTrackIndex]) return;
    audio.load();
    if (autoplayAudioRef.current) {
      void audio.play().catch(() => setAudioPlaying(false));
    }
  }, [audioTrackIndex, audioTracks]);

  function changeAudioTrack(offset: number, autoplay = audioPlaying) {
    if (audioTracks.length === 0) return;
    autoplayAudioRef.current = autoplay;
    setAudioTrackIndex((current) => (current + offset + audioTracks.length) % audioTracks.length);
  }

  function toggleAudioPlayback() {
    const audio = audioRef.current;
    if (!audio || audioTracks.length === 0) return;
    if (audio.paused) void audio.play().catch(() => setAudioPlaying(false));
    else audio.pause();
  }

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
    // Opens at the pointer; usePopupMenu clamps it back on-screen once measured.
    setContextMenu({ ...menu, x: e.clientX, y: e.clientY });
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
        const note = notes.find((item) => item.id === noteId);
        e.dataTransfer.setData(NOTE_DND_TYPE, noteId);
        if (note) e.dataTransfer.setData('text/plain', noteEmbedMarkdown(note));
        e.dataTransfer.effectAllowed = 'copyMove';
      },
      onDragEnd: () => {
        setDragOverId(null);
        setDropHint(null);
      },
    };
  }

  function folderDragProps(folderId: string) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(FOLDER_DND_TYPE, folderId);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => {
        setDragOverId(null);
        setDropHint(null);
      },
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

  function rowPlacement(e: React.DragEvent, allowInside: boolean): DropPlacement {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
    if (!allowInside) return ratio < 0.5 ? 'before' : 'after';
    if (ratio < 0.25) return 'before';
    if (ratio > 0.75) return 'after';
    return 'inside';
  }

  function noteDropProps(targetNote: NoteSummary, siblings: NoteSummary[]) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(NOTE_DND_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setDragOverId(null);
        setDropHint({ id: targetNote.id, placement: rowPlacement(e, false) });
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropHint((current) => (current?.id === targetNote.id ? null : current));
      },
      onDrop: (e: React.DragEvent) => {
        const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
        if (!noteId) return;
        e.preventDefault();
        e.stopPropagation();
        if (noteId === targetNote.id) {
          setDropHint(null);
          return;
        }
        const placement = rowPlacement(e, false) as Exclude<DropPlacement, 'inside'>;
        const position = sidebarInsertionIndex(
          siblings.map((note) => note.id),
          noteId,
          targetNote.id,
          placement,
        );
        setDropHint(null);
        onMoveNote(noteId, targetNote.folder_id, position);
      },
    };
  }

  function folderDropProps(targetFolder: Folder, siblings: Folder[]) {
    return {
      onDragOver: (e: React.DragEvent) => {
        const isNote = e.dataTransfer.types.includes(NOTE_DND_TYPE);
        const isFolder = e.dataTransfer.types.includes(FOLDER_DND_TYPE);
        if (!isNote && !isFolder) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const placement = isNote ? 'inside' : rowPlacement(e, true);
        setDragOverId(placement === 'inside' ? targetFolder.id : null);
        setDropHint({ id: targetFolder.id, placement });
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOverId((current) => (current === targetFolder.id ? null : current));
        setDropHint((current) => (current?.id === targetFolder.id ? null : current));
      },
      onDrop: (e: React.DragEvent) => {
        const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
        const folderId = e.dataTransfer.getData(FOLDER_DND_TYPE);
        if (!noteId && !folderId) return;
        e.preventDefault();
        e.stopPropagation();
        const placement = noteId ? 'inside' : rowPlacement(e, true);
        setDragOverId(null);
        setDropHint(null);

        if (noteId) {
          const targetNotes = notesByFolder.get(targetFolder.id) ?? [];
          onMoveNote(noteId, targetFolder.id, targetNotes.filter((note) => note.id !== noteId).length);
          expandFolder(targetFolder.id);
          return;
        }

        if (!folderId) return;
        if (placement === 'inside') {
          if (isInvalidFolderTarget(folderId, targetFolder.id)) return;
          onMoveFolder(folderId, targetFolder.id, nextFolderPosition(targetFolder.id, folderId));
          expandFolder(targetFolder.id);
          return;
        }

        const position = sidebarInsertionIndex(
          siblings.map((folder) => folder.id),
          folderId,
          targetFolder.id,
          placement,
        );
        onMoveFolder(folderId, targetFolder.parent_id, position);
      },
    };
  }

  function rootDropTargetProps() {
    const key = ROOT_DROP_ID;
    return {
      onDragOver: (e: React.DragEvent) => {
        const isNote = e.dataTransfer.types.includes(NOTE_DND_TYPE);
        const isFolder = e.dataTransfer.types.includes(FOLDER_DND_TYPE);
        if (!isNote && !isFolder) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropHint(null);
        if (dragOverId !== key) setDragOverId(key);
      },
      onDragLeave: () => setDragOverId((cur) => (cur === key ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
        const folderId = e.dataTransfer.getData(FOLDER_DND_TYPE);
        setDragOverId(null);
        if (noteId) {
          onMoveNote(noteId, null, rootNotes.filter((note) => note.id !== noteId).length);
          return;
        }
        if (folderId) {
          onMoveFolder(folderId, null, nextFolderPosition(null, folderId));
        }
      },
    };
  }

  // Move-to-root drop handlers, shared by the "Notes" header and the empty
  // area of the folder tree.
  const rootDropProps = rootDropTargetProps();

  function dropClass(id: string) {
    if (dropHint?.id !== id) return '';
    return ` is-drop-${dropHint.placement}`;
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
            className={`tree-item is-folder${dragOverId === folder.id ? ' drag-over' : ''}${dropClass(folder.id)}`}
            style={{ paddingLeft }}
            onClick={() => toggleFolder(folder.id)}
            onContextMenu={(e) => openMenu(e, { x: 0, y: 0, kind: 'folder', id: folder.id })}
            {...folderDragProps(folder.id)}
            {...folderDropProps(folder, childFolders.get(folder.parent_id) ?? [])}
          >
            <span className={`tree-chevron ${isExpanded ? 'expanded' : ''}`}><ChevronRight size={14} /></span>
            <span className="tree-icon">{isExpanded ? <FolderOpen size={16} /> : <FolderIcon size={16} />}</span>
            <span className="tree-label">{folder.name}</span>
            {childCount > 0 && <span className="tree-count">{childCount}</span>}
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
        className={`tree-item${isChatChannel ? ' is-channel' : ' is-note'}${note.id === activeNoteId ? ' active' : ''}${dropClass(note.id)}`}
        style={{ paddingLeft }}
        onClick={() => onSelectNote(note.id)}
        onContextMenu={(e) => openMenu(e, { x: 0, y: 0, kind: 'note', id: note.id })}
        {...noteDragProps(note.id)}
        {...noteDropProps(note, notesByFolder.get(note.folder_id) ?? [])}
      >
        <span className="tree-icon">{isChatChannel ? <Hash size={15} /> : <FileText size={15} />}</span>
        <span className="tree-label">{note.title || 'Untitled'}</span>
        {note.is_pinned ? <span className="pin-icon"><Pin size={11} fill="currentColor" /></span> : null}
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

  const quickActions = [
    { id: 'new-note', title: 'New note', icon: <Edit2 size={15} />, onClick: onNewNote },
    { id: 'new-folder', title: 'New folder', icon: <FolderPlus size={15} />, onClick: () => { void createFolder(null); } },
    { id: 'new-channel', title: 'New channel', icon: <Hash size={15} />, onClick: () => { void createChannel(null); } },
    { id: 'search', title: 'Search', icon: <Search size={15} />, onClick: onSearch },
  ];
  const actionButtons = (location: string) => quickActions.map((action) => (
    <button key={action.id} id={`${action.id}-btn-${location}`} className="btn-icon" onClick={action.onClick} title={action.title}>{action.icon}</button>
  ));

  return (
    <aside className="sidebar" id="sidebar" style={{ gridColumn: 1 }}>
      {/* Header */}
      <div className="sidebar-header">
        <div className="vault-name">
          <span className="vault-icon" aria-hidden="true"><Gem size={15} /></span>
          <span className="vault-name-text">
            {activeVault?.name || 'Cascade'}
          </span>
          {activeVault && isSharedVault(activeVault) && (
            <button
              type="button"
              className="vault-shared-badge"
              id="vault-shared-badge"
              onClick={onOpenAccount}
              title={`Shared vault — ${activeVault.memberCount} members. You are ${activeVault.role || 'a member'}. Manage members in Account.`}
              aria-label={`Shared vault with ${activeVault.memberCount} members, your role ${activeVault.role || 'member'}. Manage members.`}
            >
              <Users size={12} aria-hidden="true" />
              {activeVault.memberCount}
            </button>
          )}
        </div>
        <div className="sidebar-actions sidebar-actions-desktop" role="toolbar" aria-label="Sidebar actions">{actionButtons('desktop')}</div>
        <button className="btn-icon sidebar-mobile-collapse" onClick={onCollapse} title="Collapse sidebar"><PanelLeftClose size={16} /></button>
      </div>

      <div className="sidebar-actions sidebar-actions-mobile">{actionButtons('mobile')}</div>

      {/* Vault selector */}
      {vaults.length > 1 && (
        <div className="sidebar-vault-select">
          <select
            id="vault-select"
            aria-label="Active vault"
            value={activeVaultId ?? ''}
            onChange={(e) => onSelectVault(e.target.value)}
          >
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>{vaultOptionLabel(v)}</option>
            ))}
          </select>
          {activeVault && (
            <div className="sidebar-vault-meta">
              {isSharedVault(activeVault)
                ? <>Shared with {activeVault.memberCount! - 1} other{activeVault.memberCount === 2 ? '' : 's'} · you are {activeVault.role || 'a member'}</>
                : <>Private vault · only you</>}
            </div>
          )}
        </div>
      )}

      {/* Folder tree. The "Notes" header doubles as the move-to-root drop target. */}
      <div
        className={`sidebar-section-label ${dragOverId === ROOT_DROP_ID ? 'drag-over' : ''}`}
        onContextMenu={(e) => openMenu(e, { x: 0, y: 0, kind: 'root' })}
        {...rootDropProps}
      >
        Notes
      </div>
      <div
        className={`folder-tree ${dragOverId === ROOT_DROP_ID ? 'drag-over' : ''}`}
        id="folder-tree"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) openMenu(e, { x: 0, y: 0, kind: 'root' });
        }}
        // The whole empty tree area is a move-to-root drop target, not just the
        // "Notes" header. Guard on target === currentTarget so drops that land on
        // a folder/note row are handled by that row (and don't also fall to root).
        onDragOver={(e) => { if (e.target === e.currentTarget) rootDropProps.onDragOver(e); }}
        onDragLeave={rootDropProps.onDragLeave}
        onDrop={(e) => { if (e.target === e.currentTarget) rootDropProps.onDrop(e); }}
      >
        {rootFolders.map((folder) => renderFolder(folder, 0))}
        {rootNotes.map((note) => renderNote(note, 0))}

        {notes.length === 0 && folders.length === 0 && (
          <div className="palette-empty" style={{ padding: '24px 16px' }}>
            No notes yet. Create one to get started.
          </div>
        )}
      </div>

      {audioTracks.length > 0 && <div className="sidebar-audio-player">
        <audio
          ref={audioRef}
          src={audioTracks[audioTrackIndex]?.url}
          onPlay={() => setAudioPlaying(true)}
          onPause={() => setAudioPlaying(false)}
          onEnded={() => {
            changeAudioTrack(1, true);
          }}
        />
        <div className="sidebar-audio-track" title={audioTracks[audioTrackIndex]?.name}>
          <Music2 size={14} />
          <span>{audioTracks[audioTrackIndex]?.name}</span>
        </div>
        <div className="sidebar-audio-controls">
          <button className="btn-icon" disabled={audioTracks.length === 0} onClick={() => changeAudioTrack(-1)} title="Previous track">
            <SkipBack size={15} fill="currentColor" />
          </button>
          <button className="btn-icon sidebar-audio-play" onClick={toggleAudioPlayback} title={audioPlaying ? 'Pause' : 'Play'}>
            {audioPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
          <button className="btn-icon" disabled={audioTracks.length === 0} onClick={() => changeAudioTrack(1)} title="Next track">
            <SkipForward size={15} fill="currentColor" />
          </button>
        </div>
      </div>}

      {/* Footer */}
      <div className="sidebar-footer">
        <button type="button" className="user-info" onClick={onOpenAccount} title="Account settings">
          <div className="user-avatar">
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : (user.displayName || user.username).charAt(0).toUpperCase()}
          </div>
          <span className="truncate">{user.displayName || user.username}</span>
        </button>
        <button
          className="btn-icon"
          title="Update desktop app"
          disabled={updating}
          onClick={async () => {
            const api = (window as unknown as { electronAPI?: ElectronUpdateAPI }).electronAPI;
            if (!api?.updateAndRestart) return;
            setUpdating(true);
            const result = await api.updateAndRestart();
            if (!result.success) {
              alert('Desktop update failed: ' + (result.error || 'Unknown error'));
              setUpdating(false);
            } else if (!result.refreshing) {
              setUpdating(false);
            }
          }}
        >
          <RefreshCw size={16} className={updating ? 'spin' : ''} />
        </button>
        {isOwner && onOpenAdmin && (
          <button className="btn-icon" onClick={onOpenAdmin} title="Admin">
            <ShieldCheck size={16} />
          </button>
        )}
        <button id="logout-btn" className="btn-icon" onClick={onLogout} title="Log out">
          <LogOut size={16} />
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="tree-context-menu"
          role="menu"
          aria-label={
            contextMenu.kind === 'folder'
              ? 'Folder options'
              : contextMenu.kind === 'root'
                ? 'Sidebar options'
                : moveMenu
                  ? 'Move note to folder'
                  : 'Note options'
          }
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
                    <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onSelectNote(contextMenu.id); }}>
                      {isChatChannel ? <Hash size={14} /> : <FileText size={14} />} Open
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onOpenNoteInNewTab(contextMenu.id); }}>
                      <FilePlus size={14} /> Open in new tab
                    </button>
                  </>
                );
              })()}
              <button type="button" role="menuitem" onClick={() => { const n = notes.find((x) => x.id === contextMenu.id); if (n) startRenameNote(n); }}>
                <Pencil size={14} /> Rename
              </button>
              <button type="button" role="menuitem" onClick={() => setMoveMenu(true)}>
                <FolderInput size={14} /> Move to…
              </button>
              {!notes.find((x) => x.id === contextMenu.id)?.content_preview.trim().startsWith(CHAT_NOTE_MARKER) && (
                <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onUnlistNote(contextMenu.id); }}>
                  <Unlink size={14} /> Remove from sidebar
                </button>
              )}
              <div className="menu-divider" role="separator" />
              <button type="button" role="menuitem" className="menu-danger" onClick={() => { setContextMenu(null); onDeleteNote(contextMenu.id); }}>
                <Trash2 size={14} /> Delete
              </button>
            </>
          )}

          {contextMenu.kind === 'note' && moveMenu && (
            <div className="menu-scroll">
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onMoveNote(contextMenu.id, null); }}>
                <FolderIcon size={14} /> Root
              </button>
              {flatFolders.map(({ folder, depth }) => (
                <button
                  key={folder.id}
                  type="button"
                  role="menuitem"
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
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); expandFolder(contextMenu.id); onNewNoteInFolder(contextMenu.id); }}>
                <FilePlus size={14} /> New note
              </button>
              <button type="button" role="menuitem" onClick={() => void createChannel(contextMenu.id)}>
                <Hash size={14} /> New channel
              </button>
              <button type="button" role="menuitem" onClick={() => createFolder(contextMenu.id)}>
                <FolderPlus size={14} /> New subfolder
              </button>
              <button type="button" role="menuitem" onClick={() => { const f = folders.find((x) => x.id === contextMenu.id); if (f) startRename(f); }}>
                <Pencil size={14} /> Rename
              </button>
              <div className="menu-divider" role="separator" />
              <button type="button" role="menuitem" className="menu-danger" onClick={() => { setContextMenu(null); onDeleteFolder(contextMenu.id); }}>
                <Trash2 size={14} /> Delete
              </button>
            </>
          )}

          {contextMenu.kind === 'root' && (
            <>
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onNewNote(); }}>
                <FilePlus size={14} /> New note
              </button>
              <button type="button" role="menuitem" onClick={() => void createChannel(null)}>
                <Hash size={14} /> New channel
              </button>
              <button type="button" role="menuitem" onClick={() => createFolder(null)}>
                <FolderPlus size={14} /> New folder
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
});
