'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { claudeTurnIsActive, codexFallback, collectLocalAgents, codexTurnIsActive } = require('./local-agents.cjs');

test('discovers a live Codex thread without reviving a completed open-edge child', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-local-agents-'));
  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const rollout = path.join(codexDir, 'rollout.jsonl');
  fs.writeFileSync(rollout, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'npm test' } },
  ].map(JSON.stringify).join('\n'));
  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT,
      first_user_message TEXT, agent_nickname TEXT, agent_role TEXT,
      updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT, child_thread_id TEXT, status TEXT
    );
  `);
  const now = Date.now();
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('thread-1', rollout, '/tmp/project', '', '', null, null, Math.floor(now / 1000), now, 0);
  const childRollout = path.join(codexDir, 'child-rollout.jsonl');
  fs.writeFileSync(childRollout, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn' } },
  ].map(JSON.stringify).join('\n'));
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('thread-2', childRollout, '/tmp/project', '', '', 'Finished child', null, Math.floor(now / 1000), now, 0);
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)')
    .run('thread-1', 'thread-2', 'open');
  db.close();

  const graph = collectLocalAgents('Caption this', now, {
    homeDir,
    captioner: { getCaption: (_id, template, excerpt) => `${template}: ${excerpt}` },
  });
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.nodes[0].label, 'project');
  assert.match(graph.nodes[0].status, /Caption this: exec npm test/);
});

test('removes a Codex thread as soon as task_complete is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-liveness-'));
  const rollout = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(rollout, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ].map(JSON.stringify).join('\n'));
  assert.equal(codexTurnIsActive(rollout), false);
});

test('uses Claude stop reasons instead of transcript recency', () => {
  const working = [
    { type: 'user', isMeta: false, message: { role: 'user', content: 'Fix it' } },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use' } },
  ];
  const stopped = [...working, {
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn' },
  }];
  assert.equal(claudeTurnIsActive(working), true);
  assert.equal(claudeTurnIsActive(stopped), false);
});

test('provides deterministic Codex captions without Qwen', () => {
  assert.equal(codexFallback('exec npm test'), 'Running a command');
  assert.equal(codexFallback('apply_patch update local-agents.cjs'), 'Editing code');
  assert.equal(codexFallback(''), 'Working');
});
