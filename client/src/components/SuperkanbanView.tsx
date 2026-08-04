import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LayoutDashboard, Search } from 'lucide-react';
import { hasObsidianKanbanMarker, parseKanbanMarkdown, type KanbanCard } from './KanbanView';
import { ErrorBoundary } from './ErrorBoundary';
import type { Note } from '../api';
import type { WorkItem, WorkItemStatus } from '../chat/workItems';

export interface SuperkanbanSource {
  id: string;
  title: string;
  content: string;
}

export interface SuperkanbanCard extends KanbanCard {
  sourceId: string;
  sourceTitle: string;
  /** Live work-item twin (mission-compiled or manual). */
  live?: boolean;
  workItemId?: string;
  branch?: string;
  workspaceMode?: string;
}

export interface SuperkanbanColumn {
  id: string;
  title: string;
  cards: SuperkanbanCard[];
}

function columnKey(title: string) {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** Map durable work-item status onto familiar Kanban lanes. */
export function workItemStatusToKanbanColumn(status: WorkItemStatus | string): string {
  switch (status) {
    case 'in_progress':
    case 'leased':
      return 'In progress';
    case 'review':
      return 'Review';
    case 'blocked':
      return 'Blocked';
    case 'done':
      return 'Done';
    case 'canceled':
      return 'Archive';
    case 'open':
    default:
      return 'Backlog';
  }
}

/**
 * Project live work items (including mission-compiled twins) into Superkanban
 * columns so chat orchestration and the board share one surface.
 */
export function workItemsToLiveColumns(items: WorkItem[]): SuperkanbanColumn[] {
  const order = ['Backlog', 'In progress', 'Blocked', 'Review', 'Done', 'Archive'];
  const byKey = new Map<string, SuperkanbanColumn>();
  for (const title of order) {
    const col: SuperkanbanColumn = { id: `live-${columnKey(title)}`, title, cards: [] };
    byKey.set(columnKey(title), col);
  }
  for (const item of items) {
    // Mission twins + accepted contracts always surface; other work needs a channel.
    if (item.sourceKind !== 'mission' && item.sourceKind !== 'contract' && !item.channelId) continue;
    const title = workItemStatusToKanbanColumn(item.status);
    const key = columnKey(title);
    let column = byKey.get(key);
    if (!column) {
      column = { id: `live-${key}`, title, cards: [] };
      byKey.set(key, column);
    }
    const budget = item.tokenBudget && item.tokenBudget > 0
      ? `${item.tokensUsed || 0}/${item.tokenBudget} tok`
      : '';
    const bits = [
      item.title,
      item.sourceKind === 'contract' ? '**contract**' : '',
      item.branch ? `\`${item.branch}\`` : '',
      item.workspaceMode === 'isolated' ? 'isolated' : '',
      budget,
      item.stopReason ? `stopped: ${item.stopReason}` : '',
      item.prUrl ? `[PR](${item.prUrl})` : '',
      item.contract ? `\n\n${item.contract.slice(0, 280)}${item.contract.length > 280 ? '…' : ''}` : '',
      item.summary ? `\n\n${item.summary}` : '',
    ].filter(Boolean);
    column.cards.push({
      id: `work:${item.id}`,
      text: bits.join(' · ').replace(/ · \n\n/g, '\n\n'),
      checked: item.status === 'done',
      sourceId: item.id,
      sourceTitle: item.sourceKind === 'mission'
        ? 'Live mission work'
        : item.sourceKind === 'contract'
          ? 'Live contract'
          : 'Live work item',
      live: true,
      workItemId: item.id,
      branch: item.branch,
      workspaceMode: item.workspaceMode,
    });
  }
  return order
    .map((title) => byKey.get(columnKey(title))!)
    .filter((column) => column.cards.length > 0);
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

/** Fold live work-item columns into note-backed Superkanban columns. */
export function mergeLiveWorkIntoKanban(
  boardColumns: SuperkanbanColumn[],
  liveColumns: SuperkanbanColumn[],
): SuperkanbanColumn[] {
  if (liveColumns.length === 0) return boardColumns;
  const columns = boardColumns.map((column) => ({ ...column, cards: [...column.cards] }));
  const byKey = new Map(columns.map((column) => [columnKey(column.title), column]));
  for (const live of liveColumns) {
    const key = columnKey(live.title);
    let target = byKey.get(key);
    if (!target) {
      target = { id: live.id, title: live.title, cards: [] };
      byKey.set(key, target);
      columns.push(target);
    }
    // Live cards lead the lane so mission work is visible first.
    target.cards = [...live.cards, ...target.cards];
  }
  return columns;
}

interface SuperkanbanViewProps {
  notes: Note[];
  loading: boolean;
  error: string | null;
  onOpenNote: (id: string) => void;
  /** Durable work items for this vault (mission twins + channel work). */
  liveWorkItems?: WorkItem[];
}

export function SuperkanbanView({ notes, loading, error, onOpenNote, liveWorkItems }: SuperkanbanViewProps) {
  return (
    <ErrorBoundary label="Superkanban">
      <SuperkanbanViewInner
        notes={notes}
        loading={loading}
        error={error}
        onOpenNote={onOpenNote}
        liveWorkItems={liveWorkItems}
      />
    </ErrorBoundary>
  );
}

function SuperkanbanViewInner({
  notes,
  loading,
  error,
  onOpenNote,
  liveWorkItems = [],
}: SuperkanbanViewProps) {
  const [query, setQuery] = useState('');
  const columns = useMemo(() => {
    const boards = mergeKanbanSources((notes || []).map((note) => ({
      id: note.id,
      title: note.title,
      content: typeof note.content === 'string' ? note.content : '',
    })));
    return mergeLiveWorkIntoKanban(boards, workItemsToLiveColumns(liveWorkItems || []));
  }, [notes, liveWorkItems]);
  const liveCount = (liveWorkItems || []).filter((item) => (
    item.sourceKind === 'mission' || item.sourceKind === 'contract'
  )).length;
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (loading) return <div className="superkanban-empty">Loading your Kanban boards…</div>;
  if (error) return <div className="superkanban-empty">{error}</div>;
  if (columns.length === 0) {
    return (
      <div className="superkanban-empty">
        <LayoutDashboard size={32} aria-hidden="true" />
        <strong>No Kanban boards yet</strong>
        <p>Create a note with the Kanban board format — or run a mission and live work appears here.</p>
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
        <span className="kanban-portability">
          {notes.length} boards
          {liveCount > 0 ? ` · ${liveCount} live contracts/tasks` : ''}
          {' · read-only aggregate'}
        </span>
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
                  <article
                    className={`kanban-card${card.checked ? ' is-complete' : ''}${card.live ? ' is-live-work' : ''}`}
                    key={card.id}
                  >
                    <div className="kanban-card-title"><ReactMarkdown remarkPlugins={[remarkGfm]}>{card.text || ''}</ReactMarkdown></div>
                    {card.live ? (
                      <span className="superkanban-source is-live" title={card.branch || card.workItemId || 'Live work'}>
                        {card.sourceTitle}
                        {card.workspaceMode === 'isolated' ? ' · isolated' : ''}
                      </span>
                    ) : (
                      <button type="button" className="superkanban-source" onClick={() => onOpenNote(card.sourceId)} title={`Open ${card.sourceTitle}`}>
                        {card.sourceTitle}
                      </button>
                    )}
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
