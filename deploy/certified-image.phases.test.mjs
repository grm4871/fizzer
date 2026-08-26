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


function phaseRuntimeFixture() {
  const environment = [
    'ERL_AFLAGS=+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none',
    `CASCADE_HTTP_ACCEPTORS=${SOAK_RUNTIME_CONFIGURATION.httpAcceptors}`,
    `CASCADE_HTTP_MAX_CONNECTIONS=${SOAK_RUNTIME_CONFIGURATION.httpMaxConnections}`,
    `CASCADE_HTTP_BACKLOG=${SOAK_RUNTIME_CONFIGURATION.httpBacklog}`,
    `CASCADE_NETWORK_MODE=${SOAK_RUNTIME_CONFIGURATION.networkMode}`,
    `CASCADE_TRUST_PROXY_HOPS=${SOAK_RUNTIME_CONFIGURATION.trustProxyHops}`,
    `CASCADE_QMD_WORKER_ENABLED=${SOAK_RUNTIME_CONFIGURATION.qmdWorkerEnabled}`,
    `CASCADE_REALTIME_HIBERNATE_AFTER_MS=${SOAK_RUNTIME_CONFIGURATION.realtimeHibernateAfterMs}`,
    `CASCADE_RUNNER_ORPHAN_RECLAIM_MS=${SOAK_RUNTIME_CONFIGURATION.runnerOrphanReclaimMs}`,
    `CASCADE_SQLITE_POOL_SIZE=${SOAK_RUNTIME_CONFIGURATION.sqlitePoolSize}`,
    `CASCADE_SQLITE_BUSY_TIMEOUT_MS=${SOAK_RUNTIME_CONFIGURATION.sqliteBusyTimeoutMs}`,
  ];
  const runtime = {
    envelope: {
      nanoCpus: runtimeShape.nanoCpus,
      cpusetCpus: runtimeShape.cpusetCpus,
      memory: runtimeShape.memory,
      memorySwap: runtimeShape.memorySwap,
      pidsLimit: runtimeShape.pidsLimit,
      nofileSoft: 200_000,
      nofileHard: 200_000,
    },
    configuration: { ...SOAK_RUNTIME_CONFIGURATION },
    erlAflags: '+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none',
  };
  return {
    runtime,
    inspection: {
      Id: 'container-a',
      Config: { Env: environment },
      HostConfig: {
        NanoCpus: runtimeShape.nanoCpus,
        CpusetCpus: runtimeShape.cpusetCpus,
        Memory: runtimeShape.memory,
        MemorySwap: runtimeShape.memorySwap,
        PidsLimit: runtimeShape.pidsLimit,
        Ulimits: [{ Name: 'nofile', Soft: 200_000, Hard: 200_000 }],
      },
    },
  };
}

function logicalSourceRows(overrides = {}) {
  const fixtureExtras = new Map([
    ['community_note_activity', 400], ['notes', 400], ['users', 10_000],
    ['vault_members', 10_000], ['vaults', 400],
  ]);
  const tableDeltas = PRODUCTION_APPLICATION_TABLES.map((tableName) => ({
    tableName,
    missingRows: 0,
    extraRows: fixtureExtras.get(tableName) || 0,
  }));
  const tableNames = tableDeltas.map((row) => row.tableName);
  return {
    sourceSha256: productionSourceSummary().database.sha256,
    forbiddenChanges: 0,
    missingRows: 0,
    extraRows: 21_200,
    tables: tableDeltas.length,
    tableNames,
    tableNamesSha256: sha256(JSON.stringify(stable(tableNames))),
    tableDeltas,
    tableEvidenceSha256: sha256(JSON.stringify(stable(tableDeltas))),
    schemaMigrationSha256: '2'.repeat(64),
    schemaEvidenceSha256: '3'.repeat(64),
    schemaValidation: 'pinned Elixir transform passed',
    chatTransforms: { rows: 4_082, missionJsonSemanticReencodes: 0, missionTaskBackfills: 2, sha256: '4'.repeat(64) },
    fts: { integrityCheck: 'rank=1 passed on disposable snapshot' },
    ...overrides,
  };
}

