import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  ensurePublicVaultSchema,
  getPublicVaultDetail,
  getVaultVisibility,
  joinPublicVault,
  listPublicHomeNoteChoices,
  listPublicVaultJoinRequests,
  listPublicVaults,
  normalizePublicTopics,
  reviewPublicVaultJoinRequest,
  setVaultVisibility,
} from './publicVaults.js';
import { ensureVaultMembersSchema, getVaultRole } from './vaultMembers.js';
import { ensureDirectMessageSchema } from './directMessages.js';
import { ensureChatSchema } from './chat.js';
import { getWritableVault } from './vault.js';

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
      content_preview TEXT NOT NULL DEFAULT '',
      is_listed INTEGER NOT NULL DEFAULT 1,
      is_archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`
    INSERT INTO users (id, username, display_name)
    VALUES (1, 'alice', 'Alice'), (2, 'bob', 'Bob'), (3, 'carol', 'Carol')
  `).run();
  db.prepare(`
    INSERT INTO vaults (id, name, created_by, created_at) VALUES
      ('v-open', 'Open Research', 1, '2026-08-01 00:00:00'),
      ('v-secret', 'Alice Private', 1, '2026-08-02 00:00:00'),
      ('v-bob', 'Bob Notes', 2, '2026-08-03 00:00:00')
  `).run();
  ensureVaultMembersSchema(db);
  ensureChatSchema(db);
  ensureDirectMessageSchema(db);
  ensurePublicVaultSchema(db);
  return db;
}

function publish(db: Database.Database, vaultId: string, ownerId: number, overrides: Record<string, unknown> = {}) {
  return setVaultVisibility(db, vaultId, ownerId, {
    visibility: 'public',
    summary: 'A practical place for shared research.',
    topics: ['Research', '  Open   Data  '],
    guidelines: 'Be kind and cite sources.',
    joinPolicy: 'open',
    ...overrides,
  });
}

function seedDirectMessage(db: Database.Database, vaultId: string): void {
  db.prepare("INSERT INTO notes (id, vault_id, title, content) VALUES ('dm-note', ?, 'DM — @bob', 'cascade://chat-channel')")
    .run(vaultId);
  db.prepare(`
    INSERT INTO direct_message_channels (user_a_id, user_b_id, source_vault_id, source_channel_id, created_by)
    VALUES (1, 2, ?, 'dm-note', 1)
  `).run(vaultId);
}

test('migration is additive, idempotent, and defaults existing vaults to private', () => {
  const db = setup();
  try {
    assert.deepEqual(getVaultVisibility(db, 'v-open'), {
      visibility: 'private', summary: '', topics: [], guidelines: '', homeNoteId: null, joinPolicy: 'open',
    });
    assert.deepEqual(listPublicVaults(db, { userId: 3 }), []);
    ensurePublicVaultSchema(db);
    assert.equal(getVaultVisibility(db, 'missing'), null);
  } finally { db.close(); }
});

test('owner settings validate bounds, normalize 1-5 topics, and reject arbitrary home notes', () => {
  const db = setup();
  try {
    db.prepare(`
      INSERT INTO notes (id, vault_id, title, content, content_preview, updated_at) VALUES
        ('welcome', 'v-open', 'Welcome', 'Hello', 'Hello collaborators', '2026-08-07 12:00:00'),
        ('chat', 'v-open', 'General', 'cascade://chat-channel', 'cascade://chat-channel', '2026-08-08 12:00:00'),
        ('unlisted', 'v-open', 'Hidden', 'Secret', 'Secret', '2026-08-09 12:00:00')
    `).run();
    db.prepare("UPDATE notes SET is_listed = 0 WHERE id = 'unlisted'").run();
    assert.throws(() => publish(db, 'v-open', 2), /Only the vault owner/);
    assert.throws(() => setVaultVisibility(db, 'v-open', 1, { visibility: 'public', topics: [] }), /at least 1 topic/);
    assert.throws(() => setVaultVisibility(db, 'v-open', 1, { summary: 'x'.repeat(241) }), /240/);
    assert.throws(() => setVaultVisibility(db, 'v-open', 1, { guidelines: 'x'.repeat(2001) }), /2000/);
    assert.throws(() => publish(db, 'v-open', 1, { homeNoteId: 'chat' }), /listed non-chat/);
    assert.throws(() => publish(db, 'v-open', 1, { homeNoteId: 'unlisted' }), /listed non-chat/);
    assert.deepEqual(listPublicHomeNoteChoices(db, 'v-open', 1), [{ id: 'welcome', title: 'Welcome' }]);
    assert.throws(() => listPublicHomeNoteChoices(db, 'v-open', 2), /Only the vault owner/);

    const settings = publish(db, 'v-open', 1, { topics: [' Research ', 'OPEN   DATA', 'research'], homeNoteId: 'welcome' });
    assert.deepEqual(settings.topics, ['research', 'open data']);
    assert.equal(settings.homeNoteId, 'welcome');
    assert.deepEqual(normalizePublicTopics([' ＡＩ ', 'ai']), ['ai']);
  } finally { db.close(); }
});

