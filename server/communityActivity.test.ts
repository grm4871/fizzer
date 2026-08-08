import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CHAT_NOTE_MARKER, createChatMessage, ensureChatSchema, updateChatMessage } from './chat.js';
import {
  COMMUNITY_UPDATES_COUNT_CAP,
  ensureCommunityActivitySchema,
  listCommunityUpdates,
  markAllCommunityUpdatesRead,
  markCommunityTargetRead,
  recordCommunityNoteChange,
} from './communityActivity.js';
import { ensureVaultMembersSchema } from './vaultMembers.js';
import {
  addTag,
  createFolder,
  createNote,
  deleteFolder,
  moveNote,
  removeTag,
  renameNote,
  setNoteMutationSink,
  toggleArchive,
  togglePin,
  unlistNote,
  updateNote,
} from './vault.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-community-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, vault_id TEXT, parent_id TEXT, name TEXT, position INTEGER DEFAULT 0
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
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
    CREATE TABLE tags (id TEXT PRIMARY KEY, vault_id TEXT, name TEXT, color TEXT, UNIQUE(vault_id, name));
    CREATE TABLE note_tags (note_id TEXT, tag_id TEXT, PRIMARY KEY(note_id, tag_id));
    CREATE TABLE note_links (
      source_id TEXT NOT NULL,
      target_title TEXT NOT NULL,
      target_id TEXT,
      context TEXT,
      link_type TEXT NOT NULL DEFAULT 'wikilink'
    );
  `);
  db.prepare(`INSERT INTO users (id, username, display_name) VALUES
    (1, 'alice', 'Alice'), (2, 'bob', 'Bob'), (3, 'carol', 'Carol')`).run();
  db.prepare('INSERT INTO vaults (id, name, root_path, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('source', 'Source vault', path.join(root, 'source'), 1, '2026-08-01T00:00:00.000Z');
  db.prepare('INSERT INTO vaults (id, name, root_path, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('local', 'Bob vault', path.join(root, 'local'), 2, '2026-08-01T00:00:00.000Z');
  fs.mkdirSync(path.join(root, 'source'), { recursive: true });
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  ensureVaultMembersSchema(db);
  db.prepare("UPDATE vault_members SET created_at = '2026-08-01T00:00:00.000Z'").run();
  ensureChatSchema(db);
  ensureCommunityActivitySchema(db);
  return {
    db,
    close: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function addNote(db: Database.Database, id: string, vaultId: string, title: string, content = '') {
  db.prepare(`
    INSERT INTO notes (id, vault_id, title, content, content_preview, created_by)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, vaultId, title, content, content);
}

