import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as fixtureModule from './lib/certified-test-fixtures.mjs';
import * as soakFixtureModule from './lib/certified-test-fixtures-soak.mjs';
import * as certified from './certified-image.mjs';
import { loadConfiguration } from '../loadtest_elixir/load.mjs';
import { RETURN_THRESHOLDS, SOAK_PROFILE, SOAK_RUNTIME_CONFIGURATION, evaluateSoakEvidence as evaluateLongSoakEvidence, parseSoakJournal, recomputeSoakJournal } from '../loadtest_elixir/soak-invariants.mjs';

const { deployDirectory, root, imageId, revision, monitorDigest, runtimeShape, releaseThresholds, artifact, faultArtifact, faultResult, soakArtifact, stable, fakeJwt, sha256, productionSourceSummary, capacityFixtureArtifact, monitor, monitorEndpoints, loadShard } = fixtureModule;
const { soakFixtureArtifact, soakServerLogArtifact, soakDatabaseEvidence, soakSample, soakFixtureEvidence, soakResult } = soakFixtureModule;
const { PRODUCTION_APPLICATION_TABLES, compareProductionRows, compareCorpusTree, configureSnapshotScratch, phaseWorkloadEvidence, validateBaselineOrphanState, validateCapacityFixtureArtifact, validateCapacityFixtureSummary, validateFaultEvidence, validateFaultPersistence, validateFixturePreflight, validateFreezeEvidence, validateLoadEvidence, validateLoadProvenance, validateManifest, validateMonitorEvidence, validatePhaseTableDeltas, validatePhaseChronology, validateProductionSourceSummary, validateReconciliationEvidence, validateServerLogArtifact, validateSoakEvidence } = certified;

test('direct certifier commands reject memory-backed SQLite scratch', (t) => {
  const memoryBackedParent = ['/dev/shm', os.tmpdir()].find((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    const type = BigInt.asUintN(64, BigInt(fs.statfsSync(candidate).type));
    return type === 0x01021994n || type === 0x858458f6n;
  });
  assert.ok(memoryBackedParent, 'the Linux release test requires a tmpfs or ramfs fixture');
  const scratch = fs.mkdtempSync(path.join(memoryBackedParent, 'cascade-certifier-scratch-'));
  fs.chmodSync(scratch, 0o700);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  assert.throws(
    () => configureSnapshotScratch(scratch),
    /disk-backed storage, not tmpfs or ramfs/u,
  );
});
test('accepts only complete 10k evidence for one immutable image', () => {
  const records = monitor();
  const [start, finish] = monitorEndpoints();
  assert.deepEqual(validateMonitorEvidence(records, imageId), { start, finish });
  assert.deepEqual(validateLoadEvidence(
    [0, 1, 2, 3].map(loadShard),
    start,
    finish,
    [0, 1, 2, 3].map(artifact),
  ), {
    shardCount: 4,
    users: 10_000,
    gateStartAt: '2026-08-11T00:06:00.000Z',
    gateEndAt: '2026-08-11T00:36:00.000Z',
  });
});

test('production source provenance is pinned to the exact approved DB and corpus', () => {
  const source = productionSourceSummary();
  assert.equal(validateProductionSourceSummary(source), source);
  assert.throws(() => validateProductionSourceSummary({
    ...source,
    database: { ...source.database, sha256: '0'.repeat(64) },
  }), /approved immutable snapshot/);
  assert.throws(() => validateProductionSourceSummary({
    ...source,
    database: {
      ...source.database,
      counts: { ...source.database.counts, messages: 0 },
    },
  }), /baseline differs/);
  assert.throws(() => validateProductionSourceSummary({
    ...source,
    corpus: { ...source.corpus, files: source.corpus.files - 1 },
  }), /corpus differs/);
});

test('capacity fixtures bind exact profile shape without retaining tokens', () => {
  const finalArtifact = capacityFixtureArtifact();
  const final = validateCapacityFixtureArtifact(finalArtifact);
  assert.equal(final.users, 10_000);
  assert.equal(final.groups, 400);
  assert.doesNotMatch(JSON.stringify(final), /\.signature/u);
  const diagnostic = validateCapacityFixtureArtifact(capacityFixtureArtifact(1_000), 'diagnostic1k');
  assert.equal(diagnostic.users, 1_000);
  assert.throws(
    () => validateCapacityFixtureSummary(diagnostic, 'final10k'),
    /10,?000-user\/400-group shape/,
  );
  const rows = finalArtifact.text.trim().split('\n');
  rows[1] = rows[0];
  assert.throws(() => validateCapacityFixtureArtifact({
    ...finalArtifact,
    text: `${rows.join('\n')}\n`,
  }), /reuses a token/);
});

test('load provenance binds host driver, fixture bytes, and exact shard configuration', () => {
  const fixture = validateCapacityFixtureArtifact(capacityFixtureArtifact());
  const driverPath = path.join(root, 'loadtest_elixir', 'load.mjs');
  const driverBytes = fs.readFileSync(driverPath);
  const driver = { path: driverPath, sha256: sha256(driverBytes), bytes: driverBytes.byteLength };
  const results = [0, 1, 2, 3].map((index) => {
    const result = loadShard(index);
    result.provenance = {
      schemaVersion: 1,
      loadDriverSha256: driver.sha256,
      loadDriverBytes: driver.bytes,
      fixtureSha256: fixture.sha256,
      fixtureBytes: fixture.bytes,
      configurationSha256: sha256(JSON.stringify(stable(loadConfiguration(result)))),
    };
    return result;
  });
  const evidence = validateLoadProvenance(results, driver, fixture);
  assert.equal(evidence.configurations.length, 4);
  const loose = structuredClone(results);
  loose[0].thresholds.httpErrorRate = 1;
  assert.throws(() => validateLoadProvenance(loose, driver, fixture), /configuration digest/);
  const wrongFixture = structuredClone(results);
  wrongFixture[0].provenance.fixtureSha256 = '0'.repeat(64);
  assert.throws(() => validateLoadProvenance(wrongFixture, driver, fixture), /fixture bytes/);
});
