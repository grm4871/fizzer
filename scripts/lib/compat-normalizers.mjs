// SQLite compatibility primitives: deterministic hashing, snapshots, and row encoding.
// Inputs are database paths/connections; outputs are immutable schema snapshots; failures throw.
// Ordering copies to private scratch before opening SQLite to avoid WAL races.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

export const DEFAULT_ALLOWED_ADDITIONS = new Set(['cascade_elixir_schema_migrations']);
export const FTS5_SHADOW_SUFFIXES = ['config', 'data', 'docsize', 'idx'];

// These hashes pin the intentional one-time normalization performed by the
// Elixir bootstrap. A table is not accepted merely because its rows happen to
// compare equal: the resulting schema must be the reviewed Node-compatible
// shape as well.
export const NORMALIZED_TABLE_SQL_SHA256 = new Map([
  ['chat_agent_members', 'caa0376559c9e2b1327b414bea0b8c92c110f093b2d83277ffbc0778367cd59c'],
  ['chat_channel_links', '5c044d64e74a55bae505e0dc14fa0943d8f2ec550a3a4ee0c8cee6098b8b2f51'],
  ['chat_messages', 'c0ec7be003cb9470e0854022dd4197394b8b52e5b6d81369ab274151ccaf7ae4'],
  ['chat_messages_fts', 'a0537f09f6a0d235e2c50e090ce48214ddd0efa80544131812ccd37822e501a1'],
  ['vault_members', '90145e23f3aae530384ffca13a728c3caef47d31297078bc9cb09e78a520c6ca'],
]);

export const NORMALIZED_OBJECT_SQL_SHA256 = new Map([
  ['index:chat_messages_activity_idx', '57b71e5d8f446140a9ea1a97fdd9b06bf02943fc0c09c38e2a7208ba49dc9fd1'],
  ['index:chat_messages_channel_idx', 'cf59031cf62c9ad6b72e763f899a42bc683db9547811618c25b71720948f4bf2'],
  ['trigger:chat_messages_ai', 'fe4b388168890405a812c0baa7c785d19637612a642546e67820ecb975c9ce0e'],
  ['trigger:chat_messages_ad', 'd5ca273ea2357f3e4868b3595e75ea29d152cb4d41081f1a25a04abe19f3f60e'],
  ['trigger:chat_messages_au', '839d6582356d56eb5ae5b8391e078d3922762de41e5d77f09c678a70496143e1'],
  ['index:chat_mission_events_source_key_idx', '2c8b0abee1bdda9732d0801bfb1370a05c349190a1d6d7b1a75bb1ec2b564767'],
  ['index:runs_owner_active_idx', '2f1bd1bf23ba264283a4b5097177e08c9f5e37defd10b936faa4bdff93fc3ea9'],
]);

export const MIGRATION_LEDGER_SQL_SHA256 =
  '8bff981d0086d2f5b51a359df3ef99a46c398c202a15f151906c67c50e539cdd';
export const MIGRATION_LEDGER_ROW = {
  version: 1,
  name: 'core_node_schema_compatibility',
  checksum: 'b844b7f41e5377d5ce8ff5dd3c3cc0951cab766773f5bf0816aaec45864d338a',
};

export function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function normalizedSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function encodeValue(value) {
  if (Buffer.isBuffer(value)) return { $blob: value.toString('base64') };
  if (typeof value === 'bigint') return { $integer: value.toString() };
  return value;
}

export function hashRows(db, table, sql) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  const valueColumns = [...columns].sort((left, right) => left.name.localeCompare(right.name));
  const primaryKey = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => quoteIdentifier(column.name));
  const virtual = /^CREATE VIRTUAL TABLE\b/i.test(String(sql || ''));
  const withoutRowid = /\bWITHOUT ROWID\b/i.test(String(sql || ''));
  const ordering = primaryKey.length
    ? primaryKey.join(', ')
    : withoutRowid
      ? columns.map((column) => quoteIdentifier(column.name)).join(', ')
      : 'rowid';
  const includesRowid = !withoutRowid;
  const selection = [
    ...(includesRowid ? ['rowid AS "__cascade_rowid"'] : []),
    ...valueColumns.map((column) => quoteIdentifier(column.name)),
  ].join(', ');
  const statement = db.prepare(`SELECT ${selection} FROM ${quoteIdentifier(table)}${ordering ? ` ORDER BY ${ordering}` : ''}`);
  const hash = crypto.createHash('sha256');
  const columnHashes = new Map(valueColumns.map((column) => [column.name, crypto.createHash('sha256')]));
  let count = 0;
  for (const row of statement.iterate()) {
    const values = [
      ...(includesRowid ? [encodeValue(row.__cascade_rowid)] : []),
      ...valueColumns.map((column) => encodeValue(row[column.name])),
    ];
    hash.update(JSON.stringify(values));
    hash.update('\n');
    for (const column of valueColumns) {
      const digest = columnHashes.get(column.name);
      if (includesRowid) {
        digest.update(JSON.stringify(encodeValue(row.__cascade_rowid)));
        digest.update('\0');
      }
      digest.update(JSON.stringify(encodeValue(row[column.name])));
      digest.update('\n');
    }
    count += 1;
  }
  return {
    count,
    sha256: hash.digest('hex'),
    virtual,
    includesRowid,
    columns: valueColumns.map((column) => column.name),
    columnSha256: Object.fromEntries(
      [...columnHashes.entries()].map(([name, digest]) => [name, digest.digest('hex')]),
    ),
  };
}

