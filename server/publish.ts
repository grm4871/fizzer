/**
 * @file publish.ts — Public note publishing, read-only pages, and oEmbed
 */

import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type Database from 'better-sqlite3';
import { getNote, getWritableVault } from './vault.js';
import { redactPrivateBlocksForPublic } from './privacy.js';

type Db = Database.Database;

export type PublishedNote = {
  slug: string;
  note_id: string;
  title: string;
  content: string;
  author_username: string;
  published_at: string;
  updated_at: string;
  revoked_at: string | null;
};

export type PublishInfo = {
  slug: string;
  url: string;
  published_at: string;
  updated_at: string;
};

export function ensurePublishSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS published_notes (
      slug TEXT PRIMARY KEY,
      note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_username TEXT NOT NULL,
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_published_notes_note_id ON published_notes(note_id);
  `);
}

function newSlug(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Obsidian-style `![alt|320](url)` → sized HTML so published pages keep resize. */
function expandSizedImages(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, rawAlt: string, url: string) => {
    const sizeMatch = rawAlt.match(/^(.*?)\|(\d{1,5})(?:x(\d{1,5}))?\s*$/);
    if (!sizeMatch) return full;
    const alt = sizeMatch[1].trim();
    const width = parseInt(sizeMatch[2], 10);
    if (!Number.isFinite(width) || width <= 0) return full;
    return `<img src="${escapeHtmlAttr(url)}" alt="${escapeHtmlAttr(alt)}" width="${width}" style="max-width:100%;height:auto" />`;
  });
}

export function sanitizePublicContent(content: string): string {
  let out = redactPrivateBlocksForPublic(content);
  out = out.replace(/\{\{ai:[^}]+\}\}/g, '');
  out = out.replace(/!\[\[([^\]]+)\]\]/g, '[$1]');
  out = out.replace(/\[\[([^\]]+)\]\]/g, '$1');
  out = expandSizedImages(out);
  return out;
}

const PUBLIC_MARKDOWN_TAGS = [
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code', 'strong', 'em', 'del',
  'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

function safePublicUrl(raw: string | undefined, kind: 'link' | 'image'): string | undefined {
  if (!raw) return undefined;
  let decoded = raw.trim();
  if (!decoded || decoded.startsWith('//') || /[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  // URL parsers disagree about encoded scheme bytes. Decode a small bounded
  // number of times and reject the attribute if it reveals an unsafe scheme.
  for (let pass = 0; pass < 2 && decoded.includes('%'); pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return undefined;
    }
  }
  const scheme = decoded.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (!scheme) return raw;
  if (kind === 'link' && ['http', 'https', 'mailto'].includes(scheme)) return raw;
  if (kind === 'image' && ['http', 'https'].includes(scheme)) return raw;
  if (kind === 'image' && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(decoded)) return raw;
  return undefined;
}

/** Parser-backed allowlist applied after Markdown rendering. */
function sanitizePublicHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: PUBLIC_MARKDOWN_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      th: ['align'],
      td: ['align'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data'],
    },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attribs) => {
        const href = safePublicUrl(attribs.href, 'link');
        const nextAttribs: Record<string, string> = { ...attribs, rel: 'noopener noreferrer' };
        if (href) nextAttribs.href = href;
        else delete nextAttribs.href;
        return {
          tagName: 'a',
          attribs: nextAttribs,
        };
      },
      img: (_tagName, attribs) => {
        const src = safePublicUrl(attribs.src, 'image');
        const nextAttribs: Record<string, string> = { ...attribs };
        if (src) nextAttribs.src = src;
        else delete nextAttribs.src;
        return { tagName: 'img', attribs: nextAttribs };
      },
    },
  });
}

export function renderPublicMarkdown(content: string): string {
  // Prefer no raw HTML from the Markdown source — content is untrusted.
  const stripped = sanitizePublicContent(content).replace(/<[^>\n]+>/g, '');
  const html = marked.parse(stripped, { async: false }) as string;
  return sanitizePublicHtml(html);
}

function previewText(content: string, maxLen = 200): string {
  const plain = sanitizePublicContent(content)
    .replace(/[#*_`~[\]()!]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}…` : plain;
}

export function getPublishInfo(db: Db, noteId: string): Omit<PublishedNote, 'content' | 'revoked_at' | 'note_id'> | null {
  const row = db.prepare(`
    SELECT slug, title, author_username, published_at, updated_at
    FROM published_notes
    WHERE note_id = ? AND revoked_at IS NULL
  `).get(noteId) as { slug: string; title: string; author_username: string; published_at: string; updated_at: string } | undefined;
  return row ?? null;
}

export function getPublishedBySlug(db: Db, slug: string): PublishedNote | null {
  const row = db.prepare(`
    SELECT slug, note_id, title, content, author_username, published_at, updated_at, revoked_at
    FROM published_notes
    WHERE slug = ? AND revoked_at IS NULL
  `).get(slug) as PublishedNote | undefined;
  return row ?? null;
}

export function publishNote(
  db: Db,
  noteId: string,
  userId: number,
  username: string,
  _snapshot?: { title?: string; content?: string },
): { slug: string; published_at: string; updated_at: string } {
  const note = getNote(db, noteId);
  if (!note) throw new Error('Note not found');
  if (note.is_archived) throw new Error('Cannot publish archived notes');
  // Editor+ only; public snapshot always comes from the stored note (never client body).
  const vault = getWritableVault(db, note.vault_id, userId);
  if (!vault) throw new Error('Note not found');

  void _snapshot; // accepted for API compat; intentionally ignored
  const title = String(note.title).trim() || note.title;
  const content = sanitizePublicContent(note.content);

  const existing = db.prepare('SELECT slug, published_at FROM published_notes WHERE note_id = ?').get(noteId) as { slug: string; published_at: string } | undefined;
  const slug = existing?.slug ?? newSlug();
  const now = new Date().toISOString();

  if (existing) {
    db.prepare(`
      UPDATE published_notes
      SET title = ?, content = ?, author_username = ?, updated_at = ?, revoked_at = NULL
      WHERE note_id = ?
    `).run(title, content, username, now, noteId);
  } else {
    db.prepare(`
      INSERT INTO published_notes (slug, note_id, title, content, author_username, published_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(slug, noteId, title, content, username, now, now);
  }

  return { slug, published_at: existing?.published_at ?? now, updated_at: now };
}

