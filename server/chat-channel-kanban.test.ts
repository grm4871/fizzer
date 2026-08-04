import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  CHAT_NOTE_MARKER,
  ensureChannelOrchestrationKanban,
  ensureChatSchema,
  getChannelSettings,
  upsertChatAgentMember,
} from './chat.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-channel-kanban-'));
  const db = new Database(':memory:');
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
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE folders (id TEXT PRIMARY KEY, vault_id TEXT, parent_id TEXT, name TEXT, position INTEGER DEFAULT 0);
    CREATE TABLE tags (id TEXT PRIMARY KEY, vault_id TEXT, name TEXT);
    CREATE TABLE note_tags (note_id TEXT, tag_id TEXT);
    CREATE TABLE note_links (source_note_id TEXT, target_note_id TEXT, target_title TEXT);
    INSERT INTO users (id, username) VALUES (1, 'owner');
  `);
  db.prepare('INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)')
    .run('vault-1', 'Test', root, 1);
  db.prepare(`
    INSERT INTO notes (id, vault_id, title, content, content_preview, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('channel-1', 'vault-1', 'cascade-dev', CHAT_NOTE_MARKER, CHAT_NOTE_MARKER, 1);
  ensureChatSchema(db);
  return { db, root };
}

test('orchestrator channels get an attached local kanban board', () => {
  const { db, root } = setup();
  try {
    assert.equal(getChannelSettings(db, 'channel-1', 1).kanbanNoteId, '');
    upsertChatAgentMember(db, 1, 'vault-1', 'channel-1', {
      id: 'reg-sol',
      agentId: 'codex',
      displayName: 'Sol',
      mention: 'sol',
      model: 'gpt',
      orchestrator: true,
    });
    const settings = getChannelSettings(db, 'channel-1', 1);
    assert.ok(settings.kanbanNoteId);
    const note = db.prepare('SELECT title, content FROM notes WHERE id = ?').get(settings.kanbanNoteId) as {
      title: string;
      content: string;
    };
    assert.match(note.title, /cascade-dev board/i);
    assert.match(note.content, /kanban-plugin:\s*board/);
    assert.match(note.content, /cascade-channel:\s*channel-1/);
    const again = ensureChannelOrchestrationKanban(db, 1, 'channel-1');
    assert.equal(again?.kanbanNoteId, settings.kanbanNoteId);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
