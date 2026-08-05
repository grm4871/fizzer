'use strict';

/**
 * Exercises the workspace manager against real git repositories in a temp dir —
 * the safety rules (dirty / unpushed / primary checkout) are the whole point of
 * the module, and mocking git would test the mock instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-wt-'));
process.env.CASCADE_WORKTREE_ROOT = path.join(scratch, 'workspaces');

const wt = require('./worktrees.cjs');

function makeRepo(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  g('add', '.');
  g('commit', '-m', 'init');
  return dir;
}

test('slugs are restricted, not silently mangled into odd paths', () => {
  assert.equal(wt.normalizeSlug('Native PRs'), 'native-prs');
  assert.equal(wt.normalizeSlug('  ../escape  '), 'escape');
  assert.equal(wt.normalizeSlug('!!!'), null);
  assert.equal(wt.normalizeSlug(''), null);
});

test('non-repositories are reported rather than treated as a repo', async () => {
  const plain = path.join(scratch, 'not-a-repo');
  fs.mkdirSync(plain, { recursive: true });
  const repo = await wt.resolveRepo(plain);
  assert.equal(repo.isRepo, false);
  const listed = await wt.listWorkspaces(plain);
  assert.equal(listed.ok, false);
});

test('creates an isolated workspace on its own branch, outside the checkout', async () => {
  const repo = makeRepo('alpha');
  const created = await wt.createWorkspace({ dir: repo, slug: 'Native PRs', channelId: 'chan-1' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.branch, 'cascade/native-prs');
  assert.equal(created.baseBranch, 'main');
  assert.ok(created.path.startsWith(process.env.CASCADE_WORKTREE_ROOT));
  assert.ok(fs.existsSync(path.join(created.path, 'README.md')));

  // Editing the workspace must not touch the primary checkout.
  fs.writeFileSync(path.join(created.path, 'README.md'), '# changed\n');
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# repo\n');

  const dup = await wt.createWorkspace({ dir: repo, slug: 'native-prs' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already exists/);

  const listed = await wt.listWorkspaces(repo);
  assert.equal(listed.ok, true);
  assert.equal(listed.workspaces.length, 2);
  const managed = listed.workspaces.find((w) => w.managed);
  assert.equal(managed.branch, 'cascade/native-prs');
  assert.equal(managed.channelId, 'chan-1');
  assert.equal(listed.workspaces.find((w) => w.isPrimary).managed, false);
});

test('prepares one exact task branch and recovers it idempotently by work item', async () => {
  const repo = makeRepo('mission-owned');
  const branch = 'cascade/mission-123/fix-renderer-task-9';
  const first = await wt.prepareWorkspace({
    dir: repo,
    branch,
    channelId: 'chan-mission',
    workItemId: 'work-item-9',
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.resumed, undefined);
  assert.equal(first.branch, branch);
  assert.equal(first.repository, repo);
  assert.ok(first.baseCommit);

  const recovered = await wt.prepareWorkspace({
    // Recovery is registry-owned and does not depend on the stale server path.
    dir: path.join(repo, 'missing-old-path'),
    branch,
    channelId: 'chan-mission',
    workItemId: 'work-item-9',
  });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.resumed, true);
  assert.equal(recovered.path, first.path);
  assert.equal(recovered.baseCommit, first.baseCommit);

  const hijack = await wt.prepareWorkspace({
    dir: repo,
    branch,
    workItemId: 'different-work-item',
  });
  assert.equal(hijack.ok, false);
  assert.match(hijack.error, /owned by another workspace|already exists/);
});

test('status separates uncommitted changes from unpushed commits', async () => {
  const repo = makeRepo('beta');
  const created = await wt.createWorkspace({ dir: repo, slug: 'work' });
  fs.writeFileSync(path.join(created.path, 'new.txt'), 'hello\n');

  const dirty = await wt.workspaceStatus(created.path);
  assert.equal(dirty.ok, true);
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.isPrimary, false);
  assert.deepEqual(dirty.changedFiles.map((f) => f.path), ['new.txt']);
  assert.equal(dirty.commits.length, 0);

  execFileSync('git', ['add', '.'], { cwd: created.path });
  execFileSync('git', ['commit', '-m', 'add new file'], { cwd: created.path });

  const committed = await wt.workspaceStatus(created.path);
  assert.equal(committed.dirty, false);
  assert.equal(committed.commits.length, 1);
  assert.equal(committed.commits[0].subject, 'add new file');
  assert.equal(committed.unpushed, 1);
  assert.equal(committed.branch, 'cascade/work');

  const primary = await wt.workspaceStatus(repo);
  assert.equal(primary.isPrimary, true);
});

test('removal refuses to discard work, and never touches the primary checkout', async () => {
  const repo = makeRepo('gamma');
  const created = await wt.createWorkspace({ dir: repo, slug: 'risky' });
  fs.writeFileSync(path.join(created.path, 'draft.txt'), 'unsaved\n');

  const dirtyRemove = await wt.removeWorkspace({ dir: created.path });
  assert.equal(dirtyRemove.ok, false);
  assert.equal(dirtyRemove.needsForce, true);
  assert.ok(fs.existsSync(created.path));

  execFileSync('git', ['add', '.'], { cwd: created.path });
  execFileSync('git', ['commit', '-m', 'work'], { cwd: created.path });

  const unpushedRemove = await wt.removeWorkspace({ dir: created.path });
  assert.equal(unpushedRemove.ok, false);
  assert.match(unpushedRemove.error, /only here/);

  const primaryRemove = await wt.removeWorkspace({ dir: repo, force: true });
  assert.equal(primaryRemove.ok, false);
  assert.match(primaryRemove.error, /primary checkout/);
  assert.ok(fs.existsSync(path.join(repo, 'README.md')));

  const forced = await wt.removeWorkspace({ dir: created.path, force: true });
  assert.equal(forced.ok, true, forced.error);
  assert.equal(fs.existsSync(created.path), false);
  const listed = await wt.listWorkspaces(repo);
  assert.equal(listed.workspaces.filter((w) => w.managed).length, 0);
});

test('a clean workspace with no commits cannot open a pull request', async () => {
  const repo = makeRepo('delta');
  const created = await wt.createWorkspace({ dir: repo, slug: 'empty' });
  const pr = await wt.createPullRequest({ dir: created.path, title: 'nope' });
  assert.equal(pr.ok, false);
  assert.match(pr.error, /commit something/);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
