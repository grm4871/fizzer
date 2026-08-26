/**
 * Portable Obsidian-compatible Kanban parser and source mutations. The parser
 * intentionally accepts only level-two headings and single-line Markdown list
 * cards; unknown Markdown remains untouched. Mutations reparse before changing
 * lines, so card/column ids and ordering always follow source order.
 */

export interface KanbanCard {
  id: string;
  lineIndex: number;
  text: string;
  checked: boolean;
  marker: '-' | '*' | '+';
}

export interface KanbanColumn {
  id: string;
  title: string;
  rawTitle: string;
  maxItems: number;
  headingLineIndex: number;
  endLineIndex: number;
  cards: KanbanCard[];
}

export interface KanbanBoard {
  columns: KanbanColumn[];
  archive: KanbanCard[];
  archiveHeadingLineIndex: number | null;
  archiveMarkerLineIndex: number | null;
  hasObsidianMarker: boolean;
}

const HEADING = /^##\s+(.+?)\s*$/;
const CARD = /^\s*([-*+])\s+(?:\[([^\]])\]\s+)?(.+?)\s*$/;
const FRONTMATTER_KEY = /^kanban-plugin\s*:/m;
const SETTINGS_START = '%% kanban:settings';

function cleanSingleLine(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function parseColumnTitle(rawTitle: string) {
  const match = rawTitle.match(/^(.*?)\s*\((\d+)\)$/);
  if (!match) return { title: rawTitle.trim(), maxItems: 0 };
  return { title: match[1].trim(), maxItems: Number(match[2]) };
}

function parseCard(line: string, lineIndex: number): KanbanCard | null {
  const match = line.match(CARD);
  if (!match) return null;
  return {
    id: `card-${lineIndex}`,
    lineIndex,
    text: match[3].trim(),
    checked: match[2]?.toLowerCase() === 'x',
    marker: match[1] as '-' | '*' | '+',
  };
}

export function hasObsidianKanbanMarker(content: string) {
  if (typeof content !== 'string' || !content) return false;
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return Boolean(frontmatter && FRONTMATTER_KEY.test(frontmatter[1]));
}

export function hasSuperkanbanMarker(content: string) {
  const frontmatter = typeof content === 'string'
    ? content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || ''
    : '';
  return /^superkanban\s*:\s*true\s*$/im.test(frontmatter);
}

export function setSuperkanbanMarker(content: string, enabled: boolean): string {
  const lines = content.split('\n');
  const frontmatterEnd = findFrontmatterEnd(lines);
  if (frontmatterEnd < 0) return content;
  const markerIndex = lines.slice(1, frontmatterEnd)
    .findIndex((line) => /^superkanban\s*:/.test(line));
  if (markerIndex >= 0) {
    const absoluteIndex = markerIndex + 1;
    if (enabled) lines[absoluteIndex] = 'superkanban: true';
    else lines.splice(absoluteIndex, 1);
  } else if (enabled) {
    lines.splice(frontmatterEnd, 0, 'superkanban: true');
  }
  return lines.join('\n');
}

export function parseKanbanMarkdown(content: string): KanbanBoard {
  // Never throw on open — bad/partial note bodies used to white-screen the pane.
  const safe = typeof content === 'string' ? content : '';
  const lines = safe.split('\n');
  const columns: KanbanColumn[] = [];
  const archive: KanbanCard[] = [];
  let activeColumn: KanbanColumn | null = null;
  let inArchive = false;
  let archiveHeadingLineIndex: number | null = null;
  let archiveMarkerLineIndex: number | null = null;

  lines.forEach((line, lineIndex) => {
    const heading = line.match(HEADING);
    if (heading) {
      let previousNonBlank = lineIndex - 1;
      while (previousNonBlank >= 0 && lines[previousNonBlank].trim() === '') previousNonBlank -= 1;
      const isArchive = heading[1].trim().toLowerCase() === 'archive'
        && previousNonBlank >= 0
        && lines[previousNonBlank].trim() === '***';

      if (activeColumn) {
        activeColumn.endLineIndex = isArchive ? previousNonBlank : lineIndex;
      }

      if (isArchive) {
        activeColumn = null;
        inArchive = true;
        archiveHeadingLineIndex = lineIndex;
        archiveMarkerLineIndex = previousNonBlank;
        return;
      }

      inArchive = false;
      const rawTitle = heading[1].trim();
      const parsedTitle = parseColumnTitle(rawTitle);
      activeColumn = {
        id: `column-${lineIndex}`,
        rawTitle,
        ...parsedTitle,
        headingLineIndex: lineIndex,
        endLineIndex: lines.length,
        cards: [],
      };
      columns.push(activeColumn);
      return;
    }

    const card = parseCard(line, lineIndex);
    if (!card) return;
    if (inArchive) archive.push(card);
    else activeColumn?.cards.push(card);
  });

  const settingsStart = lines.findIndex((line) => line.trim() === SETTINGS_START);
  const lastColumn = columns[columns.length - 1];
  if (settingsStart >= 0 && lastColumn && lastColumn.endLineIndex === lines.length) {
    lastColumn.endLineIndex = settingsStart;
  }

  return {
    columns,
    archive,
    archiveHeadingLineIndex,
    archiveMarkerLineIndex,
    hasObsidianMarker: hasObsidianKanbanMarker(safe),
  };
}

function cardLine(text: string, checked = false, marker: '-' | '*' | '+' = '-') {
  return `${marker} [${checked ? 'x' : ' '}] ${cleanSingleLine(text)}`;
}

function findFrontmatterEnd(lines: string[]) {
  if (lines[0]?.trim() !== '---') return -1;
  return lines.findIndex((line, index) => index > 0 && line.trim() === '---');
}

export function ensureKanbanFrontmatter(content: string): string {
  const lines = content.split('\n');
  const frontmatterEnd = findFrontmatterEnd(lines);
  if (frontmatterEnd >= 0) {
    const existingIndex = lines
      .slice(1, frontmatterEnd)
      .findIndex((line) => /^kanban-plugin\s*:/.test(line));
    if (existingIndex >= 0) return content;
    lines.splice(frontmatterEnd, 0, 'kanban-plugin: board', 'superkanban: true');
    return lines.join('\n');
  }

  const body = content.trimStart();
  return `---\nkanban-plugin: board\nsuperkanban: true\n---\n\n${body}`;
}

function settingsFooter() {
  return [
    '%% kanban:settings',
    '```',
    '{"kanban-plugin":"board"}',
    '```',
    '%%',
  ].join('\n');
}

export function initializeKanbanMarkdown(content: string): string {
  const withFrontmatter = ensureKanbanFrontmatter(content).trimEnd();
  const board = [
    '## Backlog',
    '',
    '## In progress',
    '',
    '## Blocked',
    '',
    '## Done',
    '',
    settingsFooter(),
    '',
  ].join('\n');
  return `${withFrontmatter}\n\n${board}`;
}

function firstFooterLine(content: string) {
  const board = parseKanbanMarkdown(content);
  if (board.archiveMarkerLineIndex != null) return board.archiveMarkerLineIndex;
  const settingsIndex = content.split('\n').findIndex((line) => line.trim() === SETTINGS_START);
  return settingsIndex >= 0 ? settingsIndex : content.split('\n').length;
}

export function addKanbanCard(content: string, columnId: string, text: string): string {
  const board = parseKanbanMarkdown(content);
  const column = board.columns.find((item) => item.id === columnId);
  if (!column || !cleanSingleLine(text)) return content;
  const lines = content.split('\n');
  let insertAt = (column.cards.at(-1)?.lineIndex ?? column.headingLineIndex) + 1;
  // Empty Obsidian lanes conventionally keep one blank line below the heading.
  // For populated lanes, insert directly after the final card so the existing
  // blank line remains the separator before the next lane.
  if (!column.cards.length && lines[insertAt]?.trim() === '') insertAt += 1;
  lines.splice(insertAt, 0, cardLine(text));
  return lines.join('\n');
}

export function addKanbanColumn(content: string, title: string): string {
  const clean = cleanSingleLine(title);
  if (!clean) return content;
  const lines = content.split('\n');
  const insertAt = firstFooterLine(content);
  const section = [`## ${clean}`, '', ''];
  if (insertAt > 0 && lines[insertAt - 1]?.trim() !== '') section.unshift('');
  lines.splice(insertAt, 0, ...section);
  return lines.join('\n');
}

export function renameKanbanCard(content: string, cardId: string, text: string): string {
  const board = parseKanbanMarkdown(content);
  const card = [...board.columns.flatMap((column) => column.cards), ...board.archive]
    .find((item) => item.id === cardId);
  if (!card || !cleanSingleLine(text)) return content;
  const lines = content.split('\n');
  lines[card.lineIndex] = cardLine(text, card.checked, card.marker);
  return lines.join('\n');
}

export function renameKanbanColumn(content: string, columnId: string, title: string): string {
  const column = parseKanbanMarkdown(content).columns.find((item) => item.id === columnId);
  const clean = cleanSingleLine(title);
  if (!column || !clean) return content;
  const lines = content.split('\n');
  lines[column.headingLineIndex] = `## ${clean}`;
  return lines.join('\n');
}

export function toggleKanbanCard(content: string, cardId: string): string {
  const board = parseKanbanMarkdown(content);
  const card = board.columns.flatMap((column) => column.cards).find((item) => item.id === cardId);
  if (!card) return content;
  const lines = content.split('\n');
  lines[card.lineIndex] = cardLine(card.text, !card.checked, card.marker);
  return lines.join('\n');
}

export function deleteKanbanCard(content: string, cardId: string): string {
  const board = parseKanbanMarkdown(content);
  const card = [...board.columns.flatMap((column) => column.cards), ...board.archive]
    .find((item) => item.id === cardId);
  if (!card) return content;
  const lines = content.split('\n');
  lines.splice(card.lineIndex, 1);
  return lines.join('\n');
}

export function deleteKanbanColumn(content: string, columnId: string): string {
  const column = parseKanbanMarkdown(content).columns.find((item) => item.id === columnId);
  if (!column) return content;
  const lines = content.split('\n');
  lines.splice(column.headingLineIndex, column.endLineIndex - column.headingLineIndex);
  return lines.join('\n');
}

export function moveKanbanCard(
  content: string,
  cardId: string,
  targetColumnId: string,
  targetCardId?: string,
  placement: 'before' | 'after' = 'before',
): string {
  const board = parseKanbanMarkdown(content);
  const source = board.columns.flatMap((column) => column.cards).find((item) => item.id === cardId);
  const target = board.columns.find((column) => column.id === targetColumnId);
  const targetCard = targetCardId
    ? target?.cards.find((item) => item.id === targetCardId)
    : undefined;
  if (!source || !target || targetCard?.id === source.id) return content;

  const lines = content.split('\n');
  const movedLine = lines[source.lineIndex];
  let insertAt: number;
  if (targetCard) {
    insertAt = targetCard.lineIndex + (placement === 'after' ? 1 : 0);
  } else {
    insertAt = (target.cards.at(-1)?.lineIndex ?? target.headingLineIndex) + 1;
  }

  lines.splice(source.lineIndex, 1);
  if (source.lineIndex < insertAt) insertAt -= 1;
  lines.splice(insertAt, 0, movedLine);
  return lines.join('\n');
}

function archiveCardIds(content: string, cardIds: string[]): string {
  const board = parseKanbanMarkdown(content);
  const wanted = new Set(cardIds);
  const cards = board.columns
    .flatMap((column) => column.cards)
    .filter((card) => wanted.has(card.id));
  if (!cards.length) return content;

  const lines = content.split('\n');
  const archivedLines = cards.map((card) => lines[card.lineIndex]);
  cards
    .map((card) => card.lineIndex)
    .sort((a, b) => b - a)
    .forEach((lineIndex) => lines.splice(lineIndex, 1));

  let next = lines.join('\n');
  const nextBoard = parseKanbanMarkdown(next);
  const nextLines = next.split('\n');
  if (nextBoard.archiveHeadingLineIndex != null) {
    let insertAt = nextBoard.archive.at(-1)?.lineIndex ?? nextBoard.archiveHeadingLineIndex;
    insertAt += 1;
    while (insertAt < nextLines.length && nextLines[insertAt]?.trim() === '') insertAt += 1;
    nextLines.splice(insertAt, 0, ...archivedLines);
    return nextLines.join('\n');
  }

  const settingsIndex = nextLines.findIndex((line) => line.trim() === SETTINGS_START);
  const insertAt = settingsIndex >= 0 ? settingsIndex : nextLines.length;
  const archiveSection = ['***', '', '## Archive', '', ...archivedLines, '', ''];
  if (insertAt > 0 && nextLines[insertAt - 1]?.trim() !== '') archiveSection.unshift('');
  nextLines.splice(insertAt, 0, ...archiveSection);
  next = nextLines.join('\n');
  return next;
}

export function archiveKanbanCard(content: string, cardId: string) {
  return archiveCardIds(content, [cardId]);
}

export function archiveCompletedKanbanCards(content: string) {
  const completeIds = parseKanbanMarkdown(content).columns
    .flatMap((column) => column.cards)
    .filter((card) => card.checked)
    .map((card) => card.id);
  return archiveCardIds(content, completeIds);
}

export function archiveKanbanColumnCards(content: string, columnId: string) {
  const column = parseKanbanMarkdown(content).columns.find((item) => item.id === columnId);
  return column ? archiveCardIds(content, column.cards.map((card) => card.id)) : content;
}
