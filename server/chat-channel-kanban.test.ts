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
  setChannelKanbanNoteId,
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
    CREATE TABLE note_links (
      source_id TEXT NOT NULL,
      target_title TEXT NOT NULL,
      target_id TEXT,
      link_type TEXT NOT NULL DEFAULT 'wikilink'
    );
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

const BOARD = `---
kanban-plugin: board
---

# Project board

## Backlog

## Done

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`;

test('channel board is a pointer to an existing LHS kanban note', () => {
  const { db, root } = setup();
  try {
    upsertChatAgentMember(db, 1, 'vault-1', 'channel-1', {
      id: 'reg-sol',
      agentId: 'codex',
      displayName: 'Sol',
      mention: 'sol',
      model: 'gpt',
      orchestrator: true,
    });
    // Enabling orchestrator does not auto-create a board.
    assert.equal(getChannelSettings(db, 'channel-1', 1).kanbanNoteId, '');

    db.prepare(`
      INSERT INTO notes (id, vault_id, title, content, content_preview, is_listed, created_by)
      VALUES (?, ?, ?, ?, ?, 1, 1)
    `).run('board-1', 'vault-1', 'Cascade board', BOARD, 'kanban-plugin: board');

    const pointed = setChannelKanbanNoteId(db, 1, 'channel-1', 'board-1');
    assert.equal(pointed.kanbanNoteId, 'board-1');
    assert.equal(getChannelSettings(db, 'channel-1', 1).kanbanNoteId, 'board-1');

    const cleared = setChannelKanbanNoteId(db, 1, 'channel-1', null);
    assert.equal(cleared.kanbanNoteId, '');
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('optional internal board is unlisted and becomes the pointer', () => {
  const { db, root } = setup();
  try {
    const created = ensureChannelOrchestrationKanban(db, 1, 'channel-1', { createInternal: true });
    assert.ok(created?.kanbanNoteId);
    const note = db.prepare('SELECT title, content, is_listed FROM notes WHERE id = ?')
      .get(created!.kanbanNoteId) as { title: string; content: string; is_listed: number };
    assert.equal(note.is_listed, 0);
    assert.match(note.content, /cascade-channel:\s*channel-1/);
    assert.equal(getChannelSettings(db, 'channel-1', 1).kanbanNoteId, created!.kanbanNoteId);
    // Idempotent.
    assert.equal(
      ensureChannelOrchestrationKanban(db, 1, 'channel-1', { createInternal: true })?.kanbanNoteId,
      created!.kanbanNoteId,
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
