import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  allowsDirectMessages,
  assertDirectMessageSendAllowed,
  blockUser,
  directMessagePermission,
  ensureDirectMessageSchema,
  findDirectMessageVaultId,
  isBlocked,
  listBlockedUsers,
  listDirectMessages,
  openDirectMessage,
  resolveUserByUsername,
  setAllowDirectMessages,
  unblockUser,
  vaultHoldsDirectMessages,
} from './directMessages.js';
import { ensurePublicVaultSchema, setVaultVisibility } from './publicVaults.js';
import { assertChatChannel, ensureChatSchema, isChatChannelNote } from './chat.js';
import { deleteNote, getNote } from './vault.js';
import { ensureVaultMembersSchema } from './vaultMembers.js';

const USERS = [
  { id: 1, username: 'alice' },
  { id: 2, username: 'bob' },
  { id: 3, username: 'carol' },
];

/** Pair rows are the "is this one conversation?" invariant under test. */
function pairCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM direct_message_channels').get() as { n: number }).n;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-dm-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      folder_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      content_preview TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
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
  `);
  const insertUser = db.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)');
  const insertVault = db.prepare('INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)');
  for (const user of USERS) {
    insertUser.run(user.id, user.username, user.username);
    const vaultRoot = path.join(root, user.username);
    fs.mkdirSync(vaultRoot, { recursive: true });
    insertVault.run(`v-${user.username}`, `${user.username} vault`, vaultRoot, user.id);
  }
  ensureVaultMembersSchema(db);
  ensureChatSchema(db);
  ensureDirectMessageSchema(db);

  const created: Array<{ vaultId: string; channelId: string; userId: number }> = [];
  const deps = {
    homeVaultId: (userId: number) => {
      const user = USERS.find((candidate) => candidate.id === userId);
      if (!user) throw new Error(`no vault for user ${userId}`);
      return `v-${user.username}`;
    },
    onChannelCreated: (input: { vaultId: string; channelId: string; title: string; userId: number }) => {
      created.push({ vaultId: input.vaultId, channelId: input.channelId, userId: input.userId });
    },
  };

  return { db, deps, created, cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('usernames resolve case-insensitively and tolerate a leading @', () => {
  const { db, cleanup } = setup();
  try {
    assert.equal(resolveUserByUsername(db, '@Bob').id, 2);
    assert.equal(resolveUserByUsername(db, '  bob ').username, 'bob');
    assert.throws(() => resolveUserByUsername(db, 'nobody'), /User not found/);
    assert.throws(() => resolveUserByUsername(db, ''), /User not found/);
    // A SQL wildcard is not a username pattern.
    assert.throws(() => resolveUserByUsername(db, '%'), /User not found/);
  } finally {
    cleanup();
  }
});

test('opening a DM creates one chat channel per side, linked to the initiator source', () => {
  const { db, deps, created, cleanup } = setup();
  try {
    const result = openDirectMessage(db, 1, '@bob', deps);
    assert.equal(result.created, true);
    assert.equal(result.user.username, 'bob');
    assert.equal(result.vaultId, 'v-alice');
    assert.equal(result.title, 'DM — @bob');

    // Both notes are real chat channels, so every chat feature applies unchanged.
    const source = getNote(db, result.channelId)!;
    assert.equal(isChatChannelNote(source), true);
    assert.equal(created.length, 2);
    const mirror = created.find((entry) => entry.userId === 2)!;
    assert.equal(mirror.vaultId, 'v-bob');
    assert.equal(getNote(db, mirror.channelId)!.title, 'DM — @alice');

    // Bob reaches the same source channel through the existing link table.
    const route = assertChatChannel(db, mirror.channelId, 2).route;
    assert.equal(route.sourceChannelId, result.channelId);
    assert.equal(route.sourceVaultId, 'v-alice');

    // Neither side can reach the other's private local note.
    assert.throws(() => assertChatChannel(db, result.channelId, 2), /not found/);
    assert.throws(() => assertChatChannel(db, mirror.channelId, 1), /not found/);
  } finally {
    cleanup();
  }
});

test('a DM pair is one conversation no matter which side asks again', () => {
  const { db, deps, created, cleanup } = setup();
  try {
    const first = openDirectMessage(db, 1, 'bob', deps);
    created.length = 0;

    const aliceAgain = openDirectMessage(db, 1, 'bob', deps);
    assert.equal(aliceAgain.created, false);
    assert.equal(aliceAgain.channelId, first.channelId);

    // Bob asking for a DM with alice gets his mirror, not a second thread.
    const bobsView = openDirectMessage(db, 2, 'alice', deps);
    assert.equal(bobsView.created, false);
    assert.equal(bobsView.vaultId, 'v-bob');
    assert.notEqual(bobsView.channelId, first.channelId);
    assert.equal(assertChatChannel(db, bobsView.channelId, 2).route.sourceChannelId, first.channelId);
    assert.deepEqual(created, []);

    assert.equal(pairCount(db), 1);
    assert.throws(() => openDirectMessage(db, 1, 'alice', deps), /cannot direct message yourself/);
  } finally {
    cleanup();
  }
});

test('deleting your own copy re-links you to the same conversation', () => {
  const { db, deps, cleanup } = setup();
  try {
    const first = openDirectMessage(db, 1, 'bob', deps);
    const bobsView = openDirectMessage(db, 2, 'alice', deps);

    deleteNote(db, bobsView.channelId);
    assert.deepEqual(listDirectMessages(db, 2), []);

    const rejoined = openDirectMessage(db, 2, 'alice', deps);
    assert.equal(rejoined.created, false);
    assert.equal(rejoined.vaultId, 'v-bob');
    assert.equal(assertChatChannel(db, rejoined.channelId, 2).route.sourceChannelId, first.channelId);
    // Still one pair row, so no forked history.
    assert.equal(pairCount(db), 1);
  } finally {
    cleanup();
  }
});

test('the DM privacy toggle defaults open and refuses new conversations when off', () => {
  const { db, deps, cleanup } = setup();
  try {
    assert.equal(allowsDirectMessages(db, 2), true);

    setAllowDirectMessages(db, 2, false);
    assert.equal(allowsDirectMessages(db, 2), false);
    assert.throws(() => openDirectMessage(db, 1, 'bob', deps), /not accepting direct messages/);
    // Nothing was persisted for the refused attempt.
    assert.equal(pairCount(db), 0);
    assert.deepEqual(listDirectMessages(db, 1), []);

    // The toggle is one-directional: bob can still reach out himself.
    const opened = openDirectMessage(db, 2, 'alice', deps);
    assert.equal(opened.created, true);

    setAllowDirectMessages(db, 2, true);
    assert.equal(allowsDirectMessages(db, 2), true);
    assert.equal(openDirectMessage(db, 1, 'bob', deps).created, false);
  } finally {
    cleanup();
  }
});

test('blocking stops DM creation in both directions and unblocking restores it', () => {
  const { db, deps, cleanup } = setup();
  try {
    const blocked = blockUser(db, 2, 1);
    assert.equal(blocked.username, 'alice');
    assert.equal(isBlocked(db, 2, 1), true);
    assert.equal(isBlocked(db, 1, 2), false);
    assert.deepEqual(listBlockedUsers(db, 2).map((entry) => entry.username), ['alice']);
    assert.deepEqual(listBlockedUsers(db, 1), []);

    // The blocked party is told nothing that distinguishes a block from a
    // privacy toggle; the blocker gets an actionable message.
    assert.throws(() => openDirectMessage(db, 1, 'bob', deps), /not accepting direct messages/);
    assert.throws(() => openDirectMessage(db, 2, 'alice', deps), /Unblock @alice/);
    assert.equal(pairCount(db), 0);

    // Blocking is idempotent, self-blocking is refused, unknown users 404.
    assert.equal(blockUser(db, 2, 1).username, 'alice');
    assert.equal(listBlockedUsers(db, 2).length, 1);
    assert.throws(() => blockUser(db, 2, 2), /cannot block yourself/);
    assert.throws(() => blockUser(db, 2, 99), /User not found/);

    unblockUser(db, 2, 1);
    assert.equal(isBlocked(db, 2, 1), false);
    assert.equal(openDirectMessage(db, 1, 'bob', deps).created, true);
    // Unblocking a user who was never blocked is a no-op.
    unblockUser(db, 2, 3);
  } finally {
    cleanup();
  }
});

test('a block applies to an existing conversation, not just the first open', () => {
  const { db, deps, cleanup } = setup();
  try {
    openDirectMessage(db, 1, 'bob', deps);
    blockUser(db, 2, 1);
    assert.throws(() => openDirectMessage(db, 1, 'bob', deps), /not accepting direct messages/);
    assert.throws(() => openDirectMessage(db, 2, 'alice', deps), /Unblock @alice/);
  } finally {
    cleanup();
  }
});

test('blocking either participant stops new messages in an existing DM', () => {
  const { db, deps, cleanup } = setup();
  try {
    const opened = openDirectMessage(db, 1, 'bob', deps);
    assert.doesNotThrow(() => assertDirectMessageSendAllowed(db, opened.channelId, 1));
    blockUser(db, 2, 1);
    assert.throws(() => assertDirectMessageSendAllowed(db, opened.channelId, 1), /unavailable/);
    assert.throws(() => assertDirectMessageSendAllowed(db, opened.channelId, 2), /unavailable/);
  } finally {
    cleanup();
  }
});

test('directMessagePermission reports the same refusal for a block and a closed inbox', () => {
  const { db, cleanup } = setup();
  try {
    const bob = resolveUserByUsername(db, 'bob');
    assert.deepEqual(directMessagePermission(db, 1, bob), { allowed: true });

    blockUser(db, 2, 1);
    const blockedReason = directMessagePermission(db, 1, bob);
    unblockUser(db, 2, 1);
    setAllowDirectMessages(db, 2, false);
    const closedReason = directMessagePermission(db, 1, bob);

    assert.equal(blockedReason.allowed, false);
    assert.equal(closedReason.allowed, false);
    assert.deepEqual(blockedReason, closedReason);
  } finally {
    cleanup();
  }
});

test('DM channels never land in a public or shared vault', () => {
  const { db, cleanup } = setup();
  try {
    ensurePublicVaultSchema(db);
    db.prepare("INSERT INTO vaults (id, name, root_path, created_by) VALUES ('v-alice-2', 'Second', '', 1)").run();
    db.prepare("INSERT INTO vault_members (vault_id, user_id, role) VALUES ('v-alice-2', 1, 'owner')").run();

    // Oldest private solo vault wins.
    assert.equal(findDirectMessageVaultId(db, 1), 'v-alice');

    // Publishing it takes it out of the running.
    setVaultVisibility(db, 'v-alice', 1, { visibility: 'public' });
    assert.equal(findDirectMessageVaultId(db, 1), 'v-alice-2');

    // So does inviting anyone into it.
    db.prepare("INSERT INTO vault_members (vault_id, user_id, role) VALUES ('v-alice-2', 2, 'editor')").run();
    assert.equal(findDirectMessageVaultId(db, 1), null);

    // A vault someone else owns is never a candidate, whatever the role.
    assert.equal(findDirectMessageVaultId(db, 3), 'v-carol');
  } finally {
    cleanup();
  }
});

test('vaultHoldsDirectMessages sees both the source vault and the mirror vault', () => {
  const { db, deps, cleanup } = setup();
  try {
    assert.equal(vaultHoldsDirectMessages(db, 'v-alice'), false);
    openDirectMessage(db, 1, 'bob', deps);
    assert.equal(vaultHoldsDirectMessages(db, 'v-alice'), true);
    assert.equal(vaultHoldsDirectMessages(db, 'v-bob'), true);
    assert.equal(vaultHoldsDirectMessages(db, 'v-carol'), false);
  } finally {
    cleanup();
  }
});

test('the conversation list is per-user and shows each side its own channel', () => {
  const { db, deps, cleanup } = setup();
  try {
    const withBob = openDirectMessage(db, 1, 'bob', deps);
    const withCarol = openDirectMessage(db, 1, 'carol', deps);

    const alices = listDirectMessages(db, 1);
    assert.deepEqual(alices.map((entry) => entry.user.username).sort(), ['bob', 'carol']);
    assert.equal(alices.every((entry) => entry.vaultId === 'v-alice'), true);
    assert.equal(alices.find((entry) => entry.user.username === 'bob')!.channelId, withBob.channelId);

    const bobs = listDirectMessages(db, 2);
    assert.equal(bobs.length, 1);
    assert.equal(bobs[0].user.username, 'alice');
    assert.equal(bobs[0].vaultId, 'v-bob');
    assert.notEqual(bobs[0].channelId, withBob.channelId);

    assert.equal(listDirectMessages(db, 3)[0].user.username, 'alice');
    assert.notEqual(withBob.channelId, withCarol.channelId);
  } finally {
    cleanup();
  }
});
