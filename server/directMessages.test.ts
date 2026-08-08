import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  allowsDirectMessages,
  assertChannelPushAllowed,
  assertDirectMessageSendAllowed,
  assertShareableChatChannel,
  blockUser,
  directMessagePermission,
  DIRECT_MESSAGE_VAULT_NAME,
  ensureDirectMessageSchema,
  ensureDirectMessageVaultId,
  getDirectMessageVaultId,
  isBlocked,
  isDirectMessageChannel,
  isDirectMessageVault,
  listBlockedUsers,
  listDirectMessages,
  openDirectMessage,
  resolveUserByUsername,
  setAllowDirectMessages,
  unblockUser,
  UNREACHABLE_USER_MESSAGE,
  vaultHoldsDirectMessages,
} from './directMessages.js';
import { ensurePublicVaultSchema, setVaultVisibility } from './publicVaults.js';
import { assertChatChannel, CHAT_NOTE_MARKER, ensureChatSchema, isChatChannelNote } from './chat.js';
import { createNote, deleteNote, getNote } from './vault.js';
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

/** The message a refused call produced — the thing that must not vary. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail('expected the call to be refused');
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
  // Stands in for the real `createVault`: a brand-new vault owned solely by
  // the caller. The module decides *which* vault a DM uses; deps only make one.
  let vaultSeq = 0;
  const deps = {
    createVault: (userId: number, name: string) => {
      const id = `v-new-${++vaultSeq}`;
      const vaultRoot = path.join(root, id);
      fs.mkdirSync(vaultRoot, { recursive: true });
      insertVault.run(id, name, vaultRoot, userId);
      db.prepare("INSERT INTO vault_members (vault_id, user_id, role) VALUES (?, ?, 'owner')").run(id, userId);
      return id;
    },
    onChannelCreated: (input: { vaultId: string; channelId: string; title: string; userId: number }) => {
      created.push({ vaultId: input.vaultId, channelId: input.channelId, userId: input.userId });
    },
  };

  /** The DM vault the module picked for this account; fails loudly if none. */
  const dmVault = (userId: number): string => {
    const vaultId = getDirectMessageVaultId(db, userId);
    assert.ok(vaultId, `expected a DM vault for user ${userId}`);
    return vaultId;
  };

  return { db, deps, created, dmVault, cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** The notebook vault each user starts with, which DMs must never land in. */
function notebookVault(username: string): string {
  return `v-${username}`;
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
  const { db, deps, created, dmVault, cleanup } = setup();
  try {
    const result = openDirectMessage(db, 1, '@bob', deps);
    assert.equal(result.created, true);
    assert.equal(result.user.username, 'bob');
    assert.equal(result.vaultId, dmVault(1));
    assert.equal(result.title, 'DM — @bob');

    // Both notes are real chat channels, so every chat feature applies unchanged.
    const source = getNote(db, result.channelId)!;
    assert.equal(isChatChannelNote(source), true);
    assert.equal(created.length, 2);
    const mirror = created.find((entry) => entry.userId === 2)!;
    assert.equal(mirror.vaultId, dmVault(2));
    assert.equal(getNote(db, mirror.channelId)!.title, 'DM — @alice');

    // Bob reaches the same source channel through the existing link table.
    const route = assertChatChannel(db, mirror.channelId, 2).route;
    assert.equal(route.sourceChannelId, result.channelId);
    assert.equal(route.sourceVaultId, dmVault(1));

    // Neither side can reach the other's private local note.
    assert.throws(() => assertChatChannel(db, result.channelId, 2), /not found/);
    assert.throws(() => assertChatChannel(db, mirror.channelId, 1), /not found/);
  } finally {
    cleanup();
  }
});

