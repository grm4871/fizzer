// Shared creator/author interface
export interface Creator {
  id: string;
  username: string;
  displayName: string;
  color: string;
}

// Unified netdoc interface - used for documents and posts
export interface Netdoc {
  id: string;
  name: string;
  content: string;
  creator: Creator;
  creator_id: string;
  created_at: string | Date;
  updated_at: string | Date;
  allow_edits?: boolean;
  canRead?: boolean;
  canWrite?: boolean;
  space?: { id: string; name: string } | null;
  // Legacy fields for backward compatibility
  title?: string;        // Alias for name
  status?: string;       // Draft, published, etc.
  privacy?: string;      // Public, private, etc.
  authorId?: string;     // Alias for creator_id
  username?: string;     // Alias for creator.username
  displayName?: string;  // Alias for creator.displayName
  createdAt?: Date;      // Alias for created_at
  updatedAt?: Date;      // Alias for updated_at
}

export type Document = Netdoc;
export type Post = Netdoc;

export interface SidebarItem {
  id: string;
  type: 'post' | 'netdoc';
  postId: string | null;
  userId: string;

  netdocId?: string | null;
  parentId: string | null;
  title: string;
  content: string | null;
  authorId: string | null;
  username?: string | null;
  displayName?: string | null;
  createdAt: string;
  orderKey: number;
}

export interface Notification {
  id: string;
  type: string;
  message: string;
  timestamp: string | Date;
  read: boolean;
  netdocId?: string;
  netdocName?: string;
  authorName?: string;
  authorColor?: string;
  updateType?: string;
  content?: string;
}


export interface UserSettings {
  adultMode: boolean;
  misspellIndicator: boolean;
  openLinkNewTab?: boolean;  // false = same tab (default), true = new tab
  confirmDiscardEdits?: boolean;
  showTabs?: boolean;  // false = hide tab bar (default), true = show tab bar
}

export interface ProfileData {
  id: string;
  username: string;
  displayName: string;
  joinedAt: string;
  homepage?: string | null;
  settings?: UserSettings;
  color?: string;
  isAdmin?: boolean;
}

export interface Permission {
  id: string;
  netdoc_id: string;
  permission_type: 'read' | 'write';
  user_id: string | null; // null = nobody, EVERYONE_UUID = everyone
  is_blacklist?: boolean; // For PermissionsMenu compatibility
  created_at: string;
  updated_at?: string;
}

// Space types
export interface SpaceMember {
  userId: string;
  role: string;
  profile: Creator;
}

export interface Space {
  id: string;
  name: string;
  description?: string;
  monarchDisplayName?: string;
  monarchUsername?: string;
  monarchColor?: string;
  jacketId?: string;
  canWrite?: boolean;
  monarch?: Creator;
  members?: SpaceMember[];
}

export interface SpaceSubscription {
  id: string;
  name: string;
  orderKey: number;
  monarch: Creator;
}

// Feed/Explore types
export interface FeedItem {
  id: string;
  name: string;
  content: string;
  creator_id: string;
  creator: Creator;
  created_at: string;
  updated_at: string;
  score: number;
  type: 'netdoc' | 'space';
  space?: { id: string; name: string } | null;
}

// Socket event payloads
export interface SocketEventNetdocUpdate {
  netdocId: string;
  updateType: string;
  timestamp: Date | string;
}

export interface SocketEventNotificationNew {
  id: string;
  type: string;
  message: string;
  timestamp: string;
  read: boolean;
  netdocId?: string;
  netdocName?: string;
  authorName?: string;
  authorColor?: string;
  updateType?: string;
  content?: string;
}

// Editor types
export interface RemoteUser {
  id: string;
  username: string;
  displayName: string;
  color: string;
  cursor?: { index: number; length?: number };
}

export interface EditorHandle {
  focus: () => void;
}

export interface EditorProps {
  content: string;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  remoteUsers?: RemoteUser[];
  onCursorChange?: (index: number, length?: number) => void;
}

export interface EditorViProps extends EditorProps {
  onQuit?: () => void;
  onForceQuit?: () => void;
  onModeChange?: (mode: string) => void;
}
