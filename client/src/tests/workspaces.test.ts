import { describe, expect, it } from 'vitest';
import { describeStatus, isSafeToRemove, suggestWorkspaceSlug, workspaceBridge, type WorkspaceStatus } from '../chat/workspaces';

function status(overrides: Partial<WorkspaceStatus> = {}): WorkspaceStatus {
  return {
    ok: true,
    path: '/tmp/ws',
    repo: 'cascade',
    branch: 'cascade/native-prs',
    head: 'abc1234',
    isPrimary: false,
    baseBranch: 'master',
    dirty: false,
    changedFiles: [],
    commits: [],
    unpushed: 0,
    behindBase: 0,
    hasUpstream: false,
    ...overrides,
  };
}

describe('workspace slugs', () => {
  it('derives a branch-safe name from a channel name', () => {
    expect(suggestWorkspaceSlug('#cascade-dev')).toBe('cascade-dev');
    expect(suggestWorkspaceSlug('Native PRs!')).toBe('native-prs');
    expect(suggestWorkspaceSlug('   ')).toBe('');
  });
});

describe('status summary', () => {
  it('reads clean when nothing has accumulated', () => {
    expect(describeStatus(status())).toBe('clean');
  });

  it('separates working-tree changes from commits and push state', () => {
    expect(describeStatus(status({
      dirty: true,
      changedFiles: [{ status: 'M', path: 'a.ts' }, { status: '??', path: 'b.ts' }],
      commits: [{ sha: 'abc', subject: 'work' }],
      unpushed: 1,
      behindBase: 3,
    }))).toBe('2 changed · 1 commit · 1 unpushed · 3 behind master');
  });
});

describe('removal safety', () => {
  it('only calls a workspace safe when nothing would be lost', () => {
    expect(isSafeToRemove(status())).toBe(true);
    expect(isSafeToRemove(status({ dirty: true, changedFiles: [{ status: 'M', path: 'a' }] }))).toBe(false);
    expect(isSafeToRemove(status({ unpushed: 2 }))).toBe(false);
    expect(isSafeToRemove(status({ isPrimary: true }))).toBe(false);
  });
});

describe('bridge detection', () => {
  it('is absent in a plain browser and present on a desktop shell', () => {
    const scope = globalThis as { window?: { electronAPI?: unknown } };
    expect(workspaceBridge()).toBeUndefined();

    scope.window = {};
    expect(workspaceBridge()).toBeUndefined();

    scope.window.electronAPI = { listWorktrees: () => {}, createWorktree: () => {} };
    expect(workspaceBridge()).toBeDefined();

    // An older desktop shell exposes electronAPI without the worktree bridge.
    scope.window.electronAPI = { getConfig: () => {} };
    expect(workspaceBridge()).toBeUndefined();

    delete scope.window;
  });
});
