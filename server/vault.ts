/**
 * @file vault.ts — Dual-storage vault model (disk + SQLite index)
 *
 * Implements CRUD and synchronization for notes, folders, and tags. Vault notes
 * are stored on the local filesystem as markdown (.md) files, while metadata
 * (pinned/archived status, backlink relationships) is indexed in SQLite.
 *
 * @module server/vault
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

type Db = Database.Database;

// Persistent base directory for vaults that don't specify their own root_path.
// Lives under the user's home dir so notes survive reboots (unlike /tmp).
export const VAULTS_BASE_DIR = path.join(os.homedir(), '.cascade', 'vaults');

// ── Types ──────────────────────────────────────────────────────────

export type Vault = {
  id: string;
  name: string;
  root_path: string;
  created_by: number;
  created_at: string;
};

export type Folder = {
  id: string;
  vault_id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: string;
};

export type NoteSummary = {
  id: string;
  vault_id: string;
  folder_id: string | null;
  title: string;
  content_preview: string;
  is_pinned: number;
  is_archived: number;
  is_listed: number;
  position: number;
  word_count: number;
  created_at: string;
  updated_at: string;
  tags: string[];
};

export type Note = NoteSummary & {
  content: string;
  file_path: string;
};

export type SearchResult = {
  id: string;
  title: string;
  snippet: string;
  rank: number;
};

export type BacklinkResult = {
  id: string;
  title: string;
  context: string | null;
};

export type Tag = {
  id: string;
  name: string;
  color: string | null;
  count: number;
};

export type GraphNode = {
  id: string;
  title: string;
  folder_id: string | null;
};

export type GraphEdge = {
  source: string;
  target: string;
};

// ── Helpers ────────────────────────────────────────────────────────

function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled';
}

/**
 * Single path segment for vault FS layout. Titles already use sanitizeFilename;
 * folder names historically did not — `..` / separators could escape root_path.
 */
function sanitizePathSegment(name: string): string {
  // Reject path traversal before separator folding (../x → .._x would otherwise pass).
  const raw = String(name || '').trim();
  if (!raw || raw === '.' || raw === '..' || /[/\\]/.test(raw)) {
    throw new Error('Invalid folder or file name');
  }
  const cleaned = sanitizeFilename(raw)
    .replace(/^\.+$/, '')
    .replace(/^\.+/, '')
    .trim();
  // Block `..` and `.._outside` (from ../outside) without rejecting "v1..2" mid-title.
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('..')) {
    throw new Error('Invalid folder or file name');
  }
  return cleaned;
}

/** Resolve a path under vault.root_path or throw if it escapes. */
function resolveUnderVault(vaultRoot: string, ...parts: string[]): string {
  const root = path.resolve(vaultRoot);
  const resolved = path.resolve(root, ...parts);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path escapes vault root');
  }
  return resolved;
}

