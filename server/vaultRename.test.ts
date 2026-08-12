import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createVault, deleteVault, renameVault, listNotes, VAULTS_BASE_DIR } from './vault.js';
import { ensureVaultMembersSchema } from './vaultMembers.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, vault_id TEXT, parent_id TEXT, name TEXT, position INTEGER DEFAULT 0
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, vault_id TEXT, name TEXT);
    CREATE TABLE note_tags (note_id TEXT, tag_id TEXT);
    CREATE TABLE note_links (
      source_id TEXT NOT NULL,
      target_title TEXT NOT NULL,
      target_id TEXT,
      context TEXT,
      link_type TEXT NOT NULL DEFAULT 'wikilink'
    );
    INSERT INTO users (id, username) VALUES (1, 'alice');
  `);
  ensureVaultMembersSchema(db);
  return db;
}

function cleanup(db: Database.Database) {
  db.close();
  try {
    fs.rmSync(path.join(VAULTS_BASE_DIR, '1'), { recursive: true, force: true });
  } catch { /* ignore */ }
}

test('renameVault changes the label but never the storage root', () => {
  const db = setup();
  try {
    const vault = createVault(db, 1, { name: 'My Vault' });
    const before = listNotes(db, vault.id).map((note) => note.title);

    const renamed = renameVault(db, vault.id, '  Team notes  ');

    assert.equal(renamed.name, 'Team notes');
    assert.equal(renamed.root_path, vault.root_path);
    assert.ok(fs.existsSync(vault.root_path));
    // Notes hang off root_path, so they must survive the rename untouched.
    assert.deepEqual(listNotes(db, vault.id).map((note) => note.title), before);
  } finally {
    cleanup(db);
  }
});

test('renameVault rejects empty and overlong names', () => {
  const db = setup();
  try {
    const vault = createVault(db, 1, { name: 'My Vault' });
    assert.throws(() => renameVault(db, vault.id, '   '), /required/i);
    assert.throws(() => renameVault(db, vault.id, 'x'.repeat(81)), /80 characters/i);
    // The stored name is unchanged after a rejected rename.
    const row = db.prepare('SELECT name FROM vaults WHERE id = ?').get(vault.id) as { name: string };
    assert.equal(row.name, 'My Vault');
  } finally {
    cleanup(db);
  }
});

test('renameVault reports a missing vault instead of silently succeeding', () => {
  const db = setup();
  try {
    assert.throws(() => renameVault(db, 'no-such-vault', 'Whatever'), /not found/i);
  } finally {
    cleanup(db);
  }
});

test('deleteVault removes an owned vault and its isolated files', () => {
  const db = setup();
  try {
    const vault = createVault(db, 1, { name: 'Disposable' });
    assert.ok(fs.existsSync(vault.root_path));

    assert.equal(deleteVault(db, vault.id, 2), false);
    assert.ok(fs.existsSync(vault.root_path));
    assert.equal(deleteVault(db, vault.id, 1), true);
    assert.equal(db.prepare('SELECT id FROM vaults WHERE id = ?').get(vault.id), undefined);
    assert.equal(fs.existsSync(vault.root_path), false);
  } finally {
    cleanup(db);
  }
});

test('deleteVault refuses to remove files outside managed vault storage', () => {
  const db = setup();
  const outside = path.join(path.dirname(VAULTS_BASE_DIR), `outside-${Date.now()}`);
  try {
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    db.prepare('INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)')
      .run('unsafe', 'Unsafe', outside, 1);

    assert.throws(() => deleteVault(db, 'unsafe', 1), /outside the managed/i);
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
    assert.ok(db.prepare('SELECT id FROM vaults WHERE id = ?').get('unsafe'));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    cleanup(db);
  }
});
