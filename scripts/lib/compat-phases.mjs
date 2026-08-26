// Compatibility comparison: enforce the reviewed migration and corpus/file-tree policy.
// Inputs are before/after snapshots and optional roots; outputs are failure lists or comparison results.
// Ordering checks pinned transformations, then permitted additions, then file-tree identity.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as p from './compat-normalizers.mjs';
import * as schema from './compat-schema.mjs';
const { quoteIdentifier, databaseScratchDirectory, DEFAULT_ALLOWED_ADDITIONS,
  FTS5_SHADOW_SUFFIXES, NORMALIZED_TABLE_SQL_SHA256, NORMALIZED_OBJECT_SQL_SHA256,
  MIGRATION_LEDGER_SQL_SHA256, MIGRATION_LEDGER_ROW } = p;
const {
  commonFts5ShadowTables: schemaCommonFts5ShadowTables, exactRowsOrMissionTaskBackfill,
  exactRunOwnershipBackfill, verifyFtsIntegrity,
} = schema;

export function fileTreeSnapshot(root) {
  const resolvedRoot = path.resolve(root);
  const entries = {};
  const visit = (directory, relativeDirectory = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      const stat = fs.lstatSync(absolute);
      const mode = stat.mode & 0o7777;
      if (entry.isDirectory()) {
        entries[relative] = { type: 'directory', mode };
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const hash = crypto.createHash('sha256');
        hash.update(fs.readFileSync(absolute));
        entries[relative] = { type: 'file', mode, size: stat.size, sha256: hash.digest('hex') };
      } else if (entry.isSymbolicLink()) {
        entries[relative] = { type: 'symlink', mode, target: fs.readlinkSync(absolute) };
      } else {
        entries[relative] = { type: 'other', mode };
      }
    }
  };
  visit(resolvedRoot);
  return entries;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function commonFts5ShadowTables(before, after) {
  const virtualNames = (snapshot) => new Set(
    Object.values(snapshot.tables)
      .filter((table) => table.rows.virtual && /\bUSING\s+fts5\s*\(/iu.test(table.schema.sql))
      .map((table) => table.schema.name),
  );
  const beforeVirtual = virtualNames(before);
  const afterVirtual = virtualNames(after);
  const shadows = new Set();
  for (const table of beforeVirtual) {
    if (!afterVirtual.has(table)) continue;
    for (const suffix of FTS5_SHADOW_SUFFIXES) {
      const shadow = `${table}_${suffix}`;
      if (before.tables[shadow] && after.tables[shadow]) shadows.add(shadow);
    }
  }
  return shadows;
}

export function compareDatabaseSnapshots(before, after, allowedAdditions = DEFAULT_ALLOWED_ADDITIONS) {
  const failures = [];
  const beforeTables = new Set(Object.keys(before.tables));
  const afterTables = new Set(Object.keys(after.tables));
  const derivedFtsTables = commonFts5ShadowTables(before, after);
  for (const table of beforeTables) {
    if (!afterTables.has(table)) {
      failures.push(`table removed: ${table}`);
      continue;
    }
    if (derivedFtsTables.has(table)) continue;
    if (table === 'runs') {
      if (!exactRunOwnershipBackfill(before, after)) {
        const oldRows = before.tables[table].rows;
        const newRows = after.tables[table].rows;
        failures.push(
          `table changed outside pinned ownership migration: ${table} (rows ${oldRows.count}/${oldRows.sha256.slice(0, 12)} -> ${newRows.count}/${newRows.sha256.slice(0, 12)})`,
        );
      }
    } else if (NORMALIZED_TABLE_SQL_SHA256.has(table)) {
      const oldTable = before.tables[table];
      const newTable = after.tables[table];
      const normalized = newTable.schema.sqlSha256 === NORMALIZED_TABLE_SQL_SHA256.get(table)
        && exactRowsOrMissionTaskBackfill(table, before, after)
        && same(oldTable.rows.columns, newTable.rows.columns)
        && same(oldTable.normalizedForeignKeys, newTable.normalizedForeignKeys);
      if (!normalized) {
        failures.push(
          `table changed outside pinned normalization: ${table} (rows ${oldTable.rows.count}/${oldTable.rows.sha256.slice(0, 12)} -> ${newTable.rows.count}/${newTable.rows.sha256.slice(0, 12)})`,
        );
      }
    } else if (!same(before.tables[table], after.tables[table])) {
      const oldRows = before.tables[table].rows;
      const newRows = after.tables[table].rows;
      failures.push(
        `table changed: ${table} (rows ${oldRows.count}/${oldRows.sha256.slice(0, 12)} -> ${newRows.count}/${newRows.sha256.slice(0, 12)})`,
      );
    }
  }
  for (const table of afterTables) {
    if (beforeTables.has(table)) continue;
    if (!allowedAdditions.has(table)) {
      failures.push(`unexpected table added: ${table}`);
      continue;
    }
    if (table === 'cascade_elixir_schema_migrations') {
      const added = after.tables[table];
      const [migration] = added.migrationRows || [];
      if (added.schema.sqlSha256 !== MIGRATION_LEDGER_SQL_SHA256
          || added.migrationRows?.length !== 1
          || migration?.version !== MIGRATION_LEDGER_ROW.version
          || migration?.name !== MIGRATION_LEDGER_ROW.name
          || migration?.checksum !== MIGRATION_LEDGER_ROW.checksum
          || !Number.isFinite(Date.parse(`${migration?.applied_at || ''}Z`))) {
        failures.push('migration ledger addition differs from the pinned release migration');
      }
    }
  }

  for (const [key, object] of Object.entries(before.schema)) {
    if (object.type === 'table') continue;
    if (!after.schema[key]) failures.push(`${object.type} removed: ${object.name}`);
    else if (!same(object, after.schema[key])) {
      const expected = NORMALIZED_OBJECT_SQL_SHA256.get(key);
      if (!expected || after.schema[key].sqlSha256 !== expected) {
        failures.push(`${object.type} changed: ${object.name}`);
      }
    }
  }
  for (const [key, object] of Object.entries(after.schema)) {
    if (object.type === 'table' || before.schema[key]) continue;
    const expected = NORMALIZED_OBJECT_SQL_SHA256.get(key);
    if (expected) {
      if (object.sqlSha256 !== expected) failures.push(`${object.type} addition differs from pinned schema: ${object.name}`);
    } else if (!allowedAdditions.has(object.tableName) && !allowedAdditions.has(object.name)) {
      failures.push(`unexpected ${object.type} added: ${object.name}`);
    }
  }
  return failures;
}

export function compareIdenticalSnapshots(before, after) {
  const failures = [];
  if (!same(before.schema, after.schema)) failures.push('database schema changed');

  // FTS5 may merge or repack its data/idx shadow pages when an unchanged
  // logical index is opened by a new process. Compare the virtual table and
  // content table exactly, and verify integrity separately, but do not treat
  // the engine's private physical representation as application state.
  const derivedFtsTables = commonFts5ShadowTables(before, after);
  const tables = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
  for (const table of tables) {
    if (!before.tables[table]) failures.push(`table added: ${table}`);
    else if (!after.tables[table]) failures.push(`table removed: ${table}`);
    else if (derivedFtsTables.has(table)) continue;
    else if (!same(before.tables[table], after.tables[table])) {
      failures.push(`table changed during rolling preflight: ${table}`);
    }
  }
  if (!same(before.compatibility, after.compatibility)) {
    failures.push('compatibility projections changed during rolling preflight');
  }
  return failures;
}

export function compareSchemasExactly(before, after) {
  const failures = [];
  if (!same(before.schema, after.schema)) failures.push('database schema changed');

  const beforeLedger = before.tables.cascade_elixir_schema_migrations?.migrationRows || [];
  const afterLedger = after.tables.cascade_elixir_schema_migrations?.migrationRows || [];
  if (!same(beforeLedger, afterLedger)) failures.push('migration ledger changed');
  return failures;
}

export function validatePinnedElixirSchema(before, after) {
  const failures = [];
  const derivedFtsTables = commonFts5ShadowTables(before, after);
  for (const [table, oldTable] of Object.entries(before.tables)) {
    const next = after.tables[table];
    if (!next) {
      failures.push(`table removed: ${table}`);
      continue;
    }
    if (derivedFtsTables.has(table)) continue;
    const normalized = NORMALIZED_TABLE_SQL_SHA256.get(table);
    if (table === 'runs') {
      if (!exactRunOwnershipSchema(before, after)) {
        failures.push(`table schema differs from pinned ownership migration: ${table}`);
      }
    } else if (normalized) {
      if (next.schema.sqlSha256 !== normalized
          || !same(oldTable.rows.columns, next.rows.columns)
          || !same(oldTable.normalizedForeignKeys, next.normalizedForeignKeys)) {
        failures.push(`table schema differs from pinned normalization: ${table}`);
      }
    } else if (!same(oldTable.schema, next.schema)
        || !same(oldTable.rows.columns, next.rows.columns)
        || !same(oldTable.normalizedForeignKeys, next.normalizedForeignKeys)) {
      failures.push(`table schema changed: ${table}`);
    }
  }
  for (const table of Object.keys(after.tables)) {
    if (before.tables[table] || derivedFtsTables.has(table)
        || table === 'cascade_elixir_schema_migrations') continue;
    failures.push(`unexpected table added: ${table}`);
  }
  const migration = after.tables.cascade_elixir_schema_migrations;
  const [migrationRow] = migration?.migrationRows || [];
  if (migration?.schema.sqlSha256 !== MIGRATION_LEDGER_SQL_SHA256
      || migration?.migrationRows?.length !== 1
      || migrationRow?.version !== MIGRATION_LEDGER_ROW.version
      || migrationRow?.name !== MIGRATION_LEDGER_ROW.name
      || migrationRow?.checksum !== MIGRATION_LEDGER_ROW.checksum
      || !Number.isFinite(Date.parse(`${migrationRow?.applied_at || ''}Z`))) {
    failures.push('migration ledger differs from the pinned release migration');
  }
  for (const [key, object] of Object.entries(before.schema)) {
    if (object.type === 'table') continue;
    const next = after.schema[key];
    if (!next) failures.push(`${object.type} removed: ${object.name}`);
    else if (!same(object, next)) {
      const expected = NORMALIZED_OBJECT_SQL_SHA256.get(key);
      if (!expected || next.sqlSha256 !== expected) failures.push(`${object.type} changed: ${object.name}`);
    }
  }
  for (const [key, object] of Object.entries(after.schema)) {
    if (object.type === 'table' || before.schema[key]) continue;
    const expected = NORMALIZED_OBJECT_SQL_SHA256.get(key);
    if (expected) {
      if (object.sqlSha256 !== expected) failures.push(`${object.type} addition differs from pinned schema: ${object.name}`);
    } else if (object.tableName !== 'cascade_elixir_schema_migrations') {
      failures.push(`unexpected ${object.type} added: ${object.name}`);
    }
  }
  return failures;
}