function stripMarkdown(content: string): string {
  const normalized = content.replace(/\\+`/g, '`');
  return normalized
    .replace(/^#{1,6}\s+/gm, '')         // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // bold
    .replace(/\*([^*]+)\*/g, '$1')         // italic
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')         // strikethrough
    .replace(/`([^`]+)`/g, '$1')           // inline code
    .replace(/```[\s\S]*?```/g, '')        // code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // images
    .replace(/\[\[([^\]]+)\]\]/g, '$1')     // wikilinks
    .replace(/[-*+]\s+/g, '')              // list markers
    .replace(/>\s+/g, '')                  // blockquotes
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

function makePreview(content: string): string {
  const stripped = stripMarkdown(content);
  return stripped.length > 200 ? stripped.slice(0, 200) : stripped;
}

function wordCount(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function extractLinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
  const titles: string[] = [];
  for (const match of matches) {
    const title = match[1].trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles;
}


function getFolderPath(vault: Vault, db: Db, folderId: string): string {
  const parts: string[] = [];
  let current: { id: string; parent_id: string | null; name: string } | undefined =
    db.prepare('SELECT id, parent_id, name FROM folders WHERE id = ?').get(folderId) as typeof current;

  while (current) {
    // Re-sanitize on resolve so legacy bad names cannot escape the root.
    parts.unshift(sanitizePathSegment(current.name));
    if (current.parent_id) {
      current = db.prepare('SELECT id, parent_id, name FROM folders WHERE id = ?').get(current.parent_id) as typeof current;
    } else {
      break;
    }
  }

  return resolveUnderVault(vault.root_path, ...parts);
}


function resolveNotePath(db: Db, noteId: string): string | undefined {
  const note = db.prepare('SELECT id, vault_id, folder_id, title, is_listed FROM notes WHERE id = ?').get(noteId) as {
    id: string; vault_id: string; folder_id: string | null; title: string; is_listed: number;
  } | undefined;
  if (!note) return undefined;

  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(note.vault_id) as Vault | undefined;
  if (!vault) return undefined;

  if (!note.is_listed) {
    return resolveUnderVault(vault.root_path, '.cascade-unlisted', `${sanitizePathSegment(note.title)}.md`);
  }
  if (note.folder_id) {
    const folderPath = getFolderPath(vault, db, note.folder_id);
    return resolveUnderVault(folderPath, `${sanitizePathSegment(note.title)}.md`);
  }
  return resolveUnderVault(vault.root_path, `${sanitizePathSegment(note.title)}.md`);
}

function getTagsForNote(db: Db, noteId: string): string[] {
  const rows = db.prepare(`
    SELECT t.name FROM tags t
    JOIN note_tags nt ON nt.tag_id = t.id
    WHERE nt.note_id = ?
    ORDER BY t.name ASC
  `).all(noteId) as { name: string }[];
  return rows.map((r) => r.name);
}

function reIndexLinks(db: Db, noteId: string, vaultId: string, content: string): void {
  db.prepare('DELETE FROM note_links WHERE source_id = ?').run(noteId);
  const titles = extractLinks(content);
  if (titles.length === 0) return;

  const insert = db.prepare(
    'INSERT OR REPLACE INTO note_links (source_id, target_id, target_title, context) VALUES (?, ?, ?, ?)'
  );

  for (const title of titles) {
    // Try to resolve target_id by matching title in the same vault
    const target = db.prepare(
      'SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE'
    ).get(vaultId, title) as { id: string } | undefined;

    // Extract some context around the link
    const linkPattern = `[[${title}]]`;
    const idx = content.indexOf(linkPattern);
    let context: string | null = null;
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(content.length, idx + linkPattern.length + 40);
      context = content.slice(start, end).replace(/\n/g, ' ').trim();
    }

    insert.run(noteId, target?.id || null, title, context);
  }
}

// ── Vaults ─────────────────────────────────────────────────────────

export function listVaults(db: Db, userId: number): Vault[] {
  // Membership-aware: owners (created_by) and invited members both see the vault.
  // Falls back to created_by-only when vault_members has not been migrated yet.
  try {
    return db.prepare(`
      SELECT v.*
      FROM vaults v
      JOIN vault_members m ON m.vault_id = v.id
      WHERE m.user_id = ?
      ORDER BY v.created_at DESC
    `).all(userId) as Vault[];
  } catch {
    return db.prepare('SELECT * FROM vaults WHERE created_by = ? ORDER BY created_at DESC').all(userId) as Vault[];
  }
}

export function getVault(db: Db, vaultId: string, userId: number): Vault | undefined {
  try {
    return db.prepare(`
      SELECT v.*
      FROM vaults v
      JOIN vault_members m ON m.vault_id = v.id
      WHERE v.id = ? AND m.user_id = ?
    `).get(vaultId, userId) as Vault | undefined;
  } catch {
    return db.prepare('SELECT * FROM vaults WHERE id = ? AND created_by = ?').get(vaultId, userId) as Vault | undefined;
  }
}

/** Any member may read; only editor+ may mutate notes/folders/settings. */
export function getWritableVault(db: Db, vaultId: string, userId: number): Vault | undefined {
  try {
    return db.prepare(`
      SELECT v.*
      FROM vaults v
      JOIN vault_members m ON m.vault_id = v.id
      WHERE v.id = ? AND m.user_id = ?
        AND m.role IN ('owner', 'admin', 'editor')
    `).get(vaultId, userId) as Vault | undefined;
  } catch {
    return getVault(db, vaultId, userId);
  }
}

function prepopulateWalkthrough(vault: Vault): void {
  const welcomeContent = `# 💎 Welcome to Cascade Notes\n\nCascade Notes is an intelligent, Obsidian-style personal wiki designed for writing, organizing, and thinking alongside AI.\n\n## Key Features\n\n1. **Local Markdown Files**: All notes are stored as standard \`.md\` files in your vault folder: \`${vault.root_path}\`.\n2. **Rich Live Preview**: A modern CodeMirror 6 editor renders headers, bold/italic, checkboxes, and wikilinks directly as you type.\n3. **Wikilinks & Backlinks**: Connect notes using wikilinks like [[Navigation & Search]]. Check the backlinks panel to explore note relationships.\n4. **Agent**: Open the agent panel and pick an agent (Claude Code, Codex, Grok, Antigravity, Copilot, or Hermes) to read, edit, and organize your notes directly on disk.\n\n## Get Started\n\n- Click the **🤖 Agent** button on the tab bar to open the agent panel, then choose your agent and tell it what to do.\n- Drop an inline directive anywhere in a note with the \`{{ai: your instruction}}\` syntax, then put your cursor on it and press \`Ctrl+Enter\` (\`Cmd+Enter\` on macOS) to run it in the agent panel. Try it: {{ai: write a one-line welcome message at the top of this note}}\n- Check the boxes below to try out interactive checklists:\n  - [ ] Edit this note and change this checkbox\n  - [ ] Click on the checkbox widget directly to toggle it!\n  - [x] Press \`Ctrl+P\` to open the command palette\n`;

  const navContent = `# 🔍 Navigation & Search\n\nCascade Notes is built for speed and keyboard-driven navigation.\n\n## Keyboard Shortcuts\n\nHere are the key shortcuts to keep your hands on the keyboard:\n\n- \`Ctrl+P\` (or \`Cmd+P\`): Open the **Command Palette**. Search through note titles fuzzy-style, or press Enter on a non-existent name to create a new note instantly.\n- \`Ctrl+Shift+F\`: Open **Vault Search**. Perform ranked full-text search across all note contents using SQLite FTS5.\n- \`Ctrl+S\`: Save the current note.\n- \`Ctrl+N\`: Create a new note.\n- \`Ctrl+\\\`: Toggle the sidebar.\n\n## Organizing with Tags\n\nYou can add tags to notes (e.g., #tutorial, #reference) or add them via the tag manager in the sidebar. Tags help you filter notes in search and group them in the folder tree.\n`;

  fs.writeFileSync(path.join(vault.root_path, 'Welcome to Cascade Notes.md'), welcomeContent, 'utf8');
  fs.writeFileSync(path.join(vault.root_path, 'Navigation & Search.md'), navContent, 'utf8');
}

/**
 * Resolve an isolated on-disk root for a new vault.
 * Never honor a client-supplied path — shared roots cause note leakage across
 * accounts when rescanVault indexes whoever's markdown is already there.
 */
function uniqueVaultRootPath(userId: number, vaultId: string, name: string): string {
  const safeName = sanitizeFilename(name) || 'vault';
  // userId + vaultId guarantees isolation even when two users pick "My Vault".
  return path.resolve(path.join(VAULTS_BASE_DIR, String(userId), vaultId, safeName));
}

function vaultRootTaken(db: Db, rootPath: string, exceptVaultId?: string): boolean {
  const resolved = path.resolve(rootPath);
  const rows = db.prepare('SELECT id, root_path FROM vaults').all() as Array<{ id: string; root_path: string }>;
  return rows.some((row) => (
    row.id !== exceptVaultId
    && path.resolve(row.root_path || '') === resolved
  ));
}

function purgeVaultIndex(db: Db, vaultId: string): void {
  // Drop DB index for a vault that was pointing at a foreign tree. Disk files
  // belonging to the canonical owner of that path are left untouched.
  try {
    db.prepare(`
      DELETE FROM note_links WHERE source_id IN (SELECT id FROM notes WHERE vault_id = ?)
        OR target_id IN (SELECT id FROM notes WHERE vault_id = ?)
    `).run(vaultId, vaultId);
  } catch { /* schema variants */ }
  try {
    db.prepare(`
      DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE vault_id = ?)
    `).run(vaultId);
  } catch { /* schema variants */ }
  db.prepare('DELETE FROM notes WHERE vault_id = ?').run(vaultId);
  db.prepare('DELETE FROM folders WHERE vault_id = ?').run(vaultId);
}

/**
 * Boot-time repair: one vault per on-disk root. Secondary vaults that shared a
 * path (legacy createVault) are rehomed to empty isolated directories and their
 * leaked note index is purged so accounts never see each other's trees.
 */
export function enforceVaultStorageIsolation(db: Db): { rehomed: number } {
  const vaults = db.prepare(`
    SELECT id, name, root_path, created_by, created_at FROM vaults
    ORDER BY created_at ASC, rowid ASC
  `).all() as Array<{
    id: string;
    name: string;
    root_path: string;
    created_by: number;
    created_at: string;
  }>;

  const byRoot = new Map<string, typeof vaults>();
  for (const vault of vaults) {
    const key = path.resolve(vault.root_path || '');
    if (!key || key === path.resolve('/')) continue;
    const group = byRoot.get(key) || [];
    group.push(vault);
    byRoot.set(key, group);
  }

  let rehomed = 0;
  const updateRoot = db.prepare('UPDATE vaults SET root_path = ? WHERE id = ?');

  for (const [, group] of byRoot) {
    if (group.length < 2) continue;
    // Keep the oldest vault on the shared path (canonical owner of that tree).
    const [, ...intruders] = group;
    for (const vault of intruders) {
      const nextRoot = uniqueVaultRootPath(vault.created_by, vault.id, vault.name || 'My Vault');
      fs.mkdirSync(nextRoot, { recursive: true });
      purgeVaultIndex(db, vault.id);
      updateRoot.run(nextRoot, vault.id);
      const refreshed = db.prepare('SELECT * FROM vaults WHERE id = ?').get(vault.id) as Vault;
      try {
        prepopulateWalkthrough(refreshed);
        rescanVault(db, refreshed.id, refreshed.created_by);
      } catch (err) {
        console.error('Failed to reseed rehomed vault', vault.id, err);
      }
      rehomed += 1;
      console.warn(
        `[vault-isolation] rehomed vault ${vault.id} (user ${vault.created_by}) off shared root ${group[0].root_path} → ${nextRoot}`,
      );
    }
  }

  // Normalize stored paths to absolute resolved form and enforce uniqueness.
  for (const vault of db.prepare('SELECT id, root_path FROM vaults').all() as Array<{ id: string; root_path: string }>) {
    const resolved = path.resolve(vault.root_path || '');
    if (resolved && resolved !== vault.root_path) {
      if (!vaultRootTaken(db, resolved, vault.id)) {
        updateRoot.run(resolved, vault.id);
      }
    }
  }

  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS vaults_root_path_uidx ON vaults(root_path)');
  } catch (err) {
    console.error('[vault-isolation] unique root_path index failed (collisions remain):', err);
  }

  return { rehomed };
}

