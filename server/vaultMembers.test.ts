import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  addVaultMember,
  canManageVaultMembers,
  canWriteVault,
  ensureVaultMembersSchema,
  getVaultRole,
  isReadOnlyVaultMutation,
  listVaultMembers,
  removeVaultMember,
  setVaultMemberRole,
} from './vaultMembers.js';
import { getVault, getWritableVault, listVaults } from './vault.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
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

test('owner is backfilled and invite-only members receive editor or viewer access', () => {
  const db = setup();
  try {
    assert.equal(getVaultRole(db, 'v1', 1), 'owner');
    assert.equal(getVault(db, 'v1', 3), undefined);
    assert.deepEqual(listVaults(db, 3), []);

    const invited = addVaultMember(db, 'v1', 1, 2, 'editor');
    assert.equal(invited.role, 'editor');
    assert.equal(invited.username, 'alice');
    assert.equal(getVault(db, 'v1', 2)?.id, 'v1');
    assert.equal(getWritableVault(db, 'v1', 2)?.id, 'v1');

    const updated = setVaultMemberRole(db, 'v1', 1, 2, 'viewer');
    assert.equal(updated.role, 'viewer');
    assert.equal(getVault(db, 'v1', 2)?.id, 'v1');
    assert.equal(getWritableVault(db, 'v1', 2), undefined);
    assert.equal(listVaultMembers(db, 'v1').length, 2);
    removeVaultMember(db, 'v1', 1, 2);
    assert.equal(listVaultMembers(db, 'v1').length, 1);
    assert.equal(getVault(db, 'v1', 2), undefined);
  } finally {
    db.close();
  }
});

test('only owners manage membership while collaborators may leave', () => {
  const db = setup();
  try {
    addVaultMember(db, 'v1', 1, 2, 'editor');
    assert.throws(() => addVaultMember(db, 'v1', 2, 3, 'viewer'), /only the vault owner/i);
    assert.throws(() => setVaultMemberRole(db, 'v1', 2, 2, 'viewer'), /only the vault owner/i);
    assert.throws(() => removeVaultMember(db, 'v1', 2, 1), /vault owner/i);
    removeVaultMember(db, 'v1', 2, 2);
    assert.equal(getVaultRole(db, 'v1', 2), null);
    assert.equal(canManageVaultMembers('owner'), true);
    assert.equal(canManageVaultMembers('editor'), false);
    assert.equal(canWriteVault('editor'), true);
    assert.equal(canWriteVault('viewer'), false);
  } finally {
    db.close();
  }
});

test('viewer API access is read-only across nested vault routes', () => {
  const db = setup();
  try {
    addVaultMember(db, 'v1', 1, 2, 'viewer');
    assert.equal(isReadOnlyVaultMutation(db, 2, 'GET', '/api/vaults/v1/notes'), false);
    assert.equal(isReadOnlyVaultMutation(db, 2, 'POST', '/api/vaults/v1/notes'), true);
    assert.equal(isReadOnlyVaultMutation(db, 2, 'PATCH', '/api/vaults/v1/channels/c1/messages/m1'), true);
    assert.equal(isReadOnlyVaultMutation(db, 2, 'DELETE', '/api/vaults/v1/vault-agents/a1'), true);
    assert.equal(isReadOnlyVaultMutation(db, 2, 'DELETE', '/api/vaults/v1/members/2'), false);
    assert.equal(isReadOnlyVaultMutation(db, 2, 'DELETE', '/api/vaults/v1/members/3'), true);
    assert.equal(isReadOnlyVaultMutation(db, 1, 'POST', '/api/vaults/v1/notes'), false);
    assert.equal(isReadOnlyVaultMutation(db, 3, 'POST', '/api/vaults/v1/notes'), false);
    assert.equal(isReadOnlyVaultMutation(db, 2, 'POST', '/api/notes/n1'), false);
  } finally {
    db.close();
  }
});

test('migrates legacy membership rows and removes the retired admin role', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
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
      CREATE TABLE vault_members (
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('owner','admin','editor','viewer')),
        invited_by INTEGER,
        created_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (vault_id, user_id)
      );
      INSERT INTO users (id, username) VALUES (1, 'owner'), (2, 'legacy_admin'), (3, 'blocked_admin');
      INSERT INTO vaults (id, name, created_by) VALUES ('v1', 'Main', 1);
      INSERT INTO vault_members (vault_id, user_id, role, invited_by)
      VALUES ('v1', 1, 'editor', 1), ('v1', 2, 'admin', 1);
    `);
    ensureVaultMembersSchema(db);
    assert.equal(getVaultRole(db, 'v1', 1), 'owner');
    assert.equal(getVaultRole(db, 'v1', 2), 'editor');
    const legacy = listVaultMembers(db, 'v1').find((member) => member.userId === 2);
    assert.ok(legacy?.createdAt);
    assert.throws(
      () => db.prepare("INSERT INTO vault_members (vault_id, user_id, role) VALUES ('v1', 3, 'admin')").run(),
      /CHECK constraint failed/,
    );
    // Re-running the boot migration is idempotent and preserves both rows.
    ensureVaultMembersSchema(db);
    assert.equal(listVaultMembers(db, 'v1').length, 2);
  } finally {
    db.close();
  }
});

test('migrates membership tables that predate role metadata', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
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
      CREATE TABLE vault_members (
        vault_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        PRIMARY KEY (vault_id, user_id)
      );
      INSERT INTO users (id, username) VALUES (1, 'owner'), (2, 'member');
      INSERT INTO vaults (id, name, created_by) VALUES ('v1', 'Main', 1);
      INSERT INTO vault_members (vault_id, user_id) VALUES ('v1', 1), ('v1', 2);
    `);
    ensureVaultMembersSchema(db);
    assert.equal(getVaultRole(db, 'v1', 1), 'owner');
    assert.equal(getVaultRole(db, 'v1', 2), 'editor');
  } finally {
    db.close();
  }
});
