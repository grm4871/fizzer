/**
 * Durable chat-first orchestration state.
 *
 * Tables are authoritative; `chat_messages.mission_json` is a materialized
 * projection so normal transcript reads and multiplayer socket updates render
 * a mission without a second request or a client-owned task store.
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assertChatChannel,
  getChatMessage,
  listChatAgentMembers,
  type ChatAgentRegistration,
  type ChatMessage,
  type ChatMission,
  type ChatMissionStatus,
  type ChatMissionTask,
  type ChatMissionTaskStatus,
} from './chat.js';
import {
  acquireWorkItemLease,
  createWorkItem,
  ensureWorkItemSchema,
  getWorkItem,
  linkWorkItemRun,
  releaseWorkItemLease,
  updateWorkItem,
  type WorkItem,
  type WorkItemStatus,
} from './workItems.js';

type Db = Database.Database;

type MissionRow = {
  id: string;
  vault_id: string;
  channel_id: string;
  root_message_id: string;
  coordinator_registration_id: string;
  title: string;
  objective: string;
  status: ChatMissionStatus;
  summary: string;
  wake_sent: number;
  created_by: number;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  mission_id: string;
  title: string;
  assignee_registration_id: string;
  status: ChatMissionTaskStatus;
  summary: string;
  prompt: string;
  depends_on_json: string;
  priority: number;
  reasoning_effort: string;
  anonymous: number;
  dispatch_id: string | null;
  run_id: number | null;
  attempt: number;
  /** Durable work-item twin — workspace/PR/lease live here. */
  work_item_id: string | null;
  created_at: string;
  updated_at: string;
};

type MissionEventRow = {
  id: number;
  mission_id: string;
  task_id: string | null;
  kind: string;
  title: string;
  from_status: string;
  to_status: string;
  summary: string;
  run_id: number | null;
  attempt: number;
  created_at: string;
};

export type ChatMissionEvent = {
  id: number;
  missionId: string;
  taskId?: string;
  kind: string;
  title: string;
  fromStatus: string;
  toStatus: string;
  summary: string;
  runId?: number;
  attempt: number;
  createdAt: string;
};

export type MissionProjectionUpdate = {
  mission: ChatMission;
  vaultId: string;
  channelId: string;
  rootMessageId: string;
  createdBy: number;
  /** Obsolete coordinator prompts, trace carriers, and run shells removed when review finishes first. */
  removedWakeMessageIds?: string[];
  /** Already-launched stale review runs that should be canceled by the route. */
  canceledWakeRunIds?: number[];
  /** Live worker runs explicitly canceled through task steering. */
  canceledTaskRunIds?: number[];
};

export type MissionWake = MissionProjectionUpdate & {
  coordinatorRegistrationId: string;
};

export type MissionTaskScheduleCandidate = {
  taskId: string;
  missionId: string;
  vaultId: string;
  channelId: string;
  createdBy: number;
  coordinatorRegistrationId: string;
  assigneeRegistrationId: string;
  title: string;
  prompt: string;
  reasoningEffort: string;
  anonymous: boolean;
  attempt: number;
};