test('a DM pair is one conversation no matter which side asks again', () => {
  const { db, deps, created, dmVault, cleanup } = setup();
  try {
    const first = openDirectMessage(db, 1, 'bob', deps);
    created.length = 0;

    const aliceAgain = openDirectMessage(db, 1, 'bob', deps);
    assert.equal(aliceAgain.created, false);
    assert.equal(aliceAgain.channelId, first.channelId);

    // Bob asking for a DM with alice gets his mirror, not a second thread.
    const bobsView = openDirectMessage(db, 2, 'alice', deps);
    assert.equal(bobsView.created, false);
    assert.equal(bobsView.vaultId, dmVault(2));
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
  const { db, deps, dmVault, cleanup } = setup();
  try {
    const first = openDirectMessage(db, 1, 'bob', deps);
    const bobsView = openDirectMessage(db, 2, 'alice', deps);

    deleteNote(db, bobsView.channelId);
    assert.deepEqual(listDirectMessages(db, 2), []);

    const rejoined = openDirectMessage(db, 2, 'alice', deps);
    assert.equal(rejoined.created, false);
    assert.equal(rejoined.vaultId, dmVault(2));
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

test('DM channels land in a dedicated vault, never in an existing notebook', () => {
  const { db, deps, dmVault, cleanup } = setup();
  try {
    const opened = openDirectMessage(db, 1, 'bob', deps);

    // Both sides got a purpose-made vault, not the notebook they already own.
    for (const userId of [1, 2]) {
      const vaultId = dmVault(userId);
      assert.notEqual(vaultId, notebookVault(USERS[userId - 1].username));
      const vault = db.prepare('SELECT name, created_by FROM vaults WHERE id = ?')
        .get(vaultId) as { name: string; created_by: number };
      assert.equal(vault.name, DIRECT_MESSAGE_VAULT_NAME);
      assert.equal(vault.created_by, userId);
      assert.equal(isDirectMessageVault(db, vaultId), true);
    }
    assert.equal(opened.vaultId, dmVault(1));
    assert.equal(isDirectMessageVault(db, notebookVault('alice')), false);

    // The notebook stays free of DM notes.
    const notebookNotes = db.prepare('SELECT COUNT(*) AS n FROM notes WHERE vault_id = ?')
      .get(notebookVault('alice')) as { n: number };
    assert.equal(notebookNotes.n, 0);

    // The mapping is durable: a second conversation reuses the same vault.
    const withCarol = openDirectMessage(db, 1, 'carol', deps);
    assert.equal(withCarol.vaultId, dmVault(1));
  } finally {
    cleanup();
  }
});

test('a DM vault that has been shared or published is replaced, not reused', () => {
  const { db, deps, dmVault, cleanup } = setup();
  try {
    ensurePublicVaultSchema(db);
    openDirectMessage(db, 1, 'bob', deps);
    const original = dmVault(1);

    // Someone was let into the DM vault out of band: future DMs must not follow.
    db.prepare("INSERT INTO vault_members (vault_id, user_id, role) VALUES (?, 3, 'editor')").run(original);
    const afterShare = ensureDirectMessageVaultId(db, 1, deps);
    assert.notEqual(afterShare, original);
    assert.equal(getDirectMessageVaultId(db, 1), afterShare);

    // Same for a vault that was made public behind the mapping's back.
    db.prepare("UPDATE vaults SET visibility = 'public' WHERE id = ?").run(afterShare);
    const afterPublish = ensureDirectMessageVaultId(db, 1, deps);
    assert.notEqual(afterPublish, afterShare);

    // The original conversation is untouched and still reachable.
    const conversations = listDirectMessages(db, 1);
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].vaultId, original);
  } finally {
    cleanup();
  }
});

test('an existing DM-only vault is adopted on migration, a mixed notebook is not', () => {
  const { db, deps, cleanup } = setup();
  try {
    // Simulate the pre-migration world: DMs living in the users' notebooks.
    openDirectMessage(db, 1, 'bob', deps);
    const aliceDm = getDirectMessageVaultId(db, 1)!;
    const bobDm = getDirectMessageVaultId(db, 2)!;
    db.prepare('UPDATE notes SET vault_id = ? WHERE vault_id = ?').run(notebookVault('alice'), aliceDm);
    db.prepare('UPDATE notes SET vault_id = ? WHERE vault_id = ?').run(notebookVault('bob'), bobDm);
    db.prepare('UPDATE direct_message_channels SET source_vault_id = ?').run(notebookVault('alice'));
    db.prepare('UPDATE chat_channel_links SET local_vault_id = ? WHERE local_vault_id = ?')
      .run(notebookVault('bob'), bobDm);
    db.prepare('DELETE FROM user_dm_vaults').run();

    // Alice's notebook also holds an ordinary note; bob's holds only the DM.
    db.prepare(`
      INSERT INTO notes (id, vault_id, title, content, created_by)
      VALUES ('n-plan', ?, 'Plan', 'not a chat', 1)
    `).run(notebookVault('alice'));

    ensureDirectMessageSchema(db);

    // Bob's DM-only vault is adopted; alice's mixed notebook is left alone.
    assert.equal(getDirectMessageVaultId(db, 2), notebookVault('bob'));
    assert.equal(getDirectMessageVaultId(db, 1), null);

    // Both sides still see the conversation they already had.
    assert.equal(listDirectMessages(db, 1)[0].vaultId, notebookVault('alice'));
    assert.equal(listDirectMessages(db, 2)[0].vaultId, notebookVault('bob'));

    // Alice's next DM moves to a dedicated vault; the old one stays put.
    const withCarol = openDirectMessage(db, 1, 'carol', deps);
    assert.notEqual(withCarol.vaultId, notebookVault('alice'));
    assert.equal(listDirectMessages(db, 1).find((c) => c.user.username === 'bob')!.vaultId, notebookVault('alice'));
  } finally {
    cleanup();
  }
});

test('vaultHoldsDirectMessages sees the source vault, the mirror vault, and an empty DM vault', () => {
  const { db, deps, dmVault, cleanup } = setup();
  try {
    assert.equal(vaultHoldsDirectMessages(db, notebookVault('alice')), false);
    openDirectMessage(db, 1, 'bob', deps);
    assert.equal(vaultHoldsDirectMessages(db, dmVault(1)), true);
    assert.equal(vaultHoldsDirectMessages(db, dmVault(2)), true);
    assert.equal(vaultHoldsDirectMessages(db, notebookVault('alice')), false);
    assert.equal(vaultHoldsDirectMessages(db, notebookVault('carol')), false);

    // A registered DM vault is off limits even before it holds a channel.
    const carolVault = ensureDirectMessageVaultId(db, 3, deps);
    assert.equal(vaultHoldsDirectMessages(db, carolVault), true);
  } finally {
    cleanup();
  }
});

test('DM channels are never shareable, on either side of the pair', () => {
  const { db, deps, created, cleanup } = setup();
  try {
    const opened = openDirectMessage(db, 1, 'bob', deps);
    const mirror = created.find((entry) => entry.userId === 2)!;

    assert.equal(isDirectMessageChannel(db, opened.channelId), true);
    assert.equal(isDirectMessageChannel(db, mirror.channelId), true);
    assert.throws(() => assertShareableChatChannel(db, opened.channelId), /cannot be shared/);
    // The mirror matters too: bob owns it, so he could otherwise mint a link.
    assert.throws(() => assertShareableChatChannel(db, mirror.channelId), /cannot be shared/);

    // An ordinary chat channel is unaffected.
    const ordinary = createNote(db, notebookVault('alice'), 1, {
      title: 'standup',
      content: `${CHAT_NOTE_MARKER}\n`,
    });
    assert.equal(isDirectMessageChannel(db, ordinary.id), false);
    assert.doesNotThrow(() => assertShareableChatChannel(db, ordinary.id));
  } finally {
    cleanup();
  }
});

test('a block stops a channel being pushed into the other account by username', () => {
  const { db, cleanup } = setup();
  try {
    assert.doesNotThrow(() => assertChannelPushAllowed(db, 1, 2));

    // Either direction of the block stops the push, with the same refusal a
    // nonexistent username gets, so the route cannot enumerate accounts.
    blockUser(db, 2, 1);
    assert.throws(() => assertChannelPushAllowed(db, 1, 2), new RegExp(UNREACHABLE_USER_MESSAGE));
    assert.throws(() => assertChannelPushAllowed(db, 2, 1), new RegExp(UNREACHABLE_USER_MESSAGE));

    unblockUser(db, 2, 1);
    blockUser(db, 1, 2);
    assert.throws(() => assertChannelPushAllowed(db, 1, 2), new RegExp(UNREACHABLE_USER_MESSAGE));

    // A third party is untouched: blocks are not global visibility.
    assert.doesNotThrow(() => assertChannelPushAllowed(db, 1, 3));
    assert.doesNotThrow(() => assertChannelPushAllowed(db, 2, 3));
  } finally {
    cleanup();
  }
});

test('an unknown username is refused exactly like an unreachable one', () => {
  const { db, deps, cleanup } = setup();
  try {
    setAllowDirectMessages(db, 2, false);
    // A closed inbox, an account that does not exist, and a malformed handle
    // are indistinguishable to the caller.
    assert.equal(refusal(() => openDirectMessage(db, 1, 'bob', deps)), UNREACHABLE_USER_MESSAGE);
    assert.equal(refusal(() => openDirectMessage(db, 1, 'nobody', deps)), UNREACHABLE_USER_MESSAGE);
    assert.equal(refusal(() => openDirectMessage(db, 1, '%', deps)), UNREACHABLE_USER_MESSAGE);

    // A block by the target reads the same as all three.
    setAllowDirectMessages(db, 2, true);
    blockUser(db, 2, 1);
    assert.equal(refusal(() => openDirectMessage(db, 1, 'bob', deps)), UNREACHABLE_USER_MESSAGE);

    // Nothing was created for any of the refused attempts.
    assert.equal(pairCount(db), 0);
    assert.equal(getDirectMessageVaultId(db, 1), null);
  } finally {
    cleanup();
  }
});

test('the conversation list is per-user and shows each side its own channel', () => {
  const { db, deps, dmVault, cleanup } = setup();
  try {
    const withBob = openDirectMessage(db, 1, 'bob', deps);
    const withCarol = openDirectMessage(db, 1, 'carol', deps);

    const alices = listDirectMessages(db, 1);
    assert.deepEqual(alices.map((entry) => entry.user.username).sort(), ['bob', 'carol']);
    assert.equal(alices.every((entry) => entry.vaultId === dmVault(1)), true);
    assert.equal(alices.find((entry) => entry.user.username === 'bob')!.channelId, withBob.channelId);

    const bobs = listDirectMessages(db, 2);
    assert.equal(bobs.length, 1);
    assert.equal(bobs[0].user.username, 'alice');
    assert.equal(bobs[0].vaultId, dmVault(2));
    assert.notEqual(bobs[0].channelId, withBob.channelId);

    assert.equal(listDirectMessages(db, 3)[0].user.username, 'alice');
    assert.notEqual(withBob.channelId, withCarol.channelId);
  } finally {
    cleanup();
  }
});