export function createVault(db: Db, userId: number, opts: { name: string; root_path?: string }): Vault {
  const id = crypto.randomUUID();
  const name = String(opts.name || 'My Vault').trim() || 'My Vault';
  // Intentionally ignore opts.root_path from untrusted clients.
  const rootPath = uniqueVaultRootPath(userId, id, name);

  if (vaultRootTaken(db, rootPath)) {
    throw new Error('Vault storage path is already in use');
  }

  fs.mkdirSync(rootPath, { recursive: true });

  db.prepare(
    'INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)'
  ).run(id, name, rootPath, userId);

  try {
    db.prepare(`
      INSERT INTO vault_members (vault_id, user_id, role, invited_by)
      VALUES (?, ?, 'owner', ?)
      ON CONFLICT(vault_id, user_id) DO UPDATE SET role = 'owner'
    `).run(id, userId, userId);
  } catch {
    // Schema may not exist yet during early migrations; ensureVaultMembersSchema backfills.
  }

  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(id) as Vault;

  try {
    // Only seed walkthrough into an empty directory — never rescrape a foreign tree.
    const existing = fs.readdirSync(rootPath).filter((entry) => entry !== '.DS_Store');
    if (existing.length === 0) {
      prepopulateWalkthrough(vault);
    }
    rescanVault(db, vault.id, userId);
  } catch (err) {
    console.error('Failed to prepopulate vault walkthrough:', err);
  }

  return vault;
}

