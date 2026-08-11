/**
 * @file CommandPalette.tsx — Quick note switcher with fuzzy filtering
 *
 * A modal overlay (Ctrl+P) that lets users quickly find and open notes by
 * typing a query. Filters notes by title and tags using substring matching.
 * Supports full keyboard navigation:
 * - Arrow keys to move highlight
 * - Enter to select highlighted note (or create a new note if no matches)
 * - Escape to close
 *
 * The highlighted item auto-scrolls into view. When no results match and a
 * query is entered, offers a "Create note" action.
 *
 * @component
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { NoteSummary } from '../api';
import { Search, Sparkles, FileText } from 'lucide-react';
import { moveListSelection, useListSelection } from '../ui/listNavigation';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  notes: NoteSummary[];
  onSelectNote: (id: string) => void;
  onCreateNote: () => void;
}

export function CommandPalette({
  open,
  onClose,
  notes,
  onSelectNote,
  onCreateNote,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlightIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Fuzzy filter
  const filtered = query.trim()
    ? notes.filter((note) => {
        const q = query.toLowerCase();
        const title = (note.title || '').toLowerCase();
        const tags = note.tags.join(' ').toLowerCase();
        return title.includes(q) || tags.includes(q);
      })
    : notes;

  useListSelection(listRef, highlightIndex, filtered.length, setHighlightIndex);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightIndex((i) => moveListSelection(i, 1, filtered.length));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightIndex((i) => moveListSelection(i, -1, filtered.length));
          break;
        case 'Enter':
          e.preventDefault();
          if (filtered[highlightIndex]) {
            onSelectNote(filtered[highlightIndex].id);
            onClose();
          } else if (query.trim()) {
            onCreateNote();
            onClose();
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, highlightIndex, onSelectNote, onClose, onCreateNote, query],
  );

  if (!open) return null;

  return (
    <div
      className="overlay-backdrop"
      id="command-palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="command-palette" id="command-palette" role="dialog" aria-modal="true" aria-label="Open anything">
        <div className="command-palette-input-wrap">
          <span className="search-icon"><Search size={16} /></span>
          <input
            ref={inputRef}
            id="command-palette-input"
            className="command-palette-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlightIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search notes or type to create..."
          />
        </div>

        <div className="command-palette-results" ref={listRef}>
          {filtered.length === 0 && query.trim() && (
            <button
              className="command-palette-item highlighted"
              onClick={() => {
                onCreateNote();
                onClose();
              }}
            >
              <span className="item-icon"><Sparkles size={16} /></span>
              <span className="item-info">
                <span className="item-title">Create &quot;{query}&quot;</span>
                <span className="item-path">New note</span>
              </span>
            </button>
          )}

          {filtered.length === 0 && !query.trim() && (
            <div className="palette-empty">
              Start typing to search your notes...
            </div>
          )}

          {filtered.map((note, index) => (
            <button
              key={note.id}
              id={`palette-item-${note.id}`}
              className={`command-palette-item ${index === highlightIndex ? 'highlighted' : ''}`}
              onClick={() => {
                onSelectNote(note.id);
                onClose();
              }}
              onMouseEnter={() => setHighlightIndex(index)}
            >
              <span className="item-icon"><FileText size={16} /></span>
              <span className="item-info">
                <span className="item-title">{note.title || 'Untitled'}</span>
                <span className="item-path">
                  {note.content_preview?.slice(0, 60) || 'Empty note'}
                </span>
              </span>
              {note.tags.length > 0 && (
                <span className="item-tags">
                  {note.tags.slice(0, 2).map((tag) => (
                    <span key={tag} className="badge">{tag}</span>
                  ))}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="command-palette-footer">
          <span>
            <kbd>↑↓</kbd> navigate &nbsp; <kbd>↵</kbd> select &nbsp; <kbd>esc</kbd> close
          </span>
          <span>{filtered.length} notes</span>
        </div>
      </section>
    </div>
  );
}