export function ensureChatMissionSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_missions (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      root_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      coordinator_registration_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      summary TEXT NOT NULL DEFAULT '',
      wake_sent INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(channel_id, root_message_id)
    );
    CREATE INDEX IF NOT EXISTS chat_missions_channel_idx
      ON chat_missions(channel_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS chat_mission_tasks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES chat_missions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      assignee_registration_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      reasoning_effort TEXT NOT NULL DEFAULT '',
      anonymous INTEGER NOT NULL DEFAULT 0,
      dispatch_id TEXT,
      run_id INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0,
      work_item_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS chat_mission_tasks_mission_idx
      ON chat_mission_tasks(mission_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS chat_mission_tasks_dispatch_idx
      ON chat_mission_tasks(dispatch_id) WHERE dispatch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS chat_mission_tasks_run_idx
      ON chat_mission_tasks(run_id) WHERE run_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS chat_mission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL REFERENCES chat_missions(id) ON DELETE CASCADE,
      task_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      from_status TEXT NOT NULL DEFAULT '',
      to_status TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      run_id INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0,
      source_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS chat_mission_events_mission_idx
      ON chat_mission_events(mission_id, id);
  `);
  const taskColumns = db.prepare('PRAGMA table_info(chat_mission_tasks)').all() as Array<{ name: string }>;
  if (!taskColumns.some((column) => column.name === 'prompt')) {
    db.exec("ALTER TABLE chat_mission_tasks ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!taskColumns.some((column) => column.name === 'depends_on_json')) {
    db.exec("ALTER TABLE chat_mission_tasks ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!taskColumns.some((column) => column.name === 'priority')) {
    db.exec('ALTER TABLE chat_mission_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  }
  if (!taskColumns.some((column) => column.name === 'reasoning_effort')) {
    db.exec("ALTER TABLE chat_mission_tasks ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''");
  }
  if (!taskColumns.some((column) => column.name === 'anonymous')) {
    db.exec('ALTER TABLE chat_mission_tasks ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0');
  }
  if (!taskColumns.some((column) => column.name === 'work_item_id')) {
    db.exec('ALTER TABLE chat_mission_tasks ADD COLUMN work_item_id TEXT');
  }
  if (!taskColumns.some((column) => column.name === 'attempt')) {
    db.exec('ALTER TABLE chat_mission_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0');
  }
  // Older schedulers converted every downstream task into a terminal block.
  // That made one retryable worker failure look like the whole mission ended
  // and forced coordinators to rebuild the dependency graph. Restore only the
  // unmistakable scheduler-generated rows; explicit worker blocks stay intact.
  db.exec(`
    UPDATE chat_mission_tasks
    SET status = 'pending', summary = '', updated_at = datetime('now')
    WHERE status = 'blocked'
      AND dispatch_id IS NULL
      AND run_id IS NULL
      AND summary LIKE 'Dependency “%” ended %.'
  `);
  db.exec("UPDATE chat_missions SET status = 'attention' WHERE status = 'blocked'");

  // Existing missions predate the append-only ledger. Preserve their durable
  // snapshot without pretending we know transitions that were never recorded.
  db.exec(`
    INSERT OR IGNORE INTO chat_mission_events (
      mission_id, kind, title, to_status, summary, attempt, created_at, source_key
    )
    SELECT id, 'mission_created', title, 'active', objective, 0, created_at,
      'backfill:mission:' || id || ':created'
    FROM chat_missions m
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_mission_events e
      WHERE e.mission_id = m.id AND e.kind = 'mission_created'
    );

    INSERT OR IGNORE INTO chat_mission_events (
      mission_id, kind, title, to_status, summary, attempt, created_at, source_key
    )
    SELECT id, 'mission_snapshot', title, status, summary, 0, updated_at,
      'backfill:mission:' || id || ':snapshot'
    FROM chat_missions m
    WHERE (status <> 'active' OR summary <> '' OR updated_at <> created_at)
      AND EXISTS (
        SELECT 1 FROM chat_mission_events e
        WHERE e.source_key = 'backfill:mission:' || m.id || ':created'
      );

    INSERT OR IGNORE INTO chat_mission_events (
      mission_id, task_id, kind, title, to_status, summary, attempt, created_at, source_key
    )
    SELECT mission_id, id, 'task_added', title, 'pending', prompt, attempt, created_at,
      'backfill:task:' || id || ':created'
    FROM chat_mission_tasks t
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_mission_events e
      WHERE e.task_id = t.id AND e.kind = 'task_added'
    );

    INSERT OR IGNORE INTO chat_mission_events (
      mission_id, task_id, kind, title, to_status, summary, run_id, attempt, created_at, source_key
    )
    SELECT mission_id, id, 'task_snapshot', title, status, summary, run_id, attempt, updated_at,
      'backfill:task:' || id || ':snapshot'
    FROM chat_mission_tasks t
    WHERE (status <> 'pending' OR summary <> '' OR run_id IS NOT NULL OR updated_at <> created_at)
      AND EXISTS (
        SELECT 1 FROM chat_mission_events e
        WHERE e.source_key = 'backfill:task:' || t.id || ':created'
      );
  `);
  // Missions compile into work items; ensure the twin table exists on the same
  // upgrade path so projection can join without a separate migrate step.
  ensureWorkItemSchema(db);
  // Early scheduler builds linked the worker run to its task but omitted the
  // same durable task id from the rendered reply. Repair those existing rows so
  // internal worker reports collapse after reload as well as on new runs.
  db.exec(`
    UPDATE chat_messages
    SET mission_task_id = (
      SELECT task.id
      FROM chat_mission_tasks task
      WHERE task.run_id = chat_messages.run_id
      LIMIT 1
    )
    WHERE mission_task_id IS NULL
      AND run_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM chat_mission_tasks task
        WHERE task.run_id = chat_messages.run_id
      )
  `);
  // Re-project upgraded open missions immediately. The scheduler only emits
  // state that changes after boot, so leaving this to its polling loop would
  // keep legacy blocked descendants visible until someone opened the archive.
  const openMissions = db.prepare(`
    SELECT id FROM chat_missions
    WHERE status IN ('active', 'reviewing', 'attention', 'blocked')
  `).all() as Array<{ id: string }>;
  for (const mission of openMissions) refreshMissionProjection(db, mission.id);
}

/** Map chat-mission task lifecycle onto the durable work-item status model. */
export function missionTaskStatusToWorkItemStatus(status: ChatMissionTaskStatus): WorkItemStatus {
  switch (status) {
    case 'running':
      return 'in_progress';
    case 'blocked':
    case 'failed':
      return 'blocked';
    case 'completed':
      return 'done';
    case 'canceled':
      return 'canceled';
    case 'pending':
    default:
      return 'open';
  }
}

/** Durable workspace identity for a dispatched mission task. */
export function getMissionTaskWorkItemId(db: Db, taskId: string): string | null {
  const row = db.prepare('SELECT work_item_id FROM chat_mission_tasks WHERE id = ?').get(taskId) as { work_item_id: string | null } | undefined;
  return row?.work_item_id || null;
}

function slugifyBranchPart(value: string): string {
  return cleanText(value, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'task';
}

function workItemBranchForTask(missionId: string, taskId: string, title: string): string {
  return `cascade/${missionId.slice(0, 8)}/${slugifyBranchPart(title)}-${taskId.slice(0, 6)}`;
}

/**
 * Compile a mission task into a durable work item (or return the existing twin).
 * Workspaces/PRs hang off the work item; the mission task remains the chat
 * scheduling authority.
 */
export function ensureWorkItemForMissionTask(
  db: Db,
  userId: number,
  mission: MissionRow,
  task: TaskRow,
): WorkItem {
  if (task.work_item_id) {
    try {
      return getWorkItem(db, userId, task.work_item_id);
    } catch {
      /* re-create if the twin was deleted */
    }
  }
  const existing = db.prepare(`
    SELECT id FROM work_items
    WHERE vault_id = ? AND source_kind = 'mission' AND source_id = ?
    LIMIT 1
  `).get(mission.vault_id, task.id) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE chat_mission_tasks SET work_item_id = ? WHERE id = ?').run(existing.id, task.id);
    return getWorkItem(db, userId, existing.id);
  }

  const deps = taskDependencies(task);
  const depWorkItemIds = deps.length === 0
    ? []
    : (db.prepare(`
        SELECT work_item_id AS id FROM chat_mission_tasks
        WHERE mission_id = ? AND id IN (${deps.map(() => '?').join(',')})
          AND work_item_id IS NOT NULL
      `).all(mission.id, ...deps) as Array<{ id: string }>)
      .map((row) => row.id)
      .filter(Boolean);

  const item = createWorkItem(db, userId, mission.vault_id, {
    title: task.title,
    brief: task.prompt || task.title,
    channelId: mission.channel_id,
    priority: task.priority || 0,
    sourceKind: 'mission',
    sourceId: task.id,
    dependsOn: depWorkItemIds,
    assigneeRegistrationId: task.assignee_registration_id,
    workspaceMode: 'isolated',
    branch: workItemBranchForTask(mission.id, task.id, task.title),
  });
  db.prepare('UPDATE chat_mission_tasks SET work_item_id = ? WHERE id = ?').run(item.id, task.id);
  return item;
}

function syncWorkItemForMissionTask(
  db: Db,
  userId: number,
  mission: MissionRow,
  task: TaskRow,
  opts?: { runId?: number; lease?: boolean; release?: boolean; reset?: boolean },
): void {
  let item: WorkItem;
  try {
    item = ensureWorkItemForMissionTask(db, userId, mission, task);
  } catch {
    return;
  }
  const nextStatus = missionTaskStatusToWorkItemStatus(task.status);
  try {
    if (opts?.runId) linkWorkItemRun(db, userId, item.id, opts.runId);
    if (opts?.lease) {
      try {
        acquireWorkItemLease(db, userId, item.id, task.assignee_registration_id);
      } catch {
        /* lease contention is non-fatal for chat scheduling */
      }
    }
    updateWorkItem(db, userId, item.id, {
      status: nextStatus,
      summary: opts?.reset ? '' : task.summary || item.summary,
      ...(opts?.reset ? { verification: '', stopReason: '' } : {}),
      assigneeRegistrationId: task.assignee_registration_id,
    });
    if (opts?.release || ['done', 'canceled', 'blocked'].includes(nextStatus)) {
      try {
        releaseWorkItemLease(db, userId, item.id);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* work-item dual-write must not fail mission scheduling */
  }
}

function taskDependencies(row: Pick<TaskRow, 'depends_on_json'>): string[] {
  try {
    const parsed = JSON.parse(row.depends_on_json || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function cleanText(value: unknown, max: number): string {
  return String(value || '').trim().slice(0, max);
}

function recordMissionEvent(
  db: Db,
  missionId: string,
  input: {
    taskId?: string;
    kind: string;
    title?: string;
    fromStatus?: string;
    toStatus?: string;
    summary?: string;
    runId?: number | null;
    attempt?: number;
  },
): void {
  db.prepare(`
    INSERT INTO chat_mission_events (
      mission_id, task_id, kind, title, from_status, to_status,
      summary, run_id, attempt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    missionId,
    input.taskId || null,
    input.kind,
    input.title || '',
    input.fromStatus || '',
    input.toStatus || '',
    input.summary || '',
    input.runId ?? null,
    input.attempt || 0,
  );
}

