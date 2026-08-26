import type { CommunityUpdates, Folder, NoteSummary, User, Vault } from '../../api';

/** Public sidebar contract shared by the composition and its stateful seams. */
export interface SidebarProps {
  user: User;
  vaults: Vault[];
  activeVaultId: string | null;
  folders: Folder[];
  notes: NoteSummary[];
  activeNoteId: string | null;
  updateCounts: CommunityUpdates['counts'];
  showAgentMemory: boolean;
  onSelectVault: (id: string) => void;
  onCreateVault: (name: string) => Promise<boolean>;
  onRenameVault: (id: string, name: string) => Promise<boolean>;
  onDeleteVault: (id: string) => Promise<boolean>;
  onManageVault: (id: string) => void;
  onJoinVault: (inviteLink: string) => Promise<boolean>;
  onOpenPublicVaults: () => void;
  onOpenDirectMessages: () => void;
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
  onCreateFolder: (parentId?: string | null) => Promise<Folder | undefined> | void;
  onRenameFolder: (id: string, name: string) => void;
  onRenameNote: (id: string, title: string) => Promise<void>;
  onDeleteFolder: (id: string) => void;
}

export type ContextMenu =
  | { x: number; y: number; kind: 'note'; id: string }
  | { x: number; y: number; kind: 'folder'; id: string }
  | { x: number; y: number; kind: 'root' };

export type MediaTrack =
  | { kind: 'audio'; name: string; url: string }
  | { kind: 'youtube'; name: string; url: string; videoId: string };

export type ElectronUpdateAPI = {
  updateAndRestart?: () => Promise<{ success: boolean; refreshing?: boolean; error?: string }>;
  onUpdateFailed?: (callback: (payload: { error?: string }) => void) => () => void;
};
