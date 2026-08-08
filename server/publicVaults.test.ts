import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  ensurePublicVaultSchema,
  getVaultVisibility,
  joinPublicVault,
  listPublicVaults,
  setVaultVisibility,
} from './publicVaults.js';
import { ensureVaultMembersSchema, getVaultRole, listVaultMembers } from './vaultMembers.js';
import { ensureDirectMessageSchema } from './directMessages.js';
import { ensureChatSchema } from './chat.js';
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
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      content_preview TEXT NOT NULL DEFAULT ''
    );
  `);
  db.prepare(`
    INSERT INTO users (id, username, display_name)
    VALUES (1, 'alice', 'Alice'), (2, 'bob', 'Bob'), (3, 'carol', 'Carol')
  `).run();
  db.prepare(`
    INSERT INTO vaults (id, name, created_by) VALUES
      ('v-open', 'Open Research', 1),
      ('v-secret', 'Alice Private', 1),
      ('v-bob', 'Bob Notes', 2)
  `).run();
  ensureVaultMembersSchema(db);
  ensureChatSchema(db);
  ensureDirectMessageSchema(db);
  ensurePublicVaultSchema(db);
  return db;
}

/** Park a DM between alice and bob with its source channel in `vaultId`. */
function seedDirectMessage(db: Database.Database, vaultId: string): void {
  db.prepare("INSERT INTO notes (id, vault_id, title, content) VALUES ('dm-note', ?, 'DM — @bob', 'cascade://chat-channel')")
    .run(vaultId);
  db.prepare(`
    INSERT INTO direct_message_channels (user_a_id, user_b_id, source_vault_id, source_channel_id, created_by)
    VALUES (1, 2, ?, 'dm-note', 1)
  `).run(vaultId);
}

test('vaults default to private and stay out of the browse directory', () => {
  const db = setup();
  try {
    assert.deepEqual(getVaultVisibility(db, 'v-open'), { visibility: 'private', joinRole: 'viewer' });
    assert.deepEqual(listPublicVaults(db, { userId: 3 }), []);
    assert.equal(getVaultVisibility(db, 'missing'), null);
  } finally {
    db.close();
  }
});

test('only the owner can publish a vault, and the enum is validated', () => {
  const db = setup();
  try {
    assert.throws(
      () => setVaultVisibility(db, 'v-open', 2, { visibility: 'public' }),
      /Only the vault owner/,
    );

    // An editor is still not an owner.
    db.prepare("INSERT INTO vault_members (vault_id, user_id, role) VALUES ('v-open', 2, 'editor')").run();
    assert.throws(
      () => setVaultVisibility(db, 'v-open', 2, { visibility: 'public' }),
      /Only the vault owner/,
    );

    assert.throws(() => setVaultVisibility(db, 'v-open', 1, { visibility: 'unlisted' }), /public or private/);
    assert.throws(() => setVaultVisibility(db, 'v-open', 1, { joinRole: 'owner' }), /editor or viewer/);
    assert.throws(() => setVaultVisibility(db, 'missing', 1, { visibility: 'public' }), /Vault not found/);

    assert.equal(getVaultVisibility(db, 'v-open')?.visibility, 'private');
  } finally {
    db.close();
  }
});

test('publishing a vault lists it for strangers with the caller membership attached', () => {
  const db = setup();
  try {
    setVaultVisibility(db, 'v-open', 1, { visibility: 'public' });

    const listed = listPublicVaults(db, { userId: 3 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'v-open');
    assert.equal(listed[0].ownerUsername, 'alice');
    assert.equal(listed[0].ownerDisplayName, 'Alice');
    assert.equal(listed[0].memberCount, 1);
    assert.equal(listed[0].joinRole, 'viewer');
    // Carol has not joined yet.
    assert.equal(listed[0].role, null);
    // Browse rows never carry on-disk paths.
    assert.equal((listed[0] as Record<string, unknown>).root_path, undefined);

    // The owner sees their own membership on the same row.
    assert.equal(listPublicVaults(db, { userId: 1 })[0].role, 'owner');

    // The other private vaults stay hidden.
    assert.deepEqual(listPublicVaults(db, { userId: 3 }).map((v) => v.id), ['v-open']);
  } finally {
    db.close();
  }
});

test('browse search matches vault name or owner username and never leaks private vaults', () => {
  const db = setup();
  try {
    setVaultVisibility(db, 'v-open', 1, { visibility: 'public' });
    setVaultVisibility(db, 'v-bob', 2, { visibility: 'public' });

    assert.deepEqual(listPublicVaults(db, { userId: 3, query: 'research' }).map((v) => v.id), ['v-open']);
    assert.deepEqual(listPublicVaults(db, { userId: 3, query: 'bob' }).map((v) => v.id), ['v-bob']);
    assert.deepEqual(listPublicVaults(db, { userId: 3, query: 'nothing here' }), []);
    // Wildcards are escaped, so a lone '%' is a literal and matches nothing.
    assert.deepEqual(listPublicVaults(db, { userId: 3, query: '%' }), []);
    // 'Alice Private' is owned by a matching username but is not public.
    assert.equal(
      listPublicVaults(db, { userId: 3, query: 'alice' }).some((v) => v.id === 'v-secret'),
      false,
    );
  } finally {
    db.close();
  }
});

test('joining a public vault grants the owner-chosen role and is idempotent', () => {
  const db = setup();
  try {
    setVaultVisibility(db, 'v-open', 1, { visibility: 'public', joinRole: 'viewer' });

    const joined = joinPublicVault(db, 'v-open', 3);
    assert.deepEqual(joined, { vaultId: 'v-open', name: 'Open Research', role: 'viewer', alreadyMember: false });
    assert.equal(getVaultRole(db, 'v-open', 3), 'viewer');
    assert.equal(getVault(db, 'v-open', 3)?.id, 'v-open');
    // Viewer means read-only, exactly like an invited viewer.
    assert.equal(getWritableVault(db, 'v-open', 3), undefined);
    assert.deepEqual(listVaults(db, 3).map((v) => v.id), ['v-open']);

    // Re-joining does not duplicate the membership or change the role.
    db.prepare("UPDATE vault_members SET role = 'editor' WHERE vault_id = 'v-open' AND user_id = 3").run();
    const again = joinPublicVault(db, 'v-open', 3);
    assert.deepEqual(again, { vaultId: 'v-open', name: 'Open Research', role: 'editor', alreadyMember: true });
    assert.equal(listVaultMembers(db, 'v-open').length, 2);

    // The owner "joining" their own vault is a no-op, never a demotion.
    assert.equal(joinPublicVault(db, 'v-open', 1).role, 'owner');
  } finally {
    db.close();
  }
});

test('an editor join role is honoured but a private vault reports not found', () => {
  const db = setup();
  try {
    setVaultVisibility(db, 'v-open', 1, { visibility: 'public', joinRole: 'editor' });
    assert.equal(joinPublicVault(db, 'v-open', 2).role, 'editor');
    assert.equal(getWritableVault(db, 'v-open', 2)?.id, 'v-open');

    // Unpublishing stops new joins; existing members keep their access.
    setVaultVisibility(db, 'v-open', 1, { visibility: 'private' });
    assert.throws(() => joinPublicVault(db, 'v-open', 3), /Vault not found/);
    assert.equal(getVaultRole(db, 'v-open', 2), 'editor');

    // The join role survives the private round trip rather than resetting.
    setVaultVisibility(db, 'v-open', 1, { visibility: 'public' });
    assert.deepEqual(getVaultVisibility(db, 'v-open'), { visibility: 'public', joinRole: 'editor' });

    assert.throws(() => joinPublicVault(db, 'v-secret', 3), /Vault not found/);
    assert.throws(() => joinPublicVault(db, 'missing', 3), /Vault not found/);
  } finally {
    db.close();
  }
});

test('a vault holding a DM source channel cannot be published', () => {
  const db = setup();
  try {
    seedDirectMessage(db, 'v-open');
    assert.throws(
      () => setVaultVisibility(db, 'v-open', 1, { visibility: 'public' }),
      /holds direct messages/,
    );
    assert.equal(getVaultVisibility(db, 'v-open')?.visibility, 'private');
    assert.deepEqual(listPublicVaults(db, { userId: 3 }), []);

    // Unrelated vaults are unaffected, and the join role can still be edited.
    setVaultVisibility(db, 'v-secret', 1, { visibility: 'public' });
    assert.deepEqual(listPublicVaults(db, { userId: 3 }).map((v) => v.id), ['v-secret']);
    assert.equal(setVaultVisibility(db, 'v-open', 1, { joinRole: 'editor' }).visibility, 'private');
  } finally {
    db.close();
  }
});

test('a vault holding only the mirrored side of a DM cannot be published either', () => {
  const db = setup();
  try {
    seedDirectMessage(db, 'v-secret');
    db.prepare("INSERT INTO notes (id, vault_id, title, content) VALUES ('dm-mirror', 'v-bob', 'DM — @alice', 'cascade://chat-channel')").run();
    db.prepare(`
      INSERT INTO chat_channel_links (local_channel_id, local_vault_id, source_channel_id, source_vault_id, created_by)
      VALUES ('dm-mirror', 'v-bob', 'dm-note', 'v-secret', 1)
    `).run();

    assert.throws(
      () => setVaultVisibility(db, 'v-bob', 2, { visibility: 'public' }),
      /holds direct messages/,
    );
    // A plain shared chat is not a DM, so it never blocks publishing.
    db.prepare("INSERT INTO notes (id, vault_id, title, content) VALUES ('shared', 'v-open', 'team', 'cascade://chat-channel')").run();
    db.prepare(`
      INSERT INTO chat_channel_links (local_channel_id, local_vault_id, source_channel_id, source_vault_id, created_by)
      VALUES ('shared', 'v-open', 'shared', 'v-open', 1)
    `).run();
    assert.equal(setVaultVisibility(db, 'v-open', 1, { visibility: 'public' }).visibility, 'public');
  } finally {
    db.close();
  }
});

test('the boot migration is idempotent and repairs out-of-enum values fail-closed', () => {
  const db = setup();
  try {
    setVaultVisibility(db, 'v-open', 1, { visibility: 'public', joinRole: 'editor' });
    db.prepare("UPDATE vaults SET visibility = 'unlisted' WHERE id = 'v-bob'").run();
    db.prepare("UPDATE vaults SET public_join_role = 'owner' WHERE id = 'v-open'").run();

    ensurePublicVaultSchema(db);

    assert.deepEqual(getVaultVisibility(db, 'v-bob'), { visibility: 'private', joinRole: 'viewer' });
    // A bogus join role cannot mint an owner: it degrades to viewer.
    assert.deepEqual(getVaultVisibility(db, 'v-open'), { visibility: 'public', joinRole: 'viewer' });
    assert.equal(joinPublicVault(db, 'v-open', 3).role, 'viewer');
  } finally {
    db.close();
  }
});
