/**
 * Client helpers for durable work items (server work_items schema).
 */
import { api } from '../api';

export type WorkItemStatus =
  | 'open'
  | 'leased'
  | 'in_progress'
  | 'review'
  | 'blocked'
  | 'done'
  | 'canceled';

export type WorkspaceMode = 'shared' | 'isolated' | 'existing';

export type WorkItem = {
  id: string;
  vaultId: string;
  channelId: string | null;
  title: string;
  brief: string;
  /** Accepted clarification / acceptance criteria (the item is the contract). */
  contract?: string;
  status: WorkItemStatus;
  priority: number;
  sourceKind: 'message' | 'note' | 'kanban' | 'manual' | 'mission' | 'contract' | string;
  sourceId: string;
  assigneeRegistrationId: string | null;
  leaseHolder: string | null;
  leaseExpiresAt: string | null;
  repository: string;
  baseCommit: string;
  branch: string;
  workspaceMode: WorkspaceMode;
  worktreePath: string;
  prNumber: number | null;
  prUrl: string;
  prState: string;
  summary: string;
  verification: string;
  gitState: import('./workspaces').WorkItemGitState | null;
  gitStateUpdatedAt: string | null;
  reviewReadiness: { ready: boolean; blockers: string[] };
  tokenBudget?: number;
  tokensUsed?: number;
  stopReason?: string;
  dependsOn: string[];
  runIds: number[];
  createdBy: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemReview = {
  id: string;
  workItemId: string;
  kind: 'handoff' | 'comment' | 'change_request';
  authorUserId: number | null;
  authorUsername: string;
  fromRegistrationId: string | null;
  toRegistrationId: string | null;
  note: string;
  filePath: string;
  line: number | null;
  baseCommit: string;
  headCommit: string;
  status: string;
  createdAt: string;
};

export async function listChannelWorkItems(vaultId: string, channelId: string) {
  const data = await api<{ items: WorkItem[] }>(
    `/api/vaults/${vaultId}/work-items?channelId=${encodeURIComponent(channelId)}`,
  );
  return data.items || [];
}

export async function createChannelWorkItem(
  vaultId: string,
  input: {
    title: string;
    brief?: string;
    contract?: string;
    channelId: string;
    sourceKind?: string;
    sourceId?: string;
    repository?: string;
    workspaceMode?: WorkspaceMode;
    worktreePath?: string;
    branch?: string;
    baseCommit?: string;
    tokenBudget?: number;
  },
) {
  const data = await api<{ item: WorkItem }>(`/api/vaults/${vaultId}/work-items`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.item;
}

export async function fetchWorkItem(id: string) {
  return api<{ item: WorkItem; reviews: WorkItemReview[]; siblings: WorkItem[] }>(
    `/api/work-items/${encodeURIComponent(id)}`,
  );
}

export async function createWorkItemReview(
  id: string,
  input: {
    kind: 'comment' | 'change_request';
    note: string;
    filePath?: string;
    line?: number;
    baseCommit: string;
    headCommit: string;
  },
) {
  const data = await api<{ review: WorkItemReview }>(`/api/work-items/${encodeURIComponent(id)}/reviews`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.review;
}

export async function patchWorkItem(id: string, patch: Partial<WorkItem> & { dependsOn?: string[] }) {
  const data = await api<{ item: WorkItem }>(`/api/work-items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return data.item;
}

export async function leaseWorkItem(id: string, holder: string) {
  const data = await api<{ item: WorkItem }>(`/api/work-items/${encodeURIComponent(id)}/lease`, {
    method: 'POST',
    body: JSON.stringify({ holder }),
  });
  return data.item;
}

export async function releaseWorkItem(id: string, holder?: string) {
  const data = await api<{ item: WorkItem }>(`/api/work-items/${encodeURIComponent(id)}/release`, {
    method: 'POST',
    body: JSON.stringify({ holder }),
  });
  return data.item;
}

export function workItemStatusLabel(status: WorkItemStatus): string {
  return status.replace(/_/g, ' ');
}