function projectMissionEvent(row: MissionEventRow): ChatMissionEvent {
  return {
    id: row.id,
    missionId: row.mission_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    kind: row.kind,
    title: row.title,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    summary: row.summary,
    ...(row.run_id != null ? { runId: row.run_id } : {}),
    attempt: row.attempt || 0,
    createdAt: row.created_at,
  };
}

function dependencyNeedsAttention(task: TaskRow, byId: ReadonlyMap<string, TaskRow>, seen = new Set<string>()): boolean {
  if (seen.has(task.id)) return false;
  seen.add(task.id);
  return taskDependencies(task).some((id) => {
    const dependency = byId.get(id);
    if (!dependency) return false;
    if (['failed', 'blocked', 'canceled'].includes(dependency.status)) return true;
    return dependency.status === 'pending' && dependencyNeedsAttention(dependency, byId, seen);
  });
}

function findRegistration(
  db: Db,
  userId: number,
  channelId: string,
  ref: string,
): ChatAgentRegistration | undefined {
  const normalized = String(ref || '').replace(/^@+/, '').trim().toLowerCase();
  return listChatAgentMembers(db, channelId, userId).find((member) => (
    member.id === ref
    || member.vaultAgentId === ref
    || member.mention.toLowerCase() === normalized
    || member.displayName.toLowerCase() === normalized
  ));
}

function assertCoordinator(
  db: Db,
  userId: number,
  channelId: string,
  registrationId: string,
): ChatAgentRegistration {
  const registration = findRegistration(db, userId, channelId, registrationId);
  if (!registration) throw new Error('Mission agent not found');
  const { route } = assertChatChannel(db, channelId, userId);
  const owner = db.prepare(`
    SELECT va.owner_user_id AS owner_user_id
    FROM chat_agent_members m
    JOIN vault_agents va ON va.id = m.vault_agent_id
    WHERE m.id = ? AND m.channel_id = ?
  `).get(registration.id, route.sourceChannelId) as { owner_user_id: number } | undefined;
  if (!owner || owner.owner_user_id !== userId) {
    throw new Error('Only the agent owner can operate its mission');
  }
  return registration;
}

function missionRow(db: Db, missionId: string): MissionRow | undefined {
  return db.prepare('SELECT * FROM chat_missions WHERE id = ?').get(missionId) as MissionRow | undefined;
}