// ── Folders ────────────────────────────────────────────────────────

export function listFolders(db: Db, vaultId: string): Folder[] {
  return db.prepare('SELECT * FROM folders WHERE vault_id = ? ORDER BY position ASC, name ASC').all(vaultId) as Folder[];
}

export function createFolder(db: Db, vaultId: string, opts: { name: string; parent_id?: string }): Folder {
  const id = crypto.randomUUID();
  const name = sanitizePathSegment(String(opts.name || 'New Folder').trim() || 'New Folder');
  const parentId = opts.parent_id || null;

  // Calculate next position
  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM folders WHERE vault_id = ? AND parent_id IS ?'
  ).get(vaultId, parentId) as { next: number };

  db.prepare(
    'INSERT INTO folders (id, vault_id, parent_id, name, position) VALUES (?, ?, ?, ?, ?)'
  ).run(id, vaultId, parentId, name, maxPos.next);

  // Create directory on disk
  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId) as Vault;
  if (vault) {
    const folderPath = getFolderPath(vault, db, id);
    fs.mkdirSync(folderPath, { recursive: true });
  }

  return db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Folder;
}

function isDescendantFolder(db: Db, folderId: string, possibleDescendantId: string): boolean {
  let current = db.prepare('SELECT id, parent_id FROM folders WHERE id = ?').get(possibleDescendantId) as {
    id: string;
    parent_id: string | null;
  } | undefined;

  while (current?.parent_id) {
    if (current.parent_id === folderId) return true;
    current = db.prepare('SELECT id, parent_id FROM folders WHERE id = ?').get(current.parent_id) as typeof current;
  }

  return false;
}

export function updateFolder(db: Db, folderId: string, opts: { name?: string; parent_id?: string | null; position?: number }): Folder {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Folder | undefined;
  if (!folder) throw new Error('Folder not found');

  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(folder.vault_id) as Vault;
  const oldPath = getFolderPath(vault, db, folderId);

  const name = opts.name !== undefined
    ? sanitizePathSegment(String(opts.name).trim() || folder.name)
    : folder.name;
  const parentId = opts.parent_id !== undefined ? opts.parent_id : folder.parent_id;
  const requestedPosition = opts.position !== undefined && Number.isFinite(opts.position)
    ? Math.max(0, Math.trunc(opts.position))
    : undefined;
  const position = requestedPosition ?? folder.position;

  if (parentId) {
    if (parentId === folderId) throw new Error('Cannot move a folder into itself');
    const parent = db.prepare('SELECT * FROM folders WHERE id = ?').get(parentId) as Folder | undefined;
    if (!parent || parent.vault_id !== folder.vault_id) throw new Error('Parent folder not found');
    if (isDescendantFolder(db, folderId, parentId)) throw new Error('Cannot move a folder into its own subfolder');
  }

  db.prepare(
    'UPDATE folders SET name = ?, parent_id = ?, position = ? WHERE id = ?'
  ).run(name, parentId, position, folderId);

  // Positions are dense within each parent. This makes repeated same-parent
  // moves deterministic and prevents duplicate positions from falling back to
  // alphabetical order after a reload.
  if (parentId !== folder.parent_id || requestedPosition !== undefined) {
    const targetIds = (db.prepare(`
      SELECT id FROM folders
      WHERE vault_id = ? AND parent_id IS ? AND id != ?
      ORDER BY position ASC, name ASC, id ASC
    `).all(folder.vault_id, parentId, folderId) as Array<{ id: string }>).map((row) => row.id);
    const insertAt = requestedPosition === undefined
      ? targetIds.length
      : Math.min(requestedPosition, targetIds.length);
    targetIds.splice(insertAt, 0, folderId);

    const updatePosition = db.prepare('UPDATE folders SET position = ? WHERE id = ?');
    const resequence = db.transaction((ids: string[]) => {
      ids.forEach((id, index) => updatePosition.run(index, id));
    });
    resequence(targetIds);

    if (folder.parent_id !== parentId) {
      const sourceIds = (db.prepare(`
        SELECT id FROM folders
        WHERE vault_id = ? AND parent_id IS ?
        ORDER BY position ASC, name ASC, id ASC
      `).all(folder.vault_id, folder.parent_id) as Array<{ id: string }>).map((row) => row.id);
      resequence(sourceIds);
    }
  }

  // Rename directory on disk if path changed
  const newPath = getFolderPath(vault, db, folderId);
  if (oldPath !== newPath && fs.existsSync(oldPath)) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
  }

  return db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Folder;
}

