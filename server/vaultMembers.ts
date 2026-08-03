/**
 * @file vaultMembers.ts — vault-level membership roles
 *
 * Vaults stay owned by `vaults.created_by`, but access is gated through
 * `vault_members` so multiple users can share one vault with roles:
 * owner | admin | editor | viewer.
 */
import type Database from 'better-sqlite3';

type Db = Database.Database;

export const VAULT_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type VaultRole = (typeof VAULT_ROLES)[number];

export type VaultMember = {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  role: VaultRole;
  createdAt: string;
};

const ROLE_RANK: Record<VaultRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

export function isVaultRole(value: unknown): value is VaultRole {
  return typeof value === 'string' && (VAULT_ROLES as readonly string[]).includes(value);
}

export function roleAtLeast(role: VaultRole, min: VaultRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function ensureVaultMembersSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_members (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('owner','admin','editor','viewer')),
      invited_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (vault_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vault_members_user ON vault_members(user_id);
  `);

  // Older prod tables predated role/invited_by — add missing columns in place.
  const columns = (db.prepare('PRAGMA table_info(vault_members)').all() as Array<{ name: string }>)
    .map((row) => row.name);
  if (columns.length && !columns.includes('role')) {
    db.exec(`ALTER TABLE vault_members ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'`);
  }
  if (columns.length && !columns.includes('invited_by')) {
    db.exec('ALTER TABLE vault_members ADD COLUMN invited_by INTEGER REFERENCES users(id)');
  }
  if (columns.length && !columns.includes('created_at')) {
    db.exec(`ALTER TABLE vault_members ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))`);
  }

  // Backfill: every vault owner is a member. Safe on every boot.
  db.prepare(`
    INSERT OR IGNORE INTO vault_members (vault_id, user_id, role, invited_by)
    SELECT id, created_by, 'owner', created_by FROM vaults
  `).run();

  // Repair: ensure created_by always has an owner row (role may have been demoted wrongly).
  db.prepare(`
    INSERT INTO vault_members (vault_id, user_id, role, invited_by)
    SELECT v.id, v.created_by, 'owner', v.created_by
    FROM vaults v
    LEFT JOIN vault_members m ON m.vault_id = v.id AND m.user_id = v.created_by
    WHERE m.user_id IS NULL
  `).run();

  db.prepare(`
    UPDATE vault_members
    SET role = 'owner'
    WHERE (vault_id, user_id) IN (
      SELECT id, created_by FROM vaults
    ) AND role != 'owner'
  `).run();
}

export function getVaultRole(db: Db, vaultId: string, userId: number): VaultRole | null {
  const row = db.prepare(
    'SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?',
  ).get(vaultId, userId) as { role: string } | undefined;
  if (!row || !isVaultRole(row.role)) return null;
  return row.role;
}

export function addVaultOwnerMembership(db: Db, vaultId: string, userId: number): void {
  db.prepare(`
    INSERT INTO vault_members (vault_id, user_id, role, invited_by)
    VALUES (?, ?, 'owner', ?)
    ON CONFLICT(vault_id, user_id) DO UPDATE SET role = 'owner'
  `).run(vaultId, userId, userId);
}

export function listVaultMembers(db: Db, vaultId: string): VaultMember[] {
  return (db.prepare(`
    SELECT
      m.user_id AS userId,
      u.username AS username,
      COALESCE(NULLIF(u.display_name, ''), u.username) AS displayName,
      COALESCE(u.avatar_url, '') AS avatarUrl,
      m.role AS role,
      m.created_at AS createdAt
    FROM vault_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.vault_id = ?
    ORDER BY
      CASE m.role
        WHEN 'owner' THEN 0
        WHEN 'admin' THEN 1
        WHEN 'editor' THEN 2
        ELSE 3
      END,
      u.username COLLATE NOCASE
  `).all(vaultId) as VaultMember[]).map((row) => ({
    ...row,
    role: row.role as VaultRole,
  }));
}

export function addVaultMember(
  db: Db,
  vaultId: string,
  actorUserId: number,
  targetUserId: number,
  role: VaultRole,
): VaultMember {
  if (role === 'owner') throw new Error('Cannot assign a second owner; transfer ownership instead');
  const actorRole = getVaultRole(db, vaultId, actorUserId);
  if (!actorRole || !roleAtLeast(actorRole, 'admin')) {
    throw new Error('Only owners and admins can invite vault members');
  }
  if (targetUserId === actorUserId) throw new Error('You are already a member of this vault');

  const existing = getVaultRole(db, vaultId, targetUserId);
  if (existing) throw new Error('User is already a member of this vault');

  const user = db.prepare(
    'SELECT id, username, display_name, avatar_url FROM users WHERE id = ?',
  ).get(targetUserId) as { id: number; username: string; display_name: string; avatar_url: string } | undefined;
  if (!user) throw new Error('User not found');

  db.prepare(`
    INSERT INTO vault_members (vault_id, user_id, role, invited_by)
    VALUES (?, ?, ?, ?)
  `).run(vaultId, targetUserId, role, actorUserId);

  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    avatarUrl: user.avatar_url || '',
    role,
    createdAt: new Date().toISOString(),
  };
}

export function setVaultMemberRole(
  db: Db,
  vaultId: string,
  actorUserId: number,
  targetUserId: number,
  role: VaultRole,
): VaultMember {
  if (role === 'owner') throw new Error('Cannot promote to owner here; transfer ownership instead');
  const actorRole = getVaultRole(db, vaultId, actorUserId);
  if (!actorRole || !roleAtLeast(actorRole, 'admin')) {
    throw new Error('Only owners and admins can change roles');
  }

  const targetRole = getVaultRole(db, vaultId, targetUserId);
  if (!targetRole) throw new Error('Member not found');
  if (targetRole === 'owner') throw new Error('Cannot change the vault owner role');
  if (actorRole === 'admin' && targetRole === 'admin') {
    throw new Error('Admins cannot change other admins');
  }
  if (actorRole === 'admin' && role === 'admin') {
    throw new Error('Only the owner can grant admin');
  }

  db.prepare(
    'UPDATE vault_members SET role = ? WHERE vault_id = ? AND user_id = ?',
  ).run(role, vaultId, targetUserId);

  const member = listVaultMembers(db, vaultId).find((m) => m.userId === targetUserId);
  if (!member) throw new Error('Member not found');
  return member;
}

export function removeVaultMember(
  db: Db,
  vaultId: string,
  actorUserId: number,
  targetUserId: number,
): void {
  const actorRole = getVaultRole(db, vaultId, actorUserId);
  if (!actorRole) throw new Error('Not a vault member');

  const targetRole = getVaultRole(db, vaultId, targetUserId);
  if (!targetRole) throw new Error('Member not found');
  if (targetRole === 'owner') throw new Error('Cannot remove the vault owner');

  // Members may leave themselves; otherwise admin+.
  if (actorUserId !== targetUserId && !roleAtLeast(actorRole, 'admin')) {
    throw new Error('Only owners and admins can remove members');
  }
  if (actorRole === 'admin' && targetRole === 'admin' && actorUserId !== targetUserId) {
    throw new Error('Admins cannot remove other admins');
  }

  db.prepare(
    'DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?',
  ).run(vaultId, targetUserId);
}
