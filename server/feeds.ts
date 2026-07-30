import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import type Database from 'better-sqlite3';
import { redactPrivateBlocks } from './privacy.js';

type Db = Database.Database;

export type FeedItem = {
  id: string;
  title: string;
  url: string | null;
  summary: string;
  published_at: string | null;
};

export type ParsedFeed = {
  title: string;
  url: string;
  site_url: string | null;
  items: FeedItem[];
  fetched_at: string;
};

export type FeedWatch = {
  vault_id: string;
  note_id: string;
  widget_id: string;
  url: string;
  title: string;
  interval_minutes: number;
};

type FeedNotifySink = (vaultId: string, event: string, data: unknown) => void;

const FEED_CACHE_TTL_MS = 60_000;
const DEFAULT_WATCH_INTERVAL_MINUTES = 30;
const MIN_WATCH_INTERVAL_MINUTES = 5;
const MAX_WATCH_INTERVAL_MINUTES = 24 * 60;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const feedCache = new Map<string, { expiresAt: number; feed: ParsedFeed }>();
let notifySink: FeedNotifySink | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let pollInFlight = false;

export function ensureFeedSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS widget_feed_state (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      widget_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 30,
      last_item_id TEXT,
      last_item_title TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (vault_id, widget_id)
    );
    CREATE INDEX IF NOT EXISTS idx_widget_feed_state_vault ON widget_feed_state(vault_id);
  `);
}

export function setFeedNotifySink(sink: FeedNotifySink | null) {
  notifySink = sink;
}

export function startFeedPoller(db: Db) {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void pollWidgetFeeds(db);
  }, 60_000);
  void pollWidgetFeeds(db);
}

export async function fetchFeed(url: string, options: { force?: boolean } = {}): Promise<ParsedFeed> {
  const normalizedUrl = normalizeFeedUrl(url);
  const cached = feedCache.get(normalizedUrl);
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.feed;

  const response = await fetchWithGuards(normalizedUrl, 3);
  const contentType = response.headers.get('content-type') || '';
  const text = await readCappedText(response, MAX_FEED_BYTES);
  const feed = parseFeedText(text, normalizedUrl, contentType);
  feedCache.set(normalizedUrl, { feed, expiresAt: Date.now() + FEED_CACHE_TTL_MS });
  return feed;
}

export async function pollWidgetFeeds(db: Db) {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const watches = discoverFeedWatches(db);
    reconcileFeedState(db, watches);

    const now = Date.now();
    const rows = db.prepare('SELECT * FROM widget_feed_state').all() as Array<{
      vault_id: string;
      note_id: string;
      widget_id: string;
      url: string;
      title: string;
      interval_minutes: number;
      last_item_id: string | null;
      last_checked_at: string | null;
    }>;

    for (const row of rows) {
      const lastChecked = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0;
      const intervalMs = clampInterval(row.interval_minutes) * 60_000;
      if (lastChecked && now - lastChecked < intervalMs) continue;

      try {
        const feed = await fetchFeed(row.url, { force: true });
        const topItem = feed.items[0] || null;
        const topItemId = topItem?.id || null;
        const isInitial = !row.last_checked_at || !row.last_item_id;

        db.prepare(`
          UPDATE widget_feed_state
          SET title = ?, last_item_id = ?, last_item_title = ?, last_checked_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
          WHERE vault_id = ? AND widget_id = ?
        `).run(feed.title || row.title, topItemId, topItem?.title || null, row.vault_id, row.widget_id);

        if (!isInitial && topItem && topItemId !== row.last_item_id) {
          notifySink?.(row.vault_id, 'vault:feedNotify', {
            noteId: row.note_id,
            widgetId: row.widget_id,
            feedTitle: feed.title || row.title,
            item: topItem,
          });
        }
      } catch (error) {
        db.prepare(`
          UPDATE widget_feed_state
          SET last_checked_at = datetime('now'), last_error = ?, updated_at = datetime('now')
          WHERE vault_id = ? AND widget_id = ?
        `).run(error instanceof Error ? error.message : String(error), row.vault_id, row.widget_id);
      }
    }
  } finally {
    pollInFlight = false;
  }
}

function discoverFeedWatches(db: Db): FeedWatch[] {
  const notes = db.prepare('SELECT id, vault_id, title, content FROM notes WHERE is_archived = 0').all() as Array<{
    id: string;
    vault_id: string;
    title: string;
    content: string;
  }>;
  const watches: FeedWatch[] = [];

  for (const note of notes) {
    for (const block of extractWidgetBlocks(redactPrivateBlocks(note.content))) {
      const meta = parseWidgetMeta(block.source);
      const url = firstString(meta.feed_url, meta.feed, meta.url);
      const notify = parseBoolean(firstString(meta.notify, meta.background, meta.notifications));
      if (!url || !notify) continue;
      try {
        const normalizedUrl = normalizeFeedUrl(url);
        watches.push({
          vault_id: note.vault_id,
          note_id: note.id,
          widget_id: hashId(`${note.id}:${block.from}:${normalizedUrl}`),
          url: normalizedUrl,
          title: firstString(meta.title) || note.title || 'Feed widget',
          interval_minutes: clampInterval(Number(firstString(meta.interval_minutes, meta.interval, meta.refresh_minutes)) || DEFAULT_WATCH_INTERVAL_MINUTES),
        });
      } catch {
        // Ignore invalid watched feeds here; foreground widget refresh returns errors directly.
      }
    }
  }

  return watches;
}

function reconcileFeedState(db: Db, watches: FeedWatch[]) {
  const seen = new Set(watches.map((watch) => `${watch.vault_id}:${watch.widget_id}`));
  const existing = db.prepare('SELECT vault_id, widget_id FROM widget_feed_state').all() as Array<{ vault_id: string; widget_id: string }>;
  const deleteStmt = db.prepare('DELETE FROM widget_feed_state WHERE vault_id = ? AND widget_id = ?');
  for (const row of existing) {
    if (!seen.has(`${row.vault_id}:${row.widget_id}`)) deleteStmt.run(row.vault_id, row.widget_id);
  }

  const upsert = db.prepare(`
    INSERT INTO widget_feed_state (vault_id, note_id, widget_id, url, title, interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(vault_id, widget_id) DO UPDATE SET
      note_id = excluded.note_id,
      url = excluded.url,
      title = excluded.title,
      interval_minutes = excluded.interval_minutes,
      updated_at = datetime('now')
  `);
  for (const watch of watches) {
    upsert.run(watch.vault_id, watch.note_id, watch.widget_id, watch.url, watch.title, watch.interval_minutes);
  }
}

async function fetchWithGuards(url: string, redirectsLeft: number): Promise<Response> {
  await assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, text/xml;q=0.8, */*;q=0.5',
        'user-agent': 'CascadeNotes/0.2 feed reader',
      },
    });
    if (isRedirect(response.status)) {
      if (redirectsLeft <= 0) throw new Error('Too many feed redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Feed redirect did not include a location');
      return fetchWithGuards(new URL(location, url).toString(), redirectsLeft - 1);
    }
    if (!response.ok) throw new Error(`Feed request failed with HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function assertPublicHttpUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Feed URL must use http or https');
  }
  if (isBlockedHost(parsed.hostname)) throw new Error('Feed URL host is not allowed');
  if (net.isIP(parsed.hostname)) return;

  const records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('Feed URL resolves to a private network address');
  }
}