test('a local mirror shares one canonical watermark and ignores own/nonterminal agent writes', () => {
  const { db, close } = setup();
  try {
    addNote(db, 'source-channel', 'source', 'cascade-dev', CHAT_NOTE_MARKER);
    addNote(db, 'local-channel', 'local', 'cascade-dev', `${CHAT_NOTE_MARKER}\nshared_from=source-channel`);
    db.prepare(`
      INSERT INTO chat_channel_links (
        local_channel_id, local_vault_id, source_channel_id, source_vault_id, created_by, created_at
      ) VALUES ('local-channel', 'local', 'source-channel', 'source', 1, '2026-08-05T00:00:00.000Z')
    `).run();

    // Before the mirror subscription: never appears for Bob.
    createChatMessage(db, 1, 'source', 'source-channel', {
      id: 'old', channelId: 'source-channel', author: 'alice', body: 'old',
      createdAt: '2026-08-04T00:00:00.000Z',
    });
    // Bob's own human write is not an update for Bob.
    createChatMessage(db, 2, 'local', 'local-channel', {
      id: 'own', channelId: 'local-channel', author: 'bob', body: 'mine',
      createdAt: '2026-08-06T00:00:00.000Z',
    });
    db.prepare(`
      INSERT INTO vault_agents (id, vault_id, agent_id, display_name, mention, owner_user_id)
      VALUES ('bob-agent', 'local', 'codex', 'Bob agent', '@bob-agent', 2)
    `).run();
    db.prepare(`
      INSERT INTO chat_agent_members (
        id, channel_id, vault_id, vault_agent_id, agent_id, display_name, mention
      ) VALUES ('bob-registration', 'source-channel', 'source', 'bob-agent', 'codex', 'Bob agent', '@bob-agent')
    `).run();
    createChatMessage(db, 2, 'local', 'local-channel', {
      id: 'own-agent', channelId: 'local-channel', author: 'spoofed', body: 'agent output',
      agentId: 'codex', registrationId: 'bob-registration', createdAt: '2026-08-06T00:30:00.000Z',
    });
    createChatMessage(db, 2, 'local', 'local-channel', {
      id: 'own-unregistered-agent', channelId: 'local-channel', author: 'Local helper', body: 'helper output',
      agentId: 'codex', createdAt: '2026-08-06T00:45:00.000Z',
    });
    // A streaming shell has no activity timestamp until it becomes terminal.
    createChatMessage(db, 1, 'source', 'source-channel', {
      id: 'shell', channelId: 'source-channel', author: 'Sol', body: 'Thinking...',
      agentId: 'codex', status: 'running', createdAt: '2026-08-06T01:00:00.000Z',
    });
    createChatMessage(db, 1, 'source', 'source-channel', {
      id: 'mention', channelId: 'source-channel', author: 'alice', body: 'hi @bob',
      createdAt: '2026-08-06T02:00:00.000Z',
    });

    let updates = listCommunityUpdates(db, { id: 2, username: 'bob' });
    assert.equal(updates.counts.total, 1);
    assert.equal(updates.counts.byTarget['local-channel'], 1);
    assert.equal(updates.groups[0].items[0].kind, 'mention');
    assert.equal(updates.groups[0].items[0].targetId, 'local-channel');

    // Reading the local alias writes the source-channel watermark.
    assert.equal(markCommunityTargetRead(db, 2, 'local-channel', '2026-08-06T03:00:00.000Z'), true);
    assert.equal(listCommunityUpdates(db, { id: 2, username: 'bob' }).counts.total, 0);

    // The shell finalizes after the read watermark, so its completion is not
    // lost behind its older createdAt timestamp.
    updateChatMessage(db, 1, 'source', 'source-channel', 'shell', {
      body: 'final answer', status: undefined,
    });
    updates = listCommunityUpdates(db, { id: 2, username: 'bob' });
    assert.equal(updates.counts.total, 1);
    assert.equal(updates.groups[0].items[0].id, 'message:shell');

    assert.equal(markCommunityTargetRead(db, 2, 'source-channel', '2099-01-01T00:00:00.000Z'), true);
    assert.equal(listCommunityUpdates(db, { id: 2, username: 'bob' }).counts.total, 0);
  } finally {
    close();
  }
});

test('note changes start at membership time, are attributed, and disappear with access/content', () => {
  const { db, close } = setup();
  try {
    db.prepare("INSERT INTO vault_members (vault_id, user_id, role, invited_by, created_at) VALUES ('source', 2, 'editor', 1, '2026-08-05T00:00:00.000Z')").run();
    addNote(db, 'roadmap', 'source', 'Roadmap', 'Ship the loop');
    recordCommunityNoteChange(db, 'roadmap', 1, '2026-08-04T00:00:00.000Z');
    recordCommunityNoteChange(db, 'roadmap', 2, '2026-08-06T00:00:00.000Z');
    recordCommunityNoteChange(db, 'roadmap', 1, '2026-08-07T00:00:00.000Z');

    let updates = listCommunityUpdates(db, { id: 2, username: 'bob' });
    assert.equal(updates.counts.total, 1);
    assert.equal(updates.groups[0].items[0].id, 'note:roadmap:3');
    assert.equal(updates.groups[0].items[0].actor, 'alice');

    markAllCommunityUpdatesRead(db, 2, '2026-08-08T00:00:00.000Z');
    assert.equal(listCommunityUpdates(db, { id: 2, username: 'bob' }).counts.total, 0);
    recordCommunityNoteChange(db, 'roadmap', 1, '2026-08-09T00:00:00.000Z');
    assert.equal(listCommunityUpdates(db, { id: 2, username: 'bob' }).counts.total, 1);

    db.prepare("UPDATE notes SET is_listed = 0 WHERE id = 'roadmap'").run();
    assert.equal(listCommunityUpdates(db, { id: 2, username: 'bob' }).counts.total, 0);
    assert.equal(markCommunityTargetRead(db, 2, 'roadmap'), false);
    db.prepare("UPDATE notes SET is_listed = 1 WHERE id = 'roadmap'").run();

    db.prepare("UPDATE notes SET is_archived = 1 WHERE id = 'roadmap'").run();
    assert.equal(listCommunityUpdates(db, { id: 2, username: 'bob' }).counts.total, 0);
    db.prepare("UPDATE notes SET is_archived = 0 WHERE id = 'roadmap'").run();
    db.prepare("DELETE FROM vault_members WHERE vault_id = 'source' AND user_id = 2").run();
    assert.equal(listCommunityUpdates(db, { id: 2, username: 'bob' }).counts.total, 0);
    assert.equal(markCommunityTargetRead(db, 2, 'roadmap'), false);
    db.prepare("DELETE FROM notes WHERE id = 'roadmap'").run();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM community_note_activity').get() as { n: number }).n, 0);
  } finally {
    close();
  }
});