function candidateCorpusEvidence() {
  return Object.fromEntries(['vaults', 'qmd'].map((name) => [name, {
    approvedRecords: 1,
    approvedSha256: sha256(`approved-${name}`),
    missingOrChanged: 0,
    unexpectedExtras: 0,
    derivedIndexChanges: 0,
    extrasSha256: '5'.repeat(64),
    derivedIndexChangesSha256: '6'.repeat(64),
  }]));
}

test('phase preflight and freeze validators bind never-started identity, scratch, schema, corpus, and orphan policy', () => {
  const source = productionSourceSummary();
  const fixture = validateCapacityFixtureArtifact(capacityFixtureArtifact());
  const { runtime, inspection } = phaseRuntimeFixture();
  const mount = {
    inspection,
    mountDestination: '/data',
    mountSourceSha256: '7'.repeat(64),
    relativeDatabase: 'docs.db',
  };
  const scratch = {
    device: '8',
    availableBytes: 3 * 1024 ** 3,
    policy: 'private owned disk-backed scratch with at least 2 GiB free',
  };
  const result = {
    schemaVersion: 1,
    type: 'cascade-capacity-fixture-preflight',
    profile: 'final10k',
    phase: 'main10k',
    imageId,
    containerId: 'container-a',
    containerStartedAt: '0001-01-01T00:00:00Z',
    runtime,
    mountDestination: '/data',
    mountSourceSha256: mount.mountSourceSha256,
    relativeDatabase: 'docs.db',
    sourceDatabaseSha256: source.database.sha256,
    sourceCorpusSha256: source.corpus.sha256,
    fixtureSha256: fixture.sha256,
    databaseSha256: '8'.repeat(64),
    databaseBytes: source.database.bytes + 1,
    databaseDevice: '10',
    databaseInode: '11',
    baseline: {
      users: 10_007, vaults: 412, memberships: 10_015, notes: 725,
      messages: 4_082, runs: 1_897, runEvents: 403_514,
      delegatedRuns: 2, maxRunId: 1_897, quickCheck: 'ok', foreignKeyViolations: 0,
    },
    identity: {
      users: 10_000, groups: 400, userMismatches: 0, membershipMismatches: 0,
      vaultMismatches: 0, channelMismatches: 0, activityMismatches: 0,
      identitySha256: '9'.repeat(64),
    },
    sourceRows: logicalSourceRows(),
    candidateCorpus: candidateCorpusEvidence(),
    snapshotScratch: scratch,
    walPresent: false,
    shmPresent: false,
    createdAt: '2026-08-11T00:00:00.000Z',
  };
  const evidence = validateFixturePreflight(
    result, { sha256: 'a'.repeat(64) }, source, fixture, mount, imageId,
  );
  assert.equal(evidence.containerStartedAt, '0001-01-01T00:00:00Z');
  assert.throws(
    () => validateFixturePreflight({ ...result, containerStartedAt: '2026-08-11T00:00:00Z' },
      { sha256: 'a'.repeat(64) }, source, fixture, mount, imageId),
    /already been started/,
  );

  const freeze = {
    schemaVersion: 1,
    type: 'cascade-capacity-phase-freeze',
    phase: 'main10k',
    profile: 'final10k',
    imageId,
    containerId: 'container-a',
    mountSourceSha256: mount.mountSourceSha256,
    databaseSha256: 'b'.repeat(64),
    databaseBytes: result.databaseBytes + 1,
    databaseDevice: result.databaseDevice,
    databaseInode: result.databaseInode,
    runtime,
    candidateCorpus: candidateCorpusEvidence(),
    sourceRows: logicalSourceRows(),
    identity: result.identity,
    orphanState: { state: 'reclaimed' },
    phaseWorkload: { runs: 1 },
    snapshotScratch: scratch,
    containerState: { running: false, restartCount: 0, oomKilled: false },
    containerStartedAt: '2026-08-11T00:00:00.000Z',
    walPresent: false,
    shmPresent: false,
    frozenAt: '2026-08-11T01:00:00.000Z',
  };
  assert.equal(validateFreezeEvidence(freeze, { sha256: 'c'.repeat(64) }, evidence, imageId).phase,
    'main10k');
  assert.throws(
    () => validateFreezeEvidence({ ...freeze, orphanState: { state: 'preserved' } },
      { sha256: 'c'.repeat(64) }, evidence, imageId),
    /orphan state/,
  );
  assert.throws(
    () => validateFreezeEvidence({
      ...freeze,
      candidateCorpus: {
        ...freeze.candidateCorpus,
        vaults: { ...freeze.candidateCorpus.vaults, approvedRecords: 0 },
      },
    }, { sha256: 'c'.repeat(64) }, evidence, imageId),
    /candidate corpus/,
  );
  assert.throws(
    () => validateFreezeEvidence({
      ...freeze,
      identity: { ...freeze.identity, userMismatches: 1 },
    }, { sha256: 'c'.repeat(64) }, evidence, imageId),
    /identity joins/,
  );
});

