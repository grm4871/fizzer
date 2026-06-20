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

function stripMarkdown(content: string): string {
  return content
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
    // A wikilink may carry an alias ([[Target|shown text]]) and/or a heading
    // anchor ([[Target#Section]]); the link target is just the leading portion.
    let title = match[1].split('|')[0].split('#')[0].trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles;
}


function getFolderPath(vault: Vault, db: Db, folderId: string): string {
  const parts: string[] = [];
  let current: { id: string; parent_id: string | null; name: string } | undefined =
    db.prepare('SELECT id, parent_id, name FROM folders WHERE id = ?').get(folderId) as typeof current;

  while (current) {
    parts.unshift(current.name);
    if (current.parent_id) {
      current = db.prepare('SELECT id, parent_id, name FROM folders WHERE id = ?').get(current.parent_id) as typeof current;
    } else {
      break;
    }
  }

  return path.join(vault.root_path, ...parts);
}


function resolveNotePath(db: Db, noteId: string): string | undefined {
  const note = db.prepare('SELECT id, vault_id, folder_id, title FROM notes WHERE id = ?').get(noteId) as {
    id: string; vault_id: string; folder_id: string | null; title: string;
  } | undefined;
  if (!note) return undefined;

  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(note.vault_id) as Vault | undefined;
  if (!vault) return undefined;

  if (note.folder_id) {
    const folderPath = getFolderPath(vault, db, note.folder_id);
    return path.join(folderPath, `${sanitizeFilename(note.title)}.md`);
  }
  return path.join(vault.root_path, `${sanitizeFilename(note.title)}.md`);
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

// ── Schema ─────────────────────────────────────────────────────────

export function ensureVaultSchema(_db: Db): void {
  // Schema is created in index.ts — this is a hook for future migrations
}

// ── Vaults ─────────────────────────────────────────────────────────

export function listVaults(db: Db, userId: number): Vault[] {
  return db.prepare('SELECT * FROM vaults WHERE created_by = ? ORDER BY created_at DESC').all(userId) as Vault[];
}

export function getVault(db: Db, vaultId: string, userId: number): Vault | undefined {
  return db.prepare('SELECT * FROM vaults WHERE id = ? AND created_by = ?').get(vaultId, userId) as Vault | undefined;
}

function prepopulateWalkthrough(vault: Vault): void {
  const welcomeContent = `# 💎 Welcome to Cascade Notes\n\nCascade Notes is an intelligent, Obsidian-style personal wiki designed for writing, organizing, and thinking alongside AI.\n\n## Key Features\n\n1. **Local Markdown Files**: All notes are stored as standard \`.md\` files in your vault folder: \`${vault.root_path}\`.\n2. **Rich Live Preview**: A modern CodeMirror 6 editor renders headers, bold/italic, checkboxes, and wikilinks directly as you type.\n3. **Wikilinks & Backlinks**: Connect notes using wikilinks like [[Navigation & Search]]. Check the backlinks panel to explore note relationships.\n4. **Agent**: Open the agent panel and pick an agent (Claude Code, Codex, Grok, Antigravity, Copilot, or Hermes) to read, edit, and organize your notes directly on disk.\n\n## Get Started\n\n- Click the **🤖 Agent** button on the tab bar to open the agent panel, then choose your agent and tell it what to do.\n- Drop an inline directive anywhere in a note with the \`{{ai: your instruction}}\` syntax, then put your cursor on it and press \`Ctrl+Enter\` (\`Cmd+Enter\` on macOS) to run it in the agent panel. Try it: {{ai: write a one-line welcome message at the top of this note}}\n- Check the boxes below to try out interactive checklists:\n  - [ ] Edit this note and change this checkbox\n  - [ ] Click on the checkbox widget directly to toggle it!\n  - [x] Press \`Ctrl+P\` to open the command palette\n`;

  const navContent = `# 🔍 Navigation & Search\n\nCascade Notes is built for speed and keyboard-driven navigation.\n\n## Keyboard Shortcuts\n\nHere are the key shortcuts to keep your hands on the keyboard:\n\n- \`Ctrl+P\` (or \`Cmd+P\`): Open the **Command Palette**. Search through note titles fuzzy-style, or press Enter on a non-existent name to create a new note instantly.\n- \`Ctrl+Shift+F\`: Open **Vault Search**. Perform ranked full-text search across all note contents using SQLite FTS5.\n- \`Ctrl+S\`: Save the current note.\n- \`Ctrl+N\`: Create a new note.\n- \`Ctrl+\\\`: Toggle the sidebar.\n\n## Organizing with Tags\n\nYou can add tags to notes (e.g., #tutorial, #reference) or add them via the tag manager in the sidebar. Tags help you filter notes in search and group them in the folder tree.\n`;

  fs.writeFileSync(path.join(vault.root_path, 'Welcome to Cascade Notes.md'), welcomeContent, 'utf8');
  fs.writeFileSync(path.join(vault.root_path, 'Navigation & Search.md'), navContent, 'utf8');
}

export function createVault(db: Db, userId: number, opts: { name: string; root_path?: string }): Vault {
  const id = crypto.randomUUID();
  const name = String(opts.name || 'My Vault').trim() || 'My Vault';
  const rootPath = path.resolve(String(opts.root_path || path.join(VAULTS_BASE_DIR, sanitizeFilename(name))));

  fs.mkdirSync(rootPath, { recursive: true });

  db.prepare(
    'INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)'
  ).run(id, name, rootPath, userId);

  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(id) as Vault;

  try {
    prepopulateWalkthrough(vault);
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
  const name = String(opts.name || 'New Folder').trim() || 'New Folder';
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

  const name = opts.name !== undefined ? String(opts.name).trim() || folder.name : folder.name;
  const parentId = opts.parent_id !== undefined ? opts.parent_id : folder.parent_id;
  const position = opts.position !== undefined ? opts.position : folder.position;

  if (parentId) {
    if (parentId === folderId) throw new Error('Cannot move a folder into itself');
    const parent = db.prepare('SELECT * FROM folders WHERE id = ?').get(parentId) as Folder | undefined;
    if (!parent || parent.vault_id !== folder.vault_id) throw new Error('Parent folder not found');
    if (isDescendantFolder(db, folderId, parentId)) throw new Error('Cannot move a folder into its own subfolder');
  }

  db.prepare(
    'UPDATE folders SET name = ?, parent_id = ?, position = ? WHERE id = ?'
  ).run(name, parentId, position, folderId);

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

export function listNotes(db: Db, vaultId: string, opts?: { folder_id?: string; is_archived?: boolean; tag?: string }): NoteSummary[] {
  let sql = `
    SELECT n.id, n.vault_id, n.folder_id, n.title, n.content_preview,
           n.is_pinned, n.is_archived, n.word_count, n.created_at, n.updated_at
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
           is_pinned, is_archived, word_count, created_at, updated_at
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

export function createNote(db: Db, vaultId: string, userId: number, opts: { title?: string; content?: string; folder_id?: string }): Note {
  const id = crypto.randomUUID();
  const title = String(opts.title || 'Untitled').trim() || 'Untitled';
  const content = String(opts.content || '');
  const folderId = opts.folder_id || null;
  const preview = makePreview(content);
  const wc = wordCount(content);

  const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId) as Vault;
  if (!vault) throw new Error('Vault not found');

  // Determine file path
  let filePath: string;
  if (folderId) {
    const folderPath = getFolderPath(vault, db, folderId);
    fs.mkdirSync(folderPath, { recursive: true });
    filePath = path.join(folderPath, `${sanitizeFilename(title)}.md`);
  } else {
    fs.mkdirSync(vault.root_path, { recursive: true });
    filePath = path.join(vault.root_path, `${sanitizeFilename(title)}.md`);
  }

  // Write .md file to disk
  fs.writeFileSync(filePath, content, 'utf8');

  // Insert DB row
  db.prepare(`
    INSERT INTO notes (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, word_count, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(id, vaultId, folderId, title, content, preview, wc, userId);

  // Index links
  reIndexLinks(db, id, vaultId, content);

  return getNote(db, id)!;
}

export function updateNote(db: Db, noteId: string, content: string): Note {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as {
    id: string; vault_id: string; folder_id: string | null; title: string;
  } | undefined;
  if (!existing) throw new Error('Note not found');

  const preview = makePreview(content);
  const wc = wordCount(content);

  // Write to .md file
  const filePath = resolveNotePath(db, noteId);
  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  // Update DB
  db.prepare(`
    UPDATE notes SET content = ?, content_preview = ?, word_count = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(content, preview, wc, noteId);

  // Re-index links
  reIndexLinks(db, noteId, existing.vault_id, content);

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

export function moveNote(db: Db, noteId: string, folderId: string | null): void {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as {
    id: string; vault_id: string; folder_id: string | null; title: string;
  } | undefined;
  if (!note) throw new Error('Note not found');

  const oldPath = resolveNotePath(db, noteId);

  db.prepare('UPDATE notes SET folder_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(folderId, noteId);

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

export function togglePin(db: Db, noteId: string): void {
  db.prepare('UPDATE notes SET is_pinned = CASE WHEN is_pinned = 0 THEN 1 ELSE 0 END, updated_at = datetime(\'now\') WHERE id = ?').run(noteId);
}

export function toggleArchive(db: Db, noteId: string): void {
  db.prepare('UPDATE notes SET is_archived = CASE WHEN is_archived = 0 THEN 1 ELSE 0 END, updated_at = datetime(\'now\') WHERE id = ?').run(noteId);
}

// ── Fuzzy term resolution & on-the-fly note creation ───────────────

function normalizeTerm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')    // drop punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Rough singular form so "cascades" matches "cascade" during token overlap.
function singularize(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function tokenSet(s: string): Set<string> {
  return new Set(normalizeTerm(s).split(' ').filter(Boolean).map(singularize));
}

// Levenshtein edit distance (two-row variant). Titles are short, so this is cheap.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// 0..1 similarity blending whole-string edit distance with token overlap, so
// both "Cascadr" ≈ "Cascade" (typo) and "the cascade effect" ≈ "Cascade Effect"
// (reordering / stop words) score highly.
export function termSimilarity(a: string, b: string): number {
  const na = normalizeTerm(a);
  const nb = normalizeTerm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const maxLen = Math.max(na.length, nb.length);
  const editScore = maxLen === 0 ? 0 : 1 - editDistance(na, nb) / maxLen;

  const setA = tokenSet(a);
  const setB = tokenSet(b);
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union === 0 ? 0 : shared / union;

  return Math.max(editScore, jaccard);
}

const FUZZY_MATCH_THRESHOLD = 0.7;

// Find the existing note whose title best matches `term` above the confidence
// threshold. Returns undefined when nothing is close enough, so the caller
// creates a fresh note instead of merging into an unrelated one.
export function fuzzyFindNote(
  db: Db,
  vaultId: string,
  term: string,
): { id: string; title: string; score: number } | undefined {
  const rows = db.prepare('SELECT id, title FROM notes WHERE vault_id = ?').all(vaultId) as { id: string; title: string }[];
  let best: { id: string; title: string; score: number } | undefined;
  for (const row of rows) {
    const score = termSimilarity(term, row.title);
    if (score >= FUZZY_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { id: row.id, title: row.title, score };
    }
  }
  return best;
}

export type LinkifyResult = { note: Note; matched: boolean; score: number };

/**
 * Resolve a selected term to the note it should link to. If a sufficiently
 * similar note already exists, return it (so the caller can update it and alias
 * the link); otherwise create a minimal placeholder note titled exactly `term`
 * so the wikilink is immediately valid. The actual prose and folder placement
 * are left to the agent, which fills the note in afterwards.
 */
export function linkifyTerm(
  db: Db,
  vaultId: string,
  userId: number,
  opts: { term: string },
): LinkifyResult {
  const term = String(opts.term || '').trim();
  if (!term) throw new Error('Term is required');

  const existing = fuzzyFindNote(db, vaultId, term);
  if (existing) {
    const current = getNote(db, existing.id);
    if (!current) throw new Error('Matched note could not be loaded');
    return { note: current, matched: true, score: existing.score };
  }

  // Minimal stub — just the title. The agent writes the body and files it.
  const note = createNote(db, vaultId, userId, { title: term, content: `# ${term}\n` });
  return { note, matched: false, score: 0 };
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
      db.prepare(`
        INSERT INTO notes (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, word_count, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      `).run(noteId, vaultId, folderId, title, content, preview, wc, userId);
      reIndexLinks(db, noteId, vaultId, content);
    }
  }
}
