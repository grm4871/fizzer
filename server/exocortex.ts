/**
 * @file exocortex.ts - Vault-scoped memory and recall helpers.
 *
 * Memories are plain markdown notes in an `Exocortex/` folder. This module
 * owns the conventions around frontmatter, recall ranking, and prompt context.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  createFolder,
  createNote,
  getNote,
  getVault,
  type Folder,
  type Note,
} from './vault.js';
import { createNoteVersion } from './versions.js';

type Db = Database.Database;

export type MemoryType = 'fact' | 'decision' | 'preference' | 'reference';
export type RecallKind = 'memory' | 'note' | 'chat';

export type RecallHit = {
  kind: RecallKind;
  id: string;
  title: string;
  snippet: string;
  score: number;
  provenance: {
    vaultId: string;
    noteId?: string;
    channelId?: string;
    messageId?: string;
    source?: string;
    scope?: string;
    createdBy?: string;
  };
};

export type MemoryInput = {
  body: string;
  type?: MemoryType;
  scope?: string;
  source?: string;
  title?: string;
  createdBy?: string;
};

type Frontmatter = {
  type?: string;
  scope?: string;
  source?: string;
  created_by?: string;
};

const EXOCORTEX_FOLDER = 'Exocortex';
const VALID_TYPES = new Set<MemoryType>(['fact', 'decision', 'preference', 'reference']);

function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .toLowerCase()
    .match(/[a-z0-9_@#./:-]{2,}/g)
    ?.slice(0, 16) ?? [];
  return Array.from(new Set(terms)).map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

function stripMarks(value: string): string {
  return String(value || '').replace(/<\/?mark>/g, '');
}

function truncate(value: string, limit = 900): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}

function parseFrontmatter(content: string): { data: Frontmatter; body: string } {
  if (!content.startsWith('---\n')) return { data: {}, body: content };
  const end = content.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: content };
  const raw = content.slice(4, end);
  const data: Frontmatter = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1] as keyof Frontmatter;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'type' || key === 'scope' || key === 'source' || key === 'created_by') {
      data[key] = value;
    }
  }
  return { data, body: content.slice(end + 4).replace(/^\n+/, '') };
}

function frontmatter(input: Required<Pick<MemoryInput, 'type' | 'scope' | 'body'>> & Pick<MemoryInput, 'source' | 'createdBy'>): string {
  const lines = [
    '---',
    `type: ${input.type}`,
    `scope: ${input.scope}`,
    ...(input.source ? [`source: ${input.source}`] : []),
    ...(input.createdBy ? [`created_by: ${input.createdBy}`] : []),
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
    input.body.trim(),
    '',
  ];
  return lines.join('\n');
}

function getOrCreateExocortexFolder(db: Db, vaultId: string): Folder {
  const existing = db.prepare(`
    SELECT *
    FROM folders
    WHERE vault_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
  `).get(vaultId, EXOCORTEX_FOLDER) as Folder | undefined;
  if (existing) return existing;
  return createFolder(db, vaultId, { name: EXOCORTEX_FOLDER });
}

function uniqueMemoryTitle(db: Db, vaultId: string, requested?: string): string {
  const base = truncate(requested || 'Memory', 80).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Memory';
  let title = base;
  for (let i = 2; i < 50; i++) {
    const dupe = db.prepare('SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE').get(vaultId, title);
    if (!dupe) return title;
    title = `${base} ${i}`;
  }
  return `${base} ${crypto.randomUUID().slice(0, 8)}`;
}

function defaultTitle(body: string, type: MemoryType): string {
  const firstLine = body.split('\n').map((line) => line.trim()).find(Boolean) || type;
  return `${type[0].toUpperCase()}${type.slice(1)} - ${truncate(firstLine, 64)}`;
}

function scopeAllowed(scope: string | undefined, channelId?: string): boolean {
  if (!scope || scope === 'vault' || scope === 'global') return true;
  return Boolean(channelId && scope === `channel:${channelId}`);
}

function parseSources(rows: Array<{ content: string }>): Set<string> {
  const sources = new Set<string>();
  for (const row of rows) {
    const { data } = parseFrontmatter(row.content);
    if (data.source) sources.add(data.source);
  }
  return sources;
}

export function createMemoryNote(db: Db, userId: number, vaultId: string, input: MemoryInput): Note {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const body = String(input.body || '').trim();
  if (!body) throw new Error('Memory body is required');
  const type = VALID_TYPES.has(input.type as MemoryType) ? (input.type as MemoryType) : 'fact';
  const scope = String(input.scope || 'vault').trim() || 'vault';
  const folder = getOrCreateExocortexFolder(db, vault.id);
  const title = uniqueMemoryTitle(db, vault.id, input.title || defaultTitle(body, type));
  const note = createNote(db, vault.id, userId, {
    title,
    folder_id: folder.id,
    content: frontmatter({
      body,
      type,
      scope,
      source: input.source,
      createdBy: input.createdBy,
    }),
  });
  createNoteVersion(db, note.id, note.content, 'memory');
  return note;
}

export function recallExocortex(
  db: Db,
  userId: number,
  vaultId: string,
  rawQuery: string,
  opts: { channelId?: string; limit?: number } = {},
): RecallHit[] {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const query = sanitizeFtsQuery(rawQuery);
  if (!query) return [];
  const limit = Math.max(1, Math.min(Number(opts.limit || 8), 20));
  const channelId = opts.channelId;

  const folder = db.prepare(`
    SELECT id
    FROM folders
    WHERE vault_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
  `).get(vault.id, EXOCORTEX_FOLDER) as { id: string } | undefined;

  const memoryRows = folder ? db.prepare(`
    SELECT n.id, n.title, n.content, snippet(notes_fts, 1, '<mark>', '</mark>', '...', 36) AS snippet, rank
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ? AND n.vault_id = ? AND n.folder_id = ?
    ORDER BY rank
    LIMIT ?
  `).all(query, vault.id, folder.id, limit * 2) as Array<{ id: string; title: string; content: string; snippet: string; rank: number }> : [];

  const citedSources = parseSources(memoryRows);
  const hits: RecallHit[] = [];
  for (const row of memoryRows) {
    const { data, body } = parseFrontmatter(row.content);
    if (!scopeAllowed(data.scope, channelId)) continue;
    hits.push({
      kind: 'memory',
      id: row.id,
      title: row.title,
      snippet: row.snippet || truncate(body, 240),
      score: 1000 - Math.abs(row.rank || 0),
      provenance: {
        vaultId: vault.id,
        noteId: row.id,
        source: data.source,
        scope: data.scope,
        createdBy: data.created_by,
      },
    });
  }

  const noteRows = db.prepare(`
    SELECT n.id, n.title, snippet(notes_fts, 1, '<mark>', '</mark>', '...', 36) AS snippet, rank
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ? AND n.vault_id = ? AND (? IS NULL OR n.folder_id IS NULL OR n.folder_id != ?)
    ORDER BY rank
    LIMIT ?
  `).all(query, vault.id, folder?.id ?? null, folder?.id ?? null, limit * 2) as Array<{ id: string; title: string; snippet: string; rank: number }>;

  for (const row of noteRows) {
    hits.push({
      kind: 'note',
      id: row.id,
      title: row.title,
      snippet: row.snippet || '',
      score: 400 - Math.abs(row.rank || 0),
      provenance: { vaultId: vault.id, noteId: row.id },
    });
  }

  const chatWhere = channelId ? 'AND cm.channel_id = ?' : '';
  const chatParams = channelId
    ? [query, vault.id, channelId, limit * 2]
    : [query, vault.id, limit * 2];
  const chatRows = db.prepare(`
    SELECT cm.id, cm.channel_id AS channelId, cm.author, cm.body,
           snippet(chat_messages_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet, rank
    FROM chat_messages_fts
    JOIN chat_messages cm ON cm.rowid = chat_messages_fts.rowid
    WHERE chat_messages_fts MATCH ? AND cm.vault_id = ? ${chatWhere}
    ORDER BY rank
    LIMIT ?
  `).all(...chatParams) as Array<{ id: string; channelId: string; author: string; body: string; snippet: string; rank: number }>;

  for (const row of chatRows) {
    if (citedSources.has(row.id)) continue;
    hits.push({
      kind: 'chat',
      id: row.id,
      title: `${row.author} in chat`,
      snippet: row.snippet || truncate(row.body, 240),
      score: 100 - Math.abs(row.rank || 0),
      provenance: { vaultId: vault.id, channelId: row.channelId, messageId: row.id },
    });
  }

  const seen = new Set<string>();
  return hits
    .filter((hit) => {
      const key = `${hit.kind}:${hit.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function buildRecallContext(hits: RecallHit[], maxChars = 1800): string {
  if (hits.length === 0) return '';
  const lines: string[] = ['Exocortex recall:'];
  let used = lines[0].length;
  for (const hit of hits) {
    const source = hit.kind === 'chat'
      ? `chat:${hit.provenance.messageId}`
      : `note:${hit.title}`;
    const line = `- [${hit.kind}] ${source}: ${truncate(stripMarks(hit.snippet), 260)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

export function getMemoryNote(db: Db, userId: number, noteId: string): Note | undefined {
  const note = getNote(db, noteId);
  if (!note) return undefined;
  if (!getVault(db, note.vault_id, userId)) return undefined;
  if (!note.folder_id) return undefined;
  const folder = db.prepare('SELECT name FROM folders WHERE id = ? AND vault_id = ?').get(note.folder_id, note.vault_id) as { name: string } | undefined;
  if (folder?.name.toLowerCase() !== EXOCORTEX_FOLDER.toLowerCase()) return undefined;
  return note;
}
