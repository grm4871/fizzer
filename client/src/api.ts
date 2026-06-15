/* ═══════════════════════════════════════════════════════════
   Cascade Notes — Types & API Client
   ═══════════════════════════════════════════════════════════ */

export type User = { id: number; username: string };

export type Vault = {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
};

export type Folder = {
  id: string;
  vault_id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: string;
};

export type NoteSummary = {
  id: string;
  vault_id: string;
  folder_id: string | null;
  title: string;
  content_preview: string;
  is_pinned: number;
  is_archived: number;
  word_count: number;
  created_at: string;
  updated_at: string;
  tags: string[];
};

export type Note = NoteSummary & {
  content: string;
  file_path: string;
};

export type Tag = {
  id: string;
  name: string;
  color: string | null;
  count: number;
};

export type NoteVersion = {
  id: string;
  note_id: string;
  label: string | null;
  created_at: string;
};

export type SearchResult = {
  id: string;
  title: string;
  snippet: string;
  rank: number;
};

export type BacklinkResult = {
  id: string;
  title: string;
  context: string | null;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphNode = {
  id: string;
  title: string;
  folder_id: string | null;
};

export type GraphEdge = {
  source: string;
  target: string;
};

/* ─── API Client ─────────────────────────────────────────── */

const API_BASE = import.meta.env.VITE_API_URL || '';

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

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

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