async function readCappedText(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) throw new Error('Feed response is too large');
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function parseFeedText(text: string, url: string, contentType: string): ParsedFeed {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Feed response is empty');
  if (contentType.includes('json') || trimmed.startsWith('{')) {
    return parseJsonFeed(trimmed, url);
  }
  return parseXmlFeed(trimmed, url);
}

function parseJsonFeed(text: string, url: string): ParsedFeed {
  const data = JSON.parse(text) as {
    title?: string;
    home_page_url?: string;
    feed_url?: string;
    items?: Array<Record<string, unknown>>;
  };
  const items = Array.isArray(data.items) ? data.items.slice(0, 50).map((item) => {
    const title = cleanText(String(item.title || item.id || item.url || 'Untitled item'));
    const itemUrl = stringOrNull(item.url) || stringOrNull(item.external_url);
    return {
      id: String(item.id || itemUrl || title),
      title,
      url: itemUrl,
      summary: cleanText(String(item.summary || item.content_text || stripHtml(String(item.content_html || '')) || '')),
      published_at: stringOrNull(item.date_published) || stringOrNull(item.date_modified),
    };
  }) : [];
  return {
    title: cleanText(data.title || new URL(url).hostname),
    url: data.feed_url || url,
    site_url: data.home_page_url || null,
    items,
    fetched_at: new Date().toISOString(),
  };
}

