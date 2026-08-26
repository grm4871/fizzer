import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Archive,
  Check,
  ChevronDown,
  GripVertical,
  LayoutDashboard,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';
import { KanbanInlineEditInput } from './KanbanInlineEditInput';
import {
  addKanbanCard,
  addKanbanColumn,
  archiveCompletedKanbanCards,
  archiveKanbanCard,
  archiveKanbanColumnCards,
  deleteKanbanColumn,
  hasSuperkanbanMarker,
  initializeKanbanMarkdown,
  moveKanbanCard,
  parseKanbanMarkdown,
  renameKanbanCard,
  renameKanbanColumn,
  setSuperkanbanMarker,
  toggleKanbanCard,
  type KanbanCard,
  type KanbanColumn,
} from './kanbanMarkdown';


interface KanbanViewProps {
  content: string;
  onContentChange: (content: string) => void;
  showSuperkanbanToggle?: boolean;
}

/** UI state follows source order: drafts/editing are local, while every commit,
 * drag drop, toggle, and archive transition emits a complete Markdown update. */
type EditingValue = { id: string; value: string } | null;
type DropTarget = { cardId: string; placement: 'before' | 'after' } | null;

function CardMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        p: ({ children }) => <>{children}</>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export function KanbanView({ content, onContentChange, showSuperkanbanToggle = false }: KanbanViewProps) {
  return (
    <ErrorBoundary label="Kanban">
      <KanbanViewInner content={content} onContentChange={onContentChange} showSuperkanbanToggle={showSuperkanbanToggle} />
    </ErrorBoundary>
  );
}

