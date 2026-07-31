import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LayoutDashboard, Search } from 'lucide-react';
import { hasObsidianKanbanMarker, parseKanbanMarkdown, type KanbanCard } from './KanbanView';
import type { Note } from '../api';

export interface SuperkanbanSource {
  id: string;
  title: string;
  content: string;
}

export interface SuperkanbanCard extends KanbanCard {
  sourceId: string;
  sourceTitle: string;
}

export interface SuperkanbanColumn {
  id: string;
  title: string;
  cards: SuperkanbanCard[];
}

function columnKey(title: string) {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Merge boards in sidebar order. Within each source board we retain its lane
 * order and card order; the first matching lane supplies the merged title.
 */
export function mergeKanbanSources(sources: SuperkanbanSource[]): SuperkanbanColumn[] {
  const columns: SuperkanbanColumn[] = [];
  const byKey = new Map<string, SuperkanbanColumn>();

  for (const source of sources) {
    if (!hasObsidianKanbanMarker(source.content)) continue;
    for (const column of parseKanbanMarkdown(source.content).columns) {
      const key = columnKey(column.title);
      if (!key) continue;
      let merged = byKey.get(key);
      if (!merged) {
        merged = { id: `super-column-${columns.length}`, title: column.title, cards: [] };
        byKey.set(key, merged);
        columns.push(merged);
      }
      merged.cards.push(...column.cards.map((card) => ({
        ...card,
        id: `${source.id}:${card.id}`,
        sourceId: source.id,
        sourceTitle: source.title,
      })));
    }
  }
  return columns;
}

interface SuperkanbanViewProps {
  notes: Note[];
  loading: boolean;
  error: string | null;
  onOpenNote: (id: string) => void;
}

export function SuperkanbanView({ notes, loading, error, onOpenNote }: SuperkanbanViewProps) {
  const [query, setQuery] = useState('');
  const columns = useMemo(() => mergeKanbanSources(notes), [notes]);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (loading) return <div className="superkanban-empty">Loading your Kanban boards…</div>;
  if (error) return <div className="superkanban-empty">{error}</div>;
  if (columns.length === 0) {
    return (
      <div className="superkanban-empty">
        <LayoutDashboard size={32} aria-hidden="true" />
        <strong>No Kanban boards yet</strong>
        <p>Create a note with the Kanban board format and it will appear here.</p>
      </div>
    );
  }

  return (
    <div className="kanban-view superkanban-view" aria-label="Superkanban">
      <div className="kanban-toolbar">
        <div className="kanban-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter all boards" aria-label="Filter Superkanban cards" />
        </div>
        <span className="kanban-portability">{notes.length} boards · read-only aggregate</span>
      </div>
      <div className="kanban-board">
        {columns.map((column) => {
          const cards = normalizedQuery
            ? column.cards.filter((card) => `${card.text} ${card.sourceTitle}`.toLocaleLowerCase().includes(normalizedQuery))
            : column.cards;
          return (
            <section className="kanban-column superkanban-column" key={column.id}>
              <header><strong>{column.title}</strong><span>{cards.length}</span></header>
              <div className="kanban-cards">
                {cards.map((card) => (
                  <article className={`kanban-card${card.checked ? ' is-complete' : ''}`} key={card.id}>
                    <div className="kanban-card-title"><ReactMarkdown remarkPlugins={[remarkGfm]}>{card.text}</ReactMarkdown></div>
                    <button type="button" className="superkanban-source" onClick={() => onOpenNote(card.sourceId)} title={`Open ${card.sourceTitle}`}>
                      {card.sourceTitle}
                    </button>
                  </article>
                ))}
                {cards.length === 0 && <div className="kanban-no-matches">No matching cards</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