test('directory searches purpose and topics and ranks meaningful note activity without member scoring', () => {
  const db = setup();
  try {
    publish(db, 'v-open', 1, { summary: 'Climate evidence library', topics: ['climate', 'science'] });
    publish(db, 'v-bob', 2, { summary: 'Design practice', topics: ['design systems'] });
    db.prepare(`
      INSERT INTO notes (id, vault_id, title, content, content_preview, is_listed, updated_at) VALUES
        ('old-real', 'v-open', 'Evidence', 'Public note', 'Public note', 1, '2026-08-04 12:00:00'),
        ('new-chat', 'v-open', 'Chat', 'cascade://chat-channel', 'cascade://chat-channel', 1, '2026-08-09 12:00:00'),
        ('new-hidden', 'v-open', 'Hidden', 'Private draft', 'Private draft', 0, '2026-08-10 12:00:00'),
        ('new-real', 'v-bob', 'Patterns', 'Public patterns', 'Public patterns', 1, '2026-08-08 12:00:00')
    `).run();
    // Extra membership must not outrank newer work.
    db.prepare("INSERT INTO vault_members (vault_id, user_id, role) VALUES ('v-open', 3, 'viewer')").run();
    assert.deepEqual(listPublicVaults(db, { userId: 3 }).map((v) => v.id), ['v-bob', 'v-open']);
    assert.equal(listPublicVaults(db, { userId: 3 })[1].lastActivity, '2026-08-04 12:00:00');
    assert.deepEqual(listPublicVaults(db, { userId: 3, query: 'climate' }).map((v) => v.id), ['v-open']);
    assert.deepEqual(listPublicVaults(db, { userId: 3, query: 'evidence' }).map((v) => v.id), ['v-open']);
    assert.deepEqual(listPublicVaults(db, { userId: 3, query: 'bob' }).map((v) => v.id), ['v-bob']);
    assert.deepEqual(listPublicVaults(db, { userId: 3, query: '%' }), []);
    const row = listPublicVaults(db, { userId: 3 })[0] as unknown as Record<string, unknown>;
    assert.equal(row.root_path, undefined);
    assert.equal(row.content, undefined);
  } finally { db.close(); }
});

test('detail exposes only the owner-selected listed non-chat preview and sanitizes secrets and paths', () => {
  const db = setup();
  try {
    db.prepare(`
      INSERT INTO notes (id, vault_id, title, content, content_preview, updated_at)
      VALUES ('home', 'v-open', 'Start here', 'full arbitrary body',
        'Welcome /home/alice/private.txt :::private API_KEY=secret', '2026-08-07 12:00:00')
    `).run();
    publish(db, 'v-open', 1, { homeNoteId: 'home' });
    const detail = getPublicVaultDetail(db, 'v-open', 3)!;
    assert.equal(detail.guidelines, 'Be kind and cite sources.');
    assert.deepEqual(detail.homeNote, {
      title: 'Start here',
      preview: 'Welcome [path omitted] [Private block hidden from agents]',
      updatedAt: '2026-08-07 12:00:00',
    });
    const serialized = JSON.stringify(detail);
    assert.doesNotMatch(serialized, /root_path|file_path|full arbitrary body|API_KEY|private\.txt/);

    db.prepare("UPDATE notes SET is_listed = 0 WHERE id = 'home'").run();
    assert.equal(getPublicVaultDetail(db, 'v-open', 3)?.homeNote, null);
    assert.equal(getPublicVaultDetail(db, 'v-secret', 3), null);
  } finally { db.close(); }
});

