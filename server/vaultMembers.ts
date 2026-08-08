/**
 * @file vaultMembers.ts — vault-level membership roles
 *
 * Vaults stay owned by `vaults.created_by`, but access is gated through
 * `vault_members` so multiple users can share one vault with roles:
 * owner | editor | viewer.
 */
import type Database from 'better-sqlite3';

type Db = Database.Database;

export const VAULT_ROLES = ['owner', 'editor', 'viewer'] as const;
export type VaultRole = (typeof VAULT_ROLES)[number];

export type VaultMember = {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  role: VaultRole;
  createdAt: string;
};

export function isVaultRole(value: unknown): value is VaultRole {
  return typeof value === 'string' && (VAULT_ROLES as readonly string[]).includes(value);
}

export function canWriteVault(role: VaultRole | null): boolean {
  return role === 'owner' || role === 'editor';
}

export function canManageVaultMembers(role: VaultRole | null): boolean {
  return role === 'owner';
}

/**
 * API-wide viewer guard for routes whose vault id is the first path segment
 * after `/api/vaults/`. Individual resources such as `/api/notes/:id` still
 * resolve their vault before writing, but this closes every nested vault route
 * (chat, runs, scratchpad, missions, settings, feeds, and future additions).
 */
export function isReadOnlyVaultMutation(
  db: Db,
  userId: number,
  method: string,
  pathname: string,
): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return false;
  const match = /^\/api\/vaults\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return false;
  let vaultId: string;
  try {
    vaultId = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  const selfRemoval = /^\/api\/vaults\/[^/]+\/members\/(\d+)\/?$/.exec(pathname);
  if (method.toUpperCase() === 'DELETE' && selfRemoval && Number(selfRemoval[1]) === userId) {
    return false;
  }
  return getVaultRole(db, vaultId, userId) === 'viewer';
}

function createVaultMembersTable(db: Db, name: string): void {
  // `name` is internal and intentionally constrained before interpolation.
  if (!/^vault_members(?:_next)?$/.test(name)) throw new Error('Invalid membership table name');
  db.exec(`
    CREATE TABLE ${name} (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('owner','editor','viewer')),
      invited_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (vault_id, user_id)
    )
  `);
}

export function ensureVaultMembersSchema(db: Db): void {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_members'",
  ).get() as { sql: string } | undefined;

  if (!existing) {
    createVaultMembersTable(db, 'vault_members');
  } else {
    const columns = (db.prepare('PRAGMA table_info(vault_members)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    const exactColumns = ['vault_id', 'user_id', 'role', 'invited_by', 'created_at']
      .every((column) => columns.includes(column));
    const threeRoleConstraint = /CHECK\s*\(\s*role\s+IN\s*\(\s*'owner'\s*,\s*'editor'\s*,\s*'viewer'\s*\)\s*\)/i
      .test(existing.sql || '');

    // Rebuild legacy and four-role tables transactionally. Existing `admin`
    // rows become editors: they retain write access but no longer manage users.
    if (!exactColumns || !threeRoleConstraint) {
      const has = (column: string) => columns.includes(column);
      const roleExpr = has('role')
        ? "CASE role WHEN 'owner' THEN 'owner' WHEN 'viewer' THEN 'viewer' ELSE 'editor' END"
        : "CASE WHEN user_id = (SELECT created_by FROM vaults WHERE id = vault_id) THEN 'owner' ELSE 'editor' END";
      const invitedByExpr = has('invited_by') ? 'invited_by' : 'NULL';
      const createdAtExpr = has('created_at')
        ? "COALESCE(NULLIF(created_at, ''), datetime('now'))"
        : "datetime('now')";
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS vault_members_next');
        createVaultMembersTable(db, 'vault_members_next');
        db.exec(`
          INSERT OR REPLACE INTO vault_members_next (vault_id, user_id, role, invited_by, created_at)
          SELECT vault_id, user_id, ${roleExpr}, ${invitedByExpr}, ${createdAtExpr}
          FROM vault_members
        `);
        db.exec('DROP TABLE vault_members');
        db.exec('ALTER TABLE vault_members_next RENAME TO vault_members');
      })();
    }
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_vault_members_user ON vault_members(user_id)');

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
        WHEN 'editor' THEN 1
        ELSE 2
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
  if (!canManageVaultMembers(actorRole)) {
    throw new Error('Only the vault owner can invite members');
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
  if (!canManageVaultMembers(actorRole)) {
    throw new Error('Only the vault owner can change roles');
  }

  const targetRole = getVaultRole(db, vaultId, targetUserId);
  if (!targetRole) throw new Error('Member not found');
  if (targetRole === 'owner') throw new Error('Cannot change the vault owner role');

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

  // Members may leave themselves; only the owner can remove someone else.
  if (actorUserId !== targetUserId && !canManageVaultMembers(actorRole)) {
    throw new Error('Only the vault owner can remove members');
  }

  db.prepare(
    'DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?',
  ).run(vaultId, targetUserId);
}
