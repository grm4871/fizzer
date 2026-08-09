import { describe, expect, it } from 'vitest';
import type { NoteSummary } from '../api';
import { filterLinkableNotes } from '../components/NoteEditor';

function note(id: string, title: string, isArchived = 0): NoteSummary {
  return {
    id,
    title,
    is_archived: isArchived,
    vault_id: 'vault',
    folder_id: null,
    content_preview: '',
    is_pinned: 0,
    is_listed: 0,
    position: 0,
    word_count: 0,
    created_at: '',
    updated_at: '',
    tags: [],
  };
}

describe('mobile note link picker', () => {
  it('excludes the current and archived notes and sorts the rest', () => {
    const result = filterLinkableNotes([
      note('current', 'Current'),
      note('z', 'Zebra'),
      note('archived', 'Hidden', 1),
      note('a', 'Alpha'),
    ], 'current', '');

    expect(result.map(({ id }) => id)).toEqual(['a', 'z']);
  });

  it('searches note titles without case sensitivity', () => {
    const result = filterLinkableNotes([
      note('one', 'Project Atlas'),
      note('two', 'Shopping list'),
    ], undefined, 'ATLAS');

    expect(result.map(({ id }) => id)).toEqual(['one']);
  });
});
