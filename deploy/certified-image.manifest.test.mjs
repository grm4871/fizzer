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
    chatTransforms: {
      rows: 4_082,
      missionJsonSemanticReencodes: 0,
      missionTaskBackfills: 2,
      sha256: '4'.repeat(64),
    },
    fts: { integrityCheck: 'rank=1 passed on disposable snapshot' },
    ...overrides,
  };
}


test('certification manifest is bound to a canonical revision tag and all shards', () => {
  const { result: soakEvidence, journal, fixture, serverLog } = soakResult();
  const certifiedSoak = validateSoakEvidence(
    soakEvidence,
    soakArtifact(),
    journal,
    fixture,
    serverLog,
    imageId,
    revision,
    'https://staging.example',
  );
  const manifest = {
    schemaVersion: 2,
    status: 'certified',
    revision,
    image: { id: imageId, tag: `cascade:certified-${revision}` },
    certification: {
      totalUsers: 10_000,
      shardCount: 4,
      target: 'https://staging.example',
      monitor: {
        sha256: monitorDigest,
        imageId,
        containerId: 'container-a',
        containerStartedAt: '2026-08-10T23:59:55.000Z',
        serverLogs: {
          policy: 'zero fatal/error lines from container start through monitor finish',
          baselineCursor: '2026-08-10T23:59:55.000Z',
          finishCursor: '2026-08-11T00:37:29.000Z',
          readError: null,
          sha256: 'e'.repeat(64),
          totalBytes: 0,
          totalLines: 0,
          matchedErrorLines: 0,
          matchesTruncated: false,
        },
        runtimeEnvelope: {
          cpus: 2,
          cpuset: '0-1',
          memoryBytes: 3 * 1024 ** 3,
          memorySwapBytes: 3 * 1024 ** 3,
          pidsLimit: 100_000,
          nofileSoft: 200_000,
          nofileHard: 200_000,
        },
        runtimeConfiguration: { ...SOAK_RUNTIME_CONFIGURATION },
        sessions: 10_000,
        runners: 10_000,
        memberships: 50_000,
        durationSeconds: 2_250,
        gateWindowSeconds: 1_800,
        gateStartAt: '2026-08-11T00:06:00.000Z',
        gateEndAt: '2026-08-11T00:36:00.000Z',
        coverage: {
          sessions: 0.99,
          runners: 0.99,
          memberships: 0.99,
          sessionsEnd: 10_000,
          runnersEnd: 10_000,
          membershipsEnd: 50_000,
        },
        realtime: {
          expected: {
            enabled: true,
            authFull: 11_000,
            groupCount: 400,
            successfulChatWrites: 46_500,
          },
          presencePlan: {
            strategy: 'owner-stratified-v1',
            initialOwnedChatChannels: 400,
            forcedReconnectOwnedChatChannels: 40,
            forcedReconnectOwnerUserIds: Array.from({ length: 40 }, (_unused, index) => index + 1),
          },
          observed: {
            realtimeAuthFull: 11_000,
            realtimeAuthCacheHits: 22_000,
            realtimeAuthConflicts: 0,
            realtimeAuthUnknown: 0,
            presenceUserChannelReads: 9_999,
            presenceChannelSourceReads: 800,
            presenceParticipantSnapshotReads: 13_840,
            presenceSnapshotInitial: 11_000,
            presenceSnapshotDirect: 440,
            presenceSnapshotDispatcher: 2_400,
            presenceSnapshotOther: 0,
            chatListRouteReads: 49_340,
            chatListRouteMessage: 46_500,
            chatListRouteDirect: 440,
            chatListRouteDispatcher: 2_400,
            chatListRouteOther: 0,
            runnerDelegatedSnapshotReads: 1,
            runnerDelegatedOwnerReads: 0,
            runnerDisconnectFlushes: 1,
            runnerDisconnectFlushOwners: 9_999,
            presenceDispatcher: {
              requested: 20_000,
              dispatched: 2_400,
              completed: 2_400,
              failed: 0,
              noop: 0,
              active: 0,
              pending: 0,
              queued: 0,
              refreshed: 2_400,
              startFailed: 0,
              taskFailed: 0,
            },
          },
        },
        workload: {
          finishedAt: '2026-08-11T00:36:10.000Z',
          elapsedSeconds: 2_170,
          postWorkloadSeconds: 75,
          users: 10_000,
          shardCount: 4,
          presencePlan: {
            strategy: 'owner-stratified-v1',
            initialOwnedChatChannels: 400,
            forcedReconnectOwnedChatChannels: 40,
            forcedReconnectOwnerUserIds: Array.from({ length: 40 }, (_unused, index) => index + 1),
          },
          shards: [0, 1, 2, 3].map((shard) => ({
            shard,
            sha256: artifact(shard).sha256,
            initialOwnedChatChannels: 100,
            forcedReconnectOwnedChatChannels: 10,
            forcedReconnectStrategy: 'owner-stratified-v1',
            forcedReconnectOwnerUserIds: Array.from(
              { length: 10 },
              (_unused, owner) => shard * 10 + owner + 1,
            ),
          })),
        },
        evaluation: 'passed',
      },
      loads: [0, 1, 2, 3].map((shard) => ({
        shard,
        sha256: artifact(shard).sha256,
        users: 2_500,
        sourceIp: `198.51.100.${shard + 1}`,
        rampSeconds: 300,
        soakSeconds: 1_860,
        pollingPercent: 5,
        reconnectPercent: 10,
        reconnectAtSeconds: 600,
        selectionPlan: {
          forcedReconnectStrategy: 'owner-stratified-v1',
          forcedReconnectOwnerUserIds: Array.from(
            { length: 10 },
            (_unused, owner) => shard * 10 + owner + 1,
          ),
        },
        presencePlan: {
          strategy: 'owner-stratified-v1',
          initialOwnedChatChannels: 100,
          forcedReconnectOwnedChatChannels: 10,
          forcedReconnectOwnerUserIds: Array.from(
            { length: 10 },
            (_unused, owner) => shard * 10 + owner + 1,
          ),
        },
        rates: { chatRps: 6.25, readRps: 12.5, runRps: 0.25 },
        rampCompletedAt: '2026-08-11T00:05:00.000Z',
        soakStartedAt: '2026-08-11T00:05:00.000Z',
        workloadFinishedAt: `2026-08-11T00:36:0${shard}.000Z`,
        finishedAt: `2026-08-11T00:36:0${shard + 4}.000Z`,
        evaluation: 'passed',
      })),
      faults: [
        { ...faultResult('runner-restart-reclaim'), sha256: faultArtifact(0).sha256, evaluation: 'passed' },
        { ...faultResult('sqlite-write-lock'), sha256: faultArtifact(1).sha256, evaluation: 'passed' },
      ],
      soak: certifiedSoak,
    },
  };
  const sourceSnapshot = productionSourceSummary();
  const fixtureSummary = validateCapacityFixtureArtifact(capacityFixtureArtifact());
  for (const fault of manifest.certification.faults) fault.fixtureSha256 = fixtureSummary.sha256;
  manifest.certification.soak.fixtures.sha256 = fixtureSummary.sha256;
  for (const entry of manifest.certification.loads) {
    const workloadIdentity = loadShard(entry.shard).workloadIdentity;
    entry.thresholds = { ...releaseThresholds };
    entry.successfulChatWrites = 11_625;
    entry.successfulRuns = 465;
    entry.workloadIdentity = {
      successfulMessageIdsCount: workloadIdentity.successfulMessageIdsCount,
      successfulMessageIdsSha256: workloadIdentity.successfulMessageIdsSha256,
      requestedRunIdsCount: workloadIdentity.requestedRunIdsCount,
      requestedRunIdsSha256: workloadIdentity.requestedRunIdsSha256,
    };
    Object.assign(
      manifest.certification.monitor.workload.shards.find((shard) => shard.shard === entry.shard),
      entry.workloadIdentity,
    );
    entry.configurationSha256 = sha256(JSON.stringify(stable(loadConfiguration(entry))));
  }
  const configurations = manifest.certification.loads
    .map((entry) => ({ shard: entry.shard, sha256: entry.configurationSha256 }));
  const preflight = (phase, containerId, mountIndex, createdAt) => ({
    sha256: String(mountIndex).repeat(64),
    phase,
    profile: 'final10k',
    imageId,
    containerId,
    containerStartedAt: '0001-01-01T00:00:00Z',
    mountDestination: '/data',
    mountSourceSha256: sha256(`mount-${mountIndex}`),
    relativeDatabase: 'docs.db',
    sourceDatabaseSha256: sourceSnapshot.database.sha256,
    sourceCorpusSha256: sourceSnapshot.corpus.sha256,
    fixtureSha256: fixtureSummary.sha256,
    databaseSha256: sha256(`database-${mountIndex}`),
    databaseBytes: sourceSnapshot.database.bytes + 1_000_000,
    databaseDevice: String(100 + mountIndex),
    databaseInode: String(200 + mountIndex),
    createdAt,
  });
  const preflights = {
    main10k: preflight('main10k', 'container-a', 1, '2026-08-10T23:58:00.000Z'),
    faults: preflight('faults', 'fault-container', 2, '2026-08-11T00:41:00.000Z'),
    soak5k: preflight('soak5k', 'soak-container', 3, '2026-08-11T00:50:00.000Z'),
  };
  const phaseSourceRows = (phase) => {
    const sourceRows = logicalSourceRows();
    const extras = new Map(sourceRows.tableDeltas.map((row) => [row.tableName, row.extraRows]));
    if (phase === 'main10k') {
      extras.set('chat_messages', 46_500);
      extras.set('runs', 1_862);
      extras.set('run_events', 7_442);
    } else if (phase === 'faults') {
      extras.set('chat_messages', 1);
      extras.set('runs', 1);
      extras.set('run_events', 3);
    } else {
      extras.set('runs', 7_202);
      extras.set('run_events', 28_802);
    }
    sourceRows.tableDeltas = sourceRows.tableDeltas.map((row) => ({
      ...row,
      missingRows: ['main10k', 'soak5k'].includes(phase)
        && ['runs', 'delegated_runs'].includes(row.tableName) ? 2 : 0,
      extraRows: extras.get(row.tableName) || 0,
    }));
    sourceRows.tableEvidenceSha256 = sha256(JSON.stringify(stable(sourceRows.tableDeltas)));
    return sourceRows;
  };
  const phaseWorkload = (phase) => {
    if (phase === 'main10k') return {
      runs: 1_860, completedRuns: 1_860, runEvents: 7_440, messages: 46_500,
    };
    if (phase === 'soak5k') return {
      runs: 7_200, completedRuns: 7_200, runEvents: 28_800, messages: 0,
    };
    return {
      runs: 1,
      completedRuns: 1,
      runEvents: 3,
      messages: 1,
      workloadRuns: [{
        id: 1_898,
        status: 'completed',
        summary: 'restart recovery passed',
        eventCount: 3,
        completedTerminalEvents: 1,
        lastType: 'status',
        lastPayload: JSON.stringify({
          status: 'completed', summary: 'restart recovery passed', sessionId: 'fault-session-1898',
        }),
      }],
      workloadRunEvents: [
        { runId: 1_898, seq: 1, type: 'status', payloadJson: '{"status":"queued"}' },
        { runId: 1_898, seq: 2, type: 'status', payloadJson: '{"status":"running"}' },
        {
          runId: 1_898,
          seq: 3,
          type: 'status',
          payloadJson: JSON.stringify({
            status: 'completed', summary: 'restart recovery passed', sessionId: 'fault-session-1898',
          }),
        },
      ],
      workloadMessages: [{
        id: 'fault-lock-recovery-test', vaultId: 'vault-test', channelId: 'channel-test',
        body: 'dependency recovered',
      }],
    };
  };
  const freeze = (phase, frozenAt) => ({
    sha256: sha256(`freeze-${phase}`),
    phase,
    profile: 'final10k',
    imageId,
    containerId: preflights[phase].containerId,
    mountSourceSha256: preflights[phase].mountSourceSha256,
    databaseSha256: sha256(`frozen-database-${phase}`),
    databaseDevice: preflights[phase].databaseDevice,
    databaseInode: preflights[phase].databaseInode,
    sourceRows: phaseSourceRows(phase),
    orphanState: { state: ['main10k', 'soak5k'].includes(phase) ? 'reclaimed' : 'preserved' },
    phaseWorkload: phaseWorkload(phase),
    frozenAt,
  });
  const successfulChatWrites = 46_500;
  const successfulRuns = 1_860;
  const aggregateMessageIds = [0, 1, 2, 3]
    .flatMap((shard) => loadShard(shard).workloadIdentity.successfulMessageIds).sort();
  const aggregateRunIds = [0, 1, 2, 3]
    .flatMap((shard) => loadShard(shard).workloadIdentity.requestedRunIds)
    .sort((left, right) => left - right);
  const reconciliationExpected = {
    users: 10_007,
    vaults: 412,
    memberships: 10_015,
    channels: 400,
    successfulChatWrites,
    successfulRuns,
    successfulMessageIdsSha256: sha256(JSON.stringify(stable(aggregateMessageIds))),
    requestedRunIdsSha256: sha256(JSON.stringify(stable(aggregateRunIds))),
    shardWorkloadIdentities: manifest.certification.loads
      .map((entry) => ({ shard: entry.shard, ...entry.workloadIdentity })),
  };
  const reconciliationObserved = {
    users: 10_007,
    vaults: 412,
    memberships: 10_015,
    totalNotes: 725,
    totalMessages: 4_082 + successfulChatWrites,
    totalRuns: 1_897 + successfulRuns,
    totalRunEvents: 403_514 + successfulRuns * 4 + 2,
    totalDelegatedRuns: 0,
    fixtureChannelCount: 400,
    loadMessageCount: successfulChatWrites,
    loadMessageDistinctIds: successfulChatWrites,
    loadMessageChannels: 400,
    loadMessageIdsSha256: sha256(JSON.stringify(stable(aggregateMessageIds))),
    duplicateMessageIds: 0,
    unexercisedFixtureChannels: 0,
    badMessageScope: 0,
    badMessageBodies: 0,
    loadRunCount: successfulRuns,
    completedLoadRuns: successfulRuns,
    loadRunIdsSha256: sha256(JSON.stringify(stable(aggregateRunIds))),
    loadRunEventCount: successfulRuns * 4,
    unexpectedNewRuns: 0,
    badRunPrompts: 0,
    badRunRows: 0,
    badTerminalEventCounts: 0,
    badEventSequences: 0,
    badRunEventSignatures: 0,
    openDelegatedRuns: 0,
    foreignKeyViolations: 0,
    quickCheck: 'ok',
  };
  manifest.certification.provenance = {
    sourceSnapshot,
    fixture: fixtureSummary,
    loadDriver: {
      sha256: 'd'.repeat(64),
      bytes: 123_456,
      configurations,
      configurationsSha256: sha256(JSON.stringify(stable(configurations))),
    },
    runtimeProof: {
      sha256: 'a'.repeat(64),
      phase: 'main10k',
      profile: 'final10k',
      imageId,
      containerId: 'container-a',
      revision,
      executedAt: '2026-08-10T23:59:00.000Z',
      swapReady: true,
      embedded: {
        loadDriverSha256: 'd'.repeat(64),
        reconciliationDriverSha256: 'f'.repeat(64),
      },
    },
    preflights,
    freezes: {
      main10k: freeze('main10k', '2026-08-11T00:40:00.000Z'),
      faults: freeze('faults', '2026-08-11T00:45:00.000Z'),
      soak5k: freeze('soak5k', '2026-08-11T03:01:00.000Z'),
    },
    reconciliation: {
      sha256: 'b'.repeat(64),
      databaseSha256: 'c'.repeat(64),
      driverSha256: 'f'.repeat(64),
      fixturePrefixSha256: sha256('cap'),
      baselineMaxRunId: 1_897,
      expected: reconciliationExpected,
      observed: reconciliationObserved,
      finishedAt: '2026-08-11T00:39:00.000Z',
      evaluation: 'passed',
    },
  };
  assert.equal(validateManifest(manifest), manifest);
  const faultPersistenceDrift = structuredClone(manifest);
  faultPersistenceDrift.certification.provenance.freezes.faults
    .phaseWorkload.workloadRunEvents[1].payloadJson = '{"status":"running","extra":true}';
  assert.throws(() => validateManifest(faultPersistenceDrift), /queued\/running\/completed sequence/);
  const phaseDeltaDrift = structuredClone(manifest);
  const driftedRunEvents = phaseDeltaDrift.certification.provenance.freezes.main10k
    .sourceRows.tableDeltas.find((row) => row.tableName === 'run_events');
  driftedRunEvents.extraRows += 1;
  phaseDeltaDrift.certification.provenance.freezes.main10k.sourceRows.tableEvidenceSha256
    = sha256(JSON.stringify(stable(
      phaseDeltaDrift.certification.provenance.freezes.main10k.sourceRows.tableDeltas,
    )));
  assert.throws(() => validateManifest(phaseDeltaDrift), /unexpected rows/);
  const faultFixtureDrift = structuredClone(manifest);
  faultFixtureDrift.certification.faults[0].fixtureSha256 = '0'.repeat(64);
  assert.throws(() => validateManifest(faultFixtureDrift), /fault-recovery evidence/);
  const soakFixtureDrift = structuredClone(manifest);
  soakFixtureDrift.certification.soak.fixtures.sha256 = '0'.repeat(64);
  assert.throws(() => validateManifest(soakFixtureDrift), /fixture evidence/);
  const lateFaultPreflight = structuredClone(manifest);
  lateFaultPreflight.certification.provenance.preflights.faults.createdAt
    = '2026-08-11T00:43:00.000Z';
  assert.throws(() => validateManifest(lateFaultPreflight), /before its never-started preflight/);
  const lateSoakPreflight = structuredClone(manifest);
  lateSoakPreflight.certification.provenance.preflights.soak5k.createdAt
    = '2026-08-11T00:55:00.000Z';
  assert.throws(() => validateManifest(lateSoakPreflight), /before its never-started preflight/);
  assert.throws(() => validateManifest({ ...manifest, image: { ...manifest.image, tag: 'cascade:latest' } }),
    /not canonical/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: { ...manifest.certification, loads: manifest.certification.loads.slice(1) },
  }), /incomplete/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: { ...manifest.certification.soak, imageId: `sha256:${'f'.repeat(64)}` },
    },
  }), /soak image, revision, or target/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: { ...manifest.certification.soak, probeUninstalled: false },
    },
  }), /probe was not cleanly uninstalled/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: {
        ...manifest.certification.soak,
        journalHeadroom: { ...manifest.certification.soak.journalHeadroom, mailboxMax: 501 },
      },
    },
  }), /headroom evidence/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: {
        ...manifest.certification.soak,
        journalHeadroom: { ...manifest.certification.soak.journalHeadroom, cpuMaxPct: null },
      },
    },
  }), /headroom evidence/);
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      monitor: {
        ...manifest.certification.monitor,
        realtime: {
          ...manifest.certification.monitor.realtime,
          observed: {
            ...manifest.certification.monitor.realtime.observed,
            presenceDispatcher: {
              ...manifest.certification.monitor.realtime.observed.presenceDispatcher,
              noop: 1,
            },
          },
        },
      },
    },
  }), /presence dispatcher accounting/);
  const duplicateOwnerMonitor = structuredClone(manifest.certification.monitor);
  duplicateOwnerMonitor.workload.shards[1].forcedReconnectOwnerUserIds[0] = 1;
  assert.throws(() => validateManifest({
    ...manifest,
    certification: { ...manifest.certification, monitor: duplicateOwnerMonitor },
  }), /reconnect-owner strategy, counts, or IDs/);
  const reorderedSelectionManifest = structuredClone(manifest);
  reorderedSelectionManifest.certification.loads[0].selectionPlan.forcedReconnectOwnerUserIds.reverse();
  assert.throws(
    () => validateManifest(reorderedSelectionManifest),
    /load shard 0 reconnect-owner evidence differs/,
  );
  assert.throws(() => validateManifest({
    ...manifest,
    certification: {
      ...manifest.certification,
      soak: {
        ...manifest.certification.soak,
        database: {
          ...manifest.certification.soak.database,
          final: { ...manifest.certification.soak.database.final, runs: 7_209 },
        },
      },
    },
  }), /SQLite counts or approved orphan transition do not reconcile/);
});