export function deleteFolder(db: Db, folderId: string): void {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Folder | undefined;
  if (!folder) throw new Error('Folder not found');

  // Move notes in this folder to parent folder (or root)
  db.prepare('UPDATE notes SET folder_id = ? WHERE folder_id = ?').run(folder.parent_id, folderId);

  // Move child folders to parent
  db.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ?').run(folder.parent_id, folderId);

  // Delete the folder record
  db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);

  // Optionally remove the directory on disk (only if empty)
  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(folder.vault_id) as Vault;
  if (vault) {
    const folderPath = getFolderPath(vault, db, folderId);
    try {
      if (fs.existsSync(folderPath)) {
        const entries = fs.readdirSync(folderPath);
        if (entries.length === 0) fs.rmdirSync(folderPath);
      }
    } catch {
      // Ignore cleanup failures
    }
  }
}

// ── Notes ──────────────────────────────────────────────────────────

export function listNotes(db: Db, vaultId: string, opts?: { folder_id?: string; is_archived?: boolean; tag?: string; title?: string; title_contains?: string }): NoteSummary[] {
  let sql = `
    SELECT n.id, n.vault_id, n.folder_id, n.title, n.content_preview,
           n.is_pinned, n.is_archived, n.is_listed, n.position, n.word_count, n.created_at, n.updated_at
    FROM notes n
    WHERE n.vault_id = ?
  `;
  const params: unknown[] = [vaultId];

  if (opts?.folder_id !== undefined) {
    if (opts.folder_id === '') {
      sql += ' AND n.folder_id IS NULL';
    } else {
      sql += ' AND n.folder_id = ?';
      params.push(opts.folder_id);
    }
  }

  if (opts?.is_archived !== undefined) {
    sql += ' AND n.is_archived = ?';
    params.push(opts.is_archived ? 1 : 0);
  }

  if (opts?.tag) {
    sql += ` AND EXISTS (
      SELECT 1 FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id
      WHERE nt.note_id = n.id AND t.name = ? COLLATE NOCASE
    )`;
    params.push(opts.tag);
  }

  // Title lookups let callers resolve a note by name without listing the vault.
  if (opts?.title !== undefined) {
    sql += ' AND n.title = ? COLLATE NOCASE';
    params.push(opts.title);
  }

  if (opts?.title_contains) {
    sql += " AND n.title LIKE ? ESCAPE '\\' COLLATE NOCASE";
    params.push(`%${opts.title_contains.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }

  sql += ' ORDER BY n.is_pinned DESC, n.updated_at DESC';

  const rows = db.prepare(sql).all(...params) as Omit<NoteSummary, 'tags'>[];
  return rows.map((row) => ({
    ...row,
    tags: getTagsForNote(db, row.id),
  }));
}

export function getNote(db: Db, noteId: string): Note | undefined {
  const row = db.prepare(`
    SELECT id, vault_id, folder_id, title, content_preview,
           is_pinned, is_archived, is_listed, position, word_count, created_at, updated_at
    FROM notes WHERE id = ?
  `).get(noteId) as Omit<NoteSummary, 'tags'> | undefined;
  if (!row) return undefined;

  const filePath = resolveNotePath(db, noteId);
  if (!filePath) return undefined;

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Fall back to DB content if file is missing
    const dbRow = db.prepare('SELECT content FROM notes WHERE id = ?').get(noteId) as { content: string } | undefined;
    content = dbRow?.content || '';
  }

  return {
    ...row,
    tags: getTagsForNote(db, noteId),
    content,
    file_path: filePath,
  };
}

export function createNote(db: Db, vaultId: string, userId: number, opts: { id?: string; title?: string; content?: string; folder_id?: string; is_listed?: boolean }): Note {
  // Accept a client-supplied id so the app can mint a note's real id up front,
  // keep it local-only while empty, and persist under the same id on first
  // save — no tab/layout remapping. Only honor a well-formed, unused UUID.
  const providedId = typeof opts.id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.id)
    && !db.prepare('SELECT 1 FROM notes WHERE id = ?').get(opts.id)
    ? opts.id
    : null;
  const id = providedId ?? crypto.randomUUID();
  const title = String(opts.title || 'Untitled').trim() || 'Untitled';
  const rawContent = String(opts.content || '');
  const content = rawContent.replace(/\\+`/g, '`');
  const folderId = opts.folder_id || null;
  const isListed = opts.is_listed === false ? 0 : 1;
  const nextPosition = isListed
    ? (db.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS next
        FROM notes WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1
      `).get(vaultId, folderId) as { next: number }).next
    : 0;
  const preview = makePreview(content);
  const wc = wordCount(content);

  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId) as Vault;
  if (!vault) throw new Error('Vault not found');

  // Determine file path (always confined under vault.root_path).
  let filePath: string;
  if (!isListed) {
    const unlistedPath = resolveUnderVault(vault.root_path, '.cascade-unlisted');
    fs.mkdirSync(unlistedPath, { recursive: true });
    filePath = resolveUnderVault(unlistedPath, `${sanitizePathSegment(title)}.md`);
  } else if (folderId) {
    const folderPath = getFolderPath(vault, db, folderId);
    fs.mkdirSync(folderPath, { recursive: true });
    filePath = resolveUnderVault(folderPath, `${sanitizePathSegment(title)}.md`);
  } else {
    fs.mkdirSync(vault.root_path, { recursive: true });
    filePath = resolveUnderVault(vault.root_path, `${sanitizePathSegment(title)}.md`);
  }

  // Write .md file to disk
  fs.writeFileSync(filePath, content, 'utf8');

  // Insert DB row
  db.prepare(`
    INSERT INTO notes (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, is_listed, position, word_count, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
  `).run(id, vaultId, folderId, title, content, preview, isListed, nextPosition, wc, userId);

  // Index links
  reIndexLinks(db, id, vaultId, content);

  return getNote(db, id)!;
}

export function updateNote(db: Db, noteId: string, content: string): Note {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as {
    id: string; vault_id: string; folder_id: string | null; title: string;
  } | undefined;
  if (!existing) throw new Error('Note not found');

  const normalized = content.replace(/\\+`/g, '`');
  const preview = makePreview(normalized);
  const wc = wordCount(normalized);

  // Write to .md file
  const filePath = resolveNotePath(db, noteId);
  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, normalized, 'utf8');
  }

  // Update DB
  db.prepare(`
    UPDATE notes SET content = ?, content_preview = ?, word_count = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(normalized, preview, wc, noteId);

  // Re-index links
  reIndexLinks(db, noteId, existing.vault_id, normalized);

  return getNote(db, noteId)!;
}

// Update [[Old Title]] / [[Old Title|alias]] / [[Old Title#heading]] references
// across the vault to point at the new title (Obsidian-style link maintenance).
function updateWikilinkTargets(db: Db, vaultId: string, oldTitle: string, newTitle: string): void {
  const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\[\\[)${escaped}(?=[\\]|#])`, 'gi');
  const notes = db.prepare('SELECT id, content FROM notes WHERE vault_id = ?').all(vaultId) as { id: string; content: string }[];
  for (const n of notes) {
    if (!n.content.includes('[[')) continue;
    const updated = n.content.replace(re, `$1${newTitle}`);
    if (updated !== n.content) updateNote(db, n.id, updated);
  }
}

