#!/usr/bin/env node

// Public certified-image entrypoint. The implementation is split by seam while this file
// preserves the historical CLI path and named validator exports for direct consumers.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as primitives from './lib/certified-primitives.mjs';
import * as source from './lib/certified-source-evidence.mjs';
import * as database from './lib/certified-database-evidence.mjs';
import * as phase from './lib/certified-phase-evidence.mjs';
import * as monitor from './lib/certified-monitor-evidence.mjs';
import * as load from './lib/certified-load-evidence.mjs';
import * as soak from './lib/certified-soak-evidence.mjs';
import * as manifest from './lib/certified-manifest.mjs';
import * as cli from './lib/certified-cli.mjs';

export const { PRODUCTION_APPLICATION_TABLES } = primitives;
export const {
  configureSnapshotScratch,
} = primitives;
export const {
  validateProductionSourceSummary, collectProductionSourceEvidence,
  validateFixtureDatabaseIdentity, compareCorpusTree,
} = source;
export const {
  validateFtsIntegrity, compareProductionRows, validateBaselineOrphanState,
  phaseWorkloadEvidence,
} = database;
export const {
  validateFixturePreflight, validateFreezeEvidence, validatePhaseTableDeltas,
} = phase;
export const {
  validateMonitorEvidence, validateServerLogArtifact, validateLoadEvidence,
  validateCapacityFixtureSummary, validateCapacityFixtureArtifact,
} = monitor;
export const {
  validateLoadProvenance, validateRuntimeProof, validateReconciliationEvidence,
  validateFaultEvidence, validateFaultPersistence, validatePhaseChronology,
} = load;
export const { validateSoakEvidence } = soak;
export const { validateManifest } = manifest;

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  try {
    cli.main();
  } catch (error) {
    console.error(`[certified-image] ${error.message}`);
    process.exitCode = 1;
  }
}
