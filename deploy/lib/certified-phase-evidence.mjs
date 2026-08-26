// Phase evidence: bind never-started preflights and stopped freezes to one fixture lifecycle.
// Inputs are phase artifacts, mounts, snapshots, and image IDs; outputs are reduced evidence; failures throw.
// Ordering validates identity/state, then independent database/corpus observations.

import fs from 'node:fs';
import path from 'node:path';
import * as p from './certified-primitives.mjs';
import * as source from './certified-source-evidence.mjs';
import * as db from './certified-database-evidence.mjs';

const { stableJson, invariant, DIGEST_PATTERN, CAPACITY_PROFILES, CAPACITY_PHASES,
  ORPHAN_RECLAIM_MS, PRODUCTION_SOURCE_DATABASE, artifactSnapshot, configureSnapshotScratch,
  digestRegularFile } = p;
const { collectProductionSourceEvidence, validateFixtureDatabaseIdentity, compareCorpusTree, inspectContainerDataMount, containerRuntimeEvidence, validateCandidateCorpus, databaseBaseline } = source;
const { compareProductionRows, validateBaselineOrphanState, phaseWorkloadEvidence, expectedFixtureDatabaseBaseline, validateLogicalTableEvidence } = db;

export function validateFixturePreflight(
  result,
  artifact,
  sourceSnapshot,
  fixture,
  containerMount,
  imageId,
  monitorStartedAt = null,
  expectedProfile = 'final10k',
  expectedPhase = 'main10k',
) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'fixture preflight checksum is invalid');
  invariant(result?.schemaVersion === 1 && result?.type === 'cascade-capacity-fixture-preflight',
    'fixture preflight schema is invalid');
  invariant(result.profile === expectedProfile && CAPACITY_PROFILES[expectedProfile],
    'fixture preflight profile differs from the requested capacity profile');
  invariant(result.phase === expectedPhase && CAPACITY_PHASES.has(expectedPhase),
    'fixture preflight phase differs from the requested capacity phase');
  invariant(result.imageId === imageId
    && result.containerId === containerMount.inspection.Id,
  'fixture preflight image or container differs from capacity evidence');
  invariant(result.containerStartedAt === '0001-01-01T00:00:00Z',
    'fixture preflight container had already been started');
  invariant(stableJson(result.runtime) === stableJson(containerRuntimeEvidence(containerMount.inspection)),
    'fixture preflight runtime shape differs from current container inspect');
  invariant(result.mountDestination === containerMount.mountDestination
    && result.mountSourceSha256 === containerMount.mountSourceSha256
    && result.relativeDatabase === containerMount.relativeDatabase,
  'fixture preflight data mount differs from the owned capacity container');
  invariant(result.sourceDatabaseSha256 === sourceSnapshot.database.sha256
    && result.sourceCorpusSha256 === sourceSnapshot.corpus.sha256
    && result.fixtureSha256 === fixture.sha256,
  'fixture preflight source or fixture identity differs from certification inputs');
  invariant(DIGEST_PATTERN.test(result.databaseSha256 || '')
    && Number.isInteger(result.databaseBytes) && result.databaseBytes > sourceSnapshot.database.bytes
    && /^[0-9]+$/u.test(result.databaseDevice || '') && /^[0-9]+$/u.test(result.databaseInode || ''),
  'fixture preflight database identity is missing or invalid');
  invariant(stableJson(result.baseline) === stableJson(expectedFixtureDatabaseBaseline(sourceSnapshot, fixture)),
    'fixture preflight database counts differ from the production-derived fixture contract');
  invariant(result.identity?.users === fixture.users
    && result.identity?.groups === fixture.groups
    && result.identity?.userMismatches === 0
    && result.identity?.membershipMismatches === 0
    && result.identity?.vaultMismatches === 0
    && result.identity?.channelMismatches === 0
    && result.identity?.activityMismatches === 0
    && DIGEST_PATTERN.test(result.identity?.identitySha256 || ''),
  'fixture preflight identity-to-database joins are incomplete or failed');
  invariant(result.sourceRows?.sourceSha256 === sourceSnapshot.database.sha256
    && result.sourceRows?.forbiddenChanges === 0
    && result.sourceRows?.missingRows === 0
    && Number.isInteger(result.sourceRows?.extraRows)
    && DIGEST_PATTERN.test(result.sourceRows?.tableEvidenceSha256 || '')
    && DIGEST_PATTERN.test(result.sourceRows?.schemaMigrationSha256 || '')
    && DIGEST_PATTERN.test(result.sourceRows?.schemaEvidenceSha256 || '')
    && result.sourceRows?.schemaValidation === 'pinned Elixir transform passed'
    && Number.isInteger(result.sourceRows?.chatTransforms?.rows)
    && DIGEST_PATTERN.test(result.sourceRows?.chatTransforms?.sha256 || '')
    && result.sourceRows?.fts?.integrityCheck === 'rank=1 passed on disposable snapshot',
  'fixture preflight does not prove exact preservation of approved production rows');
  validateLogicalTableEvidence(result.sourceRows);
  const createdAt = Date.parse(result.createdAt);
  invariant(Number.isFinite(createdAt)
    && (monitorStartedAt == null || createdAt <= Date.parse(monitorStartedAt)),
  'fixture preflight timestamp is invalid or later than monitor start');
  invariant(result.walPresent === false && result.shmPresent === false,
    'fixture preflight database was not closed and checkpointed');
  invariant(result.snapshotScratch?.policy
    === 'private owned disk-backed scratch with at least 2 GiB free'
    && /^[0-9]+$/u.test(result.snapshotScratch?.device || '')
    && result.snapshotScratch?.availableBytes >= 2 * 1024 ** 3,
  'fixture preflight did not use the required disk-backed snapshot scratch');
  invariant(['vaults', 'qmd'].every((name) => (
    Number.isInteger(result.candidateCorpus?.[name]?.approvedRecords)
    && result.candidateCorpus[name].approvedRecords > 0
    && DIGEST_PATTERN.test(result.candidateCorpus[name].approvedSha256 || '')
    && result.candidateCorpus[name].missingOrChanged === 0
    && result.candidateCorpus[name].unexpectedExtras === 0
    && result.candidateCorpus[name].derivedIndexChanges === 0
    && DIGEST_PATTERN.test(result.candidateCorpus[name].extrasSha256 || '')
    && DIGEST_PATTERN.test(result.candidateCorpus[name].derivedIndexChangesSha256 || '')
  )), 'fixture preflight candidate corpus evidence is incomplete or failed');
  return {
    sha256: artifact.sha256,
    profile: result.profile,
    phase: result.phase,
    imageId,
    containerId: result.containerId,
    containerStartedAt: result.containerStartedAt,
    runtime: result.runtime,
    mountDestination: result.mountDestination,
    mountSourceSha256: result.mountSourceSha256,
    relativeDatabase: result.relativeDatabase,
    sourceDatabaseSha256: result.sourceDatabaseSha256,
    sourceCorpusSha256: result.sourceCorpusSha256,
    fixtureSha256: result.fixtureSha256,
    databaseSha256: result.databaseSha256,
    databaseBytes: result.databaseBytes,
    databaseDevice: result.databaseDevice,
    databaseInode: result.databaseInode,
    baseline: result.baseline,
    identity: result.identity,
    sourceRows: result.sourceRows,
    candidateCorpus: result.candidateCorpus,
    snapshotScratch: result.snapshotScratch,
    createdAt: result.createdAt,
  };
}
export function validateFreezeEvidence(result, artifact, preflightEvidence, imageId) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'phase freeze checksum is invalid');
  invariant(result?.schemaVersion === 1 && result?.type === 'cascade-capacity-phase-freeze',
    'phase freeze schema is invalid');
  invariant(result.phase === preflightEvidence.phase && result.profile === preflightEvidence.profile
    && result.imageId === imageId && result.containerId === preflightEvidence.containerId,
  'phase freeze identity differs from its preflight');
  invariant(result.mountSourceSha256 === preflightEvidence.mountSourceSha256
    && result.databaseDevice === preflightEvidence.databaseDevice
    && result.databaseInode === preflightEvidence.databaseInode,
  'phase freeze data root or database inode differs from its preflight');
  invariant(stableJson(result.runtime) === stableJson(preflightEvidence.runtime),
    'phase freeze runtime shape differs from preflight');
  invariant(DIGEST_PATTERN.test(result.databaseSha256 || '')
    && Number.isInteger(result.databaseBytes) && result.databaseBytes >= preflightEvidence.databaseBytes
    && Number.isFinite(Date.parse(result.frozenAt)),
  'phase freeze database identity or timestamp is invalid');
  invariant(result.walPresent === false && result.shmPresent === false,
    'phase freeze database was not checkpointed and closed');
  invariant(result.containerState?.running === false
    && result.containerState?.restartCount === 0 && result.containerState?.oomKilled === false,
  'phase freeze container was not cleanly stopped');
  const containerStartedAt = Date.parse(result.containerStartedAt);
  const frozenAt = Date.parse(result.frozenAt);
  invariant(Number.isFinite(containerStartedAt) && Number.isFinite(frozenAt)
    && frozenAt >= containerStartedAt,
  'phase freeze container lifetime is missing or invalid');
  invariant(result.snapshotScratch?.policy
    === 'private owned disk-backed scratch with at least 2 GiB free'
    && /^[0-9]+$/u.test(result.snapshotScratch?.device || '')
    && result.snapshotScratch?.availableBytes >= 2 * 1024 ** 3,
  'phase freeze did not use the required disk-backed snapshot scratch');
  invariant(['vaults', 'qmd'].every((name) => (
    result.candidateCorpus?.[name]?.approvedRecords
      === preflightEvidence.candidateCorpus?.[name]?.approvedRecords
    && result.candidateCorpus?.[name]?.approvedSha256
      === preflightEvidence.candidateCorpus?.[name]?.approvedSha256
    && result.candidateCorpus?.[name]?.missingOrChanged === 0
    && result.candidateCorpus[name].unexpectedExtras === 0
    && result.candidateCorpus[name].derivedIndexChanges === 0
    && DIGEST_PATTERN.test(result.candidateCorpus[name].extrasSha256 || '')
    && DIGEST_PATTERN.test(result.candidateCorpus[name].derivedIndexChangesSha256 || '')
  )), 'phase freeze candidate corpus evidence is incomplete or failed');
  invariant(result.sourceRows?.sourceSha256 === PRODUCTION_SOURCE_DATABASE.sha256
    && result.sourceRows?.forbiddenChanges === 0
    && DIGEST_PATTERN.test(result.sourceRows?.tableEvidenceSha256 || '')
    && DIGEST_PATTERN.test(result.sourceRows?.schemaEvidenceSha256 || '')
    && result.sourceRows?.schemaValidation === 'pinned Elixir transform passed'
    && result.sourceRows?.fts?.integrityCheck === 'rank=1 passed on disposable snapshot',
  'phase freeze does not preserve approved production rows');
  validateLogicalTableEvidence(
    result.sourceRows,
    preflightEvidence.sourceRows.tableNames,
  );
  invariant(stableJson(result.identity) === stableJson(preflightEvidence.identity),
    'phase freeze fixture identity joins differ from preflight');
  const expectedOrphanState = frozenAt - containerStartedAt >= ORPHAN_RECLAIM_MS
    ? 'reclaimed' : 'preserved';
  invariant(result.orphanState?.state === expectedOrphanState,
  'phase freeze baseline orphan state differs from its duration contract');
  return {
    sha256: artifact.sha256,
    phase: result.phase,
    profile: result.profile,
    imageId,
    containerId: result.containerId,
    mountSourceSha256: result.mountSourceSha256,
    databaseSha256: result.databaseSha256,
    databaseBytes: result.databaseBytes,
    databaseDevice: result.databaseDevice,
    databaseInode: result.databaseInode,
    baseline: result.baseline,
    runtime: result.runtime,
    candidateCorpus: result.candidateCorpus,
    sourceRows: result.sourceRows,
    identity: result.identity,
    orphanState: result.orphanState,
    phaseWorkload: result.phaseWorkload,
    snapshotScratch: result.snapshotScratch,
    containerStartedAt: result.containerStartedAt,
    frozenAt: result.frozenAt,
  };
}

