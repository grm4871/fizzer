import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSpecVersion, getSpecVersion } from './versions.js';
import { parseSpec, readSpecFile, setSpecContentStatus, type Workspace } from './workspace.js';

type Db = Database.Database;

const execFileAsync = promisify(execFile);
const liveQueries = new Map<number, Query>();
let eventSink: ((event: RunEvent) => void) | null = null;

// Guardrails for autonomous agent runs. Pin the model so behaviour/cost stay
// predictable across SDK updates, and cap turns so a run can't loop unbounded.
const RUNNER_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-4-6';
const RUNNER_MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 60);

export type RunStatus = 'queued' | 'running' | 'awaiting_review' | 'merged' | 'discarded' | 'failed';
export type RunKind = 'reconcile' | 'describe';

export type Run = {
  id: number;
  spec_id: string;
  kind: RunKind;
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

export function ensureRunnerSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'reconcile',
      base_version_id INTEGER REFERENCES spec_versions(id),
      head_version_id INTEGER NOT NULL REFERENCES spec_versions(id),
      status TEXT NOT NULL DEFAULT 'queued',
      branch_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, seq)
    );
  `);
}

export function setRunEventSink(sink: ((event: RunEvent) => void) | null) {
  eventSink = sink;
}

export function listRuns(db: Db, specId: string) {
  return db.prepare('SELECT * FROM runs WHERE spec_id = ? ORDER BY started_at DESC, id DESC').all(specId) as Run[];
}

export function getRun(db: Db, id: number) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined;
}

export function listRunEvents(db: Db, runId: number) {
  return db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as RunEvent[];
}

export async function getRunDiff(db: Db, runId: number) {
  const run = getRun(db, runId);
  if (!run) return undefined;
  try {
    const { stdout } = await git(run.worktree_path, ['diff', '--find-renames', 'HEAD']);
    return stdout;
  } catch {
    return '';
  }
}

export async function sendRunMessage(db: Db, runId: number, message: string) {
  const run = getRun(db, runId);
  if (!run) throw new Error('Run not found');
  if (run.status !== 'running') throw new Error('Run is not currently running');
  const stream = liveQueries.get(run.id);
  if (!stream) throw new Error('Live agent session is not available');

  const text = message.trim();
  if (!text) throw new Error('Message cannot be empty');
  const event = appendRunEvent(db, run.id, 'follow_up', { message: text });
  await stream.streamInput(toUserMessage(text));
  return event;
}

export async function startRun(db: Db, workspace: Workspace, specId: string, kind: RunKind = 'reconcile') {
  const activeRunning = db.prepare(`
    SELECT * FROM runs
    WHERE spec_id = ? AND status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `).get(specId) as Run | undefined;

  const spec = readSpecFile(db, specId);
  if (!spec) throw new Error('Spec not found');

  const headVersion = createSpecVersion(db, spec.id, spec.content, 'run-start');
  if (!headVersion) throw new Error('Could not snapshot spec');
  const baseVersionId = getLastImplementedVersionId(db, spec.id);

  const branchName = `spec/${spec.id}/${Date.now()}`;
  const worktreePath = path.join(os.tmpdir(), 'cascade-runs', `${spec.id}-${headVersion.id}`);
  const result = db.prepare(`
    INSERT INTO runs (spec_id, kind, base_version_id, head_version_id, status, branch_name, worktree_path)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)
  `).run(spec.id, kind, baseVersionId, headVersion.id, branchName, worktreePath);
  const run = getRun(db, Number(result.lastInsertRowid))!;
  appendRunEvent(db, run.id, 'status', { status: 'queued' });

  if (!activeRunning) queueMicrotask(() => runAndContinue(db, workspace, run.id));

  return run;
}

export async function mergeRun(db: Db, runId: number) {
  const run = getRun(db, runId);
  if (!run) throw new Error('Run not found');
  if (run.status !== 'awaiting_review') throw new Error('Run is not awaiting review');

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = (SELECT workspace_id FROM specs WHERE id = ?)').get(run.spec_id) as Workspace | undefined;
  if (!workspace) throw new Error('Workspace not found');
  const spec = readSpecFile(db, run.spec_id);
  const headVersion = getSpecVersion(db, run.head_version_id);
  if (spec && headVersion) writeSnapshotToWorktree(workspace, run.worktree_path, spec.rel_path, headVersion.content, 'implemented');

  await git(run.worktree_path, ['add', '-A']);
  const changed = await hasWorktreeChanges(run.worktree_path);
  if (changed) {
    await git(run.worktree_path, ['commit', '-m', `Implement spec ${run.spec_id}`]);
    await git(workspace.repo_path, ['merge', '--no-ff', run.branch_name, '-m', `Merge ${run.branch_name}`]);
  }

  await cleanupWorktree(workspace.repo_path, run.worktree_path, run.branch_name);
  db.prepare("UPDATE runs SET status = 'merged', finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(run.id);
  db.prepare("UPDATE specs SET status = 'implemented', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(run.spec_id);
  appendRunEvent(db, run.id, 'status', { status: 'merged' });
  return getRun(db, run.id);
}

export async function discardRun(db: Db, runId: number) {
  const run = getRun(db, runId);
  if (!run) throw new Error('Run not found');
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = (SELECT workspace_id FROM specs WHERE id = ?)').get(run.spec_id) as Workspace | undefined;
  if (!workspace) throw new Error('Workspace not found');

  await cleanupWorktree(workspace.repo_path, run.worktree_path, run.branch_name);
  db.prepare("UPDATE runs SET status = 'discarded', finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(run.id);
  appendRunEvent(db, run.id, 'status', { status: 'discarded' });
  return getRun(db, run.id);
}

async function executeRun(db: Db, workspace: Workspace, runId: number) {
  const run = getRun(db, runId);
  if (!run) throw new Error('Run not found');
  const spec = readSpecFile(db, run.spec_id);
  if (!spec) throw new Error('Spec not found');
  const headVersion = getSpecVersion(db, run.head_version_id);
  if (!headVersion) throw new Error('Run snapshot not found');

  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
  db.prepare("UPDATE specs SET status = 'implementing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(run.spec_id);
  appendRunEvent(db, run.id, 'status', { status: 'running' });

  fs.mkdirSync(path.dirname(run.worktree_path), { recursive: true });
  await git(workspace.repo_path, ['worktree', 'add', '-b', run.branch_name, run.worktree_path, 'HEAD']);
  writeSnapshotToWorktree(workspace, run.worktree_path, spec.rel_path, headVersion.content);
  appendRunEvent(db, run.id, 'worktree', { branch: run.branch_name, path: run.worktree_path });

  const prompt = buildPrompt(db, headVersion.content, run.base_version_id, spec.depends, run.kind);
  const stream = query({
    prompt,
    options: {
      cwd: run.worktree_path,
      model: RUNNER_MODEL,
      maxTurns: RUNNER_MAX_TURNS,
      permissionMode: 'acceptEdits',
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'You implement plaintext specs. Treat the supplied spec as the source of truth. Keep changes scoped to the spec and leave unrelated code alone.',
      },
    },
  });
  liveQueries.set(run.id, stream);

  let summary = '';
  try {
    for await (const message of stream) {
      appendRunEvent(db, run.id, classifySdkMessage(message), message);
      if (isResultMessage(message)) summary = message.result || message.subtype || summary;
    }
  } finally {
    liveQueries.delete(run.id);
  }

  const { stdout } = await git(run.worktree_path, ['diff', '--stat', 'HEAD']);
  const finalSummary = summary || stdout || 'Run completed with no file changes.';
  db.prepare(`
    UPDATE runs
    SET status = 'awaiting_review', finished_at = CURRENT_TIMESTAMP, summary = ?
    WHERE id = ?
  `).run(finalSummary, run.id);
  appendRunEvent(db, run.id, 'status', { status: 'awaiting_review', summary: finalSummary });
}

async function runAndContinue(db: Db, workspace: Workspace, runId: number) {
  const run = getRun(db, runId);
  if (!run || run.status !== 'queued') return;
  try {
    await executeRun(db, workspace, run.id);
  } catch (error) {
    failRun(db, run.id, error);
  } finally {
    const current = getRun(db, run.id);
    if (current) startNextQueuedRun(db, workspace, current.spec_id);
  }
}

function startNextQueuedRun(db: Db, workspace: Workspace, specId: string) {
  const activeRunning = db.prepare("SELECT id FROM runs WHERE spec_id = ? AND status = 'running' LIMIT 1").get(specId);
  if (activeRunning) return;
  const next = db.prepare(`
    SELECT * FROM runs
    WHERE spec_id = ? AND status = 'queued'
    ORDER BY started_at ASC, id ASC
    LIMIT 1
  `).get(specId) as Run | undefined;
  if (next) queueMicrotask(() => runAndContinue(db, workspace, next.id));
}

function buildPrompt(db: Db, content: string, baseVersionId: number | null, depends: string[], kind: RunKind) {
  const parsed = parseSpec(content);
  const base = baseVersionId ? getSpecVersion(db, baseVersionId) : undefined;
  const relatedSpecs = depends
    .map((id) => readSpecFile(db, id))
    .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec))
    .map((spec) => `Related spec: ${spec.rel_path}\n${spec.content}`)
    .join('\n\n');

  const reconcilePrompt = [
    'Reconcile the target codebase to this implementation spec.',
    'Make the code conform to the spec. Prefer minimal, idiomatic changes. Run focused verification when possible.',
    base ? `Spec diff basis: version ${base.id}.` : 'Spec diff basis: this is a new spec with no implemented baseline.',
    base ? `Previous implemented spec:\n${base.content}` : '',
    `Current spec body:\n${parsed.body}`,
    relatedSpecs ? `Related specs from frontmatter depends:\n${relatedSpecs}` : '',
  ].filter(Boolean).join('\n\n');
  const describePrompt = [
    'Reverse-sync the implementation spec from the current codebase.',
    'Inspect the files hinted by the spec targets and update only the spec prose/frontmatter so it accurately describes the code. Do not refactor product code unless it is necessary to keep the spec file valid.',
    base ? `Previous implemented spec:\n${base.content}` : '',
    `Current spec body:\n${parsed.body}`,
    relatedSpecs ? `Related specs from frontmatter depends:\n${relatedSpecs}` : '',
  ].filter(Boolean).join('\n\n');
  return kind === 'describe' ? describePrompt : reconcilePrompt;
}

function writeSnapshotToWorktree(workspace: Workspace, worktreePath: string, relPath: string, content: string, status?: 'implemented') {
  const specsRel = path.relative(workspace.repo_path, workspace.specs_dir);
  const snapshotPath = path.resolve(worktreePath, specsRel, relPath);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, status ? setSpecContentStatus(content, status) : content, 'utf8');
}

function appendRunEvent(db: Db, runId: number, type: string, payload: unknown) {
  const latest = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?').get(runId) as { next: number };
  const result = db.prepare('INSERT INTO run_events (run_id, seq, type, payload_json) VALUES (?, ?, ?, ?)').run(
    runId,
    latest.next,
    type,
    JSON.stringify(payload, jsonReplacer),
  );
  const event = db.prepare('SELECT * FROM run_events WHERE id = ?').get(Number(result.lastInsertRowid)) as RunEvent;
  eventSink?.(event);
  return event;
}

function failRun(db: Db, runId: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  appendRunEvent(db, runId, 'error', { message });
  db.prepare("UPDATE runs SET status = 'failed', finished_at = CURRENT_TIMESTAMP, summary = ? WHERE id = ?").run(message, runId);
  appendRunEvent(db, runId, 'status', { status: 'failed', summary: message });
  const run = getRun(db, runId);
  if (run) db.prepare("UPDATE specs SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'implementing'").run(run.spec_id);
}

function getLastImplementedVersionId(db: Db, specId: string) {
  const row = db.prepare(`
    SELECT head_version_id
    FROM runs
    WHERE spec_id = ? AND status = 'merged'
    ORDER BY finished_at DESC, id DESC
    LIMIT 1
  `).get(specId) as { head_version_id: number } | undefined;
  return row?.head_version_id ?? null;
}

function classifySdkMessage(message: SDKMessage) {
  if (message.type === 'assistant') return 'text';
  if (message.type === 'result') return 'result';
  if (message.type === 'system') return 'system';
  return message.type || 'message';
}

function isResultMessage(message: SDKMessage): message is SDKMessage & { type: 'result'; result?: string; subtype?: string } {
  return message.type === 'result';
}

function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function toUserMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* messages() {
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      priority: 'now',
    };
  })();
}

async function hasWorktreeChanges(cwd: string) {
  const { stdout } = await git(cwd, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}

async function cleanupWorktree(repoPath: string, worktreePath: string, branchName: string) {
  await git(repoPath, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
  await git(repoPath, ['branch', '-D', branchName]).catch(() => undefined);
}

async function git(cwd: string, args: string[]) {
  return execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}