export function unpublishNote(db: Db, noteId: string, userId: number): boolean {
  const note = getNote(db, noteId);
  if (!note) return false;
  const vault = getWritableVault(db, note.vault_id, userId);
  if (!vault) return false;
  const result = db.prepare(`
    UPDATE published_notes SET revoked_at = ? WHERE note_id = ? AND revoked_at IS NULL
  `).run(new Date().toISOString(), noteId);
  return result.changes > 0;
}

function httpOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function publicBaseUrl(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.CASCADE_PUBLIC_URL || '').trim();
  if (configured) {
    const origin = httpOrigin(configured);
    if (!origin) throw new Error('CASCADE_PUBLIC_URL must be an absolute HTTP(S) origin');
    return origin;
  }

  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = forwardedProto === 'http' || forwardedProto === 'https'
    ? forwardedProto
    : req.protocol === 'http' || req.protocol === 'https'
      ? req.protocol
      : 'https';
  // Do not trust X-Forwarded-Host from the request. The supported nginx config
  // preserves the validated Host header and overwrites its forwarded copy.
  const host = req.get('host') || 'localhost';
  const requested = httpOrigin(`${proto}://${host}`) || 'https://localhost';
  const allowed = String(env.CASCADE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => httpOrigin(value.trim()))
    .filter((value): value is string => Boolean(value));
  return allowed.includes(requested) ? requested : allowed[0] || requested;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PUBLIC_PAGE_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    line-height: 1.7;
    background: #0f0e0d;
    color: #e8e4df;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }
  .meta { color: #9a9288; font-size: 0.9rem; margin-bottom: 28px; }
  h1 { font-size: 2rem; font-weight: 300; letter-spacing: -0.03em; margin: 0 0 8px; }
  .content h1, .content h2, .content h3 { letter-spacing: -0.02em; }
  .content h2 { margin-top: 2rem; }
  .content pre {
    background: #1a1816;
    border: 1px solid #2a2622;
    border-radius: 8px;
    padding: 14px 16px;
    overflow-x: auto;
    font-size: 0.9rem;
  }
  .content code {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 0.9em;
    background: #1a1816;
    padding: 0.15em 0.35em;
    border-radius: 4px;
  }
  .content pre code { background: none; padding: 0; }
  .content a { color: #d4a24a; }
  .content blockquote {
    border-left: 3px solid #3a342c;
    margin: 1rem 0;
    padding-left: 1rem;
    color: #b8b0a4;
  }
  .content table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  .content th, .content td { border: 1px solid #2a2622; padding: 8px 10px; text-align: left; }
  .embed body { background: transparent; }
  .embed .wrap { padding: 16px; }
  .embed .meta { display: none; }
`;

function renderPublicPage(published: PublishedNote, req: Request, embed: boolean): string {
  const base = publicBaseUrl(req);
  const pageUrl = `${base}/p/${published.slug}`;
  const title = escapeHtml(published.title);
  const description = escapeHtml(previewText(published.content));
  const bodyHtml = renderPublicMarkdown(published.content);
  const oembedUrl = `${base}/oembed?url=${encodeURIComponent(pageUrl)}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${pageUrl}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="robots" content="noindex" />
  <link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembedUrl)}" title="${title}" />
  <style>${PUBLIC_PAGE_CSS}</style>
</head>
<body class="${embed ? 'embed' : ''}">
  <article class="wrap">
    <header>
      <h1>${title}</h1>
      <p class="meta">by ${escapeHtml(published.author_username)} · ${escapeHtml(published.updated_at)}</p>
    </header>
    <div class="content">${bodyHtml}</div>
  </article>
</body>
</html>`;
}

function parsePublicNoteUrl(url: string, base: string): string | null {
  try {
    const parsed = new URL(url);
    const baseParsed = new URL(base);
    if (parsed.origin !== baseParsed.origin) return null;
    const match = parsed.pathname.match(/^\/p\/([^/]+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function servePublicNotePage(db: Db) {
  return (req: Request, res: Response) => {
    const published = getPublishedBySlug(db, req.params.slug);
    if (!published) return res.status(404).send('Not found');
    const embed = req.query.embed === '1';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(renderPublicPage(published, req, embed));
  };
}

export function servePublicNoteJson(db: Db) {
  return (req: Request, res: Response) => {
    const published = getPublishedBySlug(db, req.params.slug);
    if (!published) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      slug: published.slug,
      title: published.title,
      content: sanitizePublicContent(published.content),
      author: published.author_username,
      published_at: published.published_at,
      updated_at: published.updated_at,
      url: `${publicBaseUrl(req)}/p/${published.slug}`,
    });
  };
}

export function serveOembed(db: Db) {
  return (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    if (!rawUrl) return res.status(400).json({ error: 'url query parameter required' });

    const base = publicBaseUrl(req);
    const slug = parsePublicNoteUrl(rawUrl, base);
    if (!slug) return res.status(404).json({ error: 'URL not found' });

    const published = getPublishedBySlug(db, slug);
    if (!published) return res.status(404).json({ error: 'Not found' });

    const pageUrl = `${base}/p/${published.slug}`;
    const embedUrl = `${pageUrl}?embed=1`;
    const title = published.title;
    const description = previewText(published.content);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      version: '1.0',
      type: 'rich',
      provider_name: 'Cascade',
      provider_url: base,
      title,
      author_name: published.author_username,
      html: `<iframe src="${embedUrl}" width="600" height="420" frameborder="0" sandbox="allow-same-origin"></iframe>`,
      width: 600,
      height: 420,
      description,
    });
  };
}