export function validatePhaseTableDeltas(freezeEvidence, fixture, workload) {
  validateLogicalTableEvidence(freezeEvidence.sourceRows);
  const deltas = new Map(freezeEvidence.sourceRows.tableDeltas
    .map((row) => [row.tableName, row]));
  invariant(deltas.size > 0, `phase ${freezeEvidence.phase} has no logical table deltas`);
  const expectedExtras = {
    users: fixture.users,
    vaults: fixture.groups,
    vault_members: fixture.users,
    notes: fixture.groups,
    community_note_activity: fixture.groups,
  };
  const orphanReclaimed = freezeEvidence.orphanState?.state === 'reclaimed';
  if (freezeEvidence.phase === 'main10k') {
    expectedExtras.chat_messages = workload.successfulChatWrites;
    expectedExtras.runs = workload.successfulRuns;
    expectedExtras.run_events = workload.successfulRuns * 4;
  } else if (freezeEvidence.phase === 'faults') {
    expectedExtras.chat_messages = 1;
    expectedExtras.runs = 1;
    expectedExtras.run_events = workload.runEvents;
  } else if (freezeEvidence.phase === 'soak5k') {
    expectedExtras.runs = workload.runCount;
    expectedExtras.run_events = workload.persistedEventCount;
  }
  if (orphanReclaimed) {
    expectedExtras.runs = (expectedExtras.runs || 0) + 2;
    expectedExtras.run_events = (expectedExtras.run_events || 0) + 2;
  }
  for (const [table, row] of deltas) {
    const expectedMissing = orphanReclaimed && ['runs', 'delegated_runs'].includes(table) ? 2 : 0;
    invariant(row.missingRows === expectedMissing,
      `phase ${freezeEvidence.phase} table ${table} changes ${row.missingRows} approved rows`);
    invariant(row.extraRows === (expectedExtras[table] || 0),
      `phase ${freezeEvidence.phase} table ${table} has ${row.extraRows} unexpected rows`);
  }
  return true;
}