function KanbanViewInner({ content, onContentChange, showSuperkanbanToggle = false }: KanbanViewProps) {
  const board = useMemo(() => parseKanbanMarkdown(content), [content]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [editingCard, setEditingCard] = useState<EditingValue>(null);
  const [editingColumn, setEditingColumn] = useState<EditingValue>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());
  const [columnMenu, setColumnMenu] = useState<string | null>(null);
  const [columnDraft, setColumnDraft] = useState('');
  const [search, setSearch] = useState('');

  // The column menu is a popup like the context menus: Escape and an outside
  // click must close it, not just a second press on its own trigger.
  useEffect(() => {
    if (!columnMenu) return;
    const close = () => setColumnMenu(null);
    // `KeyboardEvent` is React's synthetic type in this file; take the DOM one.
    const onKeyDown = (event: WindowEventMap['keydown']) => {
      if (event.key === 'Escape') close();
    };
    const timer = window.setTimeout(() => window.addEventListener('click', close), 0);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [columnMenu]);

  if (!board.columns.length) {
    return (
      <div className="kanban-empty">
        <div className="kanban-empty-icon">▦</div>
        <strong>Turn this note into an Obsidian-compatible board</strong>
        <p>Lists, cards, archive, and settings remain ordinary portable Markdown.</p>
        <button type="button" onClick={() => onContentChange(initializeKanbanMarkdown(content))}>
          <Plus size={14} /> Create board
        </button>
      </div>
    );
  }

  const commitCardEdit = () => {
    if (!editingCard) return;
    onContentChange(renameKanbanCard(content, editingCard.id, editingCard.value));
    setEditingCard(null);
  };

  const commitColumnEdit = () => {
    if (!editingColumn) return;
    onContentChange(renameKanbanColumn(content, editingColumn.id, editingColumn.value));
    setEditingColumn(null);
  };

  const submitCard = (event: FormEvent, column: KanbanColumn) => {
    event.preventDefault();
    const text = drafts[column.id]?.trim();
    if (!text) return;
    onContentChange(addKanbanCard(content, column.id, text));
    setDrafts((current) => ({ ...current, [column.id]: '' }));
  };

  const submitColumn = (event: FormEvent) => {
    event.preventDefault();
    if (!columnDraft.trim()) return;
    onContentChange(addKanbanColumn(content, columnDraft));
    setColumnDraft('');
  };

  const dropCardInColumn = (event: DragEvent, column: KanbanColumn) => {
    event.preventDefault();
    const cardId = draggedCardId || event.dataTransfer.getData('text/cascade-kanban-card');
    if (cardId) onContentChange(moveKanbanCard(content, cardId, column.id));
    setDraggedCardId(null);
    setDropTarget(null);
  };

  const dropCardOnCard = (event: DragEvent, column: KanbanColumn, card: KanbanCard) => {
    event.preventDefault();
    event.stopPropagation();
    const cardId = draggedCardId || event.dataTransfer.getData('text/cascade-kanban-card');
    if (cardId) {
      onContentChange(moveKanbanCard(
        content,
        cardId,
        column.id,
        card.id,
        dropTarget?.cardId === card.id ? dropTarget.placement : 'before',
      ));
    }
    setDraggedCardId(null);
    setDropTarget(null);
  };

  const completedCount = board.columns
    .flatMap((column) => column.cards)
    .filter((card) => card.checked).length;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const inSuperkanban = hasSuperkanbanMarker(content);

  return (
    <div className="kanban-view" aria-label="Kanban board">
      <div className="kanban-toolbar">
        <div className="kanban-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search cards"
            aria-label="Search Kanban cards"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </div>
        <span className="kanban-portability">
          {board.hasObsidianMarker ? 'Obsidian board' : 'Markdown board'}
        </span>
        {showSuperkanbanToggle && (
          <button
            type="button"
            className={`kanban-command-toggle${inSuperkanban ? ' is-active' : ''}`}
            aria-pressed={inSuperkanban}
            onClick={() => onContentChange(setSuperkanbanMarker(content, !inSuperkanban))}
            title="Choose whether this board appears in Superkanban"
          >
            <LayoutDashboard size={14} />
            {inSuperkanban ? 'In Superkanban' : 'Add to Superkanban'}
          </button>
        )}
        <button
          type="button"
          className="kanban-archive-complete"
          disabled={!completedCount}
          onClick={() => onContentChange(archiveCompletedKanbanCards(content))}
          title="Move checked cards to the Markdown archive"
        >
          <Archive size={14} />
          Archive completed
          {completedCount > 0 && <span>{completedCount}</span>}
        </button>
        {board.archive.length > 0 && (
          <span className="kanban-archive-count">{board.archive.length} archived</span>
        )}
      </div>

      <div className="kanban-board">
        {board.columns.map((column) => {
          const collapsed = collapsedColumns.has(column.id);
          const visibleCards = normalizedSearch
            ? column.cards.filter((card) => card.text.toLocaleLowerCase().includes(normalizedSearch))
            : column.cards;
          const exceeded = column.maxItems > 0 && column.cards.length > column.maxItems;
          return (
            <section
              className={`kanban-column${collapsed ? ' is-collapsed' : ''}`}
              key={column.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropCardInColumn(event, column)}
            >
              <header onDoubleClick={() => setEditingColumn({ id: column.id, value: column.rawTitle })}>
                <button
                  type="button"
                  className="kanban-column-collapse"
                  onClick={() => setCollapsedColumns((current) => {
                    const next = new Set(current);
                    if (next.has(column.id)) next.delete(column.id);
                    else next.add(column.id);
                    return next;
                  })}
                  aria-label={collapsed ? `Expand ${column.title}` : `Collapse ${column.title}`}
                >
                  <ChevronDown size={14} />
                </button>
                {editingColumn?.id === column.id ? (
                  <KanbanInlineEditInput
                    className="kanban-column-title-input"
                    value={editingColumn.value}
                    onChange={(value) => setEditingColumn({ id: column.id, value })}
                    onCommit={commitColumnEdit}
                    onCancel={() => setEditingColumn(null)}
                  />
                ) : (
                  <strong>{column.title}</strong>
                )}
                <span className={exceeded ? 'is-exceeded' : ''}>
                  {column.cards.length}{column.maxItems > 0 ? ` / ${column.maxItems}` : ''}
                </span>
                <button
                  type="button"
                  className="kanban-column-menu-button"
                  onClick={() => setColumnMenu((current) => current === column.id ? null : column.id)}
                  aria-label={`More options for ${column.title}`}
                  aria-haspopup="menu"
                  aria-expanded={columnMenu === column.id}
                >
                  <MoreVertical size={14} />
                </button>
                {columnMenu === column.id && (
                  <div className="kanban-column-menu" role="menu" aria-label={`${column.title} list options`}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEditingColumn({ id: column.id, value: column.rawTitle });
                        setColumnMenu(null);
                      }}
                    >
                      <Pencil size={13} /> Rename list
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!column.cards.length}
                      onClick={() => {
                        onContentChange(archiveKanbanColumnCards(content, column.id));
                        setColumnMenu(null);
                      }}
                    >
                      <Archive size={13} /> Archive cards
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={() => {
                        if (window.confirm(`Delete “${column.title}” and its ${column.cards.length} card(s)?`)) {
                          onContentChange(deleteKanbanColumn(content, column.id));
                        }
                        setColumnMenu(null);
                      }}
                    >
                      <Trash2 size={13} /> Delete list
                    </button>
                  </div>
                )}
              </header>

              {!collapsed && (
                <>
                  <div className="kanban-cards">
                    {visibleCards.map((card) => (
                      <article
                        className={[
                          'kanban-card',
                          card.checked ? 'is-complete' : '',
                          dropTarget?.cardId === card.id ? `is-drop-${dropTarget.placement}` : '',
                        ].filter(Boolean).join(' ')}
                        key={card.id}
                        draggable={editingCard?.id !== card.id}
                        onDragStart={(event) => {
                          setDraggedCardId(card.id);
                          event.dataTransfer.setData('text/cascade-kanban-card', card.id);
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const rect = event.currentTarget.getBoundingClientRect();
                          setDropTarget({
                            cardId: card.id,
                            placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
                          });
                        }}
                        onDrop={(event) => dropCardOnCard(event, column, card)}
                        onDragEnd={() => {
                          setDraggedCardId(null);
                          setDropTarget(null);
                        }}
                        onDoubleClick={() => setEditingCard({ id: card.id, value: card.text })}
                      >
                        <GripVertical size={14} className="kanban-card-grip" aria-hidden="true" />
                        <button
                          type="button"
                          className="kanban-card-check"
                          onClick={(event) => onContentChange(
                            event.metaKey || event.ctrlKey
                              ? archiveKanbanCard(content, card.id)
                              : toggleKanbanCard(content, card.id),
                          )}
                          title="Click to complete · Ctrl/Cmd-click to archive"
                          aria-label={card.checked ? 'Mark incomplete' : 'Mark complete'}
                        >
                          {card.checked && <Check size={12} />}
                        </button>
                        {editingCard?.id === card.id ? (
                          <KanbanInlineEditInput
                            className="kanban-card-title-input"
                            value={editingCard.value}
                            onChange={(value) => setEditingCard({ id: card.id, value })}
                            onCommit={commitCardEdit}
                            onCancel={() => setEditingCard(null)}
                          />
                        ) : (
                          <div className="kanban-card-title"><CardMarkdown text={card.text} /></div>
                        )}
                        <button
                          type="button"
                          className="kanban-card-delete"
                          onClick={() => onContentChange(archiveKanbanCard(content, card.id))}
                          aria-label={`Archive ${card.text}`}
                          title="Archive card"
                        >
                          <Archive size={12} />
                        </button>
                      </article>
                    ))}
                    {normalizedSearch && visibleCards.length === 0 && (
                      <div className="kanban-no-matches">No matching cards</div>
                    )}
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
                </>
              )}
            </section>
          );
        })}

        <form className="kanban-add-column" onSubmit={submitColumn}>
          <input
            value={columnDraft}
            onChange={(event) => setColumnDraft(event.target.value)}
            placeholder="Add list…"
            aria-label="New Kanban list name"
          />
          <button type="submit" aria-label="Add Kanban list"><Plus size={14} /></button>
        </form>
      </div>
    </div>
  );
}
