import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  acquireWorkItemLease,
  addWorkItemTokenUsage,
  createWorkItem,
  createWorkItemHandoff,
  ensureWorkItemSchema,
  getWorkItem,
  linkWorkItemRun,
  listSiblingWorkItems,
  listWorkItems,
  reapExpiredWorkItemLeases,
  reportWorkItemGitState,
  releaseWorkItemLease,
  stopWorkItem,
  updateWorkItem,
} from './workItems.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE
    );
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE vault_members (
      vault_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      PRIMARY KEY (vault_id, user_id)
    );
    INSERT INTO users (id, username) VALUES (1, 'owner');
    INSERT INTO vaults (id, name, created_by) VALUES ('v1', 'Main', 1);
    INSERT INTO vault_members (vault_id, user_id, role) VALUES ('v1', 1, 'owner');
    INSERT INTO notes (id, vault_id, title) VALUES ('ch1', 'v1', 'cascade-dev');
  `);
  ensureWorkItemSchema(db);
  return db;
}

test('create list update work items with dependencies', () => {
  const db = setup();
  try {
    const parent = createWorkItem(db, 1, 'v1', {
      title: 'Foundation',
      channelId: 'ch1',
      repository: '/repo/cascade',
      workspaceMode: 'isolated',
    });
    const child = createWorkItem(db, 1, 'v1', {
      title: 'Feature',
      channelId: 'ch1',
      dependsOn: [parent.id],
      sourceKind: 'message',
      sourceId: 'msg-1',
    });
    assert.deepEqual(child.dependsOn, [parent.id]);
    assert.equal(listWorkItems(db, 1, 'v1', { channelId: 'ch1' }).length, 2);
    const updated = updateWorkItem(db, 1, child.id, { status: 'blocked', summary: 'Waiting on foundation' });
    assert.equal(updated.status, 'blocked');
    assert.equal(updated.summary, 'Waiting on foundation');
  } finally {
    db.close();
  }
});

test('Git evidence binds one base and derives review readiness server-side', () => {
  const db = setup();
  try {
    const item = createWorkItem(db, 1, 'v1', { title: 'Evidence', verification: 'npm test' });
    const reported = reportWorkItemGitState(db, 1, item.id, {
      baseCommit: 'a'.repeat(40), branch: 'cascade/evidence',
      state: {
        headCommit: 'b'.repeat(40), baseBranch: 'master', branch: 'cascade/evidence',
        changedFiles: 3, dirty: false, ahead: 1, behind: 0, unpushed: 1, hasUpstream: false,
      },
    });
    assert.equal(reported.baseCommit, 'a'.repeat(40));
    assert.equal(reported.gitState?.changedFiles, 3);
    assert.deepEqual(reported.reviewReadiness, { ready: true, blockers: [] });
    assert.throws(() => reportWorkItemGitState(db, 1, item.id, {
      baseCommit: 'c'.repeat(40), branch: 'cascade/evidence',
      state: {
        headCommit: 'b'.repeat(40), baseBranch: 'master', branch: 'cascade/evidence',
        changedFiles: 3, dirty: false, ahead: 1, behind: 0, unpushed: 1, hasUpstream: false,
      },
    }), /base commit/);
    const dirty = reportWorkItemGitState(db, 1, item.id, {
      baseCommit: 'a'.repeat(40), branch: 'cascade/evidence',
      state: {
        headCommit: 'b'.repeat(40), baseBranch: 'master', branch: 'cascade/evidence',
        changedFiles: 3, dirty: true, ahead: 1, behind: 2, unpushed: 1, hasUpstream: false,
      },
    });
    assert.equal(dirty.reviewReadiness.ready, false);
    assert.deepEqual(dirty.reviewReadiness.blockers, [
      'working tree has uncommitted changes', 'workspace is 2 commits behind its base',
    ]);
  } finally {
    db.close();
  }
});

test('lease acquire renew steal-after-expiry and release', () => {
  const db = setup();
  try {
    const item = createWorkItem(db, 1, 'v1', { title: 'Leased work' });
    const leased = acquireWorkItemLease(db, 1, item.id, 'reg-sol', 60_000);
    assert.equal(leased.leaseHolder, 'reg-sol');
    assert.equal(leased.status, 'in_progress');
    assert.throws(() => acquireWorkItemLease(db, 1, item.id, 'reg-terra', 60_000), /leased by reg-sol/);
    const renewed = acquireWorkItemLease(db, 1, item.id, 'reg-sol', 60_000);
    assert.equal(renewed.leaseHolder, 'reg-sol');
    db.prepare(`
      UPDATE work_items SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?
    `).run(item.id);
    assert.equal(reapExpiredWorkItemLeases(db), 1);
    const open = getWorkItem(db, 1, item.id);
    assert.equal(open.leaseHolder, null);
    assert.equal(open.status, 'open');
    acquireWorkItemLease(db, 1, item.id, 'reg-terra', 60_000);
    const released = releaseWorkItemLease(db, 1, item.id, 'reg-terra');
    assert.equal(released.leaseHolder, null);
  } finally {
    db.close();
  }
});

test('link runs handoff and sibling repository query', () => {
  const db = setup();
  try {
    const a = createWorkItem(db, 1, 'v1', {
      title: 'A', repository: '/repo/cascade', workspaceMode: 'isolated', branch: 'cascade/a',
    });
    const b = createWorkItem(db, 1, 'v1', {
      title: 'B', repository: '/repo/cascade', workspaceMode: 'isolated', branch: 'cascade/b',
    });
    createWorkItem(db, 1, 'v1', { title: 'Other', repository: '/repo/other' });
    const linked = linkWorkItemRun(db, 1, a.id, 42);
    assert.deepEqual(linked.runIds, [42]);
    const handoff = createWorkItemHandoff(db, 1, a.id, {
      fromRegistrationId: 'reg-sol',
      toRegistrationId: 'reg-terra',
      note: 'Please review the PR',
    });
    assert.equal(handoff.item.status, 'review');
    assert.equal(handoff.item.assigneeRegistrationId, 'reg-terra');
    assert.equal(handoff.review.toRegistrationId, 'reg-terra');
    const siblings = listSiblingWorkItems(db, 1, a.id);
    assert.equal(siblings.length, 1);
    assert.equal(siblings[0]?.id, b.id);
  } finally {
    db.close();
  }
});

test('contract work item stops on token budget or manual stop', () => {
  const db = setup();
  try {
    const item = createWorkItem(db, 1, 'v1', {
      title: 'Ship clarifications',
      contract: 'Q1: scope?\nA1: MVP only',
      sourceKind: 'contract',
      sourceId: 'msg-clarify-1',
      channelId: 'ch1',
      tokenBudget: 1000,
      workspaceMode: 'isolated',
    });
    assert.equal(item.contract.includes('MVP only'), true);
    assert.equal(item.tokenBudget, 1000);
    const mid = addWorkItemTokenUsage(db, 1, item.id, 400);
    assert.equal(mid.budgetExceeded, false);
    assert.equal(mid.item.tokensUsed, 400);
    const hit = addWorkItemTokenUsage(db, 1, item.id, 700);
    assert.equal(hit.budgetExceeded, true);
    assert.equal(hit.item.stopReason, 'token_budget');
    assert.equal(hit.item.status, 'canceled');

    const manual = createWorkItem(db, 1, 'v1', {
      title: 'Manual stop',
      sourceKind: 'contract',
      channelId: 'ch1',
    });
    const stopped = stopWorkItem(db, 1, manual.id, 'manual', 'User hit stop');
    assert.equal(stopped.stopReason, 'manual');
    assert.equal(stopped.status, 'canceled');
    assert.throws(() => linkWorkItemRun(db, 1, manual.id, 99), /stopped/);
  } finally {
    db.close();
  }
});
