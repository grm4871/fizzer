import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  CHAT_NOTE_MARKER,
  acceptChatClarification,
  attachClarificationMission,
  createChatMessage,
  ensureChatSchema,
  getChatMessage,
  linkChatChannel,
  resolveChatAgentRun,
  setChatAgentAvatar,
  upsertChatAgentMember,
  upsertVaultAgent,
} from './chat.js';
import { ensureWorkItemSchema, getWorkItem } from './workItems.js';
import {
  createChatAgentDispatchForRegistration,
  createChatAgentDispatches,
  attachRunToChatAgentDispatch,
  ensureChatDispatchSchema,
  listPendingChatAgentDispatches,
  resolveChatAgentTargets,
} from './chat-dispatch.js';
import {
  addChatMissionTask,
  attachRunToMissionTaskByDispatch,
  createChatMission,
  claimMissionCoordinatorWake,
  ensureChatMissionSchema,
  finishChatMission,
  getMissionTaskWorkItemId,
  listChatMissionEvents,
  listChatMissions,
  listSchedulableMissionTasks,
  linkMissionTaskDispatch,
  settleMissionTaskForRun,
  updateChatMissionTask,
} from './chat-missions.js';
import { ensureRunnerSchema, findOpenRunForChatRegistration } from './runner.js';

test('scheduler respects dependencies, priority, one-active-task-per-agent, and task effort', () => {
  const { db, coordinator, worker } = setup();
  try {
    const root = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'scheduler-root', channelId: 'channel-1', author: 'owner',
      body: 'Run a dependent plan.', createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: root.id, coordinatorRegistrationId: coordinator.id, title: 'Scheduled plan',
    });
    const first = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id,
      title: 'Prepare implementation', assignee: worker.id,
      prompt: 'Inspect and prepare.', priority: 10, reasoningEffort: 'high',
    });
    const second = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id,
      title: 'Verify implementation', assignee: worker.id,
      prompt: 'Verify the result.', dependsOn: [first.task.id], reasoningEffort: 'low',
    });

    // Mission tasks compile into durable isolated work-item twins.
    assert.ok(first.task.workItemId);
    assert.equal(getMissionTaskWorkItemId(db, first.task.id), first.task.workItemId);
    assert.equal(first.task.workspaceMode, 'isolated');
    assert.match(first.task.branch || '', /^cascade\//);
    assert.ok(second.task.workItemId);
    assert.notEqual(first.task.workItemId, second.task.workItemId);

    const initial = listSchedulableMissionTasks(db, mission.mission.id);
    assert.deepEqual(initial.candidates.map((item) => item.taskId), [first.task.id]);
    assert.equal(initial.candidates[0]?.reasoningEffort, 'high');
    const dispatchMessage = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: `mission-task-${first.task.id}`, channelId: 'channel-1', author: '',
      body: '@terra Inspect and prepare.', createdAt: '2026-08-03T00:00:01.000Z',
      registrationId: coordinator.id, missionTaskId: first.task.id,
    });
    const dispatch = createChatAgentDispatchForRegistration(
      db, 1, 'channel-1', dispatchMessage, worker.id, { reasoningEffort: 'high' },
    );
    assert.equal(dispatch.reasoningEffort, 'high');
    linkMissionTaskDispatch(db, first.task.id, dispatch.id);
    assert.deepEqual(listSchedulableMissionTasks(db, mission.mission.id).candidates, []);

    attachRunToMissionTaskByDispatch(db, dispatch.id, 501);
    settleMissionTaskForRun(db, 501, 'completed', 'Prepared.');
    const unlocked = listSchedulableMissionTasks(db, mission.mission.id);
    assert.deepEqual(unlocked.candidates.map((item) => item.taskId), [second.task.id]);
    assert.deepEqual(
      unlocked.candidates.length ? getChatMessage(db, 'channel-1', 1, root.id)?.mission?.tasks[1]?.waitingFor : [],
      [],
    );
    const settledFirst = getChatMessage(db, 'channel-1', 1, root.id)?.mission?.tasks.find((t) => t.id === first.task.id);
    assert.equal(settledFirst?.workItemStatus, 'done');
  } finally {
    db.close();
  }
});

