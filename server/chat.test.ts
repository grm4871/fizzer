import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildAgentChannelWorkspaceContext, CASCADE_AGENT_APP_CONTEXT } from './chat.js';

test('the app contract identifies Cascade and the live note helper unambiguously', () => {
  assert.match(CASCADE_AGENT_APP_CONTEXT, /Obsidian-style workspace for AI-native project management/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /live app data, not a mirror/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /Use `cascade-note` by command name/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /pre-authorized/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /`--listed` and `--folder`/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /Do not replace the helper with an absolute path/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /absent from the local filesystem or named tool list/);
});

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

  assert.match(context, /Cascade channel location: projects \/ OC \/ #cubegen/);
  assert.match(context, /Project — obsidiancube/);
  assert.match(context, /ObsidianCube is the umbrella project/);
  assert.doesNotMatch(context, /This should not be injected/);
  db.close();
});