export function validateFrozenPhaseAgainstMount(
  sourceDatabase,
  sourceCorpusRoot,
  fixtureArtifact,
  preflightEvidence,
  freezeEvidence,
  mount,
) {
  invariant(mount.inspection.Id === freezeEvidence.containerId
    && mount.inspection.Image === freezeEvidence.imageId
    && mount.inspection.State?.Running === false
    && mount.inspection.RestartCount === 0
    && mount.inspection.State?.OOMKilled === false
    && mount.inspection.State?.StartedAt === freezeEvidence.containerStartedAt,
  `phase ${freezeEvidence.phase} frozen container identity or state drifted`);
  invariant(stableJson(containerRuntimeEvidence(mount.inspection)) === stableJson(freezeEvidence.runtime),
    `phase ${freezeEvidence.phase} frozen runtime shape drifted`);
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${mount.database}${suffix}`),
      `phase ${freezeEvidence.phase} frozen database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const database = digestRegularFile(mount.database, `${freezeEvidence.phase} frozen database`);
  invariant(database.sha256 === freezeEvidence.databaseSha256
    && database.bytes === freezeEvidence.databaseBytes
    && database.device === freezeEvidence.databaseDevice
    && database.inode === freezeEvidence.databaseInode,
  `phase ${freezeEvidence.phase} frozen database identity drifted`);
  const expected = {
    baseline: databaseBaseline(mount.database),
    identity: validateFixtureDatabaseIdentity(mount.database, fixtureArtifact),
    candidateCorpus: validateCandidateCorpus(
      sourceCorpusRoot, mount, mount.database, fixtureArtifact, { postRun: true },
    ),
    sourceRows: compareProductionRows(sourceDatabase, mount.database, {
      profileName: preflightEvidence.profile,
      phase: 'post-run',
      allowOrphanReclaim: freezeEvidence.orphanState.state === 'reclaimed',
    }),
    orphanState: validateBaselineOrphanState(
      mount.database, freezeEvidence.orphanState.state === 'reclaimed',
    ),
    phaseWorkload: phaseWorkloadEvidence(mount.database, freezeEvidence.phase),
  };
  for (const [name, value] of Object.entries(expected)) {
    invariant(stableJson(value) === stableJson(freezeEvidence[name]),
      `phase ${freezeEvidence.phase} frozen ${name} differs from independent database/corpus evidence`);
  }
  return true;
}
