// Schema fingerprint and FTS evidence: read/materialize exact SQLite-compatible DDL.
// Inputs are snapshots or DB paths; outputs are schema fingerprints and integrity assertions.
// Ordering hides FTS shadow tables, then compares visible schema and migration ledger.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as p from './compat-normalizers.mjs';
const { normalizedSql, databaseScratchDirectory, quoteIdentifier, FTS5_SHADOW_SUFFIXES, same } = p;

const SCHEMA_OBJECT_ORDER = { table: 0, index: 1, trigger: 2, view: 3 };

export function fts5ShadowNames(objects) {
  const virtual = objects
    .filter((object) => /\bUSING\s+fts5\s*\(/iu.test(object.sql || ''))
    .map((object) => object.name);
  const shadows = new Set();
  for (const table of virtual) {
    for (const suffix of [...FTS5_SHADOW_SUFFIXES, 'content']) shadows.add(`${table}_${suffix}`);
    for (const object of objects) {
      if (object.name.startsWith(`${table}_`)) shadows.add(object.name);
    }
  }
  return shadows;
}

export function readSchemaFingerprintFromDb(db) {
  const objects = db.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map((object) => ({
    type: object.type,
    name: object.name,
    tableName: object.tableName,
    sql: normalizedSql(object.sql),
  }));
  const shadows = fts5ShadowNames(objects);
  const visible = objects.filter((object) => !shadows.has(object.name));
  let migrations = [];
  const hasLedger = visible.some((object) => object.type === 'table' && object.name === 'cascade_elixir_schema_migrations');
  if (hasLedger) {
    migrations = db.prepare(
      'SELECT version, name, checksum FROM cascade_elixir_schema_migrations ORDER BY version',
    ).all();
  }
  return { objects: visible, migrations };
}

export function readSchemaFingerprint(filename) {
  const directory = databaseScratchDirectory('cascade-schema-fingerprint-');
  const disposable = path.join(directory, 'database.sqlite');
  try {
    fs.copyFileSync(path.resolve(filename), disposable, fs.constants.COPYFILE_FICLONE);
    const db = new Database(disposable, { readonly: true, fileMustExist: true });
    try {
      return readSchemaFingerprintFromDb(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function loadSchemaFingerprint(source) {
  if (source && typeof source === 'object' && !Array.isArray(source)) return source;
  const text = fs.readFileSync(source, 'utf8');
  if (text.startsWith('{')) return JSON.parse(text);
  return readSchemaFingerprint(source);
}

export function compareSchemaFingerprints(before, after) {
  const failures = [];
  if (!same(before.objects, after.objects)) failures.push('database schema changed');
  if (!same(before.migrations, after.migrations)) failures.push('migration ledger changed');
  return failures;
}

export function materializeSchemaFingerprint(fingerprint, destination) {
  if (fs.existsSync(destination)) fs.rmSync(destination);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(`${destination}${suffix}`); } catch { /* fresh dest */ }
  }
  const db = new Database(destination);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const objects = [...(fingerprint.objects || [])].sort((left, right) => {
      const order = (SCHEMA_OBJECT_ORDER[left.type] ?? 9) - (SCHEMA_OBJECT_ORDER[right.type] ?? 9);
      return order || left.name.localeCompare(right.name);
    });
    const shadows = fts5ShadowNames(objects);
    for (const object of objects) {
      if (shadows.has(object.name)) continue;
      if (!object.sql) continue;
      try {
        db.exec(object.sql);
      } catch (error) {
        if (!/already exists/i.test(error.message)) throw error;
      }
    }
    if (fingerprint.migrations?.length) {
      const insert = db.prepare(
        'INSERT INTO cascade_elixir_schema_migrations(version, name, checksum) VALUES (?, ?, ?)',
      );
      for (const row of fingerprint.migrations) insert.run(row.version, row.name, row.checksum);
    }
  } finally {
    db.close();
  }
}

export function exactRowsOrMissionTaskBackfill(table, before, after) {
  if (same(before.tables[table].rows, after.tables[table].rows)) return true;
  if (table !== 'chat_messages') return false;
  const oldRows = before.tables[table].rows;
  const newRows = after.tables[table].rows;
  if (oldRows.count !== newRows.count
      || oldRows.includesRowid !== newRows.includesRowid
      || !same(oldRows.columns, newRows.columns)) return false;
  for (const column of oldRows.columns) {
    if (column !== 'mission_task_id'
        && oldRows.columnSha256[column] !== newRows.columnSha256[column]) return false;
  }

  const beforeLinks = before.compatibility.chatMessageTaskLinks || [];
  const afterLinks = after.compatibility.chatMessageTaskLinks || [];
  if (beforeLinks.length !== afterLinks.length) return false;
  const firstTaskByRun = new Map();
  for (const task of after.compatibility.missionTaskRuns || []) {
    if (!firstTaskByRun.has(task.runId)) firstTaskByRun.set(task.runId, task.id);
  }
  for (let index = 0; index < beforeLinks.length; index += 1) {
    const oldLink = beforeLinks[index];
    const newLink = afterLinks[index];
    if (oldLink.id !== newLink.id || oldLink.runId !== newLink.runId) return false;
    const expected = oldLink.missionTaskId
      ?? (oldLink.runId == null ? null : firstTaskByRun.get(oldLink.runId) ?? null);
    if (newLink.missionTaskId !== expected) return false;
  }
  return true;
}

function exactRunOwnershipSchema(before, after) {
  const oldTable = before.tables.runs;
  const newTable = after.tables.runs;
  if (!oldTable || !newTable) return false;

  const oldOwner = oldTable.columns.find((column) => column.name === 'owner_user_id');
  const newOwner = newTable.columns.find((column) => column.name === 'owner_user_id');
  if (!newOwner
      || newOwner.type !== 'INTEGER'
      || Number(newOwner.notnull) !== 0
      || newOwner.dflt_value !== null
      || Number(newOwner.pk) !== 0) return false;

  if (oldOwner) {
    return same(oldTable.schema, newTable.schema)
      && same(oldTable.columns, newTable.columns)
      && same(oldTable.normalizedForeignKeys, newTable.normalizedForeignKeys);
  }

  const expectedColumns = [
    ...oldTable.columns,
    { ...newOwner, cid: oldTable.columns.length },
  ];
  const expectedForeignKeys = [
    ...oldTable.normalizedForeignKeys,
    {
      table: 'users',
      from: 'owner_user_id',
      to: 'id',
      onUpdate: 'NO ACTION',
      onDelete: 'NO ACTION',
      match: 'NONE',
    },
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const expectedSql = oldTable.schema.sql.replace(
    /\)\s*$/u,
    ', owner_user_id INTEGER REFERENCES users(id))',
  );
  return same(expectedColumns, newTable.columns)
    && same(expectedForeignKeys, newTable.normalizedForeignKeys)
    && newTable.schema.sql === expectedSql;
}

export function exactRunOwnershipBackfill(before, after) {
  if (!exactRunOwnershipSchema(before, after)) return false;
  const oldRows = before.tables.runs.rows;
  const newRows = after.tables.runs.rows;
  const oldColumns = oldRows.columns.filter((column) => column !== 'owner_user_id');
  if (oldRows.count !== newRows.count
      || oldRows.includesRowid !== newRows.includesRowid
      || !oldColumns.every((column) => newRows.columns.includes(column))) return false;
  for (const column of oldColumns) {
    if (oldRows.columnSha256[column] !== newRows.columnSha256[column]) return false;
  }

  const oldOwnership = before.compatibility.runOwnership || [];
  const newOwnership = after.compatibility.runOwnership || [];
  if (oldOwnership.length !== newOwnership.length) return false;
  const delegated = new Map(
    (before.compatibility.delegatedRunOwners || [])
      .map((row) => [row.runId, row.ownerUserId]),
  );
  for (let index = 0; index < oldOwnership.length; index += 1) {
    const oldRun = oldOwnership[index];
    const newRun = newOwnership[index];
    if (oldRun.rowid !== newRun.rowid || oldRun.id !== newRun.id) return false;
    const expectedOwner = oldRun.ownerUserId ?? delegated.get(oldRun.id) ?? null;
    if (newRun.ownerUserId !== expectedOwner) return false;
  }
  return true;
}

export function verifyFtsIntegrity(filename, snapshot) {
  const ftsTables = Object.values(snapshot.tables)
    .filter((table) => table.rows.virtual && /\bUSING\s+fts5\s*\(/iu.test(table.schema.sql))
    .map((table) => table.schema.name);
  if (!ftsTables.length) return;

  const directory = databaseScratchDirectory('cascade-fts-integrity-');
  const disposable = path.join(directory, 'database.sqlite');
  try {
    fs.copyFileSync(filename, disposable);
    const db = new Database(disposable, { fileMustExist: true });
    try {
      for (const table of ftsTables) {
        db.exec('BEGIN');
        try {
          db.prepare(
            `INSERT INTO ${quoteIdentifier(table)}(${quoteIdentifier(table)}, rank) VALUES('integrity-check', 1)`,
          ).run();
          db.exec('ROLLBACK');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* preserve the integrity error */ }
          throw new Error(`FTS integrity check failed for ${table}: ${error.message}`);
        }
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
