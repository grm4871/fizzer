import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createVault, listNotes, VAULTS_BASE_DIR } from './vault.js';
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
      source_id TEXT NOT NULL, target_title TEXT NOT NULL, target_id TEXT, link_type TEXT NOT NULL DEFAULT 'wikilink'
    );
    INSERT INTO users (id, username) VALUES (1, 'alice'), (2, 'bob');
  `);
  ensureVaultMembersSchema(db);
  return db;
}

test('new accounts get isolated vault roots and do not inherit another user disk notes', () => {
  const db = setup();
  const aliceHome = path.join(VAULTS_BASE_DIR, '1');
  try {
    // Poison a legacy shared layout path the way old createVault used to.
    const legacyShared = path.join(VAULTS_BASE_DIR, 'My Vault');
    fs.mkdirSync(legacyShared, { recursive: true });
    fs.writeFileSync(path.join(legacyShared, 'SECRET from alice.md'), '# alice only\n', 'utf8');

    const alice = createVault(db, 1, { name: 'My Vault' });
    const bob = createVault(db, 2, { name: 'My Vault' });

    assert.notEqual(alice.root_path, bob.root_path);
    assert.ok(alice.root_path.includes(`${path.sep}1${path.sep}`));
    assert.ok(bob.root_path.includes(`${path.sep}2${path.sep}`));
    // Client cannot force a shared path.
    assert.notEqual(path.resolve(bob.root_path), path.resolve(legacyShared));

    const bobNotes = listNotes(db, bob.id);
    assert.ok(bobNotes.every((n) => n.title !== 'SECRET from alice'));
    assert.ok(bobNotes.some((n) => /Welcome/i.test(n.title)));
  } finally {
    db.close();
    // Best-effort cleanup of test dirs under ~/.cascade/vaults/{1,2}
    for (const uid of ['1', '2']) {
      try {
        fs.rmSync(path.join(VAULTS_BASE_DIR, uid), { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    void aliceHome;
  }
});

test('createVault ignores client-supplied root_path', () => {
  const db = setup();
  try {
    const evil = path.join(os.tmpdir(), 'cascade-evil-shared-notes');
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'leaked.md'), '# leaked\n', 'utf8');
    const vault = createVault(db, 2, { name: 'My Vault', root_path: evil });
    assert.notEqual(path.resolve(vault.root_path), path.resolve(evil));
    const notes = listNotes(db, vault.id);
    assert.ok(notes.every((n) => n.title !== 'leaked'));
  } finally {
    db.close();
    try {
      fs.rmSync(path.join(VAULTS_BASE_DIR, '2'), { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});
