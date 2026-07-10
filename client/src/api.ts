/**
 * @file api.ts — Typed fetch wrapper and shared domain types
 *
 * Provides a generic `api<T>()` function that wraps `fetch` with:
 * - Automatic JWT Bearer token injection from `localStorage('docs_token')`
 * - JSON Content-Type headers
 * - Error extraction from server JSON responses
 * - Auto-logout on 401 (clears stored token)
 *
 * Also exports all shared domain types (User, Vault, Folder, Note, etc.)
 * and date formatting utilities used across the client.
 *
 * @module
 */

/* ═══════════════════════════════════════════════════════════
   Cascade Notes — Types & API Client
   ═══════════════════════════════════════════════════════════ */

/** Authenticated user record. */
export type User = { id: number; username: string };

/** A vault (workspace) containing folders and notes. */
export type Vault = {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
};

/** A folder within a vault; supports nesting via `parent_id`. */
export type Folder = {
  id: string;
  vault_id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: string;
};

/** Lightweight note metadata returned in list endpoints (no full content). */
export type NoteSummary = {
  id: string;
  vault_id: string;
  folder_id: string | null;
  title: string;
  content_preview: string;
  is_pinned: number;
  is_archived: number;
  is_listed: number;
  word_count: number;
  created_at: string;
  updated_at: string;
  tags: string[];
};

/** Full note record including markdown content and file path. */
export type Note = NoteSummary & {
  content: string;
  file_path: string;
};

/** Public publish metadata for a note. */
export type NotePublishInfo = {
  published: boolean;
  slug?: string;
  url?: string;
  published_at?: string;
  updated_at?: string;
};

/** A full-text search result with a ranked snippet. */
export type SearchResult = {
  id: string;
  title: string;
  snippet: string;
  rank: number;
};

/* ─── API Client ─────────────────────────────────────────── */

const API_BASE = import.meta.env.VITE_API_URL || '';

/**
 * Generic typed fetch wrapper for the Cascade API.
 *
 * Automatically attaches the JWT token from localStorage and parses the
 * JSON response. Throws an `Error` with the server's error message on
 * non-2xx responses and clears the stored token on 401.
 *
 * @template T - Expected shape of the JSON response body
 * @param path - API path (e.g. `/api/vaults`)
 * @param options - Standard `RequestInit` options (method, body, headers, etc.)
 * @returns Parsed JSON response typed as `T`
 */
export async function api<T>(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem('docs_token');
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) localStorage.removeItem('docs_token');
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data as T;
}

/**
 * Format an ISO date string into a locale-appropriate medium date + short time.
 * Example output: "Jun 15, 2026, 3:45 PM"
 */
export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

/**
 * Format an ISO date string as a human-friendly relative time.
 * Returns "Just now", "5m ago", "3h ago", "2d ago", or falls back to
 * `formatDate()` for dates older than a week.
 */
export function formatRelativeDate(value: string) {
  const now = Date.now();
  const then = new Date(value).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(value);
}