function parseXmlFeed(text: string, url: string): ParsedFeed {
  const channel = firstTag(text, 'channel') || text;
  const isAtom = /<feed[\s>]/i.test(text);
  const feedTitle = cleanText(decodeXml(firstTag(channel, 'title') || new URL(url).hostname));
  const siteUrl = isAtom ? atomLink(text, 'alternate') : decodeXml(firstTag(channel, 'link') || '') || null;
  const rawItems = isAtom ? tagBlocks(text, 'entry') : tagBlocks(text, 'item');
  const items = rawItems.slice(0, 50).map((item) => {
    const itemTitle = cleanText(decodeXml(firstTag(item, 'title') || 'Untitled item'));
    const itemUrl = isAtom ? atomLink(item, 'alternate') : decodeXml(firstTag(item, 'link') || '') || null;
    const guid = decodeXml(firstTag(item, 'guid') || firstTag(item, 'id') || itemUrl || itemTitle);
    return {
      id: guid,
      title: itemTitle,
      url: itemUrl,
      summary: cleanText(stripHtml(decodeXml(firstTag(item, 'description') || firstTag(item, 'summary') || firstTag(item, 'content') || ''))),
      published_at: decodeXml(firstTag(item, 'pubDate') || firstTag(item, 'published') || firstTag(item, 'updated') || '') || null,
    };
  });
  return { title: feedTitle, url, site_url: siteUrl, items, fetched_at: new Date().toISOString() };
}

function extractWidgetBlocks(content: string) {
  const blocks: Array<{ from: number; source: string }> = [];
  const lines = content.split(/\n/);
  let offset = 0;
  let start: number | null = null;
  let body: string[] = [];
  for (const line of lines) {
    if (start === null && line.trim() === '```cascade-widget') {
      start = offset;
      body = [];
    } else if (start !== null && line.trim() === '```') {
      blocks.push({ from: start, source: body.join('\n') });
      start = null;
    } else if (start !== null) {
      body.push(line);
    }
    offset += line.length + 1;
  }
  return blocks;
}

function parseWidgetMeta(source: string) {
  const trimmedStart = source.replace(/^\s*\n/, '');
  if (!trimmedStart.startsWith('---\n')) return {} as Record<string, string>;
  const close = trimmedStart.indexOf('\n---', 4);
  if (close === -1) return {} as Record<string, string>;
  const metaText = trimmedStart.slice(4, close);
  const meta: Record<string, string> = {};
  for (const line of metaText.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    meta[match[1].trim()] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return meta;
}

function firstTag(source: string, tag: string) {
  const match = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() || '';
}

function tagBlocks(source: string, tag: string) {
  return Array.from(source.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi'))).map((match) => match[0]);
}

function atomLink(source: string, rel: string) {
  const links = Array.from(source.matchAll(/<link\b([^>]*)>/gi));
  for (const link of links) {
    const attrs = link[1];
    const relValue = attr(attrs, 'rel') || 'alternate';
    if (relValue !== rel) continue;
    const href = attr(attrs, 'href');
    if (href) return decodeXml(href);
  }
  return null;
}

function attr(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
  return match?.[1] || null;
}

function normalizeFeedUrl(rawUrl: string) {
  const url = new URL(String(rawUrl).trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Feed URL must use http or https');
  url.hash = '';
  return url.toString();
}

function isRedirect(status: number) {
  return [301, 302, 303, 307, 308].includes(status);
}

function isBlockedHost(hostname: string) {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost') || isPrivateAddress(lower);
}

function isPrivateAddress(address: string) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
  }
  return false;
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, ' ');
}

function cleanText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseBoolean(value: string | undefined) {
  return value === 'true' || value === 'yes' || value === '1';
}

function firstString(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function clampInterval(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_WATCH_INTERVAL_MINUTES;
  return Math.max(MIN_WATCH_INTERVAL_MINUTES, Math.min(MAX_WATCH_INTERVAL_MINUTES, Math.round(value)));
}

function hashId(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}
