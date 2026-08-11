'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { collectLocalAgents } = require('./local-agents.cjs');

test('discovers a recent Codex thread and captions its tool trace', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-local-agents-'));
  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const rollout = path.join(codexDir, 'rollout.jsonl');
  fs.writeFileSync(rollout, `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', input: 'npm test' },
  })}\n`);
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
  db.close();

  const graph = collectLocalAgents('Caption this', now, {
    homeDir,
    captioner: { getCaption: (_id, template, excerpt) => `${template}: ${excerpt}` },
  });
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].label, 'project');
  assert.match(graph.nodes[0].status, /Caption this: exec npm test/);
});