function taskRows(db: Db, missionId: string): TaskRow[] {
  // rowid preserves insert order when many tasks share second-precision created_at
  // (common when dual-writing work items in the same wall-clock second).
  return db.prepare(`
    SELECT * FROM chat_mission_tasks
    WHERE mission_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(missionId) as TaskRow[];
}

function deriveMissionStatus(row: MissionRow, tasks: TaskRow[]): ChatMissionStatus {
  if (row.status === 'canceled') return 'canceled';
  if (row.status === 'completed') return 'completed';
  if (tasks.length === 0) return 'active';
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // A worker failure is a review checkpoint, not a declaration that a large
  // mission has stopped. Downstream tasks remain pending and can resume after
  // the failed task is retried or replaced.
  if (tasks.some((task) => task.status === 'failed' || task.status === 'blocked')) return 'attention';
  if (tasks.some((task) => task.status === 'pending' && dependencyNeedsAttention(task, byId))) return 'attention';
  // Worker completion means the coordinator has evidence to reconcile, not
  // that the user's whole request is done. Only `finishChatMission` can make
  // the mission completed after integration and verification.
  if (tasks.every((task) => task.status === 'completed' || task.status === 'canceled')) return 'reviewing';
  return 'active';
}

function projectMission(db: Db, row: MissionRow, tasks: TaskRow[]): ChatMission {
  const registrations = listChatAgentMembers(db, row.channel_id, row.created_by);
  const byId = new Map(registrations.map((registration) => [registration.id, registration]));
  const coordinator = byId.get(row.coordinator_registration_id);
  const byTaskId = new Map(tasks.map((item) => [item.id, item]));
  const workItemIds = tasks.map((task) => task.work_item_id).filter((id): id is string => Boolean(id));
  const workItemsById = new Map<string, WorkItem>();
  if (workItemIds.length) {
    for (const id of workItemIds) {
      try {
        workItemsById.set(id, getWorkItem(db, row.created_by, id));
      } catch {
        /* twin missing — omit workspace projection */
      }
    }
  }
  const projectedTasks: ChatMissionTask[] = tasks.map((task) => {
    const assignee = byId.get(task.assignee_registration_id);
    const dependsOn = taskDependencies(task);
    const waitingFor = dependsOn.filter((id) => byTaskId.get(id)?.status !== 'completed');
    const waitingOnAttention = task.status === 'pending' && dependencyNeedsAttention(task, byTaskId);
    const anonymous = Boolean(task.anonymous);
    const baseMention = assignee?.mention || '';
    const workItem = task.work_item_id ? workItemsById.get(task.work_item_id) : undefined;
    return {
      id: task.id,
      title: task.title,
      assignee: anonymous
        ? `${assignee?.displayName || assignee?.mention || 'agent'} subagent`
        : (assignee?.displayName || assignee?.mention || 'Unassigned agent'),
      assigneeMention: anonymous && baseMention ? `${baseMention}·sub` : baseMention,
      assigneeModel: assignee?.model || '',
      status: task.status,
      summary: task.summary || '',
      dependsOn,
      waitingFor,
      priority: task.priority || 0,
      reasoningEffort: task.reasoning_effort || '',
      anonymous,
      attempt: task.attempt || 0,
      queueReason: task.status !== 'pending'
        ? ''
        : waitingFor.length
          ? (waitingOnAttention ? 'dependency-attention' : 'dependency')
          : task.dispatch_id
            ? 'queued'
            : 'agent-busy',
      ...(task.run_id != null ? { runId: task.run_id } : {}),
      ...(workItem ? {
        workItemId: workItem.id,
        workItemStatus: workItem.status,
        workspaceMode: workItem.workspaceMode,
        baseCommit: workItem.baseCommit,
        branch: workItem.branch,
        worktreePath: workItem.worktreePath,
        prUrl: workItem.prUrl || undefined,
        prState: workItem.prState || undefined,
        verification: workItem.verification || undefined,
        gitState: workItem.gitState ? {
          changedFiles: workItem.gitState.changedFiles,
          dirty: workItem.gitState.dirty,
          behind: workItem.gitState.behind,
          updatedAt: workItem.gitStateUpdatedAt || '',
        } : undefined,
        reviewReady: workItem.reviewReadiness.ready,
        reviewBlockers: workItem.reviewReadiness.blockers,
        reviewState: workItem.status === 'review'
          ? (workItem.prUrl ? 'in_review' : 'requested')
          : workItem.status === 'done' && workItem.verification
            ? 'ready'
            : 'none',
      } : {}),
      updatedAt: task.updated_at,
    };
  });
  return {
    id: row.id,
    rootMessageId: row.root_message_id,
    title: row.title,
    objective: row.objective,
    status: deriveMissionStatus(row, tasks),
    coordinator: coordinator?.displayName || coordinator?.mention || 'Coordinator',
    coordinatorMention: coordinator?.mention || '',
    tasks: projectedTasks,
    summary: row.summary || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Refresh the transcript projection after every state transition. */
export function refreshMissionProjection(db: Db, missionId: string): MissionProjectionUpdate {
  const row = missionRow(db, missionId);
  if (!row) throw new Error('Mission not found');
  const tasks = taskRows(db, missionId);
  const status = deriveMissionStatus(row, tasks);
  if (status !== row.status) {
    db.prepare(`
      UPDATE chat_missions SET status = ?, updated_at = datetime('now') WHERE id = ?
    `).run(status, missionId);
    recordMissionEvent(db, missionId, {
      kind: 'mission_status_changed',
      title: row.title,
      fromStatus: row.status,
      toStatus: status,
    });
  }
  const updated = missionRow(db, missionId)!;
  const mission = projectMission(db, updated, tasks);
  db.prepare(`
    UPDATE chat_messages SET mission_json = ? WHERE id = ? AND channel_id = ?
  `).run(JSON.stringify(mission), updated.root_message_id, updated.channel_id);
  return {
    mission,
    vaultId: updated.vault_id,
    channelId: updated.channel_id,
    rootMessageId: updated.root_message_id,
    createdBy: updated.created_by,
  };
}

export function missionRootMessage(db: Db, update: MissionProjectionUpdate): ChatMessage | undefined {
  return getChatMessage(db, update.channelId, update.createdBy, update.rootMessageId);
}

export function createChatMission(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  input: {
    rootMessageId: string;
    coordinatorRegistrationId: string;
    title: string;
    objective?: string;
  },
): MissionProjectionUpdate {
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId) throw new Error('Chat channel not found');
  const coordinator = assertCoordinator(db, userId, channelId, input.coordinatorRegistrationId);
  const root = getChatMessage(db, channelId, userId, input.rootMessageId);
  if (!root) throw new Error('Mission root message not found');
  const title = cleanText(input.title, 180);
  if (!title) throw new Error('Mission title is required');
  const objective = cleanText(input.objective || root.body, 4000);
  const existing = db.prepare(`
    SELECT id, coordinator_registration_id FROM chat_missions WHERE channel_id = ? AND root_message_id = ?
  `).get(route.sourceChannelId, root.id) as { id: string; coordinator_registration_id: string } | undefined;
  if (existing && existing.coordinator_registration_id !== coordinator.id) {
    throw new Error('Mission belongs to another coordinator');
  }
  const id = existing?.id || crypto.randomUUID();
  if (!existing) {
    db.prepare(`
      INSERT INTO chat_missions (
        id, vault_id, channel_id, root_message_id, coordinator_registration_id,
        title, objective, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      route.sourceVaultId,
      route.sourceChannelId,
      root.id,
      coordinator.id,
      title,
      objective,
      userId,
    );
    recordMissionEvent(db, id, {
      kind: 'mission_created',
      title,
      toStatus: 'active',
      summary: objective,
    });
  }
  return refreshMissionProjection(db, id);
}

export function getChatMission(
  db: Db,
  userId: number,
  channelId: string,
  missionRef: string,
  coordinatorRegistrationId?: string,
): MissionProjectionUpdate {
  const { route } = assertChatChannel(db, channelId, userId);
  let row: MissionRow | undefined;
  if (!missionRef || missionRef === 'current') {
    row = db.prepare(`
      SELECT * FROM chat_missions
      WHERE channel_id = ?
        AND (? = '' OR coordinator_registration_id = ?)
      ORDER BY
        CASE WHEN status IN ('active', 'reviewing', 'attention', 'blocked') THEN 0 ELSE 1 END,
        updated_at DESC, rowid DESC
      LIMIT 1
    `).get(route.sourceChannelId, coordinatorRegistrationId || '', coordinatorRegistrationId || '') as MissionRow | undefined;
  } else {
    row = missionRow(db, missionRef);
    if (row?.channel_id !== route.sourceChannelId) row = undefined;
  }
  if (!row) throw new Error('Mission not found');
  return refreshMissionProjection(db, row.id);
}

