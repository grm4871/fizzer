/**
 * Durable work items — addressable tasks that own workspace, runs, PR state,
 * and review handoffs. Host worktrees are materializations; this table is the
 * source of truth (see vault note "Cascade-native parallel workspaces…").
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getVault, getWritableVault } from './vault.js';

type Db = Database.Database;

export const WORK_ITEM_STATUSES = [
  'open',
  'leased',
  'in_progress',
  'review',
  'blocked',
  'done',
  'canceled',
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORKSPACE_MODES = ['shared', 'isolated', 'existing'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/**
 * Source of the durable contract:
 * - mission — compiled from a chat mission task
 * - contract — accepted clarification Q&A (the work item *is* the contract)
 */
export const SOURCE_KINDS = ['message', 'note', 'kanban', 'manual', 'mission', 'contract'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type WorkItemStopReason = '' | 'completed' | 'token_budget' | 'manual' | 'failed';

/** A desktop-observed, base-relative Git snapshot. The server owns readiness. */
export type WorkItemGitState = {
  headCommit: string;
  baseBranch: string;
  branch: string;
  changedFiles: number;
  dirty: boolean;
  ahead: number;
  behind: number;
  unpushed: number;
  hasUpstream: boolean;
};

export type WorkItemReviewReadiness = {
  ready: boolean;
  blockers: string[];
};

export type WorkItem = {
  id: string;
  vaultId: string;
  channelId: string | null;
  title: string;
  brief: string;
  /** Accepted clarification / acceptance criteria. The work item *is* the contract. */
  contract: string;
  status: WorkItemStatus;
  priority: number;
  sourceKind: SourceKind | '';
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
  gitState: WorkItemGitState | null;
  gitStateUpdatedAt: string | null;
  reviewReadiness: WorkItemReviewReadiness;
  /** Soft token ceiling for agent drive; 0 = unlimited. */
  tokenBudget: number;
  tokensUsed: number;
  stopReason: WorkItemStopReason;
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
  status: 'requested' | 'accepted' | 'done' | 'canceled';
  createdAt: string;
};

const LEASE_DEFAULT_MS = 30 * 60 * 1000;

function cleanText(value: unknown, max: number): string {
  return String(value || '').trim().slice(0, max);
}

function isStatus(value: unknown): value is WorkItemStatus {
  return typeof value === 'string' && (WORK_ITEM_STATUSES as readonly string[]).includes(value);
}

function isMode(value: unknown): value is WorkspaceMode {
  return typeof value === 'string' && (WORKSPACE_MODES as readonly string[]).includes(value);
}

function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value);
}

function cleanGitState(value: unknown): WorkItemGitState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  const text = (key: string, max: number) => cleanText(state[key], max);
  const count = (key: string) => Math.max(0, Math.floor(Number(state[key]) || 0));
  const headCommit = text('headCommit', 80);
  const baseBranch = text('baseBranch', 200);
  const branch = text('branch', 200);
  if (!headCommit || !baseBranch || !branch) return null;
  return {
    headCommit, baseBranch, branch,
    changedFiles: count('changedFiles'), dirty: Boolean(state.dirty),
    ahead: count('ahead'), behind: count('behind'), unpushed: count('unpushed'),
    hasUpstream: Boolean(state.hasUpstream),
  };
}

function parseGitState(value: string | undefined): WorkItemGitState | null {
  try { return cleanGitState(JSON.parse(value || '')); } catch { return null; }
}

export function deriveReviewReadiness(input: {
  baseCommit: string;
  branch: string;
  verification: string;
  gitState: WorkItemGitState | null;
}): WorkItemReviewReadiness {
  const blockers: string[] = [];
  if (!input.baseCommit) blockers.push('workspace base is not bound');
  if (!input.branch) blockers.push('workspace branch is not bound');
  if (!input.gitState) blockers.push('Git state has not been reported by a desktop workspace');
  else {
    if (input.gitState.branch !== input.branch) blockers.push('reported branch does not match the bound workspace');
    if (input.gitState.dirty) blockers.push('working tree has uncommitted changes');
    if (input.gitState.behind > 0) blockers.push(`workspace is ${input.gitState.behind} commit${input.gitState.behind === 1 ? '' : 's'} behind its base`);
    if (input.gitState.changedFiles === 0) blockers.push('no base-relative changes were found');
  }
  if (!input.verification) blockers.push('verification evidence is missing');
  return { ready: blockers.length === 0, blockers };
}

