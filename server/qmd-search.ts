import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { createStore, type QMDStore } from '@tobilu/qmd';
import { redactPrivateBlocks } from './privacy.js';

type Db = Database.Database;

export type QmdSearchHit = {
  type: 'note' | 'chat';
  id: string;
  title: string;
  channelId?: string;
  snippet: string;
  score: number;
  timestamp?: string;
};

type IndexedDocument = QmdSearchHit & { body: string; updatedAt: string };
type VaultIndex = { store: QMDStore; fingerprint: string; syncing?: Promise<void>; embedding?: Promise<void> };

const indexes = new Map<string, Promise<VaultIndex>>();
const QMD_ROOT = process.env.CASCADE_QMD_DIR || path.join(os.homedir(), '.cascade', 'qmd');

function safeSegment(value: string) {
  return Buffer.from(value).toString('base64url');
}

function atomicWrite(file: string, body: string) {
  try {
    if (fs.readFileSync(file, 'utf8') === body) return;
  } catch { /* missing file */ }
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, body, 'utf8');
  fs.renameSync(temp, file);
}

function syncCorpus(db: Db, vaultId: string, root: string, redactPrivate: boolean) {
  const notesDir = path.join(root, 'notes');
  const chatsDir = path.join(root, 'chats');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(chatsDir, { recursive: true });
  const docs = new Map<string, IndexedDocument>();
  const keep = new Set<string>();

  {
    const rows = db.prepare(`
      SELECT id, title, content, updated_at FROM notes
      WHERE vault_id = ? AND is_archived = 0
    `).all(vaultId) as Array<{ id: string; title: string; content: string; updated_at: string }>;
    for (const row of rows) {
      const file = path.join(notesDir, `${safeSegment(row.id)}.md`);
      const content = redactPrivate ? redactPrivateBlocks(row.content || '') : row.content || '';
      const body = `# ${row.title || 'Untitled'}\n\n${content}`;
      atomicWrite(file, body);
      keep.add(file);
      docs.set(path.resolve(file), {
        type: 'note', id: row.id, title: row.title || 'Untitled', body: content,
        snippet: '', score: 0, updatedAt: row.updated_at,
      });
    }
  }

  {
    const rows = db.prepare(`
      SELECT id, channel_id, author, body, created_at FROM chat_messages
      WHERE vault_id = ? AND body != '' AND status IS NULL
    `).all(vaultId) as Array<{ id: string; channel_id: string; author: string; body: string; created_at: string }>;
    for (const row of rows) {
      const file = path.join(chatsDir, `${safeSegment(row.id)}.md`);
      const markdown = `# ${row.author}\n\n${row.body}`;
      atomicWrite(file, markdown);
      keep.add(file);
      docs.set(path.resolve(file), {
        type: 'chat', id: row.id, channelId: row.channel_id, title: row.author,
        body: row.body, snippet: '', score: 0, timestamp: row.created_at, updatedAt: row.created_at,
      });
    }
  }

  for (const dir of [notesDir, chatsDir]) {
    for (const entry of fs.readdirSync(dir)) {
      const file = path.join(dir, entry);
      if (entry.endsWith('.md') && !keep.has(file)) fs.unlinkSync(file);
    }
  }
  const fingerprint = [...docs.values()]
    .map((doc) => `${doc.type}:${doc.id}:${doc.updatedAt}:${doc.body.length}`)
    .sort()
    .join('|');
  return { docs, fingerprint };
}

function snippet(text: string, query: string, max = 240) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const terms = query.toLowerCase().match(/[a-z0-9_@#./:-]{2,}/g) || [];
  const lower = clean.toLowerCase();
  const at = terms.reduce((best, term) => {
    const index = lower.indexOf(term);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  const start = Math.max(0, (at < 0 ? 0 : at) - 70);
  const value = clean.slice(start, start + max);
  return `${start > 0 ? '…' : ''}${value}${start + max < clean.length ? '…' : ''}`;
}

async function openIndex(indexKey: string, root: string) {
  const existing = indexes.get(indexKey);
  if (existing) return existing;
  const promise: Promise<VaultIndex> = createStore({
    dbPath: path.join(root, 'index.sqlite'),
    config: {
      collections: {
        notes: { path: path.join(root, 'notes'), pattern: '**/*.md' },
        chats: { path: path.join(root, 'chats'), pattern: '**/*.md' },
      },
    },
  }).then((store) => ({ store, fingerprint: '' }));
  indexes.set(indexKey, promise);
  return promise;
}

export async function searchWithQmd(
  db: Db,
  vaultId: string,
  query: string,
  opts: { scope?: 'notes' | 'chat' | 'all'; limit?: number; redactPrivate?: boolean } = {},
): Promise<QmdSearchHit[]> {
  const scope = opts.scope || 'all';
  const limit = Math.max(1, Math.min(Number(opts.limit || 40), 100));
  const variant = opts.redactPrivate ? 'agent' : 'user';
  const indexKey = `${vaultId}:${variant}`;
  const root = path.join(QMD_ROOT, safeSegment(vaultId), variant);
  fs.mkdirSync(root, { recursive: true });
  const corpus = syncCorpus(db, vaultId, root, Boolean(opts.redactPrivate));
  const index = await openIndex(indexKey, root);
  while (index.fingerprint !== corpus.fingerprint) {
    if (!index.syncing) {
      const targetFingerprint = corpus.fingerprint;
      index.syncing = index.store.update()
        .then(() => { index.fingerprint = targetFingerprint; })
        .finally(() => { index.syncing = undefined; });
    }
    await index.syncing;
  }
  if (process.env.CASCADE_QMD_SEMANTIC !== 'false' && !index.embedding && (await index.store.getStatus()).needsEmbedding > 0) {
      index.embedding = index.store.embed({ chunkStrategy: 'regex' })
        .then(() => undefined)
        .catch((error) => {
          console.warn('QMD semantic indexing unavailable; lexical search remains active:', error instanceof Error ? error.message : error);
        })
        .finally(() => { index.embedding = undefined; });
  }
  const collections = scope === 'all' ? undefined : [scope === 'notes' ? 'notes' : 'chats'];
  const lexical = collections
    ? await Promise.all(collections.map((collection) => index.store.searchLex(query, { collection, limit }))).then((sets) => sets.flat())
    : await index.store.searchLex(query, { limit });
  const status = await index.store.getStatus();
  const vector = status.hasVectorIndex
    ? (collections
        ? await Promise.all(collections.map((collection) => index.store.searchVector(query, { collection, limit }))).then((sets) => sets.flat())
        : await index.store.searchVector(query, { limit }))
    : [];
  const fused = new Map<string, { result: (typeof lexical)[number]; score: number }>();
  for (const [list, weight] of [[lexical, 1], [vector, 1]] as const) {
    list.forEach((result, rank) => {
      const current = fused.get(result.filepath);
      const score = weight / (60 + rank + 1);
      fused.set(result.filepath, { result, score: (current?.score || 0) + score });
    });
  }
  const results = [...fused.values()].map(({ result, score }) => ({ ...result, score }));
  return results
    .flatMap((result): QmdSearchHit[] => {
      const resolved = index.store.internal.resolveVirtualPath(result.filepath);
      if (!resolved) return [];
      const absolute = path.resolve(resolved);
      const doc = corpus.docs.get(absolute);
      if (!doc) return [];
      return [{
        type: doc.type,
        id: doc.id,
        title: doc.title,
        ...(doc.channelId ? { channelId: doc.channelId } : {}),
        ...(doc.timestamp ? { timestamp: doc.timestamp } : {}),
        snippet: snippet(doc.body, query),
        score: result.score,
      }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