test('anonymous subagents can fan out in parallel, including self-clones', () => {
  const { db, coordinator, worker } = setup();
  try {
    const root = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'anon-root', channelId: 'channel-1', author: 'owner',
      body: 'Fan out sols.', createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: root.id, coordinatorRegistrationId: coordinator.id, title: 'Parallel sols',
    });

    assert.throws(
      () => addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
        coordinatorRegistrationId: coordinator.id,
        title: 'Self without flag', assignee: coordinator.id,
      }),
      /anonymous for a self-subagent/,
    );

    const high = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id,
      title: 'High effort probe',
      assignee: coordinator.id,
      anonymous: true,
      reasoningEffort: 'high',
      prompt: 'Deep analysis path.',
    });
    const medium = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id,
      title: 'Medium effort probe',
      assignee: coordinator.id,
      anonymous: true,
      reasoningEffort: 'medium',
      prompt: 'Faster analysis path.',
    });
    const named = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id,
      title: 'Named worker still serial',
      assignee: worker.id,
      prompt: 'Named path.',
    });
    const namedSecond = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id,
      title: 'Second named waits',
      assignee: worker.id,
      prompt: 'Also named.',
    });

    assert.equal(high.task.anonymous, true);
    assert.equal(high.task.assigneeMention, 'sol·sub');
    assert.equal(medium.task.reasoningEffort, 'medium');

    const ready = listSchedulableMissionTasks(db, mission.mission.id);
    assert.deepEqual(
      ready.candidates.map((item) => item.taskId).sort(),
      [high.task.id, medium.task.id, named.task.id].sort(),
    );
    assert.ok(!ready.candidates.some((item) => item.taskId === namedSecond.task.id));
    assert.equal(ready.candidates.filter((item) => item.anonymous).length, 2);

    const highMessage = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: `mission-task-${high.task.id}`, channelId: 'channel-1', author: '',
      body: '@sol Deep analysis path.', createdAt: '2026-08-03T00:00:01.000Z',
      registrationId: coordinator.id, missionTaskId: high.task.id,
    });
    const highDispatch = createChatAgentDispatchForRegistration(
      db, 1, 'channel-1', highMessage, coordinator.id, { reasoningEffort: 'high' },
    );
    linkMissionTaskDispatch(db, high.task.id, highDispatch.id);
    attachRunToMissionTaskByDispatch(db, highDispatch.id, 601);
    db.prepare(`
      INSERT INTO runs (vault_id, prompt, agent, conversation_id, status, chat_dispatch_id)
      VALUES ('vault-1', 'high', 'codex', ?, 'running', ?)
    `).run(`mission:${high.task.id}`, highDispatch.id);

    const mediumMessage = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: `mission-task-${medium.task.id}`, channelId: 'channel-1', author: '',
      body: '@sol Faster analysis path.', createdAt: '2026-08-03T00:00:02.000Z',
      registrationId: coordinator.id, missionTaskId: medium.task.id,
    });
    const mediumDispatch = createChatAgentDispatchForRegistration(
      db, 1, 'channel-1', mediumMessage, coordinator.id, { reasoningEffort: 'medium' },
    );
    // Mission-linked runs do not hold the sticky channel lease.
    assert.equal(findOpenRunForChatRegistration(db, coordinator.id, mediumDispatch.id), undefined);
    linkMissionTaskDispatch(db, medium.task.id, mediumDispatch.id);
    attachRunToMissionTaskByDispatch(db, mediumDispatch.id, 602);

    const afterParallel = listSchedulableMissionTasks(db, mission.mission.id);
    assert.deepEqual(afterParallel.candidates.map((item) => item.taskId), [named.task.id]);
  } finally {
    db.close();
  }
});

test('scheduler keeps descendants pending across a retryable failure and wakes review', () => {
  const { db, coordinator, worker } = setup();
  try {
    const root = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'failed-root', channelId: 'channel-1', author: 'owner', body: 'Run work.',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: root.id, coordinatorRegistrationId: coordinator.id, title: 'Failure propagation',
    });
    const parent = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Parent', assignee: worker.id,
    });
    const child = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Child', assignee: worker.id,
      dependsOn: [parent.task.id],
    });
    const grandchild = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Grandchild', assignee: worker.id,
      dependsOn: [child.task.id],
    });
    updateChatMissionTask(db, 1, 'channel-1', parent.task.id, { status: 'failed', summary: 'Nope.' });
    const result = listSchedulableMissionTasks(db, mission.mission.id);
    assert.deepEqual(result.candidates, []);
    const paused = getChatMessage(db, 'channel-1', 1, root.id)?.mission;
    assert.equal(paused?.status, 'attention');
    assert.equal(paused?.tasks.find((task) => task.id === child.task.id)?.status, 'pending');
    assert.equal(paused?.tasks.find((task) => task.id === child.task.id)?.queueReason, 'dependency-attention');
    assert.equal(paused?.tasks.find((task) => task.id === grandchild.task.id)?.status, 'pending');
    assert.equal(paused?.tasks.find((task) => task.id === grandchild.task.id)?.queueReason, 'dependency-attention');
    assert.ok(claimMissionCoordinatorWake(db, mission.mission.id));
    assert.equal(claimMissionCoordinatorWake(db, mission.mission.id), null);

    const retried = updateChatMissionTask(db, 1, 'channel-1', parent.task.id, {
      status: 'pending', summary: 'Retry after transient failure.',
    });
    assert.equal(retried.mission.status, 'active');
    assert.equal(retried.mission.tasks.find((task) => task.id === parent.task.id)?.attempt, 1);
    const retryQueue = listSchedulableMissionTasks(db, mission.mission.id);
    assert.deepEqual(retryQueue.candidates.map((task) => task.taskId), [parent.task.id]);
    assert.equal(retryQueue.candidates[0]?.attempt, 1);
    const events = listChatMissionEvents(db, 1, 'channel-1', mission.mission.id);
    assert.ok(events.some((event) => event.kind === 'task_retried' && event.taskId === parent.task.id));
  } finally {
    db.close();
  }
});

