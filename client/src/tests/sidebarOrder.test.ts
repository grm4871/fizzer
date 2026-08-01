import { describe, expect, it } from 'vitest';
import type { NoteSummary } from '../api';
import { sidebarInsertionIndex, sortSidebarNotes } from '../components/Sidebar';
import { tabInsertionIndex } from '../components/PaneGrid';

const note = (id: string, position: number, title = id): NoteSummary => ({
  id,
  vault_id: 'vault',
  folder_id: null,
  title,
  content_preview: '',
  is_pinned: 0,
  is_archived: 0,
  is_listed: 1,
  position,
  word_count: 0,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
  tags: [],
});

describe('manual workspace ordering', () => {
  it('uses persisted positions instead of title order', () => {
    expect(sortSidebarNotes([
      note('alpha', 2, 'Alpha'),
      note('zebra', 0, 'Zebra'),
      note('middle', 1, 'Middle'),
    ]).map((item) => item.id)).toEqual(['zebra', 'middle', 'alpha']);
  });

  it('calculates sidebar positions after removing the dragged item', () => {
    expect(sidebarInsertionIndex(['a', 'b', 'c'], 'a', 'c', 'after')).toBe(2);
    expect(sidebarInsertionIndex(['a', 'b', 'c'], 'c', 'a', 'before')).toBe(0);
  });

  it('calculates tab positions in both drag directions', () => {
    expect(tabInsertionIndex(['a', 'b', 'c'], 'a', 'c', 'after')).toBe(2);
    expect(tabInsertionIndex(['a', 'b', 'c'], 'c', 'a', 'before')).toBe(0);
    expect(tabInsertionIndex(['a', 'b', 'c'], 'b', 'b', 'after')).toBe(1);
  });
});
