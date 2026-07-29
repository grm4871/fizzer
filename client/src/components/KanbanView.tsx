import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { Check, GripVertical, Plus, X } from 'lucide-react';

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
  headingLineIndex: number;
  endLineIndex: number;
  cards: KanbanCard[];
}

export interface KanbanBoard {
  columns: KanbanColumn[];
}

const HEADING = /^##\s+(.+?)\s*$/;
const CARD = /^\s*([-*+])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/;

export function parseKanbanMarkdown(content: string): KanbanBoard {
  const lines = content.split('\n');
  const columns: KanbanColumn[] = [];

  lines.forEach((line, lineIndex) => {
    const heading = line.match(HEADING);
    if (heading) {
      const previous = columns.at(-1);
      if (previous) previous.endLineIndex = lineIndex;
      columns.push({
        id: `column-${lineIndex}`,
        title: heading[1].trim(),
        headingLineIndex: lineIndex,
        endLineIndex: lines.length,
        cards: [],
      });
      return;
    }

    const column = columns.at(-1);
    if (!column) return;
    const card = line.match(CARD);
    if (!card) return;
    const marker = card[1] as '-' | '*' | '+';
    column.cards.push({
      id: `card-${lineIndex}`,
      lineIndex,
      text: card[3].trim(),
      checked: card[2]?.toLowerCase() === 'x',
      marker,
    });
  });

  return { columns };
}

function cardLine(text: string, checked = false, marker: '-' | '*' | '+' = '-') {
  return `${marker} [${checked ? 'x' : ' '}] ${text.trim()}`;
}

export function initializeKanbanMarkdown(content: string): string {
  const prefix = content.trimEnd();
  const board = ['## Backlog', '', '## In progress', '', '## Done', ''].join('\n');
  return prefix ? `${prefix}\n\n${board}` : board;
}

export function addKanbanCard(content: string, columnId: string, text: string): string {
  const board = parseKanbanMarkdown(content);
  const column = board.columns.find((item) => item.id === columnId);
  if (!column || !text.trim()) return content;
  const lines = content.split('\n');
  let insertAt = column.headingLineIndex + 1;
  if (column.cards.length) insertAt = column.cards.at(-1)!.lineIndex + 1;
  while (insertAt < column.endLineIndex && lines[insertAt]?.trim() === '') insertAt += 1;
  lines.splice(insertAt, 0, cardLine(text));
  return lines.join('\n');
}

export function addKanbanColumn(content: string, title: string): string {
  const clean = title.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return content;
  const prefix = content.trimEnd();
  return `${prefix}${prefix ? '\n\n' : ''}## ${clean}\n`;
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
  const card = board.columns.flatMap((column) => column.cards).find((item) => item.id === cardId);
  if (!card) return content;
  const lines = content.split('\n');
  lines.splice(card.lineIndex, 1);
  return lines.join('\n');
}

export function moveKanbanCard(content: string, cardId: string, targetColumnId: string): string {
  const board = parseKanbanMarkdown(content);
  const source = board.columns.flatMap((column) => column.cards).find((item) => item.id === cardId);
  const target = board.columns.find((column) => column.id === targetColumnId);
  if (!source || !target) return content;

  const lines = content.split('\n');
  const movedLine = lines[source.lineIndex];
  lines.splice(source.lineIndex, 1);

  const adjustedHeadingIndex = target.headingLineIndex - (source.lineIndex < target.headingLineIndex ? 1 : 0);
  const adjusted = parseKanbanMarkdown(lines.join('\n')).columns
    .find((column) => column.headingLineIndex === adjustedHeadingIndex);
  if (!adjusted) return content;
  let insertAt = adjusted.headingLineIndex + 1;
  if (adjusted.cards.length) insertAt = adjusted.cards.at(-1)!.lineIndex + 1;
  while (insertAt < adjusted.endLineIndex && lines[insertAt]?.trim() === '') insertAt += 1;
  lines.splice(insertAt, 0, movedLine);
  return lines.join('\n');
}

interface KanbanViewProps {
  content: string;
  onContentChange: (content: string) => void;
}

export function KanbanView({ content, onContentChange }: KanbanViewProps) {
  const board = useMemo(() => parseKanbanMarkdown(content), [content]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);

  if (!board.columns.length) {
    return (
      <div className="kanban-empty">
        <div className="kanban-empty-icon">▦</div>
        <strong>Turn this note into a board</strong>
        <p>Columns and cards stay editable as ordinary Markdown.</p>
        <button type="button" onClick={() => onContentChange(initializeKanbanMarkdown(content))}>
          <Plus size={14} /> Create Backlog, In progress, and Done
        </button>
      </div>
    );
  }

  const submitCard = (event: FormEvent, column: KanbanColumn) => {
    event.preventDefault();
    const text = drafts[column.id]?.trim();
    if (!text) return;
    onContentChange(addKanbanCard(content, column.id, text));
    setDrafts((current) => ({ ...current, [column.id]: '' }));
  };

  const dropCard = (event: DragEvent, column: KanbanColumn) => {
    event.preventDefault();
    const cardId = draggedCardId || event.dataTransfer.getData('text/cascade-kanban-card');
    if (cardId) onContentChange(moveKanbanCard(content, cardId, column.id));
    setDraggedCardId(null);
  };

  return (
    <div className="kanban-view" aria-label="Kanban board">
      <div className="kanban-board">
        {board.columns.map((column) => (
          <section
            className="kanban-column"
            key={column.id}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => dropCard(event, column)}
          >
            <header>
              <strong>{column.title}</strong>
              <span>{column.cards.length}</span>
            </header>
            <div className="kanban-cards">
              {column.cards.map((card) => (
                <article
                  className={`kanban-card${card.checked ? ' is-complete' : ''}`}
                  key={card.id}
                  draggable
                  onDragStart={(event) => {
                    setDraggedCardId(card.id);
                    event.dataTransfer.setData('text/cascade-kanban-card', card.id);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => setDraggedCardId(null)}
                >
                  <GripVertical size={14} className="kanban-card-grip" aria-hidden="true" />
                  <button
                    type="button"
                    className="kanban-card-check"
                    onClick={() => onContentChange(toggleKanbanCard(content, card.id))}
                    aria-label={card.checked ? 'Mark incomplete' : 'Mark complete'}
                  >
                    {card.checked && <Check size={12} />}
                  </button>
                  <span>{card.text}</span>
                  <button
                    type="button"
                    className="kanban-card-delete"
                    onClick={() => onContentChange(deleteKanbanCard(content, card.id))}
                    aria-label={`Delete ${card.text}`}
                  >
                    <X size={12} />
                  </button>
                </article>
              ))}
            </div>
            <form className="kanban-add-card" onSubmit={(event) => submitCard(event, column)}>
              <input
                value={drafts[column.id] || ''}
                onChange={(event) => setDrafts((current) => ({ ...current, [column.id]: event.target.value }))}
                placeholder="Add a card…"
                aria-label={`Add card to ${column.title}`}
              />
              <button type="submit" aria-label={`Add card to ${column.title}`}><Plus size={14} /></button>
            </form>
          </section>
        ))}
        <button
          type="button"
          className="kanban-add-column"
          onClick={() => {
            const title = window.prompt('Column name');
            if (title) onContentChange(addKanbanColumn(content, title));
          }}
        >
          <Plus size={14} /> Add column
        </button>
      </div>
    </div>
  );
}
