/**
 * @file workspaces.ts — renderer side of task workspaces (git worktrees)
 *
 * Thin typed bridge over the desktop IPC in `cascade-electron/worktrees.cjs`,
 * plus the pure helpers the panel needs. Git never runs in the renderer, so in
 * a browser tab the bridge is simply absent and the UI hides itself.
 */

export type Workspace = {
  path: string;
  branch: string;
  isPrimary: boolean;
  managed: boolean;
  channelId: string | null;
  baseBranch: string | null;
  createdAt: string | null;
  exists: boolean;
};

export type WorkspaceStatus = {
  ok: true;
  path: string;
  repo: string;
  branch: string;
  head: string;
  isPrimary: boolean;
  baseBranch: string;
  dirty: boolean;
  changedFiles: Array<{ status: string; path: string }>;
  commits: Array<{ sha: string; subject: string }>;
  unpushed: number;
  behindBase: number;
  hasUpstream: boolean;
};

export type PullRequest = {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  checks: { total: number; failing: number; pending: number };
};

type Failure = { ok: false; error: string; needsForce?: boolean };

export type WorkspaceBridge = {
  listWorktrees: (dir: string) => Promise<{ ok: true; repo: string; primaryRoot: string; workspaces: Workspace[] } | Failure>;
  getWorktreeStatus: (dir: string) => Promise<WorkspaceStatus | Failure>;
  createWorktree: (opts: { dir: string; slug: string; channelId?: string }) => Promise<{ ok: true; path: string; branch: string } | Failure>;
  removeWorktree: (opts: { dir: string; force?: boolean }) => Promise<{ ok: true; path: string } | Failure>;
  createWorktreePullRequest: (opts: { dir: string; title?: string; body?: string; draft?: boolean }) => Promise<{ ok: true; url: string; branch: string; base: string; draft: boolean } | Failure>;
  getWorktreePullRequest: (dir: string) => Promise<{ ok: true; pr: PullRequest | null } | Failure>;
};

/** The desktop bridge, or undefined in a browser / older desktop shell. */
export function workspaceBridge(): WorkspaceBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const api = (window as unknown as { electronAPI?: Partial<WorkspaceBridge> }).electronAPI;
  if (!api?.listWorktrees || !api.createWorktree) return undefined;
  return api as WorkspaceBridge;
}

/**
 * Default name for a new workspace, from the channel it will serve. Mirrors the
 * main process's slug rules so the input shows what will actually be created.
 */
export function suggestWorkspaceSlug(channelName: string): string {
  return String(channelName || '')
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** One-line summary of what is sitting in a workspace, for the chip/row. */
export function describeStatus(status: WorkspaceStatus): string {
  const parts: string[] = [];
  if (status.changedFiles.length) parts.push(`${status.changedFiles.length} changed`);
  if (status.commits.length) parts.push(`${status.commits.length} commit${status.commits.length === 1 ? '' : 's'}`);
  if (status.unpushed) parts.push(`${status.unpushed} unpushed`);
  if (status.behindBase) parts.push(`${status.behindBase} behind ${status.baseBranch}`);
  return parts.length ? parts.join(' · ') : 'clean';
}

/** A workspace is safe to delete when nothing would be lost with it. */
export function isSafeToRemove(status: WorkspaceStatus): boolean {
  return !status.isPrimary && !status.dirty && status.unpushed === 0;
}
