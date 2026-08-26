/** Link-picker filtering keeps archived/current notes out and preserves title order. */
import type { NoteSummary } from '../api';

export function filterLinkableNotes(notes: NoteSummary[], currentNoteId: string | undefined, query: string): NoteSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return notes
    .filter((candidate) => candidate.id !== currentNoteId && !candidate.is_archived)
    .filter((candidate) => !needle || candidate.title.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.title.localeCompare(b.title));
}
