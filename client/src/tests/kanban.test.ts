import { describe, expect, it } from 'vitest';
import {
  addKanbanCard,
  addKanbanColumn,
  archiveCompletedKanbanCards,
  archiveKanbanCard,
  deleteKanbanCard,
  ensureKanbanFrontmatter,
  hasObsidianKanbanMarker,
  initializeKanbanMarkdown,
  moveKanbanCard,
  parseKanbanMarkdown,
  renameKanbanCard,
  renameKanbanColumn,
  toggleKanbanCard,
} from '../components/KanbanView';
import {
  mergeKanbanSources,
  mergeLiveWorkIntoKanban,
  workItemStatusToKanbanColumn,
  workItemsToLiveColumns,
} from '../components/SuperkanbanView';
import type { WorkItem } from '../chat/workItems';

const SAMPLE = [
  '---',
  'kanban-plugin: board',
  '---',
  '',
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
  '%% kanban:settings',
  '```',
  '{"kanban-plugin":"board"}',
  '```',
  '%%',
  '',
].join('\n');

describe('Markdown-backed Kanban helpers', () => {
  it('parses h2 sections and checklist or bullet cards', () => {
    const board = parseKanbanMarkdown(SAMPLE);
    expect(board.columns.map((column) => column.title)).toEqual(['Backlog', 'Done']);
    expect(board.columns[0].cards.map((card) => card.text)).toEqual(['Draft brief', 'Plain bullet']);
    expect(board.columns[1].cards[0].checked).toBe(true);
    expect(board.hasObsidianMarker).toBe(true);
  });

  it('moves and reorders cards without losing surrounding prose', () => {
    const board = parseKanbanMarkdown(SAMPLE);
    const next = moveKanbanCard(SAMPLE, board.columns[0].cards[0].id, board.columns[1].id);
    expect(next).toContain('Intro text stays untouched.');
    expect(parseKanbanMarkdown(next).columns[1].cards.map((card) => card.text))
      .toEqual(['Ship prototype', 'Draft brief']);

    const movedBoard = parseKanbanMarkdown(next);
    const reordered = moveKanbanCard(
      next,
      movedBoard.columns[1].cards[1].id,
      movedBoard.columns[1].id,
      movedBoard.columns[1].cards[0].id,
    );
    expect(parseKanbanMarkdown(reordered).columns[1].cards.map((card) => card.text))
      .toEqual(['Draft brief', 'Ship prototype']);
  });

  it('adds, renames, toggles, and deletes cards as ordinary Markdown', () => {
    let next = addKanbanCard(SAMPLE, parseKanbanMarkdown(SAMPLE).columns[0].id, 'Review copy');
    expect(next).toContain('- Plain bullet\n- [ ] Review copy\n\n## Done');
    let card = parseKanbanMarkdown(next).columns[0].cards.find((item) => item.text === 'Review copy')!;
    next = renameKanbanCard(next, card.id, 'Review final copy');
    card = parseKanbanMarkdown(next).columns[0].cards.find((item) => item.text === 'Review final copy')!;
    next = toggleKanbanCard(next, card.id);
    expect(next).toContain('- [x] Review final copy');
    card = parseKanbanMarkdown(next).columns[0].cards.find((item) => item.text === 'Review final copy')!;
    next = deleteKanbanCard(next, card.id);
    expect(next).not.toContain('Review final copy');
  });

  it('initializes an Obsidian-compatible board around existing note content', () => {
    const next = initializeKanbanMarkdown('# Existing');
    expect(next).toMatch(/^---\nkanban-plugin: board\n---\n\n# Existing\n\n## Backlog/);
    expect(next).toContain('%% kanban:settings\n```\n{"kanban-plugin":"board"}');
    expect(hasObsidianKanbanMarker(next)).toBe(true);
    expect(parseKanbanMarkdown(next).columns).toHaveLength(3);
  });

  it('adds and renames WIP-limited columns before the settings footer', () => {
    let next = addKanbanColumn(SAMPLE, 'Blocked (2)');
    let column = parseKanbanMarkdown(next).columns.at(-1)!;
    expect(column.title).toBe('Blocked');
    expect(column.maxItems).toBe(2);
    expect(next.indexOf('## Blocked (2)')).toBeLessThan(next.indexOf('%% kanban:settings'));
    next = renameKanbanColumn(next, column.id, 'Waiting (3)');
    column = parseKanbanMarkdown(next).columns.at(-1)!;
    expect(column.title).toBe('Waiting');
    expect(column.maxItems).toBe(3);
  });

  it('adds the marker to existing frontmatter without replacing metadata', () => {
    const next = ensureKanbanFrontmatter(['---', 'tags: [project]', '---', '', '# Plan'].join('\n'));
    expect(next).toContain('tags: [project]\nkanban-plugin: board\n---');
    expect(hasObsidianKanbanMarker(next)).toBe(true);
  });

  it('archives cards using the Obsidian thematic-break archive format', () => {
    const board = parseKanbanMarkdown(SAMPLE);
    let next = archiveKanbanCard(SAMPLE, board.columns[0].cards[0].id);
    expect(next).toContain('***\n\n## Archive');
    expect(parseKanbanMarkdown(next).archive.map((card) => card.text)).toEqual(['Draft brief']);
    expect(parseKanbanMarkdown(next).columns[0].cards.map((card) => card.text)).toEqual(['Plain bullet']);
    expect(next.indexOf('## Archive')).toBeLessThan(next.indexOf('%% kanban:settings'));

    next = archiveCompletedKanbanCards(next);
    expect(parseKanbanMarkdown(next).archive.map((card) => card.text))
      .toEqual(['Draft brief', 'Ship prototype']);
  });

  it('merges matching column names without changing board or card order', () => {
    const other = SAMPLE
      .replace('## Backlog', '##  backlog  ')
      .replace('Draft brief', 'Second board first')
      .replace('Plain bullet', 'Second board second');
    const columns = mergeKanbanSources([
      { id: 'first', title: 'First board', content: SAMPLE },
      { id: 'second', title: 'Second board', content: other },
    ]);
    expect(columns.map((column) => column.title)).toEqual(['Backlog', 'Done']);
    expect(columns[0].cards.map((card) => card.text))
      .toEqual(['Draft brief', 'Plain bullet', 'Second board first', 'Second board second']);
    expect(columns[0].cards.map((card) => card.sourceTitle))
      .toEqual(['First board', 'First board', 'Second board', 'Second board']);
  });

  it('projects mission work items into Superkanban live columns', () => {
    const items: WorkItem[] = [
      {
        id: 'wi-1', vaultId: 'v', channelId: 'ch', title: 'Ship isolation', brief: '',
        status: 'in_progress', priority: 0, sourceKind: 'mission', sourceId: 'task-1',
        assigneeRegistrationId: 'reg-1', leaseHolder: null, leaseExpiresAt: null,
        repository: '', baseCommit: '', branch: 'cascade/abc/ship-isolation',
        workspaceMode: 'isolated', worktreePath: '', prNumber: null, prUrl: '', prState: '',
        summary: '', verification: '', dependsOn: [], runIds: [], createdBy: 1,
        createdAt: '', updatedAt: '',
      },
      {
        id: 'wi-2', vaultId: 'v', channelId: 'ch', title: 'Queued follow-up', brief: '',
        status: 'open', priority: 0, sourceKind: 'mission', sourceId: 'task-2',
        assigneeRegistrationId: null, leaseHolder: null, leaseExpiresAt: null,
        repository: '', baseCommit: '', branch: 'cascade/abc/queued',
        workspaceMode: 'isolated', worktreePath: '', prNumber: null, prUrl: '', prState: '',
        summary: '', verification: '', dependsOn: [], runIds: [], createdBy: 1,
        createdAt: '', updatedAt: '',
      },
    ];
    expect(workItemStatusToKanbanColumn('in_progress')).toBe('In progress');
    const live = workItemsToLiveColumns(items);
    expect(live.map((c) => c.title)).toEqual(['Backlog', 'In progress']);
    expect(live[1].cards[0].text).toContain('Ship isolation');
    expect(live[1].cards[0].live).toBe(true);
    const boards = mergeKanbanSources([{ id: 'b1', title: 'Board', content: SAMPLE }]);
    const merged = mergeLiveWorkIntoKanban(boards, live);
    const backlog = merged.find((c) => c.title === 'Backlog')!;
    expect(backlog.cards[0].sourceTitle).toBe('Live mission work');
    expect(backlog.cards.some((c) => c.text === 'Draft brief')).toBe(true);
  });

  it('parses the live Cascade kanban board and tolerates non-string content', () => {
    const live = [
      '---',
      'kanban-plugin: board',
      '---',
      '',
      '# Cascade',
      '',
      '## Backlog',
      '',
      '- [ ] Add MP4 embeds — accept already allows `video/*`; no real `<video>` render yet',
      '- [ ] Cap anonymous mission fanout concurrency',
      '- [ ] Deeper task-workspace roadmap — [[Cascade-native parallel workspaces and pull requests]]',
      '  - durable work-item schema',
      '',
      '## In progress',
      '',
      '## Done',
      '',
      '- [x] Multiplayer account management',
      '',
      '%% kanban:settings',
      '```',
      '{"kanban-plugin":"board"}',
      '```',
      '%%',
      '',
    ].join('\n');
    const board = parseKanbanMarkdown(live);
    expect(board.columns.map((c) => c.title)).toEqual(['Backlog', 'In progress', 'Done']);
    expect(board.columns[0].cards.length).toBeGreaterThanOrEqual(3);
    expect(hasObsidianKanbanMarker(live)).toBe(true);
    expect(() => parseKanbanMarkdown(undefined as unknown as string)).not.toThrow();
    expect(parseKanbanMarkdown(undefined as unknown as string).columns).toEqual([]);
  });
});