test('first upgrade seeds existing channel history as read', () => {
  const { db, close } = setup();
  try {
    db.prepare("INSERT INTO vault_members (vault_id, user_id, role, invited_by, created_at) VALUES ('source', 2, 'viewer', 1, '2000-01-01T00:00:00.000Z')").run();
    addNote(db, 'history', 'source', 'history', CHAT_NOTE_MARKER);
    createChatMessage(db, 1, 'source', 'history', {
      id: 'before-inbox', channelId: 'history', author: 'alice', body: 'old history',
      createdAt: '2001-01-01T00:00:00.000Z',
    });

    db.exec('DROP TABLE community_read_state');
    ensureCommunityActivitySchema(db);
    assert.equal(listCommunityUpdates(db, { id: 2, username: 'bob' }).counts.total, 0);

    createChatMessage(db, 1, 'source', 'history', {
      id: 'after-inbox', channelId: 'history', author: 'alice', body: 'new history',
      createdAt: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(listCommunityUpdates(db, { id: 2, username: 'bob' }).counts.total, 1);
  } finally {
    close();
  }
});

test('counts and payloads stay bounded under noisy channels', () => {
  const { db, close } = setup();
  try {
    db.prepare("INSERT INTO vault_members (vault_id, user_id, role, invited_by, created_at) VALUES ('source', 2, 'viewer', 1, '2026-08-01T00:00:00.000Z')").run();
    addNote(db, 'busy', 'source', 'busy', CHAT_NOTE_MARKER);
    const insert = db.prepare(`
      INSERT INTO chat_messages (id, channel_id, vault_id, author, body, created_at, activity_at)
      VALUES (?, 'busy', 'source', 'alice', ?, ?, ?)
    `);
    for (let i = 0; i < 140; i++) {
      const at = `2026-08-07T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
      insert.run(`m${i}`, `message ${i}`, at, at);
    }
    const updates = listCommunityUpdates(db, { id: 2, username: 'bob' }, 12);
    assert.equal(updates.counts.total, COMMUNITY_UPDATES_COUNT_CAP);
    assert.equal(updates.counts.byTarget.busy, COMMUNITY_UPDATES_COUNT_CAP);
    assert.equal(updates.groups[0].items.length, 12);
    assert.equal(updates.truncated, true);
  } finally {
    close();
  }
});

test('storage mutation paths emit attributed note activity', () => {
  const { db, close } = setup();
  setNoteMutationSink((database, noteId, actorUserId) => {
    recordCommunityNoteChange(database, noteId, actorUserId);
  });
  try {
    const folder = createFolder(db, 'source', { name: 'Plans' });
    const note = createNote(db, 'source', 1, { title: 'Plan', content: 'one', folder_id: folder.id });
    updateNote(db, note.id, 'two', 1);
    renameNote(db, note.id, 'Roadmap', 1);
    moveNote(db, note.id, null, undefined, 1);
    unlistNote(db, note.id, 1);
    togglePin(db, note.id, 1);
    toggleArchive(db, note.id, 1);
    toggleArchive(db, note.id, 1);
    addTag(db, note.id, 'source', 'release', undefined, 1);
    const tag = db.prepare("SELECT id FROM tags WHERE name = 'release'").get() as { id: string };
    removeTag(db, note.id, tag.id, 1);
    moveNote(db, note.id, folder.id, undefined, 1);
    deleteFolder(db, folder.id, 1);

    const rows = db.prepare(`
      SELECT actor_user_id AS actorUserId FROM community_note_activity WHERE note_id = ? ORDER BY id
    `).all(note.id) as Array<{ actorUserId: number }>;
    assert.equal(rows.length, 12);
    assert.ok(rows.every((row) => row.actorUserId === 1));
  } finally {
    setNoteMutationSink(null);
    close();
  }
});
