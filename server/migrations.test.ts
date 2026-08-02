import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  ensureChatSchema,
  createChatMessage,
  getChatMessage,
  forwardChatMessage,
  upsertChatAgentMember,
  CHAT_NOTE_MARKER,
} from './chat.js';

/**
 * Release matrix — "API, persistence, migrations": a feature that works on a
 * fresh database can still fail on an existing one. These tests run the schema
 * against both shapes, because the failure mode is always the same: a column
 * added to the CREATE TABLE but not to the migration (or to the INSERT).
 */

/** Minimal vault/note tables — enough for assertChatChannel and getNote. */
function baseSchema(db: Database.Database, rootPath: string) {
  db.exec(`
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
  `);
  db.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('tester');
  db.prepare('INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, 1)')
    .run('vault-1', 'Test', rootPath);
}

function addChannel(db: Database.Database, id: string, title: string) {
  db.prepare(`
    INSERT INTO notes (id, vault_id, title, content, content_preview)
    VALUES (?, 'vault-1', ?, ?, ?)
  `).run(id, title, CHAT_NOTE_MARKER, CHAT_NOTE_MARKER);
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function withDb(fn: (db: Database.Database, rootPath: string) => void) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-migration-'));
  const db = new Database(':memory:');
  try {
    baseSchema(db, rootPath);
    fn(db, rootPath);
  } finally {
    db.close();
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
}

/** The chat_messages shape from before harness logs, change requests and forwards. */
const LEGACY_CHAT_MESSAGES = `
  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT,
    agent_id TEXT,
    registration_id TEXT,
    run_id INTEGER,
    blocks_json TEXT,
    images_json TEXT,
    attachments_json TEXT,
    reply_to_json TEXT
  );
`;

test('a fresh database gets every chat_messages column the writers use', () => {
  withDb((db) => {
    ensureChatSchema(db);
    const cols = columns(db, 'chat_messages');
    for (const required of ['harness_log', 'change_request_json', 'forwarded_from_json']) {
      assert.ok(cols.includes(required), `fresh schema is missing ${required}`);
    }
    assert.ok(columns(db, 'chat_agent_members').includes('reasoning_effort'));
  });
});

test('an existing database is migrated to the current chat_messages shape', () => {
  withDb((db) => {
    db.exec(LEGACY_CHAT_MESSAGES);
    addChannel(db, 'chan-1', 'general');
    db.prepare(`
      INSERT INTO chat_messages (id, channel_id, vault_id, author, body, created_at)
      VALUES ('legacy-1', 'chan-1', 'vault-1', 'asdfasdf', 'said this before the upgrade', '2026-01-01T00:00:00.000Z')
    `).run();

    ensureChatSchema(db);

    const cols = columns(db, 'chat_messages');
    for (const required of ['harness_log', 'change_request_json', 'forwarded_from_json']) {
      assert.ok(cols.includes(required), `migration did not add ${required}`);
    }
    // The upgrade must not drop or rewrite what was already there.
    const legacy = getChatMessage(db, 'chan-1', 1, 'legacy-1');
    assert.equal(legacy?.body, 'said this before the upgrade');
    assert.equal(legacy?.forwardedFrom, undefined);
  });
});

test('an existing agent-members table gains the reasoning effort override', () => {
  withDb((db) => {
    db.exec(`
      CREATE TABLE chat_agent_members (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        vault_agent_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        mention TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        context_prompt TEXT NOT NULL DEFAULT '',
        taggable_by_agents INTEGER NOT NULL DEFAULT 0,
        reply_to_every_message INTEGER NOT NULL DEFAULT 0,
        pingable_by_others INTEGER NOT NULL DEFAULT 0,
        yolo INTEGER NOT NULL DEFAULT 0,
        conversation_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    ensureChatSchema(db);
    assert.ok(columns(db, 'chat_agent_members').includes('reasoning_effort'));
  });
});

test('Codex reasoning effort persists on a channel registration', () => {
  withDb((db) => {
    addChannel(db, 'chan-1', 'general');
    ensureChatSchema(db);
    const saved = upsertChatAgentMember(db, 1, 'vault-1', 'chan-1', {
      id: 'reg-sol',
      agentId: 'codex',
      displayName: 'Sol',
      mention: 'sol',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
    assert.equal(saved.reasoningEffort, 'ultra');
    const row = db.prepare('SELECT reasoning_effort FROM chat_agent_members WHERE id = ?')
      .get('reg-sol') as { reasoning_effort: string };
    assert.equal(row.reasoning_effort, 'ultra');

    const updated = upsertChatAgentMember(db, 1, 'vault-1', 'chan-1', {
      ...saved,
      reasoningEffort: 'max',
    });
    assert.equal(updated.reasoningEffort, 'max');
  });
});

test('Claude Code reasoning effort persists through max and rejects ultra', () => {
  withDb((db) => {
    addChannel(db, 'chan-1', 'general');
    ensureChatSchema(db);
    const saved = upsertChatAgentMember(db, 1, 'vault-1', 'chan-1', {
      id: 'reg-claude',
      agentId: 'claude-code',
      displayName: 'Claude',
      mention: 'claude',
      model: 'claude-opus-4-6',
      reasoningEffort: 'max',
    });
    assert.equal(saved.reasoningEffort, 'max');
    const rejected = upsertChatAgentMember(db, 1, 'vault-1', 'chan-1', {
      ...saved,
      reasoningEffort: 'ultra',
    });
    assert.equal(rejected.reasoningEffort, '');
  });
});

test('writes work after the upgrade, not just after a fresh create', () => {
  // Catches the real failure: a column in CREATE TABLE and in the migration,
  // but a stale INSERT/UPDATE column list that only shows up against a
  // migrated database in production.
  withDb((db) => {
    db.exec(LEGACY_CHAT_MESSAGES);
    addChannel(db, 'chan-1', 'general');
    addChannel(db, 'chan-2', 'design');
    ensureChatSchema(db);

    createChatMessage(db, 1, 'vault-1', 'chan-1', {
      id: 'src-1',
      channelId: 'chan-1',
      author: 'Claude',
      body: 'the renderer stalled',
      createdAt: new Date().toISOString(),
      attachments: [{ name: 'trace.log', media_type: 'text/plain', url: 'https://example.test/trace.log' }],
    });

    const copy = forwardChatMessage(db, 1, 'tester', {
      fromVaultId: 'vault-1',
      fromChannelId: 'chan-1',
      messageId: 'src-1',
      toVaultId: 'vault-1',
      toChannelId: 'chan-2',
    });

    const persisted = getChatMessage(db, 'chan-2', 1, copy.id);
    assert.equal(persisted?.forwardedFrom?.channelName, 'general');
    assert.equal(persisted?.forwardedFrom?.author, 'Claude');
    assert.equal(persisted?.attachments?.[0]?.name, 'trace.log');
  });
});

test('ensureChatSchema is idempotent', () => {
  withDb((db) => {
    ensureChatSchema(db);
    const first = columns(db, 'chat_messages');
    assert.doesNotThrow(() => ensureChatSchema(db));
    assert.deepEqual(columns(db, 'chat_messages'), first);
  });
});
