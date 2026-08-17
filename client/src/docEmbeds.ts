import type { NoteSummary } from './api';

export type DocEmbedPart =
  | { type: 'text'; value: string }
  | { type: 'embed'; value: string };

export const NOTE_DND_TYPE = 'application/x-cascade-note';
/** Block embeds: `![[Title]]` (card in chat). */
export const DOC_EMBED_REGEX = /!\[\[([^\]\n]+)\]\]/g;
/**
 * Inline citations: `[[Title]]` (not embeds). Negative lookbehind keeps `![[…]]`
 * out of this match so embeds stay handled by DOC_EMBED_REGEX.
 */
export const WIKILINK_REGEX = /(?<!!)\[\[([^\]\n]+)\]\]/g;

export function normalizeDocEmbedTarget(raw: string) {
  return raw
    .split('|', 1)[0]
    .split('#', 1)[0]
    .trim();
}

export function splitDocEmbeds(markdown: string): DocEmbedPart[] {
  const parts: DocEmbedPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  DOC_EMBED_REGEX.lastIndex = 0;
  while ((match = DOC_EMBED_REGEX.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: markdown.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'embed', value: normalizeDocEmbedTarget(match[1] || '') });
    lastIndex = DOC_EMBED_REGEX.lastIndex;
  }
  if (lastIndex < markdown.length) {
    parts.push({ type: 'text', value: markdown.slice(lastIndex) });
  }
  return parts.length ? parts : [{ type: 'text', value: markdown }];
}

/** True when body has `![[…]]` embeds or plain `[[…]]` citations. */
export function bodyHasNoteRefs(body: string): boolean {
  DOC_EMBED_REGEX.lastIndex = 0;
  if (DOC_EMBED_REGEX.test(body)) return true;
  WIKILINK_REGEX.lastIndex = 0;
  return WIKILINK_REGEX.test(body);
}

/**
 * Split a plain-text run on inline `[[wikilinks]]`. Embeds (`![[…]]`) should
 * already be stripped by splitDocEmbeds before this runs.
 */
export function splitWikilinks(text: string): Array<{ type: 'text' | 'wikilink'; value: string }> {
  const parts: Array<{ type: 'text' | 'wikilink'; value: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // Use a non-lookbehind fallback that also skips `![[` by requiring the match
  // start is not preceded by `!` (handled in the loop for broader engines).
  const re = /\[\[([^\]\n]+)\]\]/g;
  while ((match = re.exec(text)) !== null) {
    if (match.index > 0 && text[match.index - 1] === '!') {
      continue;
    }
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'wikilink', value: normalizeDocEmbedTarget(match[1] || '') });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return parts.length ? parts : [{ type: 'text', value: text }];
}

export function findEmbeddedNote(notes: NoteSummary[], target: string) {
  const normalized = normalizeDocEmbedTarget(target).toLowerCase();
  if (!normalized) return null;
  return notes.find((note) => note.id.toLowerCase() === normalized)
    ?? notes.find((note) => note.title.toLowerCase() === normalized)
    ?? null;
}

export function noteEmbedMarkdown(note: NoteSummary) {
  return `![[${note.title.replace(/\]/g, '')}]]`;
}
