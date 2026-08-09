/**
 * Note creation must not produce two notes that share one file.
 *
 * A note's path on disk is derived from its title (resolveNotePath), so two
 * notes with the same title in the same folder are the same `.md` file: the
 * second create silently overwrites the first's content and both rows then read
 * back whatever was written last. The GUI hit this constantly because every new
 * note is called "Untitled Note".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createNote, createVault, getNote, VAULTS_BASE_DIR } from './vault.js';
import { ensureVaultMembersSchema } from './vaultMembers.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
      created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, folder_id TEXT, title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', content_preview TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0,
      is_listed INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 0, created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, vault_id TEXT, parent_id TEXT, name TEXT, position INTEGER DEFAULT 0
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, vault_id TEXT, name TEXT);
    CREATE TABLE note_tags (note_id TEXT, tag_id TEXT);
    CREATE TABLE note_links (
      source_id TEXT NOT NULL, target_title TEXT NOT NULL, target_id TEXT,
      context TEXT, link_type TEXT NOT NULL DEFAULT 'wikilink'
    );
    INSERT INTO users (id, username) VALUES (9, 'noteuser');
  `);
  ensureVaultMembersSchema(db);
  return db;
}

function cleanup(db: Database.Database) {
  db.close();
  try { fs.rmSync(path.join(VAULTS_BASE_DIR, '9'), { recursive: true, force: true }); } catch { /* ignore */ }
}

test('two notes with the same title get separate files instead of clobbering one', () => {
  const db = setup();
  try {
    const vault = createVault(db, 9, { name: 'Titles' });
    const first = createNote(db, vault.id, 9, { title: 'Untitled Note', content: 'AAA first' });
    const second = createNote(db, vault.id, 9, { title: 'Untitled Note', content: 'BBB second' });

    assert.notEqual(first.id, second.id);
    assert.equal(second.title, 'Untitled Note 2', 'the later note must be renamed, not merged');
    // The real regression: reading the first note back returned the second's body.
    assert.equal(getNote(db, first.id)!.content, 'AAA first');
    assert.equal(getNote(db, second.id)!.content, 'BBB second');
    assert.equal(fs.readFileSync(path.join(vault.root_path, 'Untitled Note.md'), 'utf8'), 'AAA first');
    assert.equal(fs.readFileSync(path.join(vault.root_path, 'Untitled Note 2.md'), 'utf8'), 'BBB second');
  } finally {
    cleanup(db);
  }
});
