import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { createChatMessage, ensureChatSchema, acceptChatClarification, answerChatClarification } from './chat.js';
import { ensureVaultMembersSchema } from './vaultMembers.js';
import { ensureWorkItemSchema } from './workItems.js';
import { ensureChatMissionSchema } from './chat-missions.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE vaults (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, created_by INTEGER);
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, vault_id TEXT, folder_id TEXT, title TEXT, content TEXT DEFAULT '',
      content_preview TEXT DEFAULT '', is_pinned INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0,
      is_listed INTEGER DEFAULT 1, position INTEGER DEFAULT 0, word_count INTEGER DEFAULT 0,
      created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, vault_id TEXT, name TEXT);
    CREATE TABLE note_tags (note_id TEXT, tag_id TEXT);
    CREATE TABLE folders (id TEXT PRIMARY KEY, vault_id TEXT, parent_id TEXT, name TEXT, position INTEGER DEFAULT 0);
    INSERT INTO users (id, username) VALUES (1, 'alice');
    INSERT INTO vaults (id, name, root_path, created_by) VALUES ('v1', 'V', '/tmp/cascade-clarif-test', 1);
    INSERT INTO notes (id, vault_id, title, content) VALUES ('ch1', 'v1', 'chan', 'cascade://chat-channel');
  `);
  try { fs.mkdirSync('/tmp/cascade-clarif-test', { recursive: true }); } catch { /* */ }
  ensureVaultMembersSchema(db);
  ensureChatSchema(db);
  ensureWorkItemSchema(db);
  ensureChatMissionSchema(db);
  try {
    db.prepare(`INSERT INTO vault_members (vault_id, user_id, role, invited_by) VALUES ('v1', 1, 'owner', 1)`).run();
  } catch { /* schema */ }
  return db;
}

test('clarification normalizes single/multi kinds and options', () => {
  const db = setup();
  const msg = createChatMessage(db, 1, 'v1', 'ch1', {
    id: 'msg-clarif-1',
    channelId: 'ch1',
    author: 'Supagrok',
    body: 'Need scope before starting.',
    createdAt: new Date().toISOString(),
    clarification: {
      title: 'Ship scope',
      status: 'pending',
      tokenBudget: 5000,
      questions: [
        { id: 'scope', prompt: 'How deep?', kind: 'single', options: ['MVP', 'Full'] },
        { id: 'areas', prompt: 'Areas?', kind: 'multi', options: ['API', 'UI'] },
        { id: 'notes', prompt: 'Notes?', kind: 'text' },
      ],
    },
  });
  assert.equal(msg.clarification?.questions[0].kind, 'single');
  assert.deepEqual(msg.clarification?.questions[0].options, ['MVP', 'Full']);
  assert.equal(msg.clarification?.questions[1].kind, 'multi');
  assert.equal(msg.clarification?.questions[2].kind, 'text');
  // Discrete choices auto-prefill when agent omits answer.
  assert.equal(msg.clarification?.questions[0].answer, 'MVP');
  assert.equal(msg.clarification?.questions[1].answer, 'API');
  answerChatClarification(db, 1, 'ch1', msg.id, [
    { id: 'scope', answer: 'MVP' },
    { id: 'areas', answer: 'API | UI' },
    { id: 'notes', answer: 'ship quiet' },
  ]);
  const accepted = acceptChatClarification(db, 1, 'ch1', msg.id);
  assert.ok(accepted.workItemId);
  assert.match(accepted.contract, /MVP/);
  assert.match(accepted.contract, /API \| UI/);
  db.close();
});

test('clarification caps at 3 questions and keeps explicit prefills', () => {
  const db = setup();
  const msg = createChatMessage(db, 1, 'v1', 'ch1', {
    id: 'msg-clarif-2',
    channelId: 'ch1',
    author: 'Supagrok',
    body: 'Small card.',
    createdAt: new Date().toISOString(),
    clarification: {
      title: 'Tiny',
      status: 'pending',
      questions: [
        { id: 'q1', prompt: 'A?', kind: 'single', options: ['x', 'y'], answer: 'y' },
        { id: 'q2', prompt: 'B?', kind: 'single', options: ['1', '2'], answer: '2' },
        { id: 'q3', prompt: 'C?', kind: 'text', answer: 'ok' },
        { id: 'q4', prompt: 'Dropped?', kind: 'text', answer: 'nope' },
      ],
    },
  });
  assert.equal(msg.clarification?.questions.length, 3);
  assert.equal(msg.clarification?.questions[0].answer, 'y');
  assert.equal(msg.clarification?.questions.some((q) => q.id === 'q4'), false);
  db.close();
});
