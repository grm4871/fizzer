import type { NoteSummary } from './api';

export type DocEmbedPart =
  | { type: 'text'; value: string }
  | { type: 'embed'; value: string };

export const NOTE_DND_TYPE = 'application/x-cascade-note';
export const DOC_EMBED_REGEX = /!\[\[([^\]\n]+)\]\]/g;

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
