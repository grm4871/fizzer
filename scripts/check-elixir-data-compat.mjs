#!/usr/bin/env node

// Public compatibility-checker entrypoint. Keep the historical script path and exports
// stable while implementation seams own normalization, schema, comparison, and CLI phases.
import process from 'node:process';
import * as primitives from './lib/compat-normalizers.mjs';
import * as schema from './lib/compat-schema.mjs';
import * as compare from './lib/compat-phases.mjs';
import * as cli from './lib/compat-cli.mjs';

export const { databaseSnapshot } = primitives;
export const {
  readSchemaFingerprintFromDb, readSchemaFingerprint, loadSchemaFingerprint,
  compareSchemaFingerprints, materializeSchemaFingerprint, verifyFtsIntegrity,
} = schema;
export const {
  commonFts5ShadowTables, compareDatabaseSnapshots, compareIdenticalSnapshots,
  compareSchemasExactly, validatePinnedElixirSchema,
} = compare;
export const { runComparison } = cli;
export const { fileTreeSnapshot, parseArgs } = { ...compare, ...cli };

if (import.meta.url === `file://${process.argv[1]}`) cli.main();