test('schema upgrade repairs legacy dependency blocks and refreshes the transcript projection', () => {
  const { db, coordinator, worker } = setup();
  try {
    const root = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'legacy-block-root', channelId: 'channel-1', author: 'owner', body: 'Continue after failure.',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: root.id, coordinatorRegistrationId: coordinator.id, title: 'Legacy blocked graph',
    });
    const parent = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Failed parent', assignee: worker.id,
    });
    const child = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Legacy child', assignee: worker.id,
      dependsOn: [parent.task.id],
    });
    db.prepare("UPDATE chat_mission_tasks SET status = 'failed' WHERE id = ?").run(parent.task.id);
    db.prepare("UPDATE chat_mission_tasks SET status = 'blocked', summary = 'Dependency “Failed parent” ended failed.' WHERE id = ?")
      .run(child.task.id);
    db.prepare("UPDATE chat_missions SET status = 'blocked' WHERE id = ?").run(mission.mission.id);

    ensureChatMissionSchema(db);
    const repaired = getChatMessage(db, 'channel-1', 1, root.id)?.mission;
    assert.equal(repaired?.status, 'attention');
    assert.equal(repaired?.tasks.find((task) => task.id === child.task.id)?.status, 'pending');
    assert.equal(repaired?.tasks.find((task) => task.id === child.task.id)?.queueReason, 'dependency-attention');
  } finally {
    db.close();
  }
});

test('canceling a running task returns its run for route-level interruption', () => {
  const { db, coordinator, worker } = setup();
  try {
    const root = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'cancel-root', channelId: 'channel-1', author: 'owner', body: 'Run work.',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: root.id, coordinatorRegistrationId: coordinator.id, title: 'Cancelable work',
    });
    const added = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Long worker', assignee: worker.id,
    });
    const message = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: `mission-task-${added.task.id}`, channelId: 'channel-1', author: '', body: '@terra Work.',
      createdAt: '2026-08-03T00:00:01.000Z', registrationId: coordinator.id, missionTaskId: added.task.id,
    });
    const dispatch = createChatAgentDispatchForRegistration(db, 1, 'channel-1', message, worker.id);
    linkMissionTaskDispatch(db, added.task.id, dispatch.id);
    attachRunToMissionTaskByDispatch(db, dispatch.id, 601);
    const canceled = updateChatMissionTask(db, 1, 'channel-1', added.task.id, { status: 'canceled' });
    assert.deepEqual(canceled.canceledTaskRunIds, [601]);
    assert.equal(canceled.mission.tasks[0]?.status, 'canceled');
  } finally {
    db.close();
  }
});

