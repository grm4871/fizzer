import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  createFolder,
  createVault,
  enforceVaultStorageIsolation,
  listNotes,
  rescanVault,
  VAULTS_BASE_DIR,
} from './vault.js';
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

test('enforceVaultStorageIsolation rehomes secondary shared-root vaults and purges leaked notes', () => {
  const db = setup();
  const shared = path.join(os.tmpdir(), `cascade-shared-root-${Date.now()}`);
  try {
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'ALICE SECRET.md'), '# alice only\n', 'utf8');

    // Simulate legacy createVault: two vault rows, one disk tree.
    db.prepare(
      'INSERT INTO vaults (id, name, root_path, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('v-alice', 'My Vault', shared, 1, '2020-01-01T00:00:00');
    db.prepare(
      'INSERT INTO vaults (id, name, root_path, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('v-bob', 'My Vault', shared, 2, '2024-01-01T00:00:00');
    db.prepare(`
      INSERT INTO notes (id, vault_id, title, content, content_preview, created_by)
      VALUES ('n-leaked', 'v-bob', 'ALICE SECRET', '# alice only', 'alice', 2)
    `).run();

    const result = enforceVaultStorageIsolation(db);
    assert.equal(result.rehomed, 1);

    const alice = db.prepare('SELECT * FROM vaults WHERE id = ?').get('v-alice') as { root_path: string };
    const bob = db.prepare('SELECT * FROM vaults WHERE id = ?').get('v-bob') as { root_path: string };
    assert.equal(path.resolve(alice.root_path), path.resolve(shared));
    assert.notEqual(path.resolve(bob.root_path), path.resolve(shared));
    assert.ok(bob.root_path.includes(`${path.sep}2${path.sep}`));

    const bobNotes = listNotes(db, 'v-bob');
    assert.ok(bobNotes.every((n) => n.title !== 'ALICE SECRET'));

    // Unique index blocks re-inserting a collision.
    assert.throws(() => {
      db.prepare(
        'INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)',
      ).run('v-collide', 'X', alice.root_path, 2);
    });
  } finally {
    db.close();
    try { fs.rmSync(shared, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(VAULTS_BASE_DIR, '2'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('folder names cannot escape the vault root', () => {
  const db = setup();
  try {
    const vault = createVault(db, 1, { name: 'Safe' });
    assert.throws(() => createFolder(db, vault.id, { name: '..' }));
    assert.throws(() => createFolder(db, vault.id, { name: '../outside' }));
    const ok = createFolder(db, vault.id, { name: 'Projects' });
    assert.equal(ok.name, 'Projects');
    assert.ok(path.resolve(ok.name) === 'Projects' || !ok.name.includes('..'));
  } finally {
    db.close();
    try { fs.rmSync(path.join(VAULTS_BASE_DIR, '1'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('rescanVault refuses when root_path is shared with another vault', () => {
  const db = setup();
  const shared = path.join(os.tmpdir(), `cascade-rescan-shared-${Date.now()}`);
  try {
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'LEAK.md'), '# secret\n', 'utf8');

    db.prepare(
      'INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)',
    ).run('v1', 'A', shared, 1);
    db.prepare(
      'INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)',
    ).run('v2', 'B', shared, 2);

    rescanVault(db, 'v2', 2);
    const notes = listNotes(db, 'v2');
    assert.equal(notes.length, 0);
    assert.ok(notes.every((n) => n.title !== 'LEAK'));
  } finally {
    db.close();
    try { fs.rmSync(shared, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
