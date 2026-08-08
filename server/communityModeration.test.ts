import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  banVaultMember,
  createContentReport,
  ensureCommunityModerationSchema,
  isVaultBanned,
  listGlobalReports,
  listVaultBans,
  listVaultReports,
  reviewGlobalReport,
  reviewVaultReport,
  unbanVaultMember,
} from './communityModeration.js';
import { addVaultMember, ensureVaultMembersSchema, getVaultRole } from './vaultMembers.js';
import {
  ensurePublicVaultSchema,
  joinPublicVault,
  reviewPublicVaultJoinRequest,
  setVaultVisibility,
} from './publicVaults.js';
import { ensureDirectMessageSchema } from './directMessages.js';

function setup() {
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
      root_path TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
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
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE chat_channel_links (
      local_channel_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      local_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      source_channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      source_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(local_vault_id, source_channel_id)
    );
  `);
  db.exec(`
    INSERT INTO users (id, username, display_name) VALUES
      (1, 'server', 'Server Owner'), (2, 'alice', 'Alice'),
      (3, 'bob', 'Bob'), (4, 'carol', 'Carol'), (5, 'dave', 'Dave');
    INSERT INTO vaults (id, name, created_by) VALUES
      ('v1', 'Alice Public', 2), ('v2', 'Carol Public', 4), ('source', 'Source', 5);
  `);
  ensureVaultMembersSchema(db);
  ensurePublicVaultSchema(db);
  ensureDirectMessageSchema(db);
  ensureCommunityModerationSchema(db);
  setVaultVisibility(db, 'v1', 2, {
    visibility: 'public', topics: ['community'], joinPolicy: 'open',
  });
  setVaultVisibility(db, 'v2', 4, {
    visibility: 'public', topics: ['linked'], joinPolicy: 'open',
  });
  return db;
}

test('owner-only ban removes membership and pending request atomically, while owners cannot be banned', () => {
  const db = setup();
  try {
    addVaultMember(db, 'v1', 2, 3, 'viewer');
    db.prepare(`INSERT INTO public_vault_join_requests (vault_id, user_id, status) VALUES ('v1', 3, 'pending')`).run();
    assert.throws(() => banVaultMember(db, 'v1', 3, 4), /Only the vault owner/);
    assert.throws(() => banVaultMember(db, 'v1', 2, 2), /owner cannot be banned/);

    const ban = banVaultMember(db, 'v1', 2, 3, 'Repeated harassment');
    assert.equal(ban.username, 'bob');
    assert.equal(isVaultBanned(db, 'v1', 3), true);
    assert.equal(getVaultRole(db, 'v1', 3), null);
    assert.equal((db.prepare(`SELECT status FROM public_vault_join_requests WHERE vault_id = 'v1' AND user_id = 3`).get() as { status: string }).status, 'rejected');
    assert.deepEqual(listVaultBans(db, 'v1', 2).map((row) => row.userId), [3]);

    unbanVaultMember(db, 'v1', 2, 3);
    assert.equal(isVaultBanned(db, 'v1', 3), false);
    assert.equal(getVaultRole(db, 'v1', 3), null, 'unban does not silently restore membership');
  } finally { db.close(); }
});

test('ban blocks open join, join request, approval, by-username add, and stale invite redemption', () => {
  const db = setup();
  try {
    banVaultMember(db, 'v1', 2, 3);
    assert.throws(() => joinPublicVault(db, 'v1', 3), /banned/);

    setVaultVisibility(db, 'v1', 2, { joinPolicy: 'request' });
    assert.throws(() => joinPublicVault(db, 'v1', 3), /banned/);
    assert.throws(() => addVaultMember(db, 'v1', 2, 3, 'editor'), /banned/);

    // Simulate a request or signed invite minted before the ban. Both approval
    // and invite acceptance still pass through a current deny-list check.
    db.prepare(`
      INSERT INTO public_vault_join_requests (vault_id, user_id, status)
      VALUES ('v1', 3, 'pending')
      ON CONFLICT(vault_id, user_id) DO UPDATE SET status = 'pending'
    `).run();
    const request = db.prepare(`SELECT id FROM public_vault_join_requests WHERE vault_id = 'v1' AND user_id = 3`)
      .get() as { id: number };
    assert.throws(() => reviewPublicVaultJoinRequest(db, 'v1', request.id, 2, 'approve'), /banned/);
    assert.throws(() => addVaultMember(db, 'v1', 2, 3, 'viewer'), /banned/);
    assert.equal(getVaultRole(db, 'v1', 3), null);
  } finally { db.close(); }
});

test('reports validate listed notes, members, local messages, and exact linked-channel routes', () => {
  const db = setup();
  try {
    addVaultMember(db, 'v1', 2, 3, 'viewer');
    addVaultMember(db, 'v1', 2, 4, 'editor');
    addVaultMember(db, 'v2', 4, 3, 'viewer');
    db.exec(`
      INSERT INTO notes (id, vault_id, title, content, content_preview, is_listed) VALUES
        ('listed', 'v1', 'Listed note', 'PRIVATE BODY TOKEN', 'private preview', 1),
        ('hidden', 'v1', 'Hidden note', 'hidden', 'hidden', 0),
        ('chat-v1', 'v1', 'general', 'cascade://chat-channel', 'cascade://chat-channel', 1),
        ('chat-source', 'source', 'shared', 'cascade://chat-channel', 'cascade://chat-channel', 1),
        ('chat-local', 'v2', 'shared mirror', 'cascade://chat-channel', 'cascade://chat-channel', 1);
      INSERT INTO chat_messages (id, channel_id, vault_id, author, body) VALUES
        ('local-message', 'chat-v1', 'v1', 'alice', 'LOCAL SECRET BODY'),
        ('linked-message', 'chat-source', 'source', 'dave', 'LINKED SECRET BODY');
      INSERT INTO chat_channel_links (
        local_channel_id, local_vault_id, source_channel_id, source_vault_id, created_by
      ) VALUES ('chat-local', 'v2', 'chat-source', 'source', 4);
    `);

    const noteReport = createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'note', targetId: 'listed', reason: 'spam', detail: 'Please review',
    });
    assert.equal(noteReport.targetId, 'listed');
    assert.doesNotMatch(JSON.stringify(noteReport), /PRIVATE BODY TOKEN|private preview|Listed note/);
    assert.throws(() => createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'note', targetId: 'hidden', reason: 'spam',
    }), /does not belong/);

    assert.equal(createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'message', targetId: 'local-message', reason: 'harassment',
    }).targetId, 'local-message');
    assert.equal(createContentReport(db, {
      vaultId: 'v2', reporterUserId: 3, targetType: 'message', targetId: 'linked-message', reason: 'hate',
    }).targetId, 'linked-message');
    assert.throws(() => createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'message', targetId: 'linked-message', reason: 'hate',
    }), /does not belong/);
    assert.equal(createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'member', targetId: '4', reason: 'other',
    }).targetUsername, 'carol');
    assert.throws(() => createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'member', targetId: '3', reason: 'other',
    }), /report yourself/);
  } finally { db.close(); }
});

test('public vault reports work before joining; duplicates, detail bounds, and flood abuse are rejected', () => {
  const db = setup();
  try {
    const report = createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'vault', targetId: 'v1', reason: 'illegal', detail: 'Context',
    });
    assert.equal(report.targetType, 'vault');
    assert.throws(() => createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'vault', targetId: 'v1', reason: 'illegal',
    }), /already reported/);
    assert.throws(() => createContentReport(db, {
      vaultId: 'v2', reporterUserId: 3, targetType: 'vault', targetId: 'v2', reason: 'other', detail: 'x'.repeat(501),
    }), /500/);
    assert.throws(() => createContentReport(db, {
      vaultId: 'v1', reporterUserId: 2, targetType: 'vault', targetId: 'v1', reason: 'other',
    }), /own vault/);

    db.prepare('DELETE FROM content_reports').run();
    const insert = db.prepare(`
      INSERT INTO content_reports (vault_id, target_type, target_id, reporter_user_id, reason)
      VALUES ('v1', 'note', ?, 3, 'spam')
    `);
    for (let index = 0; index < 10; index += 1) insert.run(`old-${index}`);
    assert.throws(() => createContentReport(db, {
      vaultId: 'v2', reporterUserId: 3, targetType: 'vault', targetId: 'v2', reason: 'spam',
    }), /too many reports/);
  } finally { db.close(); }
});

test('vault queue stays anonymous while global queue is accountable and can unlist', () => {
  const db = setup();
  try {
    addVaultMember(db, 'v1', 2, 3, 'viewer');
    addVaultMember(db, 'v1', 2, 4, 'editor');
    db.prepare(`
      INSERT INTO notes (id, vault_id, title, content, content_preview)
      VALUES ('listed', 'v1', 'Listed', 'body', 'preview')
    `).run();
    const contentReport = createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'note', targetId: 'listed', reason: 'spam', detail: 'Anonymous detail',
    });
    const ownerTargetReport = createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'member', targetId: '2', reason: 'harassment',
    });
    const vaultReport = createContentReport(db, {
      vaultId: 'v1', reporterUserId: 3, targetType: 'vault', targetId: 'v1', reason: 'other',
    });

    const ownerQueue = listVaultReports(db, 'v1', 2);
    assert.deepEqual(ownerQueue.map((row) => row.id), [contentReport.id]);
    assert.equal('reporterUsername' in ownerQueue[0], false);
    assert.throws(() => listVaultReports(db, 'v1', 3), /Only the vault owner/);
    assert.equal(reviewVaultReport(db, 'v1', contentReport.id, 2, 'dismiss').status, 'dismissed');
    assert.throws(() => reviewVaultReport(db, 'v1', ownerTargetReport.id, 2, 'resolve'), /not found/);

    const global = listGlobalReports(db, 1);
    assert.equal(global.find((row) => row.id === vaultReport.id)?.reporterUsername, 'bob');
    assert.throws(() => listGlobalReports(db, 2), /Owner only/);
    const unlisted = reviewGlobalReport(db, vaultReport.id, 1, 'unlist');
    assert.equal(unlisted.unlistedVaultId, 'v1');
    assert.equal((db.prepare(`SELECT visibility FROM vaults WHERE id = 'v1'`).get() as { visibility: string }).visibility, 'private');
    assert.equal(unlisted.report.status, 'resolved');
  } finally { db.close(); }
});

test('schema initialization is idempotent and repairs impossible owner bans and statuses', () => {
  const db = setup();
  try {
    db.prepare(`INSERT INTO vault_bans (vault_id, user_id, banned_by) VALUES ('v1', 2, 2)`).run();
    db.prepare(`
      INSERT INTO content_reports (vault_id, target_type, target_id, reporter_user_id, reason, status)
      VALUES ('v1', 'vault', 'v1', 3, 'other', 'legacy')
    `).run();
    ensureCommunityModerationSchema(db);
    ensureCommunityModerationSchema(db);
    assert.equal(isVaultBanned(db, 'v1', 2), false);
    assert.equal((db.prepare('SELECT status FROM content_reports').get() as { status: string }).status, 'open');
  } finally { db.close(); }
});