export function renameNote(db: Db, noteId: string, newTitleRaw: string): Note {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as {
    id: string; vault_id: string; title: string;
  } | undefined;
  if (!existing) throw new Error('Note not found');

  const newTitle = String(newTitleRaw).trim();
  if (!newTitle) throw new Error('Title cannot be empty');
  if (newTitle === existing.title) return getNote(db, noteId)!;

  // Filesystem-like rule: no two notes in a vault may share a title.
  const dupe = db.prepare(
    'SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE AND id != ?'
  ).get(existing.vault_id, newTitle, noteId) as { id: string } | undefined;
  if (dupe) throw new Error('A note with that title already exists');

  const oldPath = resolveNotePath(db, noteId);
  const oldTitle = existing.title;

  // Update the title first so resolveNotePath computes the new filename.
  db.prepare("UPDATE notes SET title = ?, updated_at = datetime('now') WHERE id = ?").run(newTitle, noteId);

  const newPath = resolveNotePath(db, noteId);
  if (oldPath && newPath && oldPath !== newPath) {
    try {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
    } catch {
      // Keep the DB rename even if the on-disk move fails.
    }
  }

  updateWikilinkTargets(db, existing.vault_id, oldTitle, newTitle);

  return getNote(db, noteId)!;
}

export function deleteNote(db: Db, noteId: string): void {
  // Chat tables use ON DELETE CASCADE, but pre-cleaning avoids sporadic 500s when
  // FTS triggers + shared channel links interact on channel note deletion.
  db.prepare('DELETE FROM chat_agent_members WHERE channel_id = ?').run(noteId);
  db.prepare('DELETE FROM chat_messages WHERE channel_id = ?').run(noteId);
  db.prepare('DELETE FROM chat_channel_links WHERE local_channel_id = ? OR source_channel_id = ?').run(noteId, noteId);

  // Remove .md file from disk
  const filePath = resolveNotePath(db, noteId);
  if (filePath) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Ignore file deletion failures
    }
  }

  db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
}

