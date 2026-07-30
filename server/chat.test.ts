import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildAgentChannelWorkspaceContext } from './chat.js';

test('chat agents inherit folder ancestry and the nearest project doc', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      parent_id TEXT,
      name TEXT NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      folder_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO folders (id, vault_id, parent_id, name) VALUES (?, ?, ?, ?)')
    .run('projects', 'vault', null, 'projects');
  db.prepare('INSERT INTO folders (id, vault_id, parent_id, name) VALUES (?, ?, ?, ?)')
    .run('oc', 'vault', 'projects', 'OC');
  const insertNote = db.prepare(`
    INSERT INTO notes (id, vault_id, folder_id, title, content)
    VALUES (?, 'vault', ?, ?, ?)
  `);
  insertNote.run('channel', 'oc', 'cubegen', 'cascade://chat-channel');
  insertNote.run(
    'project-doc',
    'oc',
    'Project — obsidiancube',
    'ObsidianCube is the umbrella project for the tools in this folder.',
  );
  insertNote.run('nearby', 'oc', 'Meeting notes', 'This should not be injected.');

  const context = buildAgentChannelWorkspaceContext(db, 'channel');

  assert.match(context, /user-facing, Obsidian-style workspace for AI-native project management/);
  assert.match(context, /`cascade-note` CLI on PATH/);
  assert.match(context, /not a mirror of the process cwd/);
  assert.match(context, /Cascade channel location: projects \/ OC \/ #cubegen/);
  assert.match(context, /Project — obsidiancube/);
  assert.match(context, /ObsidianCube is the umbrella project/);
  assert.doesNotMatch(context, /This should not be injected/);
  db.close();
});
