import { usePopupMenu } from '../../ui/popupMenu';
import { FilePlus, FileText, Folder as FolderIcon, FolderInput, FolderPlus, Hash, Pencil, Trash2, Unlink } from 'lucide-react';
import { CHAT_NOTE_MARKER } from '../../chat/shared';
import type { Folder, NoteSummary } from '../../api';
import type { ContextMenu } from './types';

interface SidebarContextMenuProps {
  contextMenu: ContextMenu;
  moveMenu: boolean;
  notes: NoteSummary[];
  folders: Folder[];
  flatFolders: { folder: Folder; depth: number }[];
  onClose: () => void;
  onSetMoveMenu: (open: boolean) => void;
  onSelectNote: (id: string) => void;
  onOpenNoteInNewTab: (id: string) => void;
  onStartRenameNote: (note: NoteSummary) => void;
  onStartRenameFolder: (folder: Folder) => void;
  onMoveNote: (id: string, folderId: string | null) => void;
  onDeleteNote: (id: string) => void;
  onUnlistNote: (id: string) => void;
  onNewNote: () => void;
  onNewNoteInFolder: (folderId: string | null) => void;
  onCreateChannel: (folderId: string | null) => Promise<void>;
  onCreateFolder: (parentId: string | null) => Promise<Folder | undefined> | void;
  onDeleteFolder: (id: string) => void;
  onExpandFolder: (id: string) => void;
}

export function SidebarContextMenu({ contextMenu, moveMenu, notes, folders, flatFolders, onClose, onSetMoveMenu, onSelectNote, onOpenNoteInNewTab, onStartRenameNote, onStartRenameFolder, onMoveNote, onDeleteNote, onUnlistNote, onNewNote, onNewNoteInFolder, onCreateChannel, onCreateFolder, onDeleteFolder, onExpandFolder }: SidebarContextMenuProps) {
  const menuRef = usePopupMenu<HTMLDivElement>(contextMenu, moveMenu);
  const note = contextMenu.kind === 'note' ? notes.find((item) => item.id === contextMenu.id) : undefined;
  const folder = contextMenu.kind === 'folder' ? folders.find((item) => item.id === contextMenu.id) : undefined;
  const isChatChannel = note?.content_preview.trim().startsWith(CHAT_NOTE_MARKER);

  return (
    <div ref={menuRef} className="tree-context-menu" role="menu" aria-label={contextMenu.kind === 'folder' ? 'Folder options' : contextMenu.kind === 'root' ? 'Sidebar options' : moveMenu ? 'Move note to folder' : 'Note options'} style={{ top: contextMenu.y, left: contextMenu.x }} onClick={(event) => event.stopPropagation()}>
      {contextMenu.kind === 'note' && !moveMenu && <>
        <button type="button" role="menuitem" onClick={() => { onClose(); onSelectNote(contextMenu.id); }}>{isChatChannel ? <Hash size={14} /> : <FileText size={14} />} Open</button>
        <button type="button" role="menuitem" onClick={() => { onClose(); onOpenNoteInNewTab(contextMenu.id); }}><FilePlus size={14} /> Open in new tab</button>
        <button type="button" role="menuitem" onClick={() => { if (note) onStartRenameNote(note); }}><Pencil size={14} /> Rename</button>
        <button type="button" role="menuitem" onClick={() => onSetMoveMenu(true)}><FolderInput size={14} /> Move to…</button>
        {!isChatChannel && <button type="button" role="menuitem" onClick={() => { onClose(); onUnlistNote(contextMenu.id); }}><Unlink size={14} /> Remove from sidebar</button>}
        <div className="menu-divider" role="separator" />
        <button type="button" role="menuitem" className="menu-danger" onClick={() => { onClose(); onDeleteNote(contextMenu.id); }}><Trash2 size={14} /> Delete</button>
      </>}
      {contextMenu.kind === 'note' && moveMenu && <div className="menu-scroll">
        <button type="button" role="menuitem" onClick={() => { onClose(); onMoveNote(contextMenu.id, null); }}><FolderIcon size={14} /> Root</button>
        {flatFolders.map(({ folder: destination, depth }) => <button key={destination.id} type="button" role="menuitem" style={{ paddingLeft: 12 + depth * 12 }} onClick={() => { onClose(); onMoveNote(contextMenu.id, destination.id); onExpandFolder(destination.id); }}><FolderIcon size={14} /> {destination.name}</button>)}
      </div>}
      {contextMenu.kind === 'folder' && <>
        <button type="button" role="menuitem" onClick={() => { onClose(); onExpandFolder(contextMenu.id); onNewNoteInFolder(contextMenu.id); }}><FilePlus size={14} /> New note</button>
        <button type="button" role="menuitem" onClick={() => void onCreateChannel(contextMenu.id)}><Hash size={14} /> New channel</button>
        <button type="button" role="menuitem" onClick={() => void onCreateFolder(contextMenu.id)}><FolderPlus size={14} /> New subfolder</button>
        <button type="button" role="menuitem" onClick={() => { if (folder) onStartRenameFolder(folder); }}><Pencil size={14} /> Rename</button>
        <div className="menu-divider" role="separator" />
        <button type="button" role="menuitem" className="menu-danger" onClick={() => { onClose(); onDeleteFolder(contextMenu.id); }}><Trash2 size={14} /> Delete</button>
      </>}
      {contextMenu.kind === 'root' && <>
        <button type="button" role="menuitem" onClick={() => { onClose(); onNewNote(); }}><FilePlus size={14} /> New note</button>
        <button type="button" role="menuitem" onClick={() => void onCreateChannel(null)}><Hash size={14} /> New channel</button>
        <button type="button" role="menuitem" onClick={() => void onCreateFolder(null)}><FolderPlus size={14} /> New folder</button>
      </>}
    </div>
  );
}
