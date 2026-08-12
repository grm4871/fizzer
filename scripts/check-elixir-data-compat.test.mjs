import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { databaseSnapshot, runComparison } from './check-elixir-data-compat.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-data-compat-'));
  const before = path.join(directory, 'before.db');
  const after = path.join(directory, 'after.db');
  const beforeRoot = path.join(directory, 'before-vaults');
  const afterRoot = path.join(directory, 'after-vaults');
  fs.mkdirSync(beforeRoot);
  fs.mkdirSync(afterRoot);
  const db = new Database(before);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE);
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL
    );
    CREATE INDEX notes_user_idx ON notes(user_id);
    CREATE TRIGGER notes_nonempty BEFORE INSERT ON notes
    WHEN NEW.body = '' BEGIN SELECT RAISE(ABORT, 'empty'); END;
    INSERT INTO users VALUES (1, 'sol');
    INSERT INTO notes VALUES ('note-1', 1, 'hello');
  `);
  db.close();
  fs.copyFileSync(before, after);
  fs.writeFileSync(path.join(beforeRoot, 'General.md'), '# General\n');
  fs.copyFileSync(path.join(beforeRoot, 'General.md'), path.join(afterRoot, 'General.md'));
  return { directory, before, after, beforeRoot, afterRoot };
}

test('permits only the additive Elixir migration ledger', () => {
  const files = fixture();
  try {
    const db = new Database(files.after);
    db.exec(`
      CREATE TABLE cascade_elixir_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO cascade_elixir_schema_migrations(version,name,checksum)
      VALUES (
        1,
        'core_node_schema_compatibility',
        'b844b7f41e5377d5ce8ff5dd3c3cc0951cab766773f5bf0816aaec45864d338a'
      );
    `);
    db.close();
    const result = runComparison(files);
    assert.equal(result.ok, true, result.failures.join('\n'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('schema snapshots never create WAL or SHM beside an authoritative database', () => {
  const files = fixture();
  try {
    const writer = new Database(files.before);
    assert.equal(writer.pragma('journal_mode = WAL', { simple: true }), 'wal');
    writer.prepare('UPDATE notes SET body = body WHERE id = ?').run('note-1');
    assert.deepEqual(writer.pragma('wal_checkpoint(TRUNCATE)'), [{ busy: 0, log: 0, checkpointed: 0 }]);
    writer.close();
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(`${files.before}${suffix}`); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    fs.copyFileSync(files.before, files.after);
    assert.equal(fs.existsSync(`${files.before}-wal`), false);
    assert.equal(fs.existsSync(`${files.before}-shm`), false);
    const snapshot = databaseSnapshot(files.before);
    assert.equal(snapshot.quickCheck, 'ok');
    assert.equal(runComparison(files).ok, true);
    assert.equal(fs.existsSync(`${files.before}-wal`), false);
    assert.equal(fs.existsSync(`${files.before}-shm`), false);
    assert.equal(fs.existsSync(`${files.after}-wal`), false);
    assert.equal(fs.existsSync(`${files.after}-shm`), false);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects candidate-only ordinary application tables', () => {
  const files = fixture();
  try {
    const db = new Database(files.after);
    db.exec('CREATE TABLE plausible_application_state (id INTEGER PRIMARY KEY, value TEXT)');
    db.close();
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('unexpected table added: plausible_application_state'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

function normalizationFixture() {
  const files = fixture();
  const db = new Database(files.before);
  db.exec(`
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE vault_members (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('owner','editor','viewer')),
      invited_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (vault_id, user_id)
    );
    INSERT INTO vaults(id,name,root_path,created_by,created_at)
      VALUES('vault-1','Vault','/tmp/vault-1',1,'2026-08-11 00:00:00');
    INSERT INTO vault_members(rowid,vault_id,user_id,role,invited_by,created_at)
      VALUES(41,'vault-1',1,'owner',NULL,'2026-08-11 00:00:00');
  `);
  db.close();
  fs.copyFileSync(files.before, files.after);
  return files;
}

function normalizeVaultMembers(filename, preserveRowid = true) {
  const db = new Database(filename);
  db.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE vault_members_next (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('owner','editor','viewer')),
      invited_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (vault_id, user_id)
    );
    INSERT INTO vault_members_next(${preserveRowid ? 'rowid,' : ''}vault_id,user_id,role,invited_by,created_at)
      SELECT ${preserveRowid ? 'rowid,' : ''}vault_id,user_id,role,invited_by,created_at FROM vault_members;
    DROP TABLE vault_members;
    ALTER TABLE vault_members_next RENAME TO vault_members;
    PRAGMA foreign_keys=ON;
  `);
  db.close();
}