test('certification hashes the same regular-file snapshot it validates', () => {
  const source = [
    'certified-image.mjs',
    ...fs.readdirSync(path.join(deployDirectory, 'lib'))
      .filter((file) => file.startsWith('certified-') && file.endsWith('.mjs')),
  ].map((file) => fs.readFileSync(path.join(deployDirectory, file === 'certified-image.mjs' ? file : `lib/${file}`), 'utf8')).join('\n');
  assert.match(source, /function artifactSnapshot[\s\S]*O_NOFOLLOW[\s\S]*fs\.fstatSync[\s\S]*metadata\.isFile\(\)[\s\S]*fs\.readFileSync\(descriptor\)[\s\S]*createHash\('sha256'\)\.update\(bytes\)/);
  assert.match(source, /const monitorArtifact = artifactSnapshot[\s\S]*monitorArtifact\.text[\s\S]*sha256: monitorArtifact\.sha256/);
  assert.match(source, /function validateServerLogArtifact[\s\S]*serverLogArtifact\.sha256 === finish\.serverLogs\.sha256/);
  assert.match(source, /const loadArtifacts = options\.loadResults\.map[\s\S]*JSON\.parse\(artifact\.text\)/);
  assert.match(source, /const soakArtifact = artifactSnapshot[\s\S]*const soakJournalArtifact = artifactSnapshot[\s\S]*validateSoakEvidence/);
  assert.match(source, /const manifestDigest = createHash\('sha256'\)\.update\(manifestBytes\)/);
  assert.match(source, /mode: 0o600, flag: 'wx'/);
  assert.match(source, /checksumTemporary[\s\S]*fs\.renameSync\(checksumTemporary/);
});

test('release images pin every Dockerfile base and Compose cannot rebuild', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const fromLines = dockerfile.split(/\r?\n/u).filter((line) => line.startsWith('FROM '));
  assert.ok(fromLines.length >= 4);
  for (const line of fromLines) assert.match(line, /@sha256:[0-9a-f]{64}(?:\s+AS\s+\S+)?$/i);

  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.doesNotMatch(compose, /^\s*build:/mu);
  assert.match(compose, /image: \$\{CASCADE_IMAGE:-cascade:latest\}/);
  assert.match(compose, /^\s{4}cpus: 2$/mu);
  assert.match(compose, /^\s{4}cpuset: "0-1"$/mu);
  assert.match(compose, /^\s{4}mem_limit: 3g$/mu);
  assert.match(compose, /^\s{4}memswap_limit: 3g$/mu);
  assert.match(compose, /^\s{4}pids_limit: 100000$/mu);
});

