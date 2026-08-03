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
  dispatch_id: string | null;
  run_id: number | null;
  created_at: string;
  updated_at: string;
};

export type MissionProjectionUpdate = {
  mission: ChatMission;
  vaultId: string;
  channelId: string;
  rootMessageId: string;
  createdBy: number;
  /** Obsolete synthetic coordinator prompts removed when review finishes first. */
  removedWakeMessageIds?: string[];
  /** Already-launched stale review runs that should be canceled by the route. */
  canceledWakeRunIds?: number[];
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
      dispatch_id TEXT,
      run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS chat_mission_tasks_mission_idx
      ON chat_mission_tasks(mission_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS chat_mission_tasks_dispatch_idx
      ON chat_mission_tasks(dispatch_id) WHERE dispatch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS chat_mission_tasks_run_idx
      ON chat_mission_tasks(run_id) WHERE run_id IS NOT NULL;
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
  if (!registration || !registration.orchestrator) {
    throw new Error('This agent is not the channel coordinator');
  }
  const { route } = assertChatChannel(db, channelId, userId);
  const owner = db.prepare(`
    SELECT va.owner_user_id AS owner_user_id
    FROM chat_agent_members m
    JOIN vault_agents va ON va.id = m.vault_agent_id
    WHERE m.id = ? AND m.channel_id = ?
  `).get(registration.id, route.sourceChannelId) as { owner_user_id: number } | undefined;
  if (!owner || owner.owner_user_id !== userId) {
    throw new Error('Only the coordinator owner can operate its mission');
  }
  return registration;
}

function missionRow(db: Db, missionId: string): MissionRow | undefined {
  return db.prepare('SELECT * FROM chat_missions WHERE id = ?').get(missionId) as MissionRow | undefined;
}

function taskRows(db: Db, missionId: string): TaskRow[] {
  return db.prepare(`
    SELECT * FROM chat_mission_tasks
    WHERE mission_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(missionId) as TaskRow[];
}

function deriveMissionStatus(row: MissionRow, tasks: TaskRow[]): ChatMissionStatus {
  if (row.status === 'canceled') return 'canceled';
  if (row.status === 'completed') return 'completed';
  if (tasks.length === 0) return 'active';
  if (tasks.some((task) => task.status === 'failed' || task.status === 'blocked')) return 'blocked';
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
  const projectedTasks: ChatMissionTask[] = tasks.map((task) => {
    const assignee = byId.get(task.assignee_registration_id);
    const dependsOn = taskDependencies(task);
    const waitingFor = dependsOn.filter((id) => byTaskId.get(id)?.status !== 'completed');
    return {
      id: task.id,
      title: task.title,
      assignee: assignee?.displayName || assignee?.mention || 'Unassigned agent',
      assigneeMention: assignee?.mention || '',
      assigneeModel: assignee?.model || '',
      status: task.status,
      summary: task.summary || '',
      dependsOn,
      waitingFor,
      priority: task.priority || 0,
      reasoningEffort: task.reasoning_effort || '',
      queueReason: task.status !== 'pending'
        ? ''
        : waitingFor.length
          ? 'dependency'
          : task.dispatch_id
            ? 'queued'
            : 'agent-busy',
      ...(task.run_id != null ? { runId: task.run_id } : {}),
      updatedAt: task.updated_at,
    };
  });
  return {
    id: row.id,
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
        CASE WHEN status IN ('active', 'reviewing', 'blocked') THEN 0 ELSE 1 END,
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
  if (assignee.id === coordinator.id) throw new Error('Delegate this task to another channel agent');
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
    SELECT id FROM chat_mission_tasks
    WHERE mission_id = ? AND assignee_registration_id = ? AND title = ?
    ORDER BY created_at ASC, rowid ASC LIMIT 1
  `).get(row.id, assignee.id, title) as { id: string } | undefined;
  const taskId = existing?.id || crypto.randomUUID();
  if (!existing) {
    db.prepare(`
      INSERT INTO chat_mission_tasks (
        id, mission_id, title, assignee_registration_id, prompt,
        depends_on_json, priority, reasoning_effort
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      row.id,
      title,
      assignee.id,
      cleanText(input.prompt || title, 12_000),
      JSON.stringify(dependencies),
      priority,
      reasoningEffort,
    );
  }
  if (!existing) {
    db.prepare(`
      UPDATE chat_missions SET status = 'active', wake_sent = 0, updated_at = datetime('now') WHERE id = ?
    `).run(row.id);
  }
  const refreshed = refreshMissionProjection(db, row.id);
  return {
    update: refreshed,
    task: refreshed.mission.tasks.find((task) => task.id === taskId)!,
    assignee,
  };
}

/**
 * Reconcile dependency failures, then choose ready work without assigning more
 * than one active task to any agent. Dispatch materialization remains in the
 * route layer because it also broadcasts the synthetic worker message.
 */
export function listSchedulableMissionTasks(
  db: Db,
  missionId?: string,
): { candidates: MissionTaskScheduleCandidate[]; updates: MissionProjectionUpdate[] } {
  const missionFilter = missionId ? 'AND m.id = ?' : '';
  const args = missionId ? [missionId] : [];
  const missions = db.prepare(`
    SELECT m.* FROM chat_missions m
    WHERE m.status IN ('active', 'blocked') ${missionFilter}
    ORDER BY m.created_at ASC, m.rowid ASC
  `).all(...args) as MissionRow[];
  const updates: MissionProjectionUpdate[] = [];
  const candidates: MissionTaskScheduleCandidate[] = [];
  const reserved = new Set<string>();

  for (const mission of missions) {
    let tasks = taskRows(db, mission.id);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    let changed = false;
    for (const task of tasks) {
      if (task.status !== 'pending' || task.dispatch_id) continue;
      const failedDependency = taskDependencies(task)
        .map((id) => byId.get(id))
        .find((dependency) => dependency && ['failed', 'blocked', 'canceled'].includes(dependency.status));
      if (!failedDependency) continue;
      db.prepare(`
        UPDATE chat_mission_tasks
        SET status = 'blocked', summary = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'pending' AND dispatch_id IS NULL
      `).run(`Dependency “${failedDependency.title}” ended ${failedDependency.status}.`, task.id);
      changed = true;
    }
    if (changed) tasks = taskRows(db, mission.id);

    const occupied = new Set((db.prepare(`
      SELECT DISTINCT t.assignee_registration_id AS id
      FROM chat_mission_tasks t
      JOIN chat_missions m ON m.id = t.mission_id
      WHERE m.channel_id = ? AND m.status IN ('active', 'reviewing', 'blocked')
        AND (t.status = 'running' OR (t.status = 'pending' AND t.dispatch_id IS NOT NULL))
    `).all(mission.channel_id) as Array<{ id: string }>).map((row) => row.id));
    const currentById = new Map(tasks.map((task) => [task.id, task]));
    const ready = tasks
      .filter((task) => task.status === 'pending' && !task.dispatch_id)
      .filter((task) => taskDependencies(task).every((id) => currentById.get(id)?.status === 'completed'))
      .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    for (const task of ready) {
      const reservationKey = `${mission.channel_id}:${task.assignee_registration_id}`;
      if (occupied.has(task.assignee_registration_id) || reserved.has(reservationKey)) continue;
      occupied.add(task.assignee_registration_id);
      reserved.add(reservationKey);
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
      });
    }
    if (changed) updates.push(refreshMissionProjection(db, mission.id));
  }
  return { candidates, updates };
}

export function linkMissionTaskDispatch(db: Db, taskId: string, dispatchId: string): MissionProjectionUpdate {
  const row = db.prepare('SELECT mission_id FROM chat_mission_tasks WHERE id = ?')
    .get(taskId) as { mission_id: string } | undefined;
  if (!row) throw new Error('Mission task not found');
  db.prepare(`
    UPDATE chat_mission_tasks SET dispatch_id = COALESCE(dispatch_id, ?), updated_at = datetime('now')
    WHERE id = ?
  `).run(dispatchId, taskId);
  return refreshMissionProjection(db, row.mission_id);
}

export function attachRunToMissionTaskByDispatch(db: Db, dispatchId: string, runId: number): MissionProjectionUpdate | null {
  const row = db.prepare(`
    SELECT id, mission_id, status FROM chat_mission_tasks WHERE dispatch_id = ?
  `).get(dispatchId) as { id: string; mission_id: string; status: ChatMissionTaskStatus } | undefined;
  if (!row) return null;
  if (row.status === 'pending' || row.status === 'running') {
    db.prepare(`
      UPDATE chat_mission_tasks SET run_id = ?, status = 'running', updated_at = datetime('now') WHERE id = ?
    `).run(runId, row.id);
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
    SELECT t.mission_id, m.channel_id, m.created_by, m.status AS mission_status FROM chat_mission_tasks t
    JOIN chat_missions m ON m.id = t.mission_id WHERE t.id = ?
  `).get(taskId) as { mission_id: string; channel_id: string; created_by: number; mission_status: ChatMissionStatus } | undefined;
  if (!row || row.channel_id !== route.sourceChannelId || row.created_by !== userId) {
    throw new Error('Mission task not found');
  }
  if (row.mission_status === 'completed' || row.mission_status === 'canceled') {
    throw new Error('Mission is already closed');
  }
  const allowed: ChatMissionTaskStatus[] = ['pending', 'running', 'completed', 'failed', 'blocked', 'canceled'];
  if (!allowed.includes(input.status)) throw new Error('Invalid mission task status');
  db.prepare(`
    UPDATE chat_mission_tasks SET status = ?, summary = ?, updated_at = datetime('now') WHERE id = ?
  `).run(input.status, cleanText(input.summary, 4000), taskId);
  if (['completed', 'failed', 'blocked', 'canceled'].includes(input.status)) {
    db.prepare(`
      DELETE FROM chat_agent_dispatches
      WHERE run_id IS NULL
        AND id = (SELECT dispatch_id FROM chat_mission_tasks WHERE id = ?)
    `).run(taskId);
  }
  return refreshMissionProjection(db, row.mission_id);
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
  const tasks = taskRows(db, row.id);
  if (input.status === 'completed' && tasks.some((task) => task.status === 'pending' || task.status === 'running')) {
    throw new Error('Mission still has active workers');
  }
  db.prepare(`
    UPDATE chat_missions SET status = ?, summary = ?, wake_sent = 1, updated_at = datetime('now') WHERE id = ?
  `).run(input.status, cleanText(input.summary, 4000), row.id);
  if (input.status === 'canceled') {
    db.prepare(`
      UPDATE chat_mission_tasks SET status = 'canceled', updated_at = datetime('now')
      WHERE mission_id = ? AND status IN ('pending', 'running')
    `).run(row.id);
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
  for (const wakeMessage of obsoleteWakeRows) {
    db.prepare('DELETE FROM chat_messages WHERE id = ? AND channel_id = ?')
      .run(wakeMessage.id, row.channel_id);
  }
  const canceledWakeRunIds = obsoleteWakeRows.flatMap((item) => item.run_id == null ? [] : [item.run_id]);
  return {
    ...refreshMissionProjection(db, row.id),
    ...(obsoleteWakeRows.length ? { removedWakeMessageIds: obsoleteWakeRows.map((item) => item.id) } : {}),
    ...(canceledWakeRunIds.length ? { canceledWakeRunIds } : {}),
  };
}

/** Claim the coordinator review wake exactly once after every task is terminal. */
export function claimMissionCoordinatorWake(db: Db, missionId: string): MissionWake | null {
  const update = refreshMissionProjection(db, missionId);
  const allWorkersSettled = update.mission.tasks.length > 0
    && update.mission.tasks.every((item) => ['completed', 'failed', 'blocked', 'canceled'].includes(item.status));
  if (!allWorkersSettled || (update.mission.status !== 'reviewing' && update.mission.status !== 'blocked')) {
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
    db.prepare(`
      UPDATE chat_mission_tasks SET status = ?, summary = ?, updated_at = datetime('now') WHERE id = ?
    `).run(next, cleanText(summary, 4000), task.id);
  }
  const update = refreshMissionProjection(db, task.mission_id);
  const wake = claimMissionCoordinatorWake(db, task.mission_id);
  return { update: wake || update, wake };
}