export function moveNote(db: Db, noteId: string, folderId: string | null, requestedPosition?: number): void {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as {
    id: string; vault_id: string; folder_id: string | null; title: string; is_listed: number;
  } | undefined;
  if (!note) throw new Error('Note not found');

  if (folderId) {
    const folder = db.prepare('SELECT vault_id FROM folders WHERE id = ?').get(folderId) as { vault_id: string } | undefined;
    if (!folder || folder.vault_id !== note.vault_id) throw new Error('Folder not found');
  }

  const oldPath = resolveNotePath(db, noteId);

  // A move into the visible tree is also the explicit "list this note" action.
  const targetIds = (db.prepare(`
    SELECT id FROM notes
    WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1 AND id != ?
    ORDER BY position ASC, updated_at DESC, id ASC
  `).all(note.vault_id, folderId, noteId) as Array<{ id: string }>).map((row) => row.id);
  const position = requestedPosition === undefined || !Number.isFinite(requestedPosition)
    ? (note.is_listed && note.folder_id === folderId
        ? Math.min((db.prepare('SELECT position FROM notes WHERE id = ?').get(noteId) as { position: number }).position, targetIds.length)
        : targetIds.length)
    : Math.max(0, Math.min(Math.trunc(requestedPosition), targetIds.length));
  targetIds.splice(position, 0, noteId);

  const updatePosition = db.prepare('UPDATE notes SET position = ? WHERE id = ?');
  const resequence = db.transaction((ids: string[]) => {
    ids.forEach((id, index) => updatePosition.run(index, id));
  });

  db.prepare(`
    UPDATE notes
    SET folder_id = ?, is_listed = 1, position = ?,
        updated_at = CASE WHEN folder_id IS NOT ? OR is_listed = 0 THEN datetime('now') ELSE updated_at END
    WHERE id = ?
  `).run(folderId, position, folderId, noteId);
  resequence(targetIds);

  if (note.is_listed && note.folder_id !== folderId) {
    const sourceIds = (db.prepare(`
      SELECT id FROM notes
      WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1
      ORDER BY position ASC, updated_at DESC, id ASC
    `).all(note.vault_id, note.folder_id) as Array<{ id: string }>).map((row) => row.id);
    resequence(sourceIds);
  }

  const newPath = resolveNotePath(db, noteId);

  // Move file on disk
  if (oldPath && newPath && oldPath !== newPath) {
    try {
      if (fs.existsSync(oldPath)) {
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.renameSync(oldPath, newPath);
      }
    } catch {
      // Ignore move failures
    }
  }
}

export function unlistNote(db: Db, noteId: string): void {
  const note = db.prepare('SELECT id FROM notes WHERE id = ?').get(noteId) as { id: string } | undefined;
  if (!note) throw new Error('Note not found');

  const oldPath = resolveNotePath(db, noteId);
  db.prepare("UPDATE notes SET folder_id = NULL, is_listed = 0, updated_at = datetime('now') WHERE id = ?").run(noteId);
  const newPath = resolveNotePath(db, noteId);

  if (oldPath && newPath && oldPath !== newPath) {
    try {
      if (fs.existsSync(oldPath)) {
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.renameSync(oldPath, newPath);
      }
    } catch {
      // Keep the database operation consistent with the existing move behavior.
    }
  }
}

export function togglePin(db: Db, noteId: string): void {
  db.prepare('UPDATE notes SET is_pinned = CASE WHEN is_pinned = 0 THEN 1 ELSE 0 END, updated_at = datetime(\'now\') WHERE id = ?').run(noteId);
}

export function toggleArchive(db: Db, noteId: string): void {
  db.prepare('UPDATE notes SET is_archived = CASE WHEN is_archived = 0 THEN 1 ELSE 0 END, updated_at = datetime(\'now\') WHERE id = ?').run(noteId);
}

// ── Search ─────────────────────────────────────────────────────────

export function searchNotes(db: Db, vaultId: string, query: string): SearchResult[] {
  if (!query.trim()) return [];

  // Use FTS5 MATCH with snippet
  const rows = db.prepare(`
    SELECT n.id, n.title, snippet(notes_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet, rank
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ? AND n.vault_id = ?
    ORDER BY rank
    LIMIT 50
  `).all(query, vaultId) as SearchResult[];

  return rows;
}

// ── Backlinks ──────────────────────────────────────────────────────

export function getBacklinks(db: Db, noteId: string): BacklinkResult[] {
  // Find notes that link to this note by ID or by title
  const note = db.prepare('SELECT id, title FROM notes WHERE id = ?').get(noteId) as { id: string; title: string } | undefined;
  if (!note) return [];

  const rows = db.prepare(`
    SELECT DISTINCT n.id, n.title, nl.context
    FROM note_links nl
    JOIN notes n ON n.id = nl.source_id
    WHERE nl.target_id = ? OR nl.target_title = ? COLLATE NOCASE
  `).all(noteId, note.title) as BacklinkResult[];

  return rows;
}

// ── Tags ───────────────────────────────────────────────────────────

export function listTags(db: Db, vaultId: string): Tag[] {
  return db.prepare(`
    SELECT t.id, t.name, t.color, COUNT(nt.note_id) AS count
    FROM tags t
    LEFT JOIN note_tags nt ON nt.tag_id = t.id
    WHERE t.vault_id = ?
    GROUP BY t.id
    ORDER BY t.name ASC
  `).all(vaultId) as Tag[];
}