export function ensureWorkItemSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      channel_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 0,
      source_kind TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      assignee_registration_id TEXT,
      lease_holder TEXT,
      lease_expires_at TEXT,
      repository TEXT NOT NULL DEFAULT '',
      base_commit TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      workspace_mode TEXT NOT NULL DEFAULT 'shared',
      worktree_path TEXT NOT NULL DEFAULT '',
      pr_number INTEGER,
      pr_url TEXT NOT NULL DEFAULT '',
      pr_state TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      verification TEXT NOT NULL DEFAULT '',
      git_state_json TEXT NOT NULL DEFAULT '',
      git_state_updated_at TEXT,
      contract TEXT NOT NULL DEFAULT '',
      token_budget INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      stop_reason TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS work_items_vault_idx ON work_items(vault_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS work_items_channel_idx ON work_items(channel_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS work_items_lease_idx ON work_items(lease_expires_at)
      WHERE lease_expires_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS work_item_dependencies (
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      PRIMARY KEY (work_item_id, depends_on_id)
    );

    CREATE TABLE IF NOT EXISTS work_item_runs (
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (work_item_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS work_item_runs_run_idx ON work_item_runs(run_id);

    CREATE TABLE IF NOT EXISTS work_item_reviews (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'handoff',
      author_user_id INTEGER,
      from_registration_id TEXT,
      to_registration_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      line INTEGER,
      base_commit TEXT NOT NULL DEFAULT '',
      head_commit TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS work_item_reviews_item_idx ON work_item_reviews(work_item_id, created_at);
  `);
  // Idempotent column upgrades for existing DBs.
  const cols = (db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('contract')) db.exec("ALTER TABLE work_items ADD COLUMN contract TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('token_budget')) db.exec('ALTER TABLE work_items ADD COLUMN token_budget INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('tokens_used')) db.exec('ALTER TABLE work_items ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('stop_reason')) db.exec("ALTER TABLE work_items ADD COLUMN stop_reason TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('git_state_json')) db.exec("ALTER TABLE work_items ADD COLUMN git_state_json TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('git_state_updated_at')) db.exec('ALTER TABLE work_items ADD COLUMN git_state_updated_at TEXT');
  const reviewCols = (db.prepare('PRAGMA table_info(work_item_reviews)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!reviewCols.includes('kind')) db.exec("ALTER TABLE work_item_reviews ADD COLUMN kind TEXT NOT NULL DEFAULT 'handoff'");
  if (!reviewCols.includes('author_user_id')) db.exec('ALTER TABLE work_item_reviews ADD COLUMN author_user_id INTEGER');
  if (!reviewCols.includes('file_path')) db.exec("ALTER TABLE work_item_reviews ADD COLUMN file_path TEXT NOT NULL DEFAULT ''");
  if (!reviewCols.includes('line')) db.exec('ALTER TABLE work_item_reviews ADD COLUMN line INTEGER');
  if (!reviewCols.includes('base_commit')) db.exec("ALTER TABLE work_item_reviews ADD COLUMN base_commit TEXT NOT NULL DEFAULT ''");
  if (!reviewCols.includes('head_commit')) db.exec("ALTER TABLE work_item_reviews ADD COLUMN head_commit TEXT NOT NULL DEFAULT ''");
}

type WorkItemRow = {
  id: string;
  vault_id: string;
  channel_id: string | null;
  title: string;
  brief: string;
  status: string;
  priority: number;
  source_kind: string;
  source_id: string;
  assignee_registration_id: string | null;
  lease_holder: string | null;
  lease_expires_at: string | null;
  repository: string;
  base_commit: string;
  branch: string;
  workspace_mode: string;
  worktree_path: string;
  pr_number: number | null;
  pr_url: string;
  pr_state: string;
  summary: string;
  verification: string;
  git_state_json?: string;
  git_state_updated_at?: string | null;
  contract?: string;
  token_budget?: number;
  tokens_used?: number;
  stop_reason?: string;
  created_by: number;
  created_at: string;
  updated_at: string;
};

function hydrate(db: Db, row: WorkItemRow): WorkItem {
  const dependsOn = (db.prepare(`
    SELECT depends_on_id AS id FROM work_item_dependencies WHERE work_item_id = ?
  `).all(row.id) as Array<{ id: string }>).map((item) => item.id);
  const runIds = (db.prepare(`
    SELECT run_id AS id FROM work_item_runs WHERE work_item_id = ? ORDER BY linked_at ASC
  `).all(row.id) as Array<{ id: number }>).map((item) => item.id);
  const stop = String(row.stop_reason || '') as WorkItemStopReason;
  const gitState = parseGitState(row.git_state_json);
  const reviewReadiness = deriveReviewReadiness({
    baseCommit: row.base_commit || '', branch: row.branch || '', verification: row.verification || '', gitState,
  });
  return {
    id: row.id,
    vaultId: row.vault_id,
    channelId: row.channel_id,
    title: row.title,
    brief: row.brief || '',
    contract: row.contract || '',
    status: isStatus(row.status) ? row.status : 'open',
    priority: row.priority || 0,
    sourceKind: isSourceKind(row.source_kind) ? row.source_kind : '',
    sourceId: row.source_id || '',
    assigneeRegistrationId: row.assignee_registration_id,
    leaseHolder: row.lease_holder,
    leaseExpiresAt: row.lease_expires_at,
    repository: row.repository || '',
    baseCommit: row.base_commit || '',
    branch: row.branch || '',
    workspaceMode: isMode(row.workspace_mode) ? row.workspace_mode : 'shared',
    worktreePath: row.worktree_path || '',
    prNumber: row.pr_number,
    prUrl: row.pr_url || '',
    prState: row.pr_state || '',
    summary: row.summary || '',
    verification: row.verification || '',
    gitState,
    gitStateUpdatedAt: row.git_state_updated_at || null,
    reviewReadiness,
    tokenBudget: Math.max(0, Number(row.token_budget) || 0),
    tokensUsed: Math.max(0, Number(row.tokens_used) || 0),
    stopReason: (['completed', 'token_budget', 'manual', 'failed'].includes(stop) ? stop : '') as WorkItemStopReason,
    dependsOn,
    runIds,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(db: Db, id: string): WorkItemRow | undefined {
  return db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined;
}

function assertVaultAccess(db: Db, vaultId: string, userId: number, write = false) {
  const vault = write ? getWritableVault(db, vaultId, userId) : getVault(db, vaultId, userId);
  if (!vault) throw new Error(write ? 'Vault not writable' : 'Vault not found');
  return vault;
}

export function listWorkItems(
  db: Db,
  userId: number,
  vaultId: string,
  opts: { channelId?: string; status?: string } = {},
): WorkItem[] {
  assertVaultAccess(db, vaultId, userId, false);
  const params: unknown[] = [vaultId];
  let sql = 'SELECT * FROM work_items WHERE vault_id = ?';
  if (opts.channelId) {
    sql += ' AND channel_id = ?';
    params.push(opts.channelId);
  }
  if (opts.status && isStatus(opts.status)) {
    sql += ' AND status = ?';
    params.push(opts.status);
  }
  sql += ' ORDER BY priority DESC, updated_at DESC, rowid DESC';
  const rows = db.prepare(sql).all(...params) as WorkItemRow[];
  return rows.map((row) => hydrate(db, row));
}

export function getWorkItem(db: Db, userId: number, id: string): WorkItem {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, false);
  return hydrate(db, row);
}

export function createWorkItem(
  db: Db,
  userId: number,
  vaultId: string,
  input: {
    title: string;
    brief?: string;
    contract?: string;
    channelId?: string | null;
    priority?: number;
    sourceKind?: string;
    sourceId?: string;
    dependsOn?: string[];
    repository?: string;
    baseCommit?: string;
    branch?: string;
    workspaceMode?: string;
    worktreePath?: string;
    assigneeRegistrationId?: string | null;
    tokenBudget?: number;
    verification?: string;
  },
): WorkItem {
  assertVaultAccess(db, vaultId, userId, true);
  const title = cleanText(input.title, 240);
  if (!title) throw new Error('Title is required');
  const id = crypto.randomUUID();
  const priority = Math.max(-100, Math.min(100, Math.floor(Number(input.priority) || 0)));
  const sourceKind = isSourceKind(input.sourceKind) ? input.sourceKind : 'manual';
  const workspaceMode = isMode(input.workspaceMode) ? input.workspaceMode : 'shared';
  const tokenBudget = Math.max(0, Math.floor(Number(input.tokenBudget) || 0));
  const dependencies = Array.from(new Set((input.dependsOn || []).map((item) => cleanText(item, 80)).filter(Boolean)));
  if (dependencies.length) {
    const found = db.prepare(`
      SELECT id FROM work_items WHERE vault_id = ? AND id IN (${dependencies.map(() => '?').join(',')})
    `).all(vaultId, ...dependencies) as Array<{ id: string }>;
    if (found.length !== dependencies.length) throw new Error('Every dependency must be a work item in this vault');
  }

  db.prepare(`
    INSERT INTO work_items (
      id, vault_id, channel_id, title, brief, contract, priority, source_kind, source_id,
      assignee_registration_id, repository, base_commit, branch, workspace_mode,
      worktree_path, verification, token_budget, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    vaultId,
    input.channelId || null,
    title,
    cleanText(input.brief, 8000),
    cleanText(input.contract, 16_000),
    priority,
    sourceKind,
    cleanText(input.sourceId, 120),
    input.assigneeRegistrationId || null,
    cleanText(input.repository, 500),
    cleanText(input.baseCommit, 80),
    cleanText(input.branch, 200),
    workspaceMode,
    cleanText(input.worktreePath, 1000),
    cleanText(input.verification, 8000),
    tokenBudget,
    userId,
  );

  const insertDep = db.prepare(`
    INSERT INTO work_item_dependencies (work_item_id, depends_on_id) VALUES (?, ?)
  `);
  for (const dep of dependencies) insertDep.run(id, dep);

  return getWorkItem(db, userId, id);
}

export function updateWorkItem(
  db: Db,
  userId: number,
  id: string,
  patch: Partial<{
    title: string;
    brief: string;
    contract: string;
    status: WorkItemStatus;
    priority: number;
    assigneeRegistrationId: string | null;
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
    tokenBudget: number;
    tokensUsed: number;
    stopReason: WorkItemStopReason;
    dependsOn: string[];
  }>,
): WorkItem {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);

  const title = patch.title !== undefined ? cleanText(patch.title, 240) : row.title;
  if (!title) throw new Error('Title is required');
  const status = patch.status !== undefined
    ? (isStatus(patch.status) ? patch.status : (() => { throw new Error('Invalid status'); })())
    : row.status;
  const workspaceMode = patch.workspaceMode !== undefined
    ? (isMode(patch.workspaceMode) ? patch.workspaceMode : (() => { throw new Error('Invalid workspace mode'); })())
    : row.workspace_mode;
  const priority = patch.priority !== undefined
    ? Math.max(-100, Math.min(100, Math.floor(Number(patch.priority) || 0)))
    : row.priority;
  const tokenBudget = patch.tokenBudget !== undefined
    ? Math.max(0, Math.floor(Number(patch.tokenBudget) || 0))
    : (row.token_budget || 0);
  const tokensUsed = patch.tokensUsed !== undefined
    ? Math.max(0, Math.floor(Number(patch.tokensUsed) || 0))
    : (row.tokens_used || 0);
  const stopReason = patch.stopReason !== undefined
    ? cleanText(patch.stopReason, 40)
    : (row.stop_reason || '');

  db.prepare(`
    UPDATE work_items SET
      title = ?, brief = ?, contract = ?, status = ?, priority = ?,
      assignee_registration_id = ?, repository = ?, base_commit = ?, branch = ?,
      workspace_mode = ?, worktree_path = ?, pr_number = ?, pr_url = ?, pr_state = ?,
      summary = ?, verification = ?, token_budget = ?, tokens_used = ?, stop_reason = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    title,
    patch.brief !== undefined ? cleanText(patch.brief, 8000) : row.brief,
    patch.contract !== undefined ? cleanText(patch.contract, 16_000) : (row.contract || ''),
    status,
    priority,
    patch.assigneeRegistrationId !== undefined ? patch.assigneeRegistrationId : row.assignee_registration_id,
    patch.repository !== undefined ? cleanText(patch.repository, 500) : row.repository,
    patch.baseCommit !== undefined ? cleanText(patch.baseCommit, 80) : row.base_commit,
    patch.branch !== undefined ? cleanText(patch.branch, 200) : row.branch,
    workspaceMode,
    patch.worktreePath !== undefined ? cleanText(patch.worktreePath, 1000) : row.worktree_path,
    patch.prNumber !== undefined ? patch.prNumber : row.pr_number,
    patch.prUrl !== undefined ? cleanText(patch.prUrl, 500) : row.pr_url,
    patch.prState !== undefined ? cleanText(patch.prState, 80) : row.pr_state,
    patch.summary !== undefined ? cleanText(patch.summary, 4000) : row.summary,
    patch.verification !== undefined ? cleanText(patch.verification, 8000) : row.verification,
    tokenBudget,
    tokensUsed,
    stopReason,
    id,
  );

  if (patch.dependsOn) {
    const dependencies = Array.from(new Set(patch.dependsOn.map((item) => cleanText(item, 80)).filter(Boolean)));
    if (dependencies.includes(id)) throw new Error('A work item cannot depend on itself');
    if (dependencies.length) {
      const found = db.prepare(`
        SELECT id FROM work_items WHERE vault_id = ? AND id IN (${dependencies.map(() => '?').join(',')})
      `).all(row.vault_id, ...dependencies) as Array<{ id: string }>;
      if (found.length !== dependencies.length) throw new Error('Every dependency must be a work item in this vault');
    }
    db.prepare('DELETE FROM work_item_dependencies WHERE work_item_id = ?').run(id);
    const insertDep = db.prepare(`
      INSERT INTO work_item_dependencies (work_item_id, depends_on_id) VALUES (?, ?)
    `);
    for (const dep of dependencies) insertDep.run(id, dep);
  }

  return getWorkItem(db, userId, id);
}

/**
 * Persist an observation from the desktop Git bridge. This is deliberately not
 * a generic patch: a task gets one base/branch identity, and review readiness
 * is always derived from evidence rather than accepted from a renderer.
 */
export function reportWorkItemGitState(
  db: Db,
  userId: number,
  id: string,
  input: { baseCommit: string; branch: string; state: unknown },
): WorkItem {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);
  const baseCommit = cleanText(input.baseCommit, 80);
  const branch = cleanText(input.branch, 200);
  const state = cleanGitState(input.state);
  if (!baseCommit || !branch || !state) throw new Error('A complete Git state, base commit, and branch are required');
  if (state.branch !== branch) throw new Error('Reported Git branch does not match the workspace branch');
  if (row.base_commit && row.base_commit !== baseCommit) throw new Error('Reported base commit does not match this work item');
  if (row.branch && row.branch !== branch) throw new Error('Reported branch does not match this work item');
  db.prepare(`
    UPDATE work_items
    SET base_commit = CASE WHEN base_commit = '' THEN ? ELSE base_commit END,
        branch = CASE WHEN branch = '' THEN ? ELSE branch END,
        git_state_json = ?, git_state_updated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(baseCommit, branch, JSON.stringify(state), id);
  return getWorkItem(db, userId, id);
}

/**
 * Bind the host-local workspace prepared by the owner's desktop runner.
 * Identity fields are write-once: reconnect may re-assert the same binding,
 * but no runner acknowledgement can silently repoint an existing task.
 */
export function bindWorkItemWorkspace(
  db: Db,
  userId: number,
  id: string,
  input: {
    repository: string;
    baseCommit: string;
    branch: string;
    worktreePath: string;
  },
): WorkItem {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);
  if (row.workspace_mode !== 'isolated' && row.workspace_mode !== 'existing') {
    throw new Error('Work item does not permit a managed workspace');
  }
  const repository = cleanText(input.repository, 500);
  const baseCommit = cleanText(input.baseCommit, 80);
  const branch = cleanText(input.branch, 200);
  const worktreePath = cleanText(input.worktreePath, 1000);
  if (!repository || !baseCommit || !branch || !worktreePath) {
    throw new Error('A complete repository, base, branch, and workspace path are required');
  }
  if (row.repository && row.repository !== repository) throw new Error('Prepared repository does not match this work item');
  if (row.base_commit && row.base_commit !== baseCommit) throw new Error('Prepared base commit does not match this work item');
  if (row.branch && row.branch !== branch) throw new Error('Prepared branch does not match this work item');
  if (row.worktree_path && row.worktree_path !== worktreePath) throw new Error('Prepared path does not match this work item');

  db.prepare(`
    UPDATE work_items
    SET repository = CASE WHEN repository = '' THEN ? ELSE repository END,
        base_commit = CASE WHEN base_commit = '' THEN ? ELSE base_commit END,
        branch = CASE WHEN branch = '' THEN ? ELSE branch END,
        worktree_path = CASE WHEN worktree_path = '' THEN ? ELSE worktree_path END,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(repository, baseCommit, branch, worktreePath, id);
  return getWorkItem(db, userId, id);
}

/** Acquire or renew a lease. Expired leases are stealable. */
export function acquireWorkItemLease(
  db: Db,
  userId: number,
  id: string,
  holder: string,
  ttlMs = LEASE_DEFAULT_MS,
): WorkItem {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);
  const who = cleanText(holder, 120);
  if (!who) throw new Error('Lease holder is required');
  if (['done', 'canceled'].includes(row.status)) throw new Error('Work item is closed');

  const now = Date.now();
  const held = row.lease_holder && !leaseExpired(row.lease_expires_at, now);
  if (held && row.lease_holder !== who) {
    throw new Error(`Work item is leased by ${row.lease_holder} until ${row.lease_expires_at}`);
  }

  const nextExpiry = new Date(now + Math.max(60_000, ttlMs)).toISOString();
  const nextStatus = row.status === 'open' || row.status === 'leased' ? 'in_progress' : row.status;
  db.prepare(`
    UPDATE work_items
    SET lease_holder = ?, lease_expires_at = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(who, nextExpiry, nextStatus, id);
  return getWorkItem(db, userId, id);
}

function leaseExpired(expiresAt: string | null, nowMs = Date.now()): boolean {
  if (!expiresAt) return true;
  const parsed = Date.parse(expiresAt);
  return !Number.isFinite(parsed) || parsed <= nowMs;
}

export function releaseWorkItemLease(
  db: Db,
  userId: number,
  id: string,
  holder?: string,
): WorkItem {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);
  if (holder && row.lease_holder && row.lease_holder !== holder) {
    throw new Error('Only the lease holder can release this lease');
  }
  const nextStatus = row.status === 'in_progress' || row.status === 'leased' ? 'open' : row.status;
  db.prepare(`
    UPDATE work_items
    SET lease_holder = NULL, lease_expires_at = NULL, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nextStatus, id);
  return getWorkItem(db, userId, id);
}

/** Drop expired leases so crashed agents free ownership. */
export function reapExpiredWorkItemLeases(db: Db): number {
  const nowIso = new Date().toISOString();
  const result = db.prepare(`
    UPDATE work_items
    SET lease_holder = NULL,
        lease_expires_at = NULL,
        status = CASE WHEN status IN ('leased', 'in_progress') THEN 'open' ELSE status END,
        updated_at = datetime('now')
    WHERE lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
      AND status NOT IN ('done', 'canceled')
  `).run(nowIso);
  return result.changes;
}

export function linkWorkItemRun(db: Db, userId: number, id: string, runId: number): WorkItem {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);
  if (!Number.isInteger(runId) || runId <= 0) throw new Error('Invalid run id');
  if (['done', 'canceled'].includes(row.status) || row.stop_reason) {
    throw new Error('Work item is stopped');
  }
  db.prepare(`
    INSERT OR IGNORE INTO work_item_runs (work_item_id, run_id) VALUES (?, ?)
  `).run(id, runId);
  if (row.status === 'open' || row.status === 'leased') {
    db.prepare(`
      UPDATE work_items SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?
    `).run(id);
  } else {
    db.prepare(`UPDATE work_items SET updated_at = datetime('now') WHERE id = ?`).run(id);
  }
  return getWorkItem(db, userId, id);
}

/**
 * Stop agent drive on this contract: completed, token budget hit, or manual.
 * Releases the lease and marks the item terminal (done or canceled).
 */
export function stopWorkItem(
  db: Db,
  userId: number,
  id: string,
  reason: WorkItemStopReason,
  summary?: string,
): WorkItem {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);
  if (!reason) throw new Error('Stop reason is required');
  if (['done', 'canceled'].includes(row.status) && row.stop_reason) {
    return getWorkItem(db, userId, id);
  }
  const status: WorkItemStatus = reason === 'completed' ? 'done' : 'canceled';
  db.prepare(`
    UPDATE work_items
    SET status = ?,
        stop_reason = ?,
        summary = CASE WHEN ? != '' THEN ? ELSE summary END,
        lease_holder = NULL,
        lease_expires_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    status,
    reason,
    cleanText(summary, 4000),
    cleanText(summary, 4000),
    id,
  );
  return getWorkItem(db, userId, id);
}

/**
 * Accumulate run token usage. When a budget is set and exceeded, auto-stops
 * with reason `token_budget` so agents no longer drive the contract.
 */
export function addWorkItemTokenUsage(
  db: Db,
  userId: number,
  id: string,
  tokens: number,
): { item: WorkItem; budgetExceeded: boolean } {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);
  const delta = Math.max(0, Math.floor(Number(tokens) || 0));
  if (delta > 0 && !['done', 'canceled'].includes(row.status)) {
    db.prepare(`
      UPDATE work_items
      SET tokens_used = COALESCE(tokens_used, 0) + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(delta, id);
  }
  let item = getWorkItem(db, userId, id);
  let budgetExceeded = false;
  if (
    item.tokenBudget > 0
    && item.tokensUsed >= item.tokenBudget
    && !['done', 'canceled'].includes(item.status)
  ) {
    item = stopWorkItem(db, userId, id, 'token_budget', `Token budget ${item.tokenBudget} reached (${item.tokensUsed} used).`);
    budgetExceeded = true;
  }
  return { item, budgetExceeded };
}

/** Find work items linked to a run (for settle / budget checks). */
export function listWorkItemsForRun(db: Db, runId: number): string[] {
  if (!Number.isInteger(runId) || runId <= 0) return [];
  return (db.prepare(`
    SELECT work_item_id AS id FROM work_item_runs WHERE run_id = ?
  `).all(runId) as Array<{ id: string }>).map((row) => row.id);
}

export function createWorkItemHandoff(
  db: Db,
  userId: number,
  id: string,
  input: { toRegistrationId: string; fromRegistrationId?: string; note?: string },
): { item: WorkItem; review: WorkItemReview } {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);
  const to = cleanText(input.toRegistrationId, 120);
  if (!to) throw new Error('Handoff target is required');
  const reviewId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO work_item_reviews (id, work_item_id, from_registration_id, to_registration_id, note, status)
    VALUES (?, ?, ?, ?, ?, 'requested')
  `).run(
    reviewId,
    id,
    cleanText(input.fromRegistrationId, 120) || null,
    to,
    cleanText(input.note, 2000),
  );
  db.prepare(`
    UPDATE work_items
    SET status = 'review',
        assignee_registration_id = ?,
        lease_holder = NULL,
        lease_expires_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(to, id);
  const review = listWorkItemReviews(db, userId, id).find((item) => item.id === reviewId);
  if (!review) throw new Error('Review handoff was not persisted');
  return {
    item: getWorkItem(db, userId, id),
    review,
  };
}

/**
 * Persist a human review annotation against the exact local Git snapshot.
 * A change request records review intent only: it deliberately does not push,
 * merge, dispatch another worker, or mutate mission/task state.
 */
export function createWorkItemReview(
  db: Db,
  userId: number,
  id: string,
  input: {
    kind: 'comment' | 'change_request';
    note: string;
    filePath?: string;
    line?: number;
    baseCommit: string;
    headCommit: string;
  },
): WorkItemReview {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, true);
  if (input.kind !== 'comment' && input.kind !== 'change_request') throw new Error('Invalid review kind');
  const note = cleanText(input.note, 8000);
  if (!note) throw new Error('Review comment is required');
  const baseCommit = cleanText(input.baseCommit, 80);
  const headCommit = cleanText(input.headCommit, 80);
  const gitState = parseGitState(row.git_state_json);
  if (!row.base_commit || baseCommit !== row.base_commit) throw new Error('Review base does not match this work item');
  if (!gitState || headCommit !== gitState.headCommit) throw new Error('Review head does not match the latest desktop Git evidence');

  const reviewId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO work_item_reviews (
      id, work_item_id, kind, author_user_id, note, file_path, line,
      base_commit, head_commit, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reviewId,
    id,
    input.kind,
    userId,
    note,
    cleanText(input.filePath, 1000),
    Number.isInteger(input.line) && Number(input.line) > 0 ? Number(input.line) : null,
    baseCommit,
    headCommit,
    input.kind === 'change_request' ? 'requested' : 'done',
  );
  const review = listWorkItemReviews(db, userId, id).find((item) => item.id === reviewId);
  if (!review) throw new Error('Review comment was not persisted');
  return review;
}

export function listWorkItemReviews(db: Db, userId: number, id: string): WorkItemReview[] {
  const row = getRow(db, id);
  if (!row) throw new Error('Work item not found');
  assertVaultAccess(db, row.vault_id, userId, false);
  return (db.prepare(`
    SELECT r.*, COALESCE(u.username, '') AS author_username
    FROM work_item_reviews r
    LEFT JOIN users u ON u.id = r.author_user_id
    WHERE r.work_item_id = ?
    ORDER BY r.created_at ASC, r.id ASC
  `).all(id) as Array<{
    id: string;
    work_item_id: string;
    kind: string;
    author_user_id: number | null;
    author_username: string;
    from_registration_id: string | null;
    to_registration_id: string | null;
    note: string;
    file_path: string;
    line: number | null;
    base_commit: string;
    head_commit: string;
    status: string;
    created_at: string;
  }>).map((item) => ({
    id: item.id,
    workItemId: item.work_item_id,
    kind: item.kind === 'comment' || item.kind === 'change_request' ? item.kind : 'handoff',
    authorUserId: item.author_user_id,
    authorUsername: item.author_username,
    fromRegistrationId: item.from_registration_id,
    toRegistrationId: item.to_registration_id,
    note: item.note,
    filePath: item.file_path || '',
    line: item.line,
    baseCommit: item.base_commit || '',
    headCommit: item.head_commit || '',
    status: item.status as WorkItemReview['status'],
    createdAt: item.created_at,
  }));
}

/** Sibling open items in the same repository (for overlap warnings). */
export function listSiblingWorkItems(db: Db, userId: number, id: string): WorkItem[] {
  const item = getWorkItem(db, userId, id);
  if (!item.repository) return [];
  return listWorkItems(db, userId, item.vaultId).filter((other) => (
    other.id !== item.id
    && other.repository === item.repository
    && !['done', 'canceled'].includes(other.status)
  ));
}