export function normalizedForeignKeys(rows) {
  return rows.map((row) => ({
    table: row.table,
    from: row.from,
    to: row.to,
    onUpdate: row.on_update,
    onDelete: row.on_delete,
    match: row.match,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function databaseScratchDirectory(prefix) {
  const configured = process.env.CASCADE_SQLITE_SNAPSHOT_TMPDIR || os.tmpdir();
  const root = fs.realpathSync(path.resolve(configured));
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`SQLite snapshot scratch is not a directory: ${root}`);
  return fs.mkdtempSync(path.join(root, prefix));
}

export function databaseSnapshotFromCopy(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = db.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') throw new Error(`${filename}: PRAGMA quick_check returned ${quickCheck}`);
    const foreignKeys = db.pragma('foreign_key_check');
    if (foreignKeys.length) {
      throw new Error(`${filename}: ${foreignKeys.length} foreign-key violation(s)`);
    }
    const objects = db.prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const schema = Object.fromEntries(objects.map((object) => [
      `${object.type}:${object.name}`,
      {
        type: object.type,
        name: object.name,
        tableName: object.tableName,
        sql: normalizedSql(object.sql),
        sqlSha256: sha256(normalizedSql(object.sql)),
      },
    ]));
    const tables = {};
    for (const object of objects) {
      if (object.type !== 'table') continue;
      tables[object.name] = {
        schema: schema[`table:${object.name}`],
        columns: db.prepare(`PRAGMA table_info(${quoteIdentifier(object.name)})`).all(),
        foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(object.name)})`).all(),
        normalizedForeignKeys: normalizedForeignKeys(
          db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(object.name)})`).all(),
        ),
        rows: hashRows(db, object.name, object.sql),
        ...(object.name === 'cascade_elixir_schema_migrations'
          ? { migrationRows: db.prepare('SELECT version,name,checksum,applied_at FROM cascade_elixir_schema_migrations ORDER BY version').all() }
          : {}),
      };
    }
    const compatibility = {};
    if (tables.chat_messages) {
      compatibility.chatMessageTaskLinks = db.prepare(`
        SELECT id,run_id AS runId,mission_task_id AS missionTaskId
        FROM chat_messages ORDER BY id
      `).all();
    }
    if (tables.chat_mission_tasks) {
      compatibility.missionTaskRuns = db.prepare(`
        SELECT id,run_id AS runId FROM chat_mission_tasks
        WHERE run_id IS NOT NULL ORDER BY rowid
      `).all();
    }
    if (tables.runs) {
      const hasOwner = tables.runs.columns.some((column) => column.name === 'owner_user_id');
      compatibility.runOwnership = db.prepare(`
        SELECT rowid,id,${hasOwner ? 'owner_user_id' : 'NULL'} AS ownerUserId
        FROM runs ORDER BY rowid
      `).all();
    }
    if (tables.delegated_runs) {
      compatibility.delegatedRunOwners = db.prepare(`
        SELECT run_id AS runId,owner_user_id AS ownerUserId
        FROM delegated_runs ORDER BY run_id
      `).all();
    }
    return { quickCheck, schema, tables, compatibility };
  } finally {
    db.close();
  }
}

export function databaseSnapshot(filename) {
  const directory = databaseScratchDirectory('cascade-database-snapshot-');
  const disposable = path.join(directory, 'database.sqlite');
  try {
    fs.copyFileSync(path.resolve(filename), disposable, fs.constants.COPYFILE_FICLONE);
    return databaseSnapshotFromCopy(disposable);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
