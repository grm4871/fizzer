/**
 * Folder-tree sidebar composition.
 *
 * Stateful seams live with the feature they own: VaultSwitcher owns vault
 * forms, SidebarTree owns tree selection/editing/DnD, SidebarAudioPlayer owns
 * media events, and SidebarFooter owns account/update actions.
 */
import { memo, useMemo, useRef } from 'react';
import { PanelLeftClose, Edit2, FolderPlus, Hash, Search } from 'lucide-react';
import { SidebarAudioPlayer } from './sidebar/SidebarAudioPlayer';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarTree, type SidebarTreeHandle } from './sidebar/SidebarTree';
import { VaultSwitcher } from './sidebar/VaultSwitcher';
import type { SidebarProps } from './sidebar/types';

export const Sidebar = memo(function Sidebar({
  user,
  vaults,
  activeVaultId,
  folders,
  notes,
  activeNoteId,
  updateCounts,
  showAgentMemory,
  onSelectVault,
  onCreateVault,
  onRenameVault,
  onDeleteVault,
  onManageVault,
  onJoinVault,
  onOpenPublicVaults,
  onOpenDirectMessages,
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
  const treeRef = useRef<SidebarTreeHandle>(null);
  const quickActions = useMemo(() => [
    { id: 'new-note', title: 'New note', icon: <Edit2 size={15} />, onClick: onNewNote },
    { id: 'new-folder', title: 'New folder', icon: <FolderPlus size={15} />, onClick: () => { void treeRef.current?.createFolder(null); } },
    { id: 'new-channel', title: 'New channel', icon: <Hash size={15} />, onClick: () => { void treeRef.current?.createChannel(null); } },
    { id: 'search', title: 'Search', icon: <Search size={15} />, onClick: onSearch },
  ], [onNewNote, onSearch]);
  const actionButtons = (location: string) => quickActions.map((action) => <button key={action.id} id={`${action.id}-btn-${location}`} className="btn-icon" onClick={action.onClick} title={action.title}>{action.icon}</button>);

  return (
    <aside className="sidebar" id="sidebar" style={{ gridColumn: 1 }}>
      <div className="sidebar-header">
        <VaultSwitcher vaults={vaults} activeVaultId={activeVaultId} updateCounts={updateCounts} onSelectVault={onSelectVault} onCreateVault={onCreateVault} onRenameVault={onRenameVault} onDeleteVault={onDeleteVault} onManageVault={onManageVault} onJoinVault={onJoinVault} onOpenPublicVaults={onOpenPublicVaults} />
        <div className="sidebar-actions sidebar-actions-desktop" role="toolbar" aria-label="Sidebar actions">{actionButtons('desktop')}</div>
        <button className="btn-icon sidebar-mobile-collapse" onClick={onCollapse} title="Collapse sidebar"><PanelLeftClose size={16} /></button>
      </div>
      <div className="sidebar-actions sidebar-actions-mobile">{actionButtons('mobile')}</div>
      <SidebarTree ref={treeRef} folders={folders} notes={notes} activeNoteId={activeNoteId} updateCounts={updateCounts} showAgentMemory={showAgentMemory} onSelectNote={onSelectNote} onOpenNoteInNewTab={onOpenNoteInNewTab} onNewNote={onNewNote} onCreateChannel={onCreateChannel} onNewNoteInFolder={onNewNoteInFolder} onDeleteNote={onDeleteNote} onMoveNote={onMoveNote} onUnlistNote={onUnlistNote} onMoveFolder={onMoveFolder} onCreateFolder={onCreateFolder} onRenameFolder={onRenameFolder} onRenameNote={onRenameNote} onDeleteFolder={onDeleteFolder} />
      <SidebarAudioPlayer />
      <SidebarFooter user={user} updateCounts={updateCounts} isOwner={isOwner} onOpenAccount={onOpenAccount} onOpenDirectMessages={onOpenDirectMessages} onLogout={onLogout} onOpenAdmin={onOpenAdmin} />
    </aside>
  );
});
