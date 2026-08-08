/**
 * Agents belong to the person who made them, not to a vault.
 *
 * Before this, `vault_agents` was keyed UNIQUE(vault_id, mention) and listing
 * was `WHERE vault_id = ?`, so joining someone else's vault meant arriving with
 * no agents at all and rebuilding the roster by hand in every vault.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ensureChatSchema, listVaultAgents, upsertVaultAgent, deleteVaultAgent } from './chat.js';
import { addVaultMember, ensureVaultMembersSchema } from './vaultMembers.js';
import { ensureCommunityModerationSchema } from './communityModeration.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, folder_id TEXT, title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', content_preview TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0,
      is_listed INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 0, created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO users (id, username) VALUES (1, 'owner'), (2, 'alice')").run();
  db.prepare("INSERT INTO vaults (id, name, created_by) VALUES ('v1', 'Owner vault', 1), ('v2', 'Alice vault', 2)").run();
  ensureVaultMembersSchema(db);
  ensureCommunityModerationSchema(db);
  ensureChatSchema(db);
  return db;
}

test('an invited member brings their own agents into the shared vault', () => {
  const db = setup();
  try {
    // Alice builds her roster in her own vault, then gets invited to v1.
    upsertVaultAgent(db, 2, 'v2', { agentId: 'claude-code', displayName: 'Claude', mention: 'claude' });
    addVaultMember(db, 'v1', 1, 2, 'editor');

    const inV1 = listVaultAgents(db, 2, 'v1').map((a) => a.mention);
    assert.ok(inV1.includes('claude'), `Alice's agent should follow her into v1, got ${JSON.stringify(inV1)}`);
  } finally {
    db.close();
  }
});

test('two people can each hold the same handle without colliding', () => {
  const db = setup();
  try {
    upsertVaultAgent(db, 1, 'v1', { agentId: 'claude-code', displayName: 'Claude', mention: 'claude' });
    // Same handle, different owner, different vault — previously fine, and it
    // must stay fine now that uniqueness is keyed on the owner.
    const alices = upsertVaultAgent(db, 2, 'v2', { agentId: 'claude-code', displayName: 'Claude', mention: 'claude' });
    assert.equal(alices.mention, 'claude');

    // But one person cannot hold the handle twice, even across their vaults.
    addVaultMember(db, 'v1', 1, 2, 'editor');
    assert.throws(
      () => upsertVaultAgent(db, 2, 'v1', { agentId: 'codex', displayName: 'Other', mention: 'claude' }),
      /already used/i,
    );
  } finally {
    db.close();
  }
});

test('a member cannot delete another person agent', () => {
  const db = setup();
  try {
    const owned = upsertVaultAgent(db, 1, 'v1', { agentId: 'codex', displayName: 'Codex', mention: 'codex' });
    addVaultMember(db, 'v1', 1, 2, 'editor');
    assert.throws(() => deleteVaultAgent(db, 2, 'v1', owned.id), /owner/i);
    assert.equal(deleteVaultAgent(db, 1, 'v1', owned.id), true);
  } finally {
    db.close();
  }
});

test('the migration merges one person per-vault copies into a single agent', () => {
  const db = setup();
  try {
    // Rebuild the pre-migration shape: unique per vault, so one owner ended up
    // with a separate @claude row in each vault.
    db.exec(`
      DROP TABLE vault_agents;
      CREATE TABLE vault_agents (
        id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        display_name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '',
        mention TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '',
        context_prompt TEXT NOT NULL DEFAULT '', owner_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(vault_id, mention)
      );
      INSERT INTO vault_agents (id, vault_id, agent_id, display_name, mention, owner_user_id, created_at)
      VALUES ('a1', 'v1', 'claude-code', 'Claude', 'claude', 2, '2020-01-01'),
             ('a2', 'v2', 'claude-code', 'Claude', 'claude', 2, '2020-01-02');
      INSERT INTO notes (id, vault_id, title) VALUES ('c1', 'v1', 'c1'), ('c2', 'v2', 'c2');
      INSERT INTO chat_agent_members (id, channel_id, vault_id, vault_agent_id, agent_id, display_name, mention, conversation_id)
      VALUES ('m1', 'c1', 'v1', 'a1', 'claude-code', 'Claude', 'claude', 'x1'),
             ('m2', 'c2', 'v2', 'a2', 'claude-code', 'Claude', 'claude', 'x2');
    `);
    ensureChatSchema(db);

    const rows = db.prepare('SELECT id, mention FROM vault_agents').all() as Array<{ id: string; mention: string }>;
    assert.equal(rows.length, 1, 'the two copies were always the same agent');
    assert.equal(rows[0].id, 'a1', 'the older row survives');
    assert.equal(rows[0].mention, 'claude', 'and keeps the handle — no @claude-2');

    // Crucially the memberships in *both* vaults survive, now pointing at one agent.
    const members = db.prepare(
      'SELECT channel_id FROM chat_agent_members WHERE vault_agent_id = ? ORDER BY channel_id',
    ).all('a1') as Array<{ channel_id: string }>;
    assert.deepEqual(members.map((m) => m.channel_id), ['c1', 'c2']);

    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vault_agents'").get() as { sql: string }).sql;
    assert.match(sql, /UNIQUE\(owner_user_id, mention\)/);
  } finally {
    db.close();
  }
});
