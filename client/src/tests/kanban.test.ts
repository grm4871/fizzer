import { describe, expect, it } from 'vitest';
import {
  addKanbanCard,
  addKanbanColumn,
  deleteKanbanCard,
  initializeKanbanMarkdown,
  moveKanbanCard,
  parseKanbanMarkdown,
  toggleKanbanCard,
} from '../components/KanbanView';

const SAMPLE = [
  '# Project',
  '',
  'Intro text stays untouched.',
  '',
  '## Backlog',
  '',
  '- [ ] Draft brief',
  '- Plain bullet',
  '',
  '## Done',
  '',
  '- [x] Ship prototype',
  '',
].join('\n');

describe('Markdown-backed Kanban helpers', () => {
  it('parses h2 sections and checklist or bullet cards', () => {
    const board = parseKanbanMarkdown(SAMPLE);
    expect(board.columns.map((column) => column.title)).toEqual(['Backlog', 'Done']);
    expect(board.columns[0].cards.map((card) => card.text)).toEqual(['Draft brief', 'Plain bullet']);
    expect(board.columns[1].cards[0].checked).toBe(true);
  });

  it('moves a card without losing surrounding prose', () => {
    const board = parseKanbanMarkdown(SAMPLE);
    const next = moveKanbanCard(SAMPLE, board.columns[0].cards[0].id, board.columns[1].id);
    expect(next).toContain('Intro text stays untouched.');
    expect(parseKanbanMarkdown(next).columns[1].cards.map((card) => card.text))
      .toEqual(['Ship prototype', 'Draft brief']);
  });

  it('adds, toggles, and deletes cards as ordinary Markdown', () => {
    let next = addKanbanCard(SAMPLE, parseKanbanMarkdown(SAMPLE).columns[0].id, 'Review copy');
    let card = parseKanbanMarkdown(next).columns[0].cards.find((item) => item.text === 'Review copy')!;
    next = toggleKanbanCard(next, card.id);
    expect(next).toContain('- [x] Review copy');
    card = parseKanbanMarkdown(next).columns[0].cards.find((item) => item.text === 'Review copy')!;
    next = deleteKanbanCard(next, card.id);
    expect(next).not.toContain('Review copy');
  });

  it('initializes a board after existing note content', () => {
    const next = initializeKanbanMarkdown('# Existing');
    expect(next).toMatch(/^# Existing\n\n## Backlog/);
    expect(parseKanbanMarkdown(next).columns).toHaveLength(3);
  });

  it('adds custom columns as h2 sections', () => {
    const next = addKanbanColumn(SAMPLE, 'Blocked');
    expect(parseKanbanMarkdown(next).columns.at(-1)?.title).toBe('Blocked');
  });
});