export function addTag(db: Db, noteId: string, vaultId: string, name: string, color?: string): void {
  const tagName = String(name).trim().toLowerCase();
  if (!tagName) throw new Error('Tag name is required');

  // Upsert the tag
  let tag = db.prepare('SELECT id FROM tags WHERE vault_id = ? AND name = ?').get(vaultId, tagName) as { id: string } | undefined;
  if (!tag) {
    const tagId = crypto.randomUUID();
    db.prepare('INSERT INTO tags (id, vault_id, name, color) VALUES (?, ?, ?, ?)').run(tagId, vaultId, tagName, color || null);
    tag = { id: tagId };
  } else if (color) {
    db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color, tag.id);
  }

  // Link tag to note
  db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tag.id);
}

export function removeTag(db: Db, noteId: string, tagId: string): void {
  db.prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?').run(noteId, tagId);

  // Clean up orphan tags (no notes using them)
  const count = db.prepare('SELECT COUNT(*) AS c FROM note_tags WHERE tag_id = ?').get(tagId) as { c: number };
  if (count.c === 0) {
    db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
  }
}

// ── Graph ──────────────────────────────────────────────────────────

export function getGraph(db: Db, vaultId: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = db.prepare(`
    SELECT id, title, folder_id FROM notes WHERE vault_id = ?
  `).all(vaultId) as GraphNode[];

  const edges = db.prepare(`
    SELECT nl.source_id AS source, nl.target_id AS target
    FROM note_links nl
    JOIN notes n ON n.id = nl.source_id
    WHERE n.vault_id = ? AND nl.target_id IS NOT NULL
  `).all(vaultId) as GraphEdge[];

  return { nodes, edges };
}

// ── Directory scan & sync helpers ──────────────────────────────────

function scanDirRecursive(dirPath: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dirPath)) return results;
  try {
    const list = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of list) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        results = results.concat(scanDirRecursive(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    console.error('Error scanning directory:', err);
  }
  return results;
}

export function rescanVault(db: Db, vaultId: string, userId: number): void {
  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId) as Vault | undefined;
  if (!vault) return;

  // Hard boundary: never index a directory claimed by another vault row.
  if (vaultRootTaken(db, vault.root_path, vault.id)) {
    console.error(
      `[vault-isolation] refusing rescan for vault ${vaultId}: root_path shared with another vault (${vault.root_path})`,
    );
    return;
  }

  const filesOnDisk = scanDirRecursive(vault.root_path);

  // 1. Delete notes in DB that no longer exist on disk
  const existingNotes = db.prepare('SELECT id, title FROM notes WHERE vault_id = ?').all(vaultId) as { id: string; title: string }[];
  for (const note of existingNotes) {
    const filePath = resolveNotePath(db, note.id);
    if (!filePath || !fs.existsSync(filePath)) {
      db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
    }
  }

  // 2. Add or update notes from disk
  for (const filePath of filesOnDisk) {
    const resolvedPath = path.resolve(filePath);
    const relPath = path.relative(vault.root_path, resolvedPath);
    const pathParts = relPath.split(path.sep);

    let folderId: string | null = null;
    let currentParentId: string | null = null;

    // Create folders in DB if they do not exist
    if (pathParts.length > 1) {
      for (let i = 0; i < pathParts.length - 1; i++) {
        const folderName = pathParts[i];
        let folder = db.prepare(
          'SELECT id FROM folders WHERE vault_id = ? AND parent_id IS ? AND name = ?'
        ).get(vaultId, currentParentId, folderName) as { id: string } | undefined;

        if (!folder) {
          const newId = crypto.randomUUID();
          db.prepare(
            'INSERT INTO folders (id, vault_id, parent_id, name, position) VALUES (?, ?, ?, ?, 0)'
          ).run(newId, vaultId, currentParentId, folderName);
          folder = { id: newId };
        }
        currentParentId = folder.id;
      }
      folderId = currentParentId;
    }

    const filename = pathParts[pathParts.length - 1];
    const title = filename.endsWith('.md') ? filename.slice(0, -3) : filename;

    // Check if note exists in DB
    const note = db.prepare(
      'SELECT id, content FROM notes WHERE vault_id = ? AND title = ? AND (folder_id IS ? OR folder_id = ?)'
    ).get(vaultId, title, folderId, folderId) as { id: string; content: string } | undefined;

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const preview = makePreview(content);
    const wc = wordCount(content);

    if (note) {
      if (note.content !== content) {
        db.prepare(`
          UPDATE notes SET content = ?, content_preview = ?, word_count = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(content, preview, wc, note.id);
        reIndexLinks(db, note.id, vaultId, content);
      }
    } else {
      const noteId = crypto.randomUUID();
      const nextPosition = (db.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS next
        FROM notes WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1
      `).get(vaultId, folderId) as { next: number }).next;
      db.prepare(`
        INSERT INTO notes (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, position, word_count, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
      `).run(noteId, vaultId, folderId, title, content, preview, nextPosition, wc, userId);
      reIndexLinks(db, noteId, vaultId, content);
    }
  }
}
