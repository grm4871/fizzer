import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  DEFAULT_CHAT_SESSION_MAX_AGE_HOURS,
  DEFAULT_CHAT_SESSION_MAX_RUNS,
  cancelRun,
  ensureRunnerSchema,
  findConversationSession,
  finishDelegatedRun,
  getRun,
  listRunEvents,
} from './runner.js';

function insertRun(
  db: Database.Database,
  id: number,
  sessionId: string,
  startedAt = '2026-08-07 12:00:00',
) {
  db.prepare(`
    INSERT INTO runs (
      id, vault_id, note_id, prompt, agent, conversation_id, status,
      session_id, started_at
    ) VALUES (?, 'vault', NULL, 'prompt', 'codex', 'conversation',
      'completed', ?, ?)
  `).run(id, sessionId, startedAt);
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vaults (id TEXT PRIMARY KEY);
    CREATE TABLE notes (id TEXT PRIMARY KEY);
    INSERT INTO vaults (id) VALUES ('vault');
  `);
  ensureRunnerSchema(db);
  return db;
}

test('chat sessions remain continuous by default', () => {
  assert.equal(DEFAULT_CHAT_SESSION_MAX_RUNS, 0);
  assert.equal(DEFAULT_CHAT_SESSION_MAX_AGE_HOURS, 0);

  const db = createDb();
  try {
    for (let id = 1; id <= 12; id += 1) {
      insertRun(db, id, 'session-long', '2026-08-01 12:00:00');
    }
    assert.equal(findConversationSession(db, {
      vaultId: 'vault',
      noteId: null,
      agent: 'codex',
      conversationId: 'conversation',
      boundedChat: true,
      nowMs: Date.parse('2026-08-07T12:30:00Z'),
    }), 'session-long');
  } finally {
    db.close();
  }
});

test('chat sessions resume below the bound and event reads can advance by sequence', () => {
  const db = createDb();
  try {
    insertRun(db, 1, 'session-short');
    assert.equal(findConversationSession(db, {
      vaultId: 'vault',
      noteId: null,
      agent: 'codex',
      conversationId: 'conversation',
      boundedChat: true,
      nowMs: Date.parse('2026-08-07T12:30:00Z'),
    }), 'session-short');

    const insertEvent = db.prepare(`
      INSERT INTO run_events (run_id, seq, type, payload_json)
      VALUES (1, ?, 'harness', '{}')
    `);
    insertEvent.run(1);
    insertEvent.run(2);
    insertEvent.run(3);
    assert.deepEqual(listRunEvents(db, 1, 1).map((event) => event.seq), [2, 3]);
  } finally {
    db.close();
  }
});

test('a missing Claude session invalidates the stale machine-local id', () => {
  const db = createDb();
  try {
    insertRun(db, 1, 'foreign-session');
    db.prepare("UPDATE runs SET status = 'running' WHERE id = 1").run();
    finishDelegatedRun(db, 1, {
      status: 'failed',
      summary: 'No conversation found with session ID: foreign-session',
    });
    assert.equal(findConversationSession(db, {
      vaultId: 'vault', noteId: null, agent: 'codex',
      conversationId: 'conversation', boundedChat: true,
    }), undefined);
  } finally {
    db.close();
  }
});

test('automatic cancellation records its real reason and suppression intent', async () => {
  const db = createDb();
  try {
    insertRun(db, 1, 'mission-review');
    db.prepare("UPDATE runs SET status = 'running', finished_at = NULL, summary = NULL WHERE id = 1").run();

    assert.equal(await cancelRun(db, 1, {
      force: true,
      summary: 'Mission review wake closed automatically.',
      suppressChatBody: true,
    }), true);

    assert.equal(getRun(db, 1)?.status, 'canceled');
    assert.equal(getRun(db, 1)?.summary, 'Mission review wake closed automatically.');
    const event = listRunEvents(db, 1).at(-1);
    assert.equal(event?.type, 'status');
    assert.deepEqual(JSON.parse(event?.payload_json || '{}'), {
      status: 'canceled',
      summary: 'Mission review wake closed automatically.',
      steering: false,
      suppressChatBody: true,
    });
  } finally {
    db.close();
  }
});