function chatBackfillFixture() {
  const files = fixture();
  const before = new Database(files.before);
  before.exec(`
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,root_path TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    INSERT INTO vaults VALUES('vault-1','Vault','/tmp/vault-1',1,'2026-08-11 00:00:00');
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,author TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now')),
      status TEXT,agent_id TEXT,registration_id TEXT,run_id INTEGER,blocks_json TEXT,images_json TEXT,
      attachments_json TEXT,reply_to_json TEXT,harness_log TEXT,change_request_json TEXT,
      forwarded_from_json TEXT,mission_json TEXT,mission_task_id TEXT,clarification_json TEXT,
      activity_at TEXT,actor_user_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE chat_mission_tasks (id TEXT PRIMARY KEY,run_id INTEGER);
    INSERT INTO chat_mission_tasks VALUES('task-1',900),('task-2',900);
    INSERT INTO chat_messages(
      rowid,id,channel_id,vault_id,author,body,created_at,run_id,mission_json
    ) VALUES(
      41,'message-1','note-1','vault-1','Sol','done','2026-08-11 00:00:00',900,
      '{"id":"mission-1","status":"active"}'
    );
  `);
  before.close();
  fs.copyFileSync(files.before, files.after);
  return files;
}

function normalizeChatMessages(filename, missionTaskExpression) {
  const db = new Database(filename);
  db.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE chat_messages_next (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, author TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      activity_at TEXT, actor_user_id INTEGER REFERENCES users(id), status TEXT, agent_id TEXT,
      registration_id TEXT, run_id INTEGER, blocks_json TEXT, harness_log TEXT, images_json TEXT,
      attachments_json TEXT, reply_to_json TEXT, forwarded_from_json TEXT, change_request_json TEXT,
      mission_json TEXT, mission_task_id TEXT, clarification_json TEXT
    );
    INSERT INTO chat_messages_next(
      rowid,id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,status,agent_id,
      registration_id,run_id,blocks_json,harness_log,images_json,attachments_json,reply_to_json,
      forwarded_from_json,change_request_json,mission_json,mission_task_id,clarification_json
    ) SELECT
      rowid,id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,status,agent_id,
      registration_id,run_id,blocks_json,harness_log,images_json,attachments_json,reply_to_json,
      forwarded_from_json,change_request_json,mission_json,${missionTaskExpression},clarification_json
    FROM chat_messages;
    DROP TABLE chat_messages;
    ALTER TABLE chat_messages_next RENAME TO chat_messages;
    PRAGMA foreign_keys=ON;
  `);
  db.close();
}

function runOwnershipFixture() {
  const files = fixture();
  const before = new Database(files.before);
  before.exec(`
    INSERT INTO users VALUES (2, 'other');
    CREATE TABLE vaults (id TEXT PRIMARY KEY);
    INSERT INTO vaults VALUES ('vault-1'), ('vault-2');
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'claude-code',
      session_id TEXT,
      conversation_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      summary TEXT,
      model TEXT
    );
    ALTER TABLE runs ADD COLUMN chat_dispatch_id TEXT;
    CREATE UNIQUE INDEX runs_chat_dispatch_idx
      ON runs(chat_dispatch_id) WHERE chat_dispatch_id IS NOT NULL;
    CREATE TABLE delegated_runs (
      run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      owner_user_id INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO runs(id,vault_id,prompt,status) VALUES
      (10,'vault-1','owned active','running'),
      (11,'vault-2','legacy terminal','completed'),
      (12,'vault-1','other active','queued');
    INSERT INTO delegated_runs(run_id,owner_user_id) VALUES (10,1),(12,2);
  `);
  before.close();
  fs.copyFileSync(files.before, files.after);
  return files;
}

function migrateRunOwnership(filename) {
  const db = new Database(filename);
  db.exec(`
    ALTER TABLE runs ADD COLUMN owner_user_id INTEGER REFERENCES users(id);
    UPDATE runs
    SET owner_user_id=(SELECT d.owner_user_id FROM delegated_runs d WHERE d.run_id=runs.id)
    WHERE owner_user_id IS NULL
      AND EXISTS (SELECT 1 FROM delegated_runs d WHERE d.run_id=runs.id);
    CREATE INDEX runs_owner_active_idx
      ON runs(owner_user_id,status,started_at DESC,id DESC);
  `);
  db.close();
}

test('accepts only the pinned schema normalization while preserving rows and rowids', () => {
  const files = normalizationFixture();
  try {
    normalizeVaultMembers(files.after);
    const result = runComparison(files);
    assert.equal(result.ok, true, result.failures.join('\n'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects a normalized table that compacts historical rowids', () => {
  const files = normalizationFixture();
  try {
    normalizeVaultMembers(files.after, false);
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith(
      'table changed outside pinned normalization: vault_members',
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('accepts only the deterministic Node mission-task repair during chat normalization', () => {
  const files = chatBackfillFixture();
  try {
    normalizeChatMessages(
      files.after,
      "COALESCE(mission_task_id,(SELECT id FROM chat_mission_tasks WHERE run_id=chat_messages.run_id ORDER BY rowid LIMIT 1))",
    );
    const result = runComparison(files);
    assert.equal(result.ok, true, result.failures.join('\n'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects an unrelated mission-task mutation hidden in chat normalization', () => {
  const files = chatBackfillFixture();
  try {
    normalizeChatMessages(files.after, "'not-the-linked-task'");
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith(
      'table changed outside pinned normalization: chat_messages',
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('accepts only the exact run-owner schema and delegated-owner backfill', () => {
  const files = runOwnershipFixture();
  try {
    migrateRunOwnership(files.after);
    const result = runComparison(files);
    assert.equal(result.ok, true, result.failures.join('\n'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects a foreign owner hidden in the run ownership migration', () => {
  const files = runOwnershipFixture();
  try {
    migrateRunOwnership(files.after);
    const after = new Database(files.after);
    after.prepare('UPDATE runs SET owner_user_id=? WHERE id=?').run(2, 10);
    after.close();
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith(
      'table changed outside pinned ownership migration: runs',
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('runs the FTS5 external-content integrity check instead of trusting projected rows', () => {
  const files = fixture();
  try {
    const before = new Database(files.before);
    before.exec(`
      CREATE VIRTUAL TABLE notes_search_fts USING fts5(body,content='notes',content_rowid='rowid');
      CREATE TRIGGER notes_search_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_search_fts(rowid,body) VALUES(NEW.rowid,NEW.body);
      END;
      INSERT INTO notes_search_fts(notes_search_fts) VALUES('rebuild');
    `);
    before.close();
    fs.copyFileSync(files.before, files.after);
    assert.equal(runComparison(files).ok, true);

    const after = new Database(files.after);
    after.exec("INSERT INTO notes_search_fts(notes_search_fts) VALUES('delete-all')");
    after.close();
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith(
      'FTS integrity check failed for notes_search_fts',
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects arbitrary tables that merely resemble FTS5 shadow tables', () => {
  const added = fixture();
  try {
    const db = new Database(added.after);
    db.exec('CREATE TABLE evil_fts_data (value TEXT)');
    db.close();
    const result = runComparison(added);
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('unexpected table added: evil_fts_data'));
  } finally {
    fs.rmSync(added.directory, { recursive: true, force: true });
  }

  const removed = fixture();
  try {
    const before = new Database(removed.before);
    before.exec('CREATE TABLE evil_fts_data (value TEXT)');
    before.close();
    fs.copyFileSync(removed.before, removed.after);
    const after = new Database(removed.after);
    after.exec('DROP TABLE evil_fts_data');
    after.close();
    const result = runComparison(removed);
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('table removed: evil_fts_data'));
  } finally {
    fs.rmSync(removed.directory, { recursive: true, force: true });
  }
});

test('fails on row, schema, integrity, or vault-file drift', () => {
  const files = fixture();
  try {
    const db = new Database(files.after);
    db.prepare('UPDATE notes SET body = ? WHERE id = ?').run('changed', 'note-1');
    db.close();
    fs.writeFileSync(path.join(files.afterRoot, 'General.md'), '# Changed\n');
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith('table changed: notes')));
    assert.ok(result.failures.includes('vault file tree changed'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});
