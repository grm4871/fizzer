import type { VaultRole } from '../api';

export type AssignableRole = Exclude<VaultRole, 'owner'>;
export type AccountSettingsSection = 'profile' | 'preferences' | 'security' | 'local-agent' | 'vault';
export type PublicJoinPolicy = 'open' | 'request' | 'invite';
export type PublicVaultSettings = {
  visibility: 'private' | 'public';
  summary: string;
  topics: string[];
  guidelines: string;
  homeNoteId: string | null;
  joinPolicy: PublicJoinPolicy;
};
export type PublicHomeNoteChoice = { id: string; title: string };
export type PublicJoinRequest = {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  status: 'pending';
  createdAt: string;
};
export type VaultBan = {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  reason: string;
  createdAt: string;
};
export type VaultReport = {
  id: number;
  targetType: 'vault' | 'note' | 'message' | 'member';
  targetId: string;
  targetUsername: string | null;
  reason: 'spam' | 'harassment' | 'hate' | 'illegal' | 'other';
  detail: string;
  createdAt: string;
};

export const ROLE_HELP: Record<VaultRole, string> = {
  owner: 'Owns the vault. Cannot be removed or demoted here.',
  editor: 'Can read and write notes, folders, and chats.',
  viewer: 'Read-only access.',
};