/** Durable channel mission archive. Intentionally unbounded; callers opt in. */
export function listChatMissions(
  db: Db,
  userId: number,
  channelId: string,
  coordinatorRegistrationId?: string,
): ChatMission[] {
  const { route } = assertChatChannel(db, channelId, userId);
  const rows = db.prepare(`
    SELECT * FROM chat_missions
    WHERE channel_id = ?
      AND (? = '' OR coordinator_registration_id = ?)
    ORDER BY updated_at DESC, rowid DESC
  `).all(
    route.sourceChannelId,
    coordinatorRegistrationId || '',
    coordinatorRegistrationId || '',
  ) as MissionRow[];
  return rows.map((row) => refreshMissionProjection(db, row.id).mission);
}

/** Append-only mission timeline. No retention window or result cap. */
export function listChatMissionEvents(
  db: Db,
  userId: number,
  channelId: string,
  missionId: string,
): ChatMissionEvent[] {
  const { route } = assertChatChannel(db, channelId, userId);
  const row = missionRow(db, missionId);
  if (!row || row.channel_id !== route.sourceChannelId) throw new Error('Mission not found');
  return (db.prepare(`
    SELECT * FROM chat_mission_events
    WHERE mission_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(missionId) as MissionEventRow[]).map(projectMissionEvent);
}

export function addChatMissionTask(
  db: Db,
  userId: number,
  channelId: string,
  missionId: string,
  input: {
    coordinatorRegistrationId: string;
    title: string;
    assignee: string;
    prompt?: string;
    dependsOn?: string[];
    priority?: number;
    reasoningEffort?: string;
    anonymous?: boolean;
    /** Internal: bind the coordinator's already-dispatched root turn. */
    primary?: boolean;
  },
): { update: MissionProjectionUpdate; task: ChatMissionTask; assignee: ChatAgentRegistration } {
  const update = getChatMission(db, userId, channelId, missionId, input.coordinatorRegistrationId);
  const row = missionRow(db, update.mission.id)!;
  if (row.status === 'completed' || row.status === 'canceled') {
    throw new Error('Mission is already closed');
  }
  const coordinator = assertCoordinator(db, userId, channelId, input.coordinatorRegistrationId);
  if (row.coordinator_registration_id !== coordinator.id) throw new Error('Mission belongs to another coordinator');
  const assignee = findRegistration(db, userId, channelId, input.assignee);
  if (!assignee) throw new Error(`No channel agent matches ${input.assignee}`);
  const anonymous = Boolean(input.anonymous);
  if (assignee.id === coordinator.id && !anonymous && !input.primary) {
    throw new Error('Delegate this task to another channel agent, or pass anonymous for a self-subagent');
  }
  const title = cleanText(input.title, 240);
  if (!title) throw new Error('Task title is required');
  const dependencies = Array.from(new Set((input.dependsOn || []).map((id) => cleanText(id, 80)).filter(Boolean)));
  if (dependencies.length) {
    const found = db.prepare(`
      SELECT id FROM chat_mission_tasks WHERE mission_id = ? AND id IN (${dependencies.map(() => '?').join(',')})
    `).all(row.id, ...dependencies) as Array<{ id: string }>;
    if (found.length !== dependencies.length) throw new Error('Every dependency must be an existing task in this mission');
  }
  const priority = Math.max(-100, Math.min(100, Math.floor(Number(input.priority) || 0)));
  const requestedEffort = cleanText(input.reasoningEffort, 20).toLowerCase();
  const supportedEfforts = assignee.agentId === 'codex'
    ? ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    : assignee.agentId === 'claude-code'
      ? ['', 'low', 'medium', 'high', 'xhigh', 'max']
      : [''];
  if (!supportedEfforts.includes(requestedEffort)) {
    throw new Error(`${requestedEffort || 'Reasoning effort'} is not supported by @${assignee.mention}`);
  }
  const reasoningEffort = requestedEffort;
  // Tool retries after a lost HTTP response must not fan out a second worker.
  // A coordinator can still rerun work by giving the new task a distinct title.
  const existing = db.prepare(`
    SELECT * FROM chat_mission_tasks
    WHERE mission_id = ? AND assignee_registration_id = ? AND title = ?
    ORDER BY created_at ASC, rowid ASC LIMIT 1
  `).get(row.id, assignee.id, title) as TaskRow | undefined;
  const normalizedPrompt = cleanText(input.prompt || title, 12_000);
  const anonymousFlag = anonymous ? 1 : 0;
  if (existing && (
    existing.prompt !== normalizedPrompt
    || existing.depends_on_json !== JSON.stringify(dependencies)
    || existing.priority !== priority
    || existing.reasoning_effort !== reasoningEffort
    || Boolean(existing.anonymous) !== anonymous
  )) {
    throw new Error('A task with this title already exists with different scheduling options; use a distinct title');
  }
  const taskId = existing?.id || crypto.randomUUID();
  if (!existing) {
    db.prepare(`
      INSERT INTO chat_mission_tasks (
        id, mission_id, title, assignee_registration_id, prompt,
        depends_on_json, priority, reasoning_effort, anonymous
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      row.id,
      title,
      assignee.id,
      normalizedPrompt,
      JSON.stringify(dependencies),
      priority,
      reasoningEffort,
      anonymousFlag,
    );
    db.prepare(`
      UPDATE chat_missions SET status = 'active', wake_sent = 0, updated_at = datetime('now') WHERE id = ?
    `).run(row.id);
    if (row.status !== 'active') {
      recordMissionEvent(db, row.id, {
        kind: 'mission_status_changed',
        title: row.title,
        fromStatus: row.status,
        toStatus: 'active',
        summary: 'Follow-up work added.',
      });
    }
    // Compile into a durable work-item twin (isolated workspace identity).
    const taskRow = db.prepare('SELECT * FROM chat_mission_tasks WHERE id = ?').get(taskId) as TaskRow;
    ensureWorkItemForMissionTask(db, userId, row, taskRow);
    recordMissionEvent(db, row.id, {
      taskId,
      kind: 'task_added',
      title,
      toStatus: 'pending',
      summary: normalizedPrompt,
      attempt: 0,
    });
  } else if (!existing.work_item_id) {
    ensureWorkItemForMissionTask(db, userId, row, existing);
  }
  const refreshed = refreshMissionProjection(db, row.id);
  return {
    update: refreshed,
    task: refreshed.mission.tasks.find((task) => task.id === taskId)!,
    assignee,
  };
}

/**
 * Choose ready work without assigning more
 * than one named (non-anonymous) active task to any agent. Anonymous subagents
 * are parallel clones and skip that occupancy limit. Dispatch materialization
 * remains in the route layer because it also broadcasts the synthetic worker
 * message.
 */
export function listSchedulableMissionTasks(
  db: Db,
  missionId?: string,
): { candidates: MissionTaskScheduleCandidate[]; updates: MissionProjectionUpdate[] } {
  const missionFilter = missionId ? 'AND m.id = ?' : '';
  const args = missionId ? [missionId] : [];
  const missions = db.prepare(`
    SELECT m.* FROM chat_missions m
    -- A coordinator review is a pause between waves, not a terminal state:
    -- users can add a follow-up task while reviewing prior evidence.
    WHERE m.status IN ('active', 'reviewing', 'attention', 'blocked') ${missionFilter}
    ORDER BY m.created_at ASC, m.rowid ASC
  `).all(...args) as MissionRow[];
  const updates: MissionProjectionUpdate[] = [];
  const candidates: MissionTaskScheduleCandidate[] = [];
  const reserved = new Set<string>();

  for (const mission of missions) {
    const tasks = taskRows(db, mission.id);

    const occupied = new Set((db.prepare(`
      SELECT DISTINCT t.assignee_registration_id AS id
      FROM chat_mission_tasks t
      JOIN chat_missions m ON m.id = t.mission_id
      WHERE m.channel_id = ? AND m.status IN ('active', 'reviewing', 'attention', 'blocked')
        AND COALESCE(t.anonymous, 0) = 0
        AND (t.status = 'running' OR (t.status = 'pending' AND t.dispatch_id IS NOT NULL))
    `).all(mission.channel_id) as Array<{ id: string }>).map((row) => row.id));
    const currentById = new Map(tasks.map((task) => [task.id, task]));
    // Keep ready order as taskRows already sorted by created_at/rowid; only
    // re-sort by priority so same-second inserts stay in insert order.
    const ready = tasks
      .filter((task) => task.status === 'pending' && !task.dispatch_id)
      .filter((task) => taskDependencies(task).every((id) => currentById.get(id)?.status === 'completed'))
      .map((task, index) => ({ task, index }))
      .sort((a, b) => b.task.priority - a.task.priority || a.index - b.index)
      .map((entry) => entry.task);
    for (const task of ready) {
      const anonymous = Boolean(task.anonymous);
      if (!anonymous) {
        const reservationKey = `${mission.channel_id}:${task.assignee_registration_id}`;
        if (occupied.has(task.assignee_registration_id) || reserved.has(reservationKey)) continue;
        occupied.add(task.assignee_registration_id);
        reserved.add(reservationKey);
      }
      candidates.push({
        taskId: task.id,
        missionId: mission.id,
        vaultId: mission.vault_id,
        channelId: mission.channel_id,
        createdBy: mission.created_by,
        coordinatorRegistrationId: mission.coordinator_registration_id,
        assigneeRegistrationId: task.assignee_registration_id,
        title: task.title,
        prompt: task.prompt || task.title,
        reasoningEffort: task.reasoning_effort || '',
        anonymous,
        attempt: task.attempt || 0,
      });
    }
  }
  return { candidates, updates };
}

export function linkMissionTaskDispatch(db: Db, taskId: string, dispatchId: string): MissionProjectionUpdate {
  const row = db.prepare('SELECT * FROM chat_mission_tasks WHERE id = ?')
    .get(taskId) as TaskRow | undefined;
  if (!row) throw new Error('Mission task not found');
  const linked = db.prepare(`
    UPDATE chat_mission_tasks SET dispatch_id = COALESCE(dispatch_id, ?), updated_at = datetime('now')
    WHERE id = ? AND dispatch_id IS NULL
  `).run(dispatchId, taskId);
  if (linked.changes > 0) {
    recordMissionEvent(db, row.mission_id, {
      taskId,
      kind: 'task_dispatched',
      title: row.title,
      fromStatus: row.status,
      toStatus: row.status,
      attempt: row.attempt || 0,
    });
  }
  return refreshMissionProjection(db, row.mission_id);
}

export function attachRunToMissionTaskByDispatch(db: Db, dispatchId: string, runId: number): MissionProjectionUpdate | null {
  const row = db.prepare(`
    SELECT * FROM chat_mission_tasks WHERE dispatch_id = ?
  `).get(dispatchId) as TaskRow | undefined;
  if (!row) return null;
  if (row.status === 'pending' || row.status === 'running') {
    db.prepare(`
      UPDATE chat_mission_tasks SET run_id = ?, status = 'running', updated_at = datetime('now') WHERE id = ?
    `).run(runId, row.id);
    if (row.status !== 'running' || row.run_id !== runId) {
      recordMissionEvent(db, row.mission_id, {
        taskId: row.id,
        kind: 'task_started',
        title: row.title,
        fromStatus: row.status,
        toStatus: 'running',
        runId,
        attempt: row.attempt || 0,
      });
    }
  }
  const mission = missionRow(db, row.mission_id);
  const updated = db.prepare('SELECT * FROM chat_mission_tasks WHERE id = ?').get(row.id) as TaskRow;
  if (mission) {
    syncWorkItemForMissionTask(db, mission.created_by, mission, updated, { runId, lease: true });
  }
  return refreshMissionProjection(db, row.mission_id);
}

export function updateChatMissionTask(
  db: Db,
  userId: number,
  channelId: string,
  taskId: string,
  input: { status: ChatMissionTaskStatus; summary?: string },
): MissionProjectionUpdate {
  const { route } = assertChatChannel(db, channelId, userId);
  const row = db.prepare(`
    SELECT t.*, m.channel_id AS owner_channel_id, m.created_by, m.status AS mission_status FROM chat_mission_tasks t
    JOIN chat_missions m ON m.id = t.mission_id WHERE t.id = ?
  `).get(taskId) as (TaskRow & { owner_channel_id: string; created_by: number; mission_status: ChatMissionStatus }) | undefined;
  if (!row || row.owner_channel_id !== route.sourceChannelId || row.created_by !== userId) {
    throw new Error('Mission task not found');
  }
  if (row.mission_status === 'completed' || row.mission_status === 'canceled') {
    throw new Error('Mission is already closed');
  }
  const allowed: ChatMissionTaskStatus[] = ['pending', 'running', 'completed', 'failed', 'blocked', 'canceled'];
  if (!allowed.includes(input.status)) throw new Error('Invalid mission task status');
  const summary = cleanText(input.summary, 4000);
  const terminalStatuses: ChatMissionTaskStatus[] = ['completed', 'failed', 'blocked', 'canceled'];
  const retrying = input.status === 'pending' && terminalStatuses.includes(row.status);
  if (input.status === 'pending' && row.status === 'running') {
    throw new Error('Task is still running; cancel or wait for it before retrying');
  }
  if (retrying && row.run_id != null) {
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(row.run_id) as { status: string } | undefined;
    if (run && ['queued', 'running'].includes(run.status)) {
      throw new Error('Task run is still active; cancel or wait for it before retrying');
    }
  }
  if (retrying) {
    db.prepare(`
      DELETE FROM chat_agent_dispatches
      WHERE run_id IS NULL AND id = ?
    `).run(row.dispatch_id);
    db.prepare(`
      UPDATE chat_mission_tasks
      SET status = 'pending', summary = ?, dispatch_id = NULL, run_id = NULL,
        attempt = attempt + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(summary, taskId);
    db.prepare(`
      UPDATE chat_missions
      SET status = 'active', wake_sent = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(row.mission_id);
    if (row.mission_status !== 'active') {
      const missionTitle = missionRow(db, row.mission_id)?.title || '';
      recordMissionEvent(db, row.mission_id, {
        kind: 'mission_status_changed',
        title: missionTitle,
        fromStatus: row.mission_status,
        toStatus: 'active',
        summary: `Retrying ${row.title}.`,
      });
    }
    recordMissionEvent(db, row.mission_id, {
      taskId,
      kind: 'task_retried',
      title: row.title,
      fromStatus: row.status,
      toStatus: 'pending',
      summary,
      attempt: (row.attempt || 0) + 1,
    });
  } else {
    db.prepare(`
      UPDATE chat_mission_tasks SET status = ?, summary = ?, updated_at = datetime('now') WHERE id = ?
    `).run(input.status, summary, taskId);
    if (row.status !== input.status || row.summary !== summary) {
      recordMissionEvent(db, row.mission_id, {
        taskId,
        kind: 'task_status_changed',
        title: row.title,
        fromStatus: row.status,
        toStatus: input.status,
        summary,
        runId: row.run_id,
        attempt: row.attempt || 0,
      });
    }
  }
  if (terminalStatuses.includes(input.status)) {
    db.prepare(`
      DELETE FROM chat_agent_dispatches
      WHERE run_id IS NULL
        AND id = (SELECT dispatch_id FROM chat_mission_tasks WHERE id = ?)
    `).run(taskId);
  }
  const mission = missionRow(db, row.mission_id);
  const task = db.prepare('SELECT * FROM chat_mission_tasks WHERE id = ?').get(taskId) as TaskRow;
  if (mission && task) {
    syncWorkItemForMissionTask(db, mission.created_by, mission, task, {
      release: terminalStatuses.includes(input.status),
      reset: retrying,
    });
  }
  return {
    ...refreshMissionProjection(db, row.mission_id),
    ...(input.status === 'canceled' && row.run_id != null ? { canceledTaskRunIds: [row.run_id] } : {}),
  };
}

export function finishChatMission(
  db: Db,
  userId: number,
  channelId: string,
  missionId: string,
  input: {
    coordinatorRegistrationId: string;
    status: 'completed' | 'canceled';
    summary?: string;
    /** Preserve the legitimate wake run that is closing its own mission. */
    currentRunId?: number;
  },
): MissionProjectionUpdate {
  const update = getChatMission(db, userId, channelId, missionId, input.coordinatorRegistrationId);
  const row = missionRow(db, update.mission.id)!;
  const coordinator = assertCoordinator(db, userId, channelId, input.coordinatorRegistrationId);
  if (row.coordinator_registration_id !== coordinator.id) throw new Error('Mission belongs to another coordinator');
  if (row.status === 'completed' || row.status === 'canceled') {
    if (row.status !== input.status) throw new Error('Mission is already closed');
    return refreshMissionProjection(db, row.id);
  }
  let tasks = taskRows(db, row.id);
  // The coordinator's implicit primary task represents this very run. Finishing
  // the mission is the natural terminal action, so do not require agents to
  // first issue a redundant task-update command. Never settle delegated work.
  if (input.status === 'completed' && input.currentRunId != null) {
    const primary = tasks.find((task) => (
      task.status === 'running'
      && task.run_id === input.currentRunId
      && task.assignee_registration_id === row.coordinator_registration_id
    ));
    if (primary) {
      const summary = cleanText(input.summary, 4000);
      db.prepare(`
        UPDATE chat_mission_tasks
        SET status = 'completed', summary = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(summary, primary.id);
      recordMissionEvent(db, row.id, {
        taskId: primary.id,
        kind: 'task_status_changed',
        title: primary.title,
        fromStatus: primary.status,
        toStatus: 'completed',
        summary,
        runId: primary.run_id,
        attempt: primary.attempt || 0,
      });
      syncWorkItemForMissionTask(db, row.created_by, row, { ...primary, status: 'completed', summary }, { release: true });
      tasks = taskRows(db, row.id);
    }
  }
  if (input.status === 'completed' && tasks.some((task) => task.status === 'pending' || task.status === 'running')) {
    throw new Error('Mission still has active workers');
  }
  db.prepare(`
    UPDATE chat_missions SET status = ?, summary = ?, wake_sent = 1, updated_at = datetime('now') WHERE id = ?
  `).run(input.status, cleanText(input.summary, 4000), row.id);
  recordMissionEvent(db, row.id, {
    kind: input.status === 'completed' ? 'mission_completed' : 'mission_canceled',
    title: row.title,
    fromStatus: row.status,
    toStatus: input.status,
    summary: cleanText(input.summary, 4000),
  });
  if (input.status === 'canceled') {
    db.prepare(`
      UPDATE chat_mission_tasks SET status = 'canceled', updated_at = datetime('now')
      WHERE mission_id = ? AND status IN ('pending', 'running')
    `).run(row.id);
    for (const task of tasks.filter((item) => item.status === 'pending' || item.status === 'running')) {
      recordMissionEvent(db, row.id, {
        taskId: task.id,
        kind: 'task_status_changed',
        title: task.title,
        fromStatus: task.status,
        toStatus: 'canceled',
        summary: 'Mission canceled.',
        runId: task.run_id,
        attempt: task.attempt || 0,
      });
    }
    db.prepare(`
      DELETE FROM chat_agent_dispatches
      WHERE run_id IS NULL
        AND id IN (SELECT dispatch_id FROM chat_mission_tasks WHERE mission_id = ?)
    `).run(row.id);
  }
  // Worker settlement can enqueue the synthetic review prompt while the
  // coordinator is still finishing the mission in its current run. That
  // dispatch is intentionally queued behind the same provider session. If the
  // coordinator closes the mission before the queue advances, remove the stale
  // prompt and its pending outbox row so it cannot launch a second, inert run.
  const staleWakeRows = db.prepare(`
    SELECT m.id, d.run_id FROM chat_messages m
    JOIN chat_agent_dispatches d ON d.message_id = m.id
    WHERE m.channel_id = ?
      AND m.id LIKE ?
      AND d.registration_id = ?
  `).all(row.channel_id, `sys-mission-${row.id}-%`, row.coordinator_registration_id) as Array<{ id: string; run_id: number | null }>;
  const obsoleteWakeRows = staleWakeRows.filter((item) => (
    item.run_id == null || item.run_id !== input.currentRunId
  ));
  const removedWakeMessageIds = new Set<string>();
  const removeWakeMessage = db.prepare('DELETE FROM chat_messages WHERE id = ? AND channel_id = ?');
  const runShellRows = db.prepare(`
    SELECT id FROM chat_messages
    WHERE channel_id = ? AND run_id = ? AND registration_id = ?
  `);
  for (const wakeMessage of obsoleteWakeRows) {
    if (removeWakeMessage.run(wakeMessage.id, row.channel_id).changes > 0) {
      removedWakeMessageIds.add(wakeMessage.id);
    }
    // Wakes have a paired empty coordinator shell (`agent-trace-*`) so their
    // compact status never hangs under the preceding human message. If a
    // manual finish removes the unlaunched wake, remove that otherwise-empty
    // shell in the same transition.
    const carrierId = wakeMessage.id.replace(/^sys-mission-/, 'agent-trace-');
    if (removeWakeMessage.run(carrierId, row.channel_id).changes > 0) {
      removedWakeMessageIds.add(carrierId);
    }
    // If the redundant wake was already claimed, its visible agent-dispatch
    // shell has a third id. Remove every shell linked to that coordinator run;
    // canceling the run below is automatic cleanup, not a user-authored event.
    if (wakeMessage.run_id != null) {
      const shells = runShellRows.all(
        row.channel_id,
        wakeMessage.run_id,
        row.coordinator_registration_id,
      ) as Array<{ id: string }>;
      for (const shell of shells) {
        if (removeWakeMessage.run(shell.id, row.channel_id).changes > 0) {
          removedWakeMessageIds.add(shell.id);
        }
      }
    }
  }
  const canceledWakeRunIds = obsoleteWakeRows.flatMap((item) => item.run_id == null ? [] : [item.run_id]);
  for (const task of taskRows(db, row.id)) {
    syncWorkItemForMissionTask(db, userId, row, task, { release: true });
  }
  return {
    ...refreshMissionProjection(db, row.id),
    ...(removedWakeMessageIds.size ? { removedWakeMessageIds: [...removedWakeMessageIds] } : {}),
    ...(canceledWakeRunIds.length ? { canceledWakeRunIds } : {}),
  };
}

/** Claim the coordinator review wake exactly once after every task is terminal. */
export function claimMissionCoordinatorWake(db: Db, missionId: string): MissionWake | null {
  const update = refreshMissionProjection(db, missionId);
  const rows = taskRows(db, missionId);
  const byId = new Map(rows.map((task) => [task.id, task]));
  const allWorkersSettled = rows.length > 0
    && rows.every((item) => ['completed', 'failed', 'blocked', 'canceled'].includes(item.status));
  const workStillMoving = rows.some((task) => (
    task.status === 'running'
    || (task.status === 'pending' && task.dispatch_id != null)
    || (task.status === 'pending' && !task.dispatch_id
      && taskDependencies(task).every((id) => byId.get(id)?.status === 'completed'))
  ));
  const stalledForAttention = ['attention', 'blocked'].includes(update.mission.status) && !workStillMoving;
  if ((!allWorkersSettled && !stalledForAttention)
    || !['reviewing', 'attention', 'blocked'].includes(update.mission.status)) {
    return null;
  }
  const claimed = db.prepare(`
    UPDATE chat_missions SET wake_sent = 1, updated_at = datetime('now')
    WHERE id = ? AND wake_sent = 0
  `).run(missionId);
  if (claimed.changes === 0) return null;
  const row = missionRow(db, missionId)!;
  return { ...refreshMissionProjection(db, missionId), coordinatorRegistrationId: row.coordinator_registration_id };
}

/** Settle a worker task from its authoritative run terminal status. */
export function settleMissionTaskForRun(
  db: Db,
  runId: number,
  status: 'completed' | 'failed' | 'canceled',
  summary: string,
): { update: MissionProjectionUpdate; wake: MissionWake | null } | null {
  const task = db.prepare(`
    SELECT * FROM chat_mission_tasks WHERE run_id = ? LIMIT 1
  `).get(runId) as TaskRow | undefined;
  if (!task) return null;
  // A worker may explicitly report blocked before exiting successfully. Preserve
  // that higher-information state instead of converting it to completed.
  if (!['blocked', 'canceled', 'completed', 'failed'].includes(task.status)) {
    const next: ChatMissionTaskStatus = status === 'completed' ? 'completed' : status;
    const cleanedSummary = cleanText(summary, 4000);
    db.prepare(`
      UPDATE chat_mission_tasks SET status = ?, summary = ?, updated_at = datetime('now') WHERE id = ?
    `).run(next, cleanedSummary, task.id);
    recordMissionEvent(db, task.mission_id, {
      taskId: task.id,
      kind: 'task_status_changed',
      title: task.title,
      fromStatus: task.status,
      toStatus: next,
      summary: cleanedSummary,
      runId,
      attempt: task.attempt || 0,
    });
  }
  const mission = missionRow(db, task.mission_id);
  const settled = db.prepare('SELECT * FROM chat_mission_tasks WHERE id = ?').get(task.id) as TaskRow;
  if (mission && settled) {
    syncWorkItemForMissionTask(db, mission.created_by, mission, settled, {
      runId: runId,
      release: true,
    });
  }
  const update = refreshMissionProjection(db, task.mission_id);
  const wake = claimMissionCoordinatorWake(db, task.mission_id);
  return { update: wake || update, wake };
}