test('candidate corpus accepts scoped fixture extras and rejects approved-byte drift or unexpected roots', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-corpus-proof-'));
  const source = path.join(directory, 'source');
  const candidate = path.join(directory, 'candidate');
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(candidate);
    fs.writeFileSync(path.join(source, 'approved.md'), 'approved\n');
    fs.copyFileSync(path.join(source, 'approved.md'), path.join(candidate, 'approved.md'));
    fs.mkdirSync(path.join(candidate, 'fixture-1'));
    fs.writeFileSync(path.join(candidate, 'fixture-1', 'General.md'), 'fixture\n');
    assert.equal(compareCorpusTree(source, candidate, 'test corpus', ['fixture-1']).missingOrChanged, 0);
    fs.writeFileSync(path.join(candidate, 'approved.md'), 'mutated\n');
    assert.throws(() => compareCorpusTree(source, candidate, 'test corpus', ['fixture-1']), /mutated or omitted/);
    fs.copyFileSync(path.join(source, 'approved.md'), path.join(candidate, 'approved.md'));
    fs.mkdirSync(path.join(candidate, 'unexpected'));
    assert.throws(() => compareCorpusTree(source, candidate, 'test corpus', ['fixture-1']), /not attributable/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('orphan, phase-workload, and exact table-delta evidence fail closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-phase-proof-'));
  const database = path.join(directory, 'docs.db');
  try {
    const db = new Database(database);
    db.exec(`
      CREATE TABLE runs (id INTEGER PRIMARY KEY,status TEXT,summary TEXT,prompt TEXT);
      CREATE TABLE delegated_runs (run_id INTEGER PRIMARY KEY,owner_user_id INTEGER);
      CREATE TABLE run_events (run_id INTEGER,seq INTEGER,type TEXT,payload_json TEXT);
      CREATE TABLE chat_messages (id TEXT PRIMARY KEY,vault_id TEXT,channel_id TEXT,body TEXT);
      INSERT INTO runs VALUES
        (1896,'queued',NULL,'baseline'),(1897,'queued',NULL,'baseline'),
        (1898,'completed','restart recovery passed','runner restart recovery proof');
      INSERT INTO delegated_runs VALUES(1896,1),(1897,4);
      INSERT INTO run_events VALUES
        (1896,1913,'queued','{}'),(1897,27,'queued','{}'),
        (1898,1,'status','{"status":"queued"}'),
        (1898,2,'status','{"status":"running"}'),
        (1898,3,'status','{"status":"completed","summary":"restart recovery passed","sessionId":"fault-session-1898"}');
      INSERT INTO chat_messages VALUES(
        'fault-lock-recovery-test','vault-test','channel-test','dependency recovered'
      );
    `);
    db.close();
    assert.equal(validateBaselineOrphanState(database, false).state, 'preserved');
    const workload = phaseWorkloadEvidence(database, 'faults');
    assert.deepEqual(workload.workloadMessages.map((row) => row.id), ['fault-lock-recovery-test']);
    assert.equal(workload.badRunEventSequences, 0);
    const faults = validateFaultEvidence(
      [faultResult('runner-restart-reclaim'), faultResult('sqlite-write-lock')],
      [faultArtifact(0), faultArtifact(1)], imageId, revision, 'https://staging.example',
      'e'.repeat(64),
    );
    assert.equal(validateFaultPersistence(workload, faults), true);
    for (const mutate of [
      (copy) => copy.workloadRunEvents.splice(1, 0, {
        runId: 1_898, seq: 2, type: 'text', payloadJson: '{"text":"arbitrary"}',
      }),
      (copy) => { copy.workloadRunEvents[1].payloadJson = '{"status":"queued"}'; },
      (copy) => { copy.workloadRunEvents[2].payloadJson = '{"status":"completed","summary":"restart recovery passed"}'; },
    ]) {
      const changed = structuredClone(workload);
      mutate(changed);
      assert.throws(() => validateFaultPersistence(changed, faults), /exact queued\/running\/completed|exact runner-restart/);
    }

    const reclaimed = new Database(database);
    const summary = 'Desktop agent runner did not reclaim this run after server restart.';
    reclaimed.prepare('UPDATE runs SET status=?,summary=? WHERE id IN (1896,1897)').run('failed', summary);
    reclaimed.exec('DELETE FROM delegated_runs');
    reclaimed.prepare('INSERT INTO run_events VALUES(?,?,?,?)')
      .run(1896, 1914, 'status', JSON.stringify({ status: 'failed', summary }));
    reclaimed.prepare('INSERT INTO run_events VALUES(?,?,?,?)')
      .run(1897, 28, 'status', JSON.stringify({ status: 'failed', summary }));
    reclaimed.close();
    assert.equal(validateBaselineOrphanState(database, true).state, 'reclaimed');
    const compensated = new Database(database);
    compensated.prepare('UPDATE run_events SET payload_json=? WHERE run_id=1896 AND seq=1914')
      .run(JSON.stringify({ status: 'failed', summary, sessionId: 'unexpected' }));
    compensated.close();
    assert.throws(() => validateBaselineOrphanState(database, true), /exact terminal event/);
    const restored = new Database(database);
    restored.prepare('UPDATE run_events SET payload_json=? WHERE run_id=1896 AND seq=1914')
      .run(JSON.stringify({ status: 'failed', summary }));
    restored.close();

    const phaseExtras = new Map([
      ['users', 10_000], ['vaults', 400], ['vault_members', 10_000],
      ['notes', 400], ['community_note_activity', 400], ['chat_messages', 1],
      ['runs', 1], ['run_events', 3],
    ]);
    const deltas = PRODUCTION_APPLICATION_TABLES.map((tableName) => ({
      tableName, missingRows: 0, extraRows: phaseExtras.get(tableName) || 0,
    }));
    const deltaEvidence = () => ({
      tables: deltas.length,
      tableNames: deltas.map((row) => row.tableName),
      tableNamesSha256: sha256(JSON.stringify(stable(deltas.map((row) => row.tableName)))),
      tableDeltas: deltas,
      tableEvidenceSha256: sha256(JSON.stringify(stable(deltas))),
    });
    assert.equal(validatePhaseTableDeltas(
      { phase: 'faults', orphanState: { state: 'preserved' }, sourceRows: deltaEvidence() },
      { users: 10_000, groups: 400 },
      { runEvents: 3 },
    ), true);
    deltas.find((row) => row.tableName === 'run_events').extraRows = 4;
    assert.throws(() => validatePhaseTableDeltas(
      { phase: 'faults', orphanState: { state: 'preserved' }, sourceRows: deltaEvidence() },
      { users: 10_000, groups: 400 },
      { runEvents: 3 },
    ), /unexpected rows/);
    const deleted = structuredClone(deltaEvidence());
    deleted.tableDeltas.pop();
    deleted.tables = deleted.tableDeltas.length;
    deleted.tableNames = deleted.tableDeltas.map((row) => row.tableName);
    deleted.tableNamesSha256 = sha256(JSON.stringify(stable(deleted.tableNames)));
    deleted.tableEvidenceSha256 = sha256(JSON.stringify(stable(deleted.tableDeltas)));
    assert.throws(() => validatePhaseTableDeltas(
      { phase: 'faults', orphanState: { state: 'preserved' }, sourceRows: deleted },
      { users: 10_000, groups: 400 }, { runEvents: 3 },
    ), /approved production database|duplicate, missing, or reordered/);
    const duplicate = structuredClone(deltaEvidence());
    duplicate.tableDeltas[1].tableName = duplicate.tableDeltas[0].tableName;
    duplicate.tableNames[1] = duplicate.tableNames[0];
    duplicate.tableNamesSha256 = sha256(JSON.stringify(stable(duplicate.tableNames)));
    duplicate.tableEvidenceSha256 = sha256(JSON.stringify(stable(duplicate.tableDeltas)));
    assert.throws(() => validatePhaseTableDeltas(
      { phase: 'faults', orphanState: { state: 'preserved' }, sourceRows: duplicate },
      { users: 10_000, groups: 400 }, { runEvents: 3 },
    ), /duplicate, missing, or reordered/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('real production-derived fixture passes exact logical origin without side effects', {
  skip: !(process.env.CASCADE_REAL_PRODUCTION_SOURCE_DB && process.env.CASCADE_REAL_CAPACITY_FIXTURE_DB),
}, () => {
  const source = process.env.CASCADE_REAL_PRODUCTION_SOURCE_DB;
  const candidate = process.env.CASCADE_REAL_CAPACITY_FIXTURE_DB;
  for (const database of [source, candidate]) {
    assert.equal(fs.existsSync(`${database}-wal`), false);
    assert.equal(fs.existsSync(`${database}-shm`), false);
  }
  const evidence = compareProductionRows(source, candidate, {
    profileName: 'diagnostic1k', phase: 'preflight',
  });
  assert.equal(evidence.missingRows, 0);
  assert.equal(evidence.chatTransforms.missionJsonSemanticReencodes, 0);
  assert.equal(evidence.chatTransforms.missionTaskBackfills, 2);
  assert.equal(evidence.schemaValidation, 'pinned Elixir transform passed');
  for (const database of [source, candidate]) {
    assert.equal(fs.existsSync(`${database}-wal`), false);
    assert.equal(fs.existsSync(`${database}-shm`), false);
  }
});

test('certifier independently binds exact realtime reason and dispatcher accounting', () => {
  const otherReason = monitor();
  otherReason.at(-1).evaluation.observed.presenceSnapshotOther = 1;
  assert.throws(() => validateMonitorEvidence(otherReason, imageId), /presence snapshot reason accounting/);

  const shardPlanDrift = monitor();
  shardPlanDrift.at(-1).workload.shards[0].initialOwnedChatChannels = 99;
  assert.throws(() => validateMonitorEvidence(shardPlanDrift, imageId), /invalid presence-owner plan/);

  const strategyDrift = monitor();
  strategyDrift.at(-1).workload.shards[0].forcedReconnectStrategy = 'owner-first-v1';
  assert.throws(() => validateMonitorEvidence(strategyDrift, imageId), /invalid presence-owner plan/);

  const duplicateOwner = monitor();
  duplicateOwner.at(-1).workload.shards[1].forcedReconnectOwnerUserIds[0] = 1;
  assert.throws(() => validateMonitorEvidence(duplicateOwner, imageId), /reconnect-owner IDs differ/);
});

test('rejects image drift, failed monitor evaluation, and incomplete load shards', () => {
  assert.throws(() => validateMonitorEvidence(monitor({ id: `sha256:${'c'.repeat(64)}` }), imageId),
    /exercised .* expected/);
  assert.throws(() => validateMonitorEvidence(monitor({ ok: false }), imageId), /capacity monitor failed/);
  const [start, finish] = monitorEndpoints();
  assert.throws(() => validateLoadEvidence(
    [0, 1, 2].map(loadShard), start, finish, [0, 1, 2].map(artifact),
  ), /3 load results for 4 shards/);
});