test('release build binds a clean full revision to one canonical image tag and label', () => {
  const build = fs.readFileSync(path.join(deployDirectory, 'build-release-image.sh'), 'utf8');
  assert.match(build, /REVISION="\$\(git rev-parse HEAD\)"/);
  assert.match(build, /git status --porcelain --untracked-files=all/);
  assert.match(build, /git archive --format=tar "\$REVISION" \| DOCKER_BUILDKIT=1 docker build/);
  assert.match(build, /--provenance=false/);
  assert.match(build, /IMAGE="cascade:certified-\$REVISION"/);
  assert.match(build, /--build-arg "CASCADE_REVISION=\$REVISION"/);
  assert.match(build, /IMAGE_ID="\$\(docker image inspect/);
  assert.match(build, /Descriptor\.Annotations "config\.digest"/);
  assert.match(build, /org\.opencontainers\.image\.revision/);
  assert.match(build, /--tag "\$IMAGE" -/);
  assert.doesNotMatch(build, /cascade:latest/);
});

test('staging transfers a Docker archive and records the exact loaded image without starting it', () => {
  const stage = fs.readFileSync(path.join(deployDirectory, 'stage-certified-image.sh'), 'utf8');
  assert.match(stage, /docker image save "\$IMAGE_TAG"/);
  assert.match(stage, /docker image load/);
  assert.match(stage, /BatchMode=yes/);
  assert.match(stage, /StrictHostKeyChecking=yes/);
  assert.match(stage, /ServerAliveInterval=20/);
  assert.match(stage, /REMOTE_ID.*docker image inspect/);
  assert.doesNotMatch(stage, /docker (?:compose )?(?:up|run)/);
  assert.match(stage, /mktemp '\/tmp\/cascade-certified-\$REVISION\.XXXXXX\.json'/);
  assert.match(stage, /\/var\/lib\/cascade-release\/certified-images\/\$REVISION\.json/);
  assert.match(stage, /stat -c '%u:%g:%a:%F'/);
});

test('routine staging transfers only the exact revision-labelled image', () => {
  const stage = fs.readFileSync(path.join(deployDirectory, 'stage-release-image.sh'), 'utf8');
  assert.match(stage, /git status --porcelain --untracked-files=all/);
  assert.match(stage, /IMAGE_TAG="cascade:certified-\$REVISION"/);
  assert.match(stage, /Descriptor\.Annotations "config\.digest"/);
  assert.match(stage, /org\.opencontainers\.image\.revision/);
  assert.match(stage, /docker image save "\$IMAGE_TAG"/);
  assert.match(stage, /docker image load/);
  assert.match(stage, /BatchMode=yes/);
  assert.match(stage, /StrictHostKeyChecking=yes/);
  assert.match(stage, /REMOTE_ID.*docker image inspect/);
  assert.match(stage, /REMOTE_REVISION.*docker image inspect/);
  assert.doesNotMatch(stage, /capacity|waiver|manifest/iu);
  assert.doesNotMatch(stage, /docker (?:compose )?(?:up|run)/);
});

test('first-time deployment starts only the verified staged image without rebuilding', () => {
  const deploy = fs.readFileSync(path.join(deployDirectory, 'deploy.sh'), 'utf8');
  const finishHttps = fs.readFileSync(path.join(deployDirectory, 'finish-https.sh'), 'utf8');
  assert.match(deploy, /certified-image\.mjs verify --manifest "\$CERTIFIED_MANIFEST"/);
  assert.match(deploy, /docker compose up -d --no-build/);
  assert.match(deploy, /RUNNING_IMAGE_ID="\$\(docker inspect --format '\{\{\.Image\}\}' cascade\)"/);
  assert.match(deploy, /RUNNING_IMAGE_ID" != "\$CERTIFIED_IMAGE_ID/);
  assert.match(deploy, /acquire_cascade_deploy_lock "\$ROOT"/);
  assert.match(deploy, /deploy\.sh is bootstrap-only and refuses to replace an existing Cascade container/);
  assert.match(deploy, /install -d -m 0750 -o 1000 -g 1000 "\$DATA_DIR"/);
  assert.match(deploy, /CERTIFIED_RELEASE_DIR="\/var\/lib\/cascade-release"/);
  assert.doesNotMatch(deploy, /chown -R 1000:1000 "\$DATA_DIR"/);
  assert.match(deploy, /chmod 0600 \.env/);
  assert.match(deploy, /-L "\$CERTIFICATE_FILE"/);
  assert.match(deploy, /RUNNING_SHAPE=.*HostConfig\.NanoCpus/);
  assert.match(deploy, /EXPECTED_SHAPE="2000000000 0-1 3221225472 3221225472 100000 nofile 200000 200000"/);
  for (const renderer of [deploy, finishHttps]) {
    assert.match(renderer, /s\/CASCADE_PRIMARY_PORT\/3000\/g/);
    assert.match(renderer, /server 127\.0\.0\.1:39001 backup max_fails=1 fail_timeout=2s/);
  }
  assert.doesNotMatch(deploy, /^\s*docker (?:compose )?build(?:\s|$)/mu);
});

test('public source does not contain a production deployment workflow', () => {
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/deploy.yml')), false);

  const contributorDocs = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(contributorDocs, /does not contain or operate a production deployment/u);
});
