export type User = { id: number; username: string };
export type Workspace = { id: number; name: string; repo_path: string; specs_dir: string; created_at: string };
export type SpecSummary = {
  id: string;
  workspace_id: number;
  rel_path: string;
  title: string;
  status: SpecStatus;
  targets: string[];
  depends: string[];
  updated_at: string;
};
export type Spec = SpecSummary & { content: string; file_path: string };
export type SpecStatus = 'draft' | 'ready' | 'implementing' | 'implemented' | 'stale';
export type SpecVersion = { id: number; spec_id: string; label: string | null; created_at: string };
export type RunStatus = 'queued' | 'running' | 'awaiting_review' | 'merged' | 'discarded' | 'failed';
export type Run = {
  id: number;
  spec_id: string;
  kind: 'reconcile' | 'describe';
  base_version_id: number | null;
  head_version_id: number;
  status: RunStatus;
  branch_name: string;
  worktree_path: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
};
export type RunEvent = {
  id: number;
  run_id: number;
  seq: number;
  type: string;
  payload_json: string;
  ts: string;
};
export type ThreadMessage = { id: number; thread_id: number; role: 'user' | 'agent' | 'system'; content: string; created_at: string };
export type SpecThread = {
  id: number;
  spec_id: string;
  anchor: string;
  status: 'open' | 'resolved' | 'dismissed';
  run_id: number | null;
  created_at: string;
  updated_at: string;
  messages: ThreadMessage[];
};

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
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
