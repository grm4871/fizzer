import { useState, useMemo } from 'react';
import type { Vault, Folder, NoteSummary } from '../api';
import { Folder as FolderIcon, FileText, Pin, Gem, Edit2, Search, ChevronRight, PanelLeftClose, LogOut } from 'lucide-react';

interface SidebarProps {
  user: { id: number; username: string };
  vaults: Vault[];
  activeVaultId: string | null;
  folders: Folder[];
  notes: NoteSummary[];
  activeNoteId: string | null;
  onSelectVault: (id: string) => void;
  onSelectNote: (id: string) => void;
  onNewNote: () => void;
  onSearch: () => void;
  onCollapse: () => void;
  onLogout: () => void;
}

export function Sidebar({
  user,
  vaults,
  activeVaultId,
  folders,
  notes,
  activeNoteId,
  onSelectVault,
  onSelectNote,
  onNewNote,
  onSearch,
  onCollapse,
  onLogout,
}: SidebarProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const activeVault = useMemo(
    () => vaults.find((v) => v.id === activeVaultId) ?? null,
    [vaults, activeVaultId],
  );

  // Group notes by folder
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
    // Sort: pinned first, then by updated_at desc
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
    return map;
  }, [folders]);

  const rootNotes = notesByFolder.get(null) ?? [];

  function toggleFolder(folderId: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function renderFolder(folder: Folder, depth: number) {
    const isExpanded = expandedFolders.has(folder.id);
    const folderNotes = notesByFolder.get(folder.id) ?? [];
    const subFolders = childFolders.get(folder.id) ?? [];
    const paddingLeft = 12 + depth * 16;

    return (
      <div key={folder.id}>
        <button
          id={`folder-${folder.id}`}
          className="tree-item"
          style={{ paddingLeft }}
          onClick={() => toggleFolder(folder.id)}
        >
          <span className={`tree-chevron ${isExpanded ? 'expanded' : ''}`}><ChevronRight size={14} /></span>
          <span className="tree-icon"><FolderIcon size={16} /></span>
          <span className="tree-label">{folder.name}</span>
          <span className="text-xs text-tertiary">{folderNotes.length + subFolders.length}</span>
        </button>
        {isExpanded && (
          <div className="tree-children">
            {subFolders.map((sf) => renderFolder(sf, depth + 1))}
            {folderNotes.map((note) => renderNote(note, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  function renderNote(note: NoteSummary, depth: number) {
    const paddingLeft = 12 + depth * 16 + 16; // extra indent to align under folder
    return (
      <button
        key={note.id}
        id={`note-${note.id}`}
        className={`tree-item ${note.id === activeNoteId ? 'active' : ''}`}
        style={{ paddingLeft }}
        onClick={() => onSelectNote(note.id)}
      >
        <span className="tree-icon"><FileText size={16} /></span>
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
          {activeVault ? activeVault.name : 'Cascade Notes'}
        </div>
        <button
          id="sidebar-collapse-btn"
          className="btn-icon"
          onClick={onCollapse}
          title="Collapse sidebar"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* Quick actions */}
      <div className="sidebar-actions">
        <button id="new-note-btn" className="btn-icon" onClick={onNewNote} title="New note">
          <Edit2 size={16} />
        </button>
        <button id="search-btn" className="btn-icon" onClick={onSearch} title="Search">
          <Search size={16} />
        </button>
      </div>

      {/* Vault selector */}
      {vaults.length > 1 && (
        <div className="sidebar-vault-select">
          <select
            id="vault-select"
            value={activeVaultId ?? ''}
            onChange={(e) => onSelectVault(e.target.value)}
          >
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Folder tree */}
      <div className="sidebar-section-label">Notes</div>
      <div className="folder-tree" id="folder-tree">
        {rootFolders.map((folder) => renderFolder(folder, 0))}

        {/* Root-level notes (no folder) */}
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
          <div className="user-avatar">
            {user.username.charAt(0).toUpperCase()}
          </div>
          <span className="truncate">{user.username}</span>
        </div>
        <button
          id="logout-btn"
          className="btn-icon"
          onClick={onLogout}
          title="Log out"
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}
