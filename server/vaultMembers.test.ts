import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  addVaultMember,
  ensureVaultMembersSchema,
  getVaultRole,
  listVaultMembers,
  removeVaultMember,
  setVaultMemberRole,
} from './vaultMembers.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO users (id, username, display_name) VALUES (1, 'owner', 'Owner'), (2, 'alice', 'Alice'), (3, 'bob', 'Bob')").run();
  db.prepare("INSERT INTO vaults (id, name, created_by) VALUES ('v1', 'Main', 1)").run();
  ensureVaultMembersSchema(db);
  return db;
}

test('owner is backfilled and can invite/change/remove members', () => {
  const db = setup();
  try {
    assert.equal(getVaultRole(db, 'v1', 1), 'owner');
    const invited = addVaultMember(db, 'v1', 1, 2, 'editor');
    assert.equal(invited.role, 'editor');
    assert.equal(invited.username, 'alice');
    const updated = setVaultMemberRole(db, 'v1', 1, 2, 'admin');
    assert.equal(updated.role, 'admin');
    assert.equal(listVaultMembers(db, 'v1').length, 2);
    removeVaultMember(db, 'v1', 1, 2);
    assert.equal(listVaultMembers(db, 'v1').length, 1);
  } finally {
    db.close();
  }
});

test('viewers cannot manage membership', () => {
  const db = setup();
  try {
    addVaultMember(db, 'v1', 1, 2, 'viewer');
    assert.throws(() => addVaultMember(db, 'v1', 2, 3, 'editor'), /owners and admins/i);
  } finally {
    db.close();
  }
});