test('accepting clarification yields contract work item + mission root', () => {
  const { db, coordinator } = setup();
  try {
    const card = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'clarify-1',
      channelId: 'channel-1',
      author: 'Sol',
      body: 'Need scope before starting.',
      createdAt: '2026-08-04T00:00:00.000Z',
      registrationId: coordinator.id,
      clarification: {
        title: 'Ship isolation',
        questions: [
          { id: 'q1', prompt: 'What is in scope?', answer: 'Vault path confinement only' },
          { id: 'q2', prompt: 'Token budget?', answer: '50k' },
        ],
        status: 'pending',
        tokenBudget: 50_000,
      },
    });
    assert.equal(card.clarification?.status, 'pending');
    const accepted = acceptChatClarification(db, 1, 'channel-1', card.id, { tokenBudget: 50_000 });
    assert.ok(accepted.workItemId);
    assert.match(accepted.contract, /Vault path confinement/);
    const item = getWorkItem(db, 1, accepted.workItemId);
    assert.equal(item.sourceKind, 'contract');
    assert.equal(item.tokenBudget, 50_000);

    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: card.id,
      coordinatorRegistrationId: coordinator.id,
      title: accepted.title,
      objective: accepted.contract,
    });
    assert.equal(mission.mission.id.length > 0, true);
    assert.equal(mission.rootMessageId, card.id);
    const withMission = attachClarificationMission(db, 1, 'channel-1', card.id, mission.mission.id);
    assert.equal(withMission.clarification?.missionId, mission.mission.id);
    assert.equal(withMission.clarification?.workItemId, accepted.workItemId);
    assert.equal(withMission.clarification?.status, 'accepted');
  } finally {
    db.close();
  }
});

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE vaults (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, created_by INTEGER);
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      folder_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      content_preview TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_listed INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, vault_id TEXT, name TEXT);
    CREATE TABLE note_tags (note_id TEXT, tag_id TEXT);
    INSERT INTO users (id, username) VALUES (1, 'owner'), (2, 'guest');
    INSERT INTO vaults (id, name, root_path, created_by) VALUES ('vault-1', 'Test', '/tmp', 1);
    INSERT INTO vaults (id, name, root_path, created_by) VALUES ('vault-2', 'Guest', '/tmp', 2);
    INSERT INTO notes (id, vault_id, title, content, content_preview)
      VALUES ('channel-1', 'vault-1', 'dev', '${CHAT_NOTE_MARKER}', '${CHAT_NOTE_MARKER}');
    INSERT INTO notes (id, vault_id, title, content, content_preview)
      VALUES ('channel-2', 'vault-2', 'dev', '${CHAT_NOTE_MARKER}', '${CHAT_NOTE_MARKER}');
  `);
  ensureChatSchema(db);
  linkChatChannel(db, {
    localVaultId: 'vault-2', localChannelId: 'channel-2',
    sourceVaultId: 'vault-1', sourceChannelId: 'channel-1', createdBy: 1,
  });
  ensureChatDispatchSchema(db);
  ensureRunnerSchema(db);
  ensureChatMissionSchema(db);
  ensureWorkItemSchema(db);
  const coordinator = upsertChatAgentMember(db, 1, 'vault-1', 'channel-1', {
    id: 'reg-sol',
    agentId: 'codex',
    displayName: 'Sol',
    mention: 'sol',
    model: 'gpt-5.6-sol',
    orchestrator: true,
  });
  const worker = upsertChatAgentMember(db, 1, 'vault-1', 'channel-1', {
    id: 'reg-terra',
    agentId: 'codex',
    displayName: 'Terra',
    mention: 'terra',
    model: 'gpt-5.6-terra',
    taggableByAgents: false,
  });
  return { db, coordinator, worker };
}

test('one registration cannot lease two open provider runs across dispatches', () => {
  const { db, coordinator } = setup();
  try {
    const firstMessage = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'lease-first', channelId: 'channel-1', author: 'owner', body: 'Start',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const secondMessage = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'lease-steer', channelId: 'channel-1', author: 'owner', body: 'Steer',
      createdAt: '2026-08-03T00:00:01.000Z',
    });
    const first = createChatAgentDispatchForRegistration(db, 1, 'channel-1', firstMessage, coordinator.id);
    const second = createChatAgentDispatchForRegistration(db, 1, 'channel-1', secondMessage, coordinator.id);
    db.prepare(`
      INSERT INTO runs (vault_id, prompt, agent, conversation_id, status, chat_dispatch_id)
      VALUES ('vault-1', 'first', 'codex', 'coordinator-session', 'running', ?)
    `).run(first.id);

    assert.equal(findOpenRunForChatRegistration(db, coordinator.id, second.id)?.chat_dispatch_id, first.id);
    db.prepare("UPDATE runs SET status = 'canceled' WHERE chat_dispatch_id = ?").run(first.id);
    assert.equal(findOpenRunForChatRegistration(db, coordinator.id, second.id), undefined);
  } finally {
    db.close();
  }
});

test('schema repair marks historical worker replies as internal mission evidence', () => {
  const { db, coordinator, worker } = setup();
  try {
    const root = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'repair-root', channelId: 'channel-1', author: 'owner', body: 'Run it',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: root.id, coordinatorRegistrationId: coordinator.id, title: 'Repair projection',
    });
    const task = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Audit', assignee: worker.id,
    });
    const run = db.prepare(`
      INSERT INTO runs (vault_id, prompt, agent, conversation_id, status)
      VALUES ('vault-1', 'audit', 'codex', 'mission-task', 'completed')
    `).run();
    db.prepare('UPDATE chat_mission_tasks SET run_id = ? WHERE id = ?')
      .run(Number(run.lastInsertRowid), task.task.id);
    createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'historical-worker-report', channelId: 'channel-1', author: 'Terra',
      body: 'A long internal audit.', createdAt: '2026-08-03T00:00:01.000Z',
      agentId: 'codex', registrationId: worker.id, runId: Number(run.lastInsertRowid),
    });

    assert.equal(getChatMessage(db, 'channel-1', 1, 'historical-worker-report')?.missionTaskId, undefined);
    ensureChatMissionSchema(db);
    assert.equal(getChatMessage(db, 'channel-1', 1, 'historical-worker-report')?.missionTaskId, task.task.id);
  } finally {
    db.close();
  }
});

test('a coordinator mission persists, dispatches a focused task, and settles from the worker run', () => {
  const { db, coordinator, worker } = setup();
  try {
    const root = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'root-message', channelId: 'channel-1', author: 'owner',
      body: 'Build and verify the multiplayer flow.', createdAt: '2026-08-03T00:00:00.000Z',
    });
    const created = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: root.id,
      coordinatorRegistrationId: coordinator.id,
      title: 'Multiplayer flow',
      objective: root.body,
    });
    assert.equal(created.mission.status, 'active');
    assert.deepEqual(created.mission.tasks, []);

    const added = addChatMissionTask(db, 1, 'channel-1', created.mission.id, {
      coordinatorRegistrationId: coordinator.id,
      title: 'Verify the second client',
      assignee: '@terra',
    });
    assert.equal(added.assignee.id, worker.id);
    const delegation = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: `mission-task-${added.task.id}`,
      channelId: 'channel-1',
      author: '',
      body: '@terra Exercise reload and reconnect.',
      createdAt: '2026-08-03T00:00:01.000Z',
      registrationId: coordinator.id,
      missionTaskId: added.task.id,
    });
    const dispatch = createChatAgentDispatchForRegistration(
      db, 1, 'channel-1', delegation, worker.id,
    );
    linkMissionTaskDispatch(db, added.task.id, dispatch.id);
    const running = attachRunToMissionTaskByDispatch(db, dispatch.id, 42);
    assert.equal(running?.mission.tasks[0]?.status, 'running');
    assert.equal(running?.mission.tasks[0]?.runId, 42);

    const settled = settleMissionTaskForRun(db, 42, 'completed', 'Reload and reconnect both passed.');
    assert.equal(settled?.update.mission.status, 'reviewing');
    assert.equal(settled?.update.mission.tasks[0]?.status, 'completed');
    assert.equal(settled?.update.mission.tasks[0]?.summary, 'Reload and reconnect both passed.');
    assert.equal(settled?.wake?.coordinatorRegistrationId, coordinator.id);
    // Follow-up work may be added while the coordinator is reviewing the
    // completed wave; it must schedule rather than becoming a stranded row.
    const followUp = addChatMissionTask(db, 1, 'channel-1', created.mission.id, {
      coordinatorRegistrationId: coordinator.id,
      title: 'Review the reconnect evidence', assignee: '@terra',
    });
    assert.deepEqual(
      listSchedulableMissionTasks(db, created.mission.id).candidates.map((candidate) => candidate.taskId),
      [followUp.task.id],
    );
    // Terminal events can be replayed; the coordinator wake is claimed once.
    assert.equal(settleMissionTaskForRun(db, 42, 'completed', 'same')?.wake, null);
    assert.equal(
      getChatMessage(db, 'channel-1', 1, root.id)?.mission?.tasks[0]?.summary,
      'Reload and reconnect both passed.',
    );

    const projected = getChatMessage(db, 'channel-1', 1, root.id);
    assert.equal(projected?.mission?.id, created.mission.id);
    assert.equal(projected?.mission?.tasks[0]?.status, 'completed');
  } finally {
    db.close();
  }
});

test('explicit mission dispatch bypasses worker opt-in while agent chatter does not', () => {
  const { db, coordinator, worker } = setup();
  try {
    const coordinatorMessage = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'coord-msg', channelId: 'channel-1', author: '', body: '@terra investigate',
      createdAt: '2026-08-03T00:00:00.000Z', registrationId: coordinator.id,
    });
    assert.deepEqual(resolveChatAgentTargets(db, 1, 'channel-1', coordinatorMessage), []);
    const explicit = createChatAgentDispatchForRegistration(db, 1, 'channel-1', coordinatorMessage, worker.id);
    assert.equal(explicit.registration.id, worker.id);

    const ordinary = upsertChatAgentMember(db, 1, 'vault-1', 'channel-1', {
      id: 'reg-ordinary', agentId: 'codex', displayName: 'Ordinary', mention: 'ordinary',
    });
    const ordinaryMessage = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'ordinary-msg', channelId: 'channel-1', author: '', body: '@terra investigate',
      createdAt: '2026-08-03T00:00:01.000Z', registrationId: ordinary.id,
    });
    assert.deepEqual(resolveChatAgentTargets(db, 1, 'channel-1', ordinaryMessage), []);
  } finally {
    db.close();
  }
});

test('an explicit specialist call takes the zero-hop route instead of also running the coordinator', () => {
  const { db, coordinator, worker } = setup();
  try {
    const plain = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'plain', channelId: 'channel-1', author: 'owner', body: 'Can you handle this?',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    assert.deepEqual(resolveChatAgentTargets(db, 1, 'channel-1', plain).map((item) => item.id), [coordinator.id]);

    const direct = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'direct', channelId: 'channel-1', author: 'owner', body: '@terra handle this directly',
      createdAt: '2026-08-03T00:00:01.000Z',
    });
    assert.deepEqual(resolveChatAgentTargets(db, 1, 'channel-1', direct).map((item) => item.id), [worker.id]);

    const both = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'both', channelId: 'channel-1', author: 'owner', body: '@sol and @terra compare approaches',
      createdAt: '2026-08-03T00:00:02.000Z',
    });
    assert.deepEqual(resolveChatAgentTargets(db, 1, 'channel-1', both).map((item) => item.id), [coordinator.id, worker.id]);
  } finally {
    db.close();
  }
});

test('shared-channel users can add their own coordinator without controlling another user\'s agents', () => {
  const { db, coordinator } = setup();
  try {
    const closed = createChatMessage(db, 2, 'vault-2', 'channel-2', {
      id: 'guest-closed', channelId: 'channel-2', author: 'guest', body: 'Please coordinate this.',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    assert.deepEqual(resolveChatAgentTargets(db, 2, 'channel-2', closed), []);

    db.prepare('UPDATE chat_agent_members SET pingable_by_others = 1 WHERE id = ?').run(coordinator.id);
    const open = createChatMessage(db, 2, 'vault-2', 'channel-2', {
      id: 'guest-open', channelId: 'channel-2', author: 'guest', body: '@sol Please coordinate this.',
      createdAt: '2026-08-03T00:00:01.000Z',
    });
    assert.deepEqual(resolveChatAgentTargets(db, 2, 'channel-2', open).map((item) => item.id), [coordinator.id]);
    assert.throws(() => upsertChatAgentMember(db, 2, 'vault-2', 'channel-2', {
      ...coordinator,
      orchestrator: false,
      replyToEveryMessage: false,
    }), /Vault agent not found/);

    const guestAgent = upsertVaultAgent(db, 2, 'vault-2', {
      agentId: 'codex', displayName: 'Guest Sol', mention: 'guest-sol', model: 'gpt-5.6-sol',
    });
    const guestCoordinator = upsertChatAgentMember(db, 2, 'vault-2', 'channel-2', {
      vaultAgentId: guestAgent.id,
      agentId: 'codex',
      displayName: 'Guest Sol',
      mention: 'guest-sol',
      model: 'gpt-5.6-sol',
      orchestrator: true,
    });
    assert.equal(guestCoordinator.ownerUserId, 2);
    const guestRun = resolveChatAgentRun(db, 2, 'channel-2', guestCoordinator.id);
    assert.equal(guestRun.ownerId, 2);
    assert.equal(guestRun.agentVault.id, 'vault-2');
    assert.equal(guestRun.ownerChannelId, 'channel-2');
    const ownerCallingGuest = resolveChatAgentRun(db, 1, 'channel-1', guestCoordinator.id);
    assert.equal(ownerCallingGuest.ownerId, 2);
    assert.equal(ownerCallingGuest.agentVault.id, 'vault-2');
    assert.equal(ownerCallingGuest.ownerChannelId, 'channel-2');
    db.prepare("INSERT INTO vaults (id, name, created_by) VALUES ('vault-3', 'Guest agent home', 2)").run();
    const elsewhereAgent = upsertVaultAgent(db, 2, 'vault-3', {
      agentId: 'codex', displayName: 'Elsewhere', mention: 'elsewhere', model: 'gpt-5.6-sol',
    });
    const elsewhereMember = upsertChatAgentMember(db, 2, 'vault-2', 'channel-2', {
      vaultAgentId: elsewhereAgent.id,
      agentId: 'codex', displayName: 'Elsewhere', mention: 'elsewhere', model: 'gpt-5.6-sol',
    });
    const elsewhereRun = resolveChatAgentRun(db, 2, 'channel-2', elsewhereMember.id);
    assert.equal(elsewhereRun.agentVault.id, 'vault-2');
    assert.equal(elsewhereRun.ownerChannelId, 'channel-2');
    assert.throws(
      () => setChatAgentAvatar(db, 1, 'vault-1', 'channel-1', guestCoordinator.id, 'https://example.com/nope.png'),
      /Only the agent owner/,
    );
    assert.equal(
      setChatAgentAvatar(db, 2, 'vault-2', 'channel-2', guestCoordinator.id, 'https://example.com/guest.png').avatarUrl,
      'https://example.com/guest.png',
    );

    const guestTurn = createChatMessage(db, 2, 'vault-2', 'channel-2', {
      id: 'guest-own-coordinator', channelId: 'channel-2', author: 'guest', body: 'Please coordinate this.',
      createdAt: '2026-08-03T00:00:02.000Z',
    });
    assert.deepEqual(resolveChatAgentTargets(db, 2, 'channel-2', guestTurn).map((item) => item.id), [guestCoordinator.id]);
    createChatAgentDispatches(db, 2, 'channel-2', guestTurn);
    assert.deepEqual(
      listPendingChatAgentDispatches(db, 2, 'channel-2').map((item) => item.registration.id),
      [guestCoordinator.id],
    );

    const ownerCrossPing = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'owner-cross-ping', channelId: 'channel-1', author: 'owner', body: '@guest-sol answer this.',
      createdAt: '2026-08-03T00:00:03.000Z',
    });
    assert.deepEqual(
      resolveChatAgentTargets(db, 1, 'channel-1', ownerCrossPing).map((item) => item.id),
      [coordinator.id],
    );
    db.prepare('UPDATE chat_agent_members SET pingable_by_others = 1 WHERE id = ?').run(guestCoordinator.id);
    assert.deepEqual(
      resolveChatAgentTargets(db, 1, 'channel-1', ownerCrossPing).map((item) => item.id).sort(),
      [coordinator.id, guestCoordinator.id].sort(),
    );
  } finally {
    db.close();
  }
});

test('a reply to a human does not become an accidental agent dispatch', () => {
  const { db } = setup();
  try {
    createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'human', channelId: 'channel-1', author: 'terra', body: 'human message',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const reply = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'reply', channelId: 'channel-1', author: 'owner', body: 'sounds good',
      createdAt: '2026-08-03T00:00:01.000Z',
      replyTo: { messageId: 'human', author: 'terra', mention: 'terra', preview: 'human message' },
    });
    // The owner still reaches the coordinator; Terra must not be selected
    // merely because the human happens to share its handle.
    assert.deepEqual(
      createChatAgentDispatches(db, 1, 'channel-1', reply).map((dispatch) => dispatch.registration.mention),
      ['sol'],
    );
  } finally {
    db.close();
  }
});

test('a human coordinator turn supersedes an unclaimed mission review wake', () => {
  const { db, coordinator } = setup();
  try {
    const wake = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'sys-mission-00000000-0000-0000-0000-000000000001-review',
      channelId: 'channel-1', author: 'Cascade', body: '@sol review the mission',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const wakeDispatch = createChatAgentDispatchForRegistration(
      db, 1, 'channel-1', wake, coordinator.id,
    );
    assert.equal(listPendingChatAgentDispatches(db, 1, 'channel-1').length, 1);

    const human = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'human-steer', channelId: 'channel-1', author: 'owner', body: 'Did we fix this?',
      createdAt: '2026-08-03T00:00:01.000Z',
    });
    const [humanDispatch] = createChatAgentDispatches(db, 1, 'channel-1', human);

    assert.equal(humanDispatch.messageId, human.id);
    assert.deepEqual(
      listPendingChatAgentDispatches(db, 1, 'channel-1').map((dispatch) => dispatch.id),
      [humanDispatch.id],
    );
    const removed = db.prepare('SELECT COUNT(*) AS count FROM chat_agent_dispatches WHERE id = ?')
      .get(wakeDispatch.id) as { count: number };
    assert.equal(removed.count, 0);
    assert.ok(getChatMessage(db, 'channel-1', 1, wake.id));
  } finally {
    db.close();
  }
});

test('an explicit blocked report survives a nominally successful worker exit', () => {
  const { db, coordinator, worker } = setup();
  try {
    createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'root', channelId: 'channel-1', author: 'owner', body: 'Ship it', createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: 'root', coordinatorRegistrationId: coordinator.id, title: 'Ship it',
    });
    const added = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Deploy', assignee: worker.id,
    });
    const msg = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'delegate', channelId: 'channel-1', author: '', body: '@terra deploy',
      createdAt: '2026-08-03T00:00:01.000Z', registrationId: coordinator.id,
      missionTaskId: added.task.id,
    });
    const dispatch = createChatAgentDispatchForRegistration(db, 1, 'channel-1', msg, worker.id);
    linkMissionTaskDispatch(db, added.task.id, dispatch.id);
    attachRunToMissionTaskByDispatch(db, dispatch.id, 99);
    updateChatMissionTask(db, 1, 'channel-1', added.task.id, {
      status: 'blocked', summary: 'Needs production credentials.',
    });
    const settled = settleMissionTaskForRun(db, 99, 'completed', 'Done.');
    assert.equal(settled?.update.mission.status, 'attention');
    assert.equal(settled?.update.mission.tasks[0]?.summary, 'Needs production credentials.');
  } finally {
    db.close();
  }
});

test('mission and delegation retries are idempotent', () => {
  const { db, coordinator, worker } = setup();
  try {
    createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'root-retry', channelId: 'channel-1', author: 'owner', body: 'Do durable work',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const firstMission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: 'root-retry', coordinatorRegistrationId: coordinator.id, title: 'Durable work',
    });
    const firstTask = addChatMissionTask(db, 1, 'channel-1', firstMission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'One assignment', assignee: worker.id,
    });
    const retriedMission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: 'root-retry', coordinatorRegistrationId: coordinator.id, title: 'Changed by retry',
    });
    const retriedTask = addChatMissionTask(db, 1, 'channel-1', firstMission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'One assignment', assignee: worker.id,
    });
    assert.equal(retriedMission.mission.id, firstMission.mission.id);
    assert.equal(retriedMission.mission.title, 'Durable work');
    assert.equal(retriedTask.task.id, firstTask.task.id);
    assert.equal(retriedTask.update.mission.tasks.length, 1);
  } finally {
    db.close();
  }
});

test('mission archive and append-only timeline survive completion', () => {
  const { db, coordinator, worker } = setup();
  try {
    createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'history-root', channelId: 'channel-1', author: 'owner', body: 'Keep the evidence.',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: 'history-root', coordinatorRegistrationId: coordinator.id, title: 'Durable history',
    });
    const task = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Record outcome', assignee: worker.id,
      prompt: 'Produce lasting evidence.',
    });
    updateChatMissionTask(db, 1, 'channel-1', task.task.id, {
      status: 'completed', summary: 'Evidence recorded.',
    });
    finishChatMission(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, status: 'completed', summary: 'Integrated.',
    });

    const archive = listChatMissions(db, 1, 'channel-1');
    assert.equal(archive[0]?.id, mission.mission.id);
    assert.equal(archive[0]?.rootMessageId, 'history-root');
    assert.equal(archive[0]?.status, 'completed');
    const events = listChatMissionEvents(db, 1, 'channel-1', mission.mission.id);
    assert.deepEqual(events.map((event) => event.kind), [
      'mission_created',
      'task_added',
      'task_status_changed',
      'mission_status_changed',
      'mission_completed',
    ]);
    assert.ok(events.every((event, index) => index === 0 || event.id > events[index - 1]!.id));
    assert.equal(events.find((event) => event.kind === 'task_status_changed')?.summary, 'Evidence recorded.');
    ensureChatMissionSchema(db);
    assert.equal(listChatMissionEvents(db, 1, 'channel-1', mission.mission.id).length, events.length);
  } finally {
    db.close();
  }
});

test('the coordinator wakes only after every worker has settled', () => {
  const { db, coordinator, worker } = setup();
  try {
    createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'root-many', channelId: 'channel-1', author: 'owner', body: 'Compare two checks',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: 'root-many', coordinatorRegistrationId: coordinator.id, title: 'Two checks',
    });
    const tasks = ['First check', 'Second check'].map((title, index) => {
      const added = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
        coordinatorRegistrationId: coordinator.id, title, assignee: worker.id,
      });
      const message = createChatMessage(db, 1, 'vault-1', 'channel-1', {
        id: `many-${index}`, channelId: 'channel-1', author: '', body: `@terra ${title}`,
        createdAt: `2026-08-03T00:00:0${index + 1}.000Z`, registrationId: coordinator.id,
        missionTaskId: added.task.id,
      });
      const dispatch = createChatAgentDispatchForRegistration(db, 1, 'channel-1', message, worker.id);
      linkMissionTaskDispatch(db, added.task.id, dispatch.id);
      attachRunToMissionTaskByDispatch(db, dispatch.id, 200 + index);
      return added.task;
    });
    assert.equal(tasks.length, 2);
    const first = settleMissionTaskForRun(db, 200, 'completed', 'First passed.');
    assert.equal(first?.update.mission.status, 'active');
    assert.equal(first?.wake, null);
    const second = settleMissionTaskForRun(db, 201, 'failed', 'Second failed.');
    assert.equal(second?.update.mission.status, 'attention');
    assert.equal(second?.wake?.coordinatorRegistrationId, coordinator.id);
  } finally {
    db.close();
  }
});

test('finishing review removes a queued synthetic coordinator wake', () => {
  const { db, coordinator, worker } = setup();
  try {
    createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'root-reviewed', channelId: 'channel-1', author: 'owner', body: 'Ship this',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: 'root-reviewed', coordinatorRegistrationId: coordinator.id, title: 'Reviewed',
    });
    const added = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Investigate', assignee: worker.id,
    });
    const workerMessage = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'worker-reviewed', channelId: 'channel-1', author: '', body: '@terra investigate',
      createdAt: '2026-08-03T00:00:01.000Z', registrationId: coordinator.id,
      missionTaskId: added.task.id,
    });
    const workerDispatch = createChatAgentDispatchForRegistration(db, 1, 'channel-1', workerMessage, worker.id);
    linkMissionTaskDispatch(db, added.task.id, workerDispatch.id);
    attachRunToChatAgentDispatch(db, workerDispatch.id, 301);
    attachRunToMissionTaskByDispatch(db, workerDispatch.id, 301);
    assert.ok(settleMissionTaskForRun(db, 301, 'completed', 'Evidence ready.')?.wake);

    const wakeId = `sys-mission-${mission.mission.id}-queued`;
    const wakeMessage = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: wakeId, channelId: 'channel-1', author: 'Cascade', body: '@sol review',
      createdAt: '2026-08-03T00:00:02.000Z',
    });
    createChatAgentDispatchForRegistration(db, 1, 'channel-1', wakeMessage, coordinator.id);
    const activeWakeId = `sys-mission-${mission.mission.id}-active`;
    const activeWake = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: activeWakeId, channelId: 'channel-1', author: 'Cascade', body: '@sol review duplicate',
      createdAt: '2026-08-03T00:00:03.000Z',
    });
    const activeDispatch = createChatAgentDispatchForRegistration(db, 1, 'channel-1', activeWake, coordinator.id);
    attachRunToChatAgentDispatch(db, activeDispatch.id, 401);
    const currentWakeId = `sys-mission-${mission.mission.id}-current`;
    const currentWake = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: currentWakeId, channelId: 'channel-1', author: 'Cascade', body: '@sol legitimate review',
      createdAt: '2026-08-03T00:00:04.000Z',
    });
    const currentDispatch = createChatAgentDispatchForRegistration(db, 1, 'channel-1', currentWake, coordinator.id);
    attachRunToChatAgentDispatch(db, currentDispatch.id, 999);

    const finished = finishChatMission(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, status: 'completed', summary: 'Already reviewed.', currentRunId: 999,
    });
    assert.deepEqual(finished.removedWakeMessageIds, [wakeId, activeWakeId]);
    assert.deepEqual(finished.canceledWakeRunIds, [401]);
    assert.equal(getChatMessage(db, 'channel-1', 1, wakeId), undefined);
    assert.equal(getChatMessage(db, 'channel-1', 1, activeWakeId), undefined);
    assert.equal(getChatMessage(db, 'channel-1', 1, currentWakeId)?.id, currentWakeId);
    assert.deepEqual(listPendingChatAgentDispatches(db, 1, 'channel-1'), []);
  } finally {
    db.close();
  }
});

test('a mission cannot complete over active work and cancel removes pending dispatches', () => {
  const { db, coordinator, worker } = setup();
  try {
    createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'root-cancel', channelId: 'channel-1', author: 'owner', body: 'Maybe do this',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const mission = createChatMission(db, 1, 'vault-1', 'channel-1', {
      rootMessageId: 'root-cancel', coordinatorRegistrationId: coordinator.id, title: 'Cancelable',
    });
    const added = addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Pending task', assignee: worker.id,
    });
    const message = createChatMessage(db, 1, 'vault-1', 'channel-1', {
      id: 'pending-delegation', channelId: 'channel-1', author: '', body: '@terra wait',
      createdAt: '2026-08-03T00:00:01.000Z', registrationId: coordinator.id,
      missionTaskId: added.task.id,
    });
    const dispatch = createChatAgentDispatchForRegistration(db, 1, 'channel-1', message, worker.id);
    linkMissionTaskDispatch(db, added.task.id, dispatch.id);
    assert.equal(listPendingChatAgentDispatches(db, 1, 'channel-1').length, 1);
    assert.throws(() => finishChatMission(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, status: 'completed', summary: 'Too soon',
    }), /active workers/);
    const canceled = finishChatMission(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, status: 'canceled', summary: 'No longer needed',
    });
    assert.equal(canceled.mission.status, 'canceled');
    assert.equal(canceled.mission.tasks[0]?.status, 'canceled');
    assert.deepEqual(listPendingChatAgentDispatches(db, 1, 'channel-1'), []);
    assert.throws(() => addChatMissionTask(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, title: 'Too late', assignee: worker.id,
    }), /already closed/);
    assert.throws(() => updateChatMissionTask(db, 1, 'channel-1', added.task.id, {
      status: 'completed', summary: 'Too late',
    }), /already closed/);
    assert.throws(() => finishChatMission(db, 1, 'channel-1', mission.mission.id, {
      coordinatorRegistrationId: coordinator.id, status: 'completed', summary: 'Reopen',
    }), /already closed/);
  } finally {
    db.close();
  }
});
