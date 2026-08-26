// Compatibility CLI: preserve all checker flags, output text, and exit statuses.
// Inputs are argv and optional JSON/schema files; outputs are stdout diagnostics; failures set exitCode=1.
// Ordering parses mode flags before opening any database.

import fs from 'node:fs';
import process from 'node:process';
import * as p from './compat-normalizers.mjs';
import * as schema from './compat-schema.mjs';
import * as compare from './compat-phases.mjs';
const { DEFAULT_ALLOWED_ADDITIONS, databaseSnapshot } = p;
const { readSchemaFingerprint, loadSchemaFingerprint, materializeSchemaFingerprint, compareSchemaFingerprints, verifyFtsIntegrity } = schema;
const { fileTreeSnapshot, compareDatabaseSnapshots, compareIdenticalSnapshots, validatePinnedElixirSchema, same } = compare;

export function parseArgs(argv) {
  const args = { allowTable: [], requireIdentical: false, schemaOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'require-identical') {
      args.requireIdentical = true;
      continue;
    }
    if (key === 'schema-only') {
      args.schemaOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    index += 1;
    if (key === 'allow-table') args.allowTable.push(value);
    else if (key === 'before') args.before = value;
    else if (key === 'after') args.after = value;
    else if (key === 'before-root') args.beforeRoot = value;
    else if (key === 'after-root') args.afterRoot = value;
    else if (key === 'before-schema') args.beforeSchema = value;
    else if (key === 'after-schema') args.afterSchema = value;
    else if (key === 'dump-schema') args.dumpSchema = value;
    else if (key === 'materialize-schema') args.materializeSchema = value;
    else if (key === 'materialize-dest') args.materializeDest = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  if (args.dumpSchema || args.materializeSchema) {
    if (args.dumpSchema && (args.before || args.after || args.materializeSchema)) {
      throw new Error('--dump-schema cannot be combined with comparison or materialize options');
    }
    if (args.materializeSchema && !args.materializeDest) {
      throw new Error('--materialize-schema requires --materialize-dest');
    }
    return args;
  }
  args.before = args.beforeSchema || args.before;
  args.after = args.afterSchema || args.after;
  if (!args.before || !args.after) {
    throw new Error('provide --before/--after or --before-schema/--after-schema');
  }
  if (Boolean(args.beforeRoot) !== Boolean(args.afterRoot)) {
    throw new Error('--before-root and --after-root must be supplied together');
  }
  if (args.requireIdentical && args.schemaOnly) {
    throw new Error('--require-identical and --schema-only are mutually exclusive');
  }
  if ((args.beforeSchema || args.afterSchema) && !args.schemaOnly) args.schemaOnly = true;
  return args;
}
function tableCountFromFingerprint(fingerprint) {
  return (fingerprint.objects || []).filter((object) => object.type === 'table').length;
}

export function runComparison(options) {
  if (options.schemaOnly) {
    const before = options.beforeFingerprint || loadSchemaFingerprint(options.beforeSchema || options.before);
    const after = options.afterFingerprint || loadSchemaFingerprint(options.afterSchema || options.after);
    const failures = compareSchemaFingerprints(before, after);
    return {
      ok: failures.length === 0,
      failures,
      beforeTables: tableCountFromFingerprint(before),
      afterTables: tableCountFromFingerprint(after),
    };
  }

  const allowed = new Set([...DEFAULT_ALLOWED_ADDITIONS, ...(options.allowTable || [])]);
  const before = databaseSnapshot(options.before);
  const after = databaseSnapshot(options.after);
  const failures = options.requireIdentical
    ? compareIdenticalSnapshots(before, after)
    : compareDatabaseSnapshots(before, after, allowed);
  try {
    verifyFtsIntegrity(options.after, after);
  } catch (error) {
    failures.push(error.message);
  }
  if (options.beforeRoot) {
    const beforeFiles = fileTreeSnapshot(options.beforeRoot);
    const afterFiles = fileTreeSnapshot(options.afterRoot);
    if (!same(beforeFiles, afterFiles)) failures.push('vault file tree changed');
  }
  return {
    ok: failures.length === 0,
    failures,
    beforeTables: Object.keys(before.tables).length,
    afterTables: Object.keys(after.tables).length,
  };
}

export function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dumpSchema) {
    process.stdout.write(`${JSON.stringify(readSchemaFingerprint(args.dumpSchema))}\n`);
    return;
  }
  if (args.materializeSchema) {
    const fingerprint = loadSchemaFingerprint(args.materializeSchema);
    materializeSchemaFingerprint(fingerprint, args.materializeDest);
    console.log(`Materialized schema into ${args.materializeDest}.`);
    return;
  }
  const result = runComparison(args);
  if (!result.ok) {
    console.error('Elixir data compatibility check failed:');
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  if (args.requireIdentical) {
    console.log(
      `Rolling data identity check passed: ${result.beforeTables} existing tables; ${result.afterTables} tables after boot.`,
    );
  } else if (args.schemaOnly) {
    console.log(
      `Rolling schema identity check passed: ${result.beforeTables} existing tables; ${result.afterTables} tables after boot.`,
    );
  } else {
    console.log(
      `Elixir data compatibility check passed: ${result.beforeTables} existing tables unchanged; ${result.afterTables} tables after boot.`,
    );
  }
}
