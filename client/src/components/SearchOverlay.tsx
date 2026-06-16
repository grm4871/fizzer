/**
 * @file SearchOverlay.tsx — Debounced full-text search overlay
 *
 * A modal overlay (Ctrl+Shift+F) that performs server-side full-text search
 * across all notes in the active vault. Features:
 * - 300ms debounced API calls to avoid excessive requests
 * - Keyboard navigation (arrow keys, Enter, Escape)
 * - Highlighted matching text in result snippets via `<mark>` tags
 * - Auto-scrolling of the highlighted result into view
 *
 * @param props.open - Whether the overlay is visible
 * @param props.onClose - Called when the overlay should close
 * @param props.vaultId - Active vault ID for scoping search
 * @param props.onSelectNote - Called when a search result is selected
 *
 * @component
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { api, type SearchResult } from '../api';
import { Search, Loader2 } from 'lucide-react';

interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
  vaultId: string | null;
  onSelectNote: (id: string) => void;
}

export function SearchOverlay({
  open,
  onClose,
  vaultId,
  onSelectNote,
}: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setHighlightIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Debounced search
  const doSearch = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!q.trim() || !vaultId) {
        setResults([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      debounceRef.current = setTimeout(async () => {
        try {
          const data = await api<{ results: SearchResult[] }>(
            `/api/vaults/${vaultId}/search?q=${encodeURIComponent(q)}`,
          );
          setResults(data.results ?? []);
        } catch {
          setResults([]);
        } finally {
          setLoading(false);
        }
      }, 300);
    },
    [vaultId],
  );

  useEffect(() => {
    doSearch(query);
  }, [query, doSearch]);

  // Clamp highlight
  useEffect(() => {
    if (highlightIndex >= results.length) {
      setHighlightIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, highlightIndex]);

  // Scroll highlighted into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[highlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (results[highlightIndex]) {
            onSelectNote(results[highlightIndex].id);
            onClose();
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, highlightIndex, onSelectNote, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="overlay-backdrop"
      id="search-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="search-overlay" id="search-overlay">
        <div className="search-input-wrap">
          <span className="search-icon"><Search size={16} /></span>
          <input
            ref={inputRef}
            id="search-input"
            className="search-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlightIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search across all your notes..."
          />
          {loading && <span className="text-tertiary text-xs" style={{ display: 'flex', alignItems: 'center' }}><Loader2 size={14} /></span>}
        </div>

        <div className="search-results" ref={listRef}>
          {results.map((result, index) => (
            <button
              key={result.id}
              id={`search-result-${result.id}`}
              className={`search-result-item ${index === highlightIndex ? 'highlighted' : ''}`}
              onClick={() => {
                onSelectNote(result.id);
                onClose();
              }}
              onMouseEnter={() => setHighlightIndex(index)}
            >
              <span className="result-title">{result.title || 'Untitled'}</span>
              <span
                className="result-snippet"
                dangerouslySetInnerHTML={{
                  __html: highlightSnippet(result.snippet, query),
                }}
              />
            </button>
          ))}

          {results.length === 0 && query.trim() && !loading && (
            <div className="search-empty">
              <span className="search-empty-icon"><Search size={32} /></span>
              <span>No results found for &quot;{query}&quot;</span>
            </div>
          )}

          {!query.trim() && (
            <div className="search-empty">
              <span className="search-empty-icon"><Search size={32} /></span>
              <span>Search across all your notes</span>
              <span className="text-xs text-tertiary">
                Full-text search with ranked results
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Wrap occurrences of `query` in the snippet with `<mark>` tags for
 * visual highlighting. HTML-escapes both the snippet and query first
 * to prevent XSS from server-provided content.
 */
function highlightSnippet(snippet: string, query: string): string {
  if (!query.trim() || !snippet) return escapeHtml(snippet || '');
  const escaped = escapeHtml(snippet);
  const q = escapeHtml(query.trim());
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(regex, '<mark>$1</mark>');
}

/** Escape HTML special characters to prevent XSS injection. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