test('open public joins are always viewer-only, including upgraded legacy editor settings', () => {
  const db = setup();
  try {
    publish(db, 'v-open', 1);
    db.prepare("UPDATE vaults SET public_join_role = 'editor'").run();
    ensurePublicVaultSchema(db);
    const joined = joinPublicVault(db, 'v-open', 3);
    assert.deepEqual(joined, {
      vaultId: 'v-open', name: 'Open Research', role: 'viewer', alreadyMember: false, requestStatus: null,
    });
    assert.equal(getVaultRole(db, 'v-open', 3), 'viewer');
    assert.equal(getWritableVault(db, 'v-open', 3), undefined);
    assert.equal(joinPublicVault(db, 'v-open', 3).alreadyMember, true);
    assert.equal(joinPublicVault(db, 'v-open', 1).role, 'owner');
  } finally { db.close(); }
});

test('request policy creates an owner-reviewable request and approval grants viewer, never editor', () => {
  const db = setup();
  try {
    publish(db, 'v-open', 1, { joinPolicy: 'request' });
    const requested = joinPublicVault(db, 'v-open', 3);
    assert.equal(requested.role, null);
    assert.equal(requested.requestStatus, 'pending');
    assert.equal(getVaultRole(db, 'v-open', 3), null);
    assert.equal(listPublicVaults(db, { userId: 3 })[0].requestStatus, 'pending');
    assert.throws(() => listPublicVaultJoinRequests(db, 'v-open', 2), /Only the vault owner/);

    const requests = listPublicVaultJoinRequests(db, 'v-open', 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].username, 'carol');
    const reviewed = reviewPublicVaultJoinRequest(db, 'v-open', requests[0].id, 1, 'approve');
    assert.equal(reviewed.role, 'viewer');
    assert.equal(getVaultRole(db, 'v-open', 3), 'viewer');
    assert.deepEqual(listPublicVaultJoinRequests(db, 'v-open', 1), []);
    assert.throws(() => reviewPublicVaultJoinRequest(db, 'v-open', requests[0].id, 1, 'approve'), /not found/);

    // Editors still require the owner's explicit member-management action.
    db.prepare("UPDATE vault_members SET role = 'editor' WHERE vault_id = 'v-open' AND user_id = 3").run();
    assert.equal(getVaultRole(db, 'v-open', 3), 'editor');
  } finally { db.close(); }
});

test('rejected requests can be resubmitted, while invite policy has no self-join', () => {
  const db = setup();
  try {
    publish(db, 'v-open', 1, { joinPolicy: 'request' });
    joinPublicVault(db, 'v-open', 3);
    const request = listPublicVaultJoinRequests(db, 'v-open', 1)[0];
    reviewPublicVaultJoinRequest(db, 'v-open', request.id, 1, 'reject');
    assert.equal(joinPublicVault(db, 'v-open', 3).requestStatus, 'pending');

    setVaultVisibility(db, 'v-open', 1, { joinPolicy: 'invite' });
    assert.deepEqual(listPublicVaultJoinRequests(db, 'v-open', 1), []);
    assert.throws(() => joinPublicVault(db, 'v-open', 2), /invite only/);
  } finally { db.close(); }
});

test('publishing a vault that holds direct messages remains forbidden', () => {
  const db = setup();
  try {
    seedDirectMessage(db, 'v-open');
    assert.throws(() => publish(db, 'v-open', 1), /holds direct messages/);
    assert.equal(getVaultVisibility(db, 'v-open')?.visibility, 'private');
  } finally { db.close(); }
});

test('invalid persisted enums and topics repair fail-closed without unpublishing existing public vaults', () => {
  const db = setup();
  try {
    publish(db, 'v-open', 1);
    db.prepare("UPDATE vaults SET public_join_policy = 'editor', public_join_role = 'editor', public_topics = 'not-json'").run();
    ensurePublicVaultSchema(db);
    assert.deepEqual(getVaultVisibility(db, 'v-open'), {
      visibility: 'public', summary: 'A practical place for shared research.', topics: [],
      guidelines: 'Be kind and cite sources.', homeNoteId: null, joinPolicy: 'invite',
    });
    // Repair preserves discoverability but removes self-join authority.
    assert.equal(listPublicVaults(db, { userId: 3 }).length, 1);
    assert.throws(() => joinPublicVault(db, 'v-open', 3), /invite only/);
  } finally { db.close(); }
});
