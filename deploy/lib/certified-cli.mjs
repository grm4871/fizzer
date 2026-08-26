// Certified-image CLI: orchestrate preflight, freeze, certification, verification, and field reads.
// Inputs are preserved command flags; outputs remain existing stdout paths/IDs; failures retain nonzero exit behavior.
// Ordering follows the release lifecycle: preflight -> workloads -> freezes -> manifest -> image/checksum verification.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as p from './certified-primitives.mjs';
import * as source from './certified-source-evidence.mjs';
import * as db from './certified-database-evidence.mjs';
import * as phase from './certified-phase-evidence.mjs';
import * as monitor from './certified-monitor-evidence.mjs';
import * as load from './certified-load-evidence.mjs';
import { validateSoakEvidence } from './certified-soak-evidence.mjs';
import { validateManifest } from './certified-manifest.mjs';
import * as image from './certified-image-verification.mjs';

const { root, invariant, stableJson, configureSnapshotScratch, artifactSnapshot, digestRegularFile, parseArgs, REQUIRED_FAULTS } = p;
const { collectProductionSourceEvidence, inspectContainerDataMount, containerRuntimeEvidence, databaseBaseline, expectedFixtureDatabaseBaseline, validateFixtureDatabaseIdentity, validateCandidateCorpus } = source;
const { compareProductionRows, phaseWorkloadEvidence, validateBaselineOrphanState } = db;
const { validateFixturePreflight, validatePhaseTableDeltas, validateFrozenPhaseAgainstMount } = phase;
const { validateMonitorEvidence, validateServerLogArtifact, validateLoadEvidence, validateCapacityFixtureArtifact } = monitor;
const { validateLoadProvenance, validateReconciliationEvidence, validateRuntimeProof, validateFaultEvidence, validateFaultPersistence, validatePhaseChronology } = load;
const { inspectImage, runtimeImageId, verifyImage, verifyChecksum, requireExactCheckout } = image;

function writeExclusiveJson(filename, value) {
  const output = path.resolve(filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  return output;
}

export function preflight(options) {
  invariant(options.container, '--container is required');
  invariant(options.sourceDatabase, '--source-database is required');
  invariant(options.sourceCorpusRoot, '--source-corpus-root is required');
  invariant(options.fixture, '--fixture is required');
  invariant(options.output, '--output is required');
  const snapshotScratch = configureSnapshotScratch(options.scratchDirectory);
  invariant(CAPACITY_PROFILES[options.profile],
    '--profile must be diagnostic1k or final10k');
  invariant(CAPACITY_PHASES.has(options.phase),
    '--phase must be diagnostic, main10k, faults, or soak5k');
  invariant((options.phase === 'diagnostic') === (options.profile === 'diagnostic1k'),
    'diagnostic phase requires diagnostic1k and release phases require final10k');
  const mount = inspectContainerDataMount(options.container);
  invariant(mount.inspection.State?.Running === false
    && mount.inspection.RestartCount === 0 && mount.inspection.State?.OOMKilled === false,
  'fixture preflight requires a never-started/stopped healthy capacity container');
  invariant(mount.inspection.State?.StartedAt === '0001-01-01T00:00:00Z',
    'fixture preflight refuses a previously started container');
  const runtime = containerRuntimeEvidence(mount.inspection);
  const sourceSnapshot = collectProductionSourceEvidence(options.sourceDatabase, options.sourceCorpusRoot);
  const fixtureArtifact = artifactSnapshot(options.fixture, 'capacity fixture evidence');
  const fixture = validateCapacityFixtureArtifact(fixtureArtifact, options.profile);
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${mount.database}${suffix}`),
      `fixture preflight database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const database = digestRegularFile(mount.database, 'fixture preflight database');
  const baseline = databaseBaseline(mount.database);
  const identity = validateFixtureDatabaseIdentity(mount.database, fixtureArtifact);
  const sourceRows = compareProductionRows(options.sourceDatabase, mount.database, {
    profileName: options.profile,
    phase: 'preflight',
  });
  const candidateCorpus = validateCandidateCorpus(
    options.sourceCorpusRoot,
    mount,
    mount.database,
    fixtureArtifact,
  );
  invariant(stableJson(baseline) === stableJson(expectedFixtureDatabaseBaseline(sourceSnapshot, fixture)),
    'fixture preflight database is not an exact production-derived fixture');
  const evidence = {
    schemaVersion: 1,
    type: 'cascade-capacity-fixture-preflight',
    profile: options.profile,
    phase: options.phase,
    imageId: mount.inspection.Image,
    containerId: mount.inspection.Id,
    containerStartedAt: mount.inspection.State.StartedAt,
    runtime,
    mountDestination: mount.mountDestination,
    mountSourceSha256: mount.mountSourceSha256,
    relativeDatabase: mount.relativeDatabase,
    sourceDatabaseSha256: sourceSnapshot.database.sha256,
    sourceCorpusSha256: sourceSnapshot.corpus.sha256,
    fixtureSha256: fixture.sha256,
    databaseSha256: database.sha256,
    databaseBytes: database.bytes,
    databaseDevice: database.device,
    databaseInode: database.inode,
    baseline,
    identity,
    sourceRows,
    candidateCorpus,
    snapshotScratch,
    walPresent: false,
    shmPresent: false,
    createdAt: new Date().toISOString(),
  };
  const output = writeExclusiveJson(options.output, evidence);
  process.stdout.write(`${output}\n`);
}
export function freeze(options) {
  invariant(options.container, '--container is required');
  invariant(options.sourceDatabase, '--source-database is required');
  invariant(options.sourceCorpusRoot, '--source-corpus-root is required');
  invariant(options.fixture, '--fixture is required');
  invariant(options.preflight, '--preflight is required');
  invariant(options.output, '--output is required');
  const snapshotScratch = configureSnapshotScratch(options.scratchDirectory);
  const preflightArtifact = artifactSnapshot(options.preflight, 'phase preflight evidence');
  const preflightResult = JSON.parse(preflightArtifact.text);
  const mount = inspectContainerDataMount(options.container);
  invariant(mount.inspection.State?.Running === false
    && mount.inspection.RestartCount === 0 && mount.inspection.State?.OOMKilled === false,
  'phase freeze requires the exact stopped healthy capacity container');
  const sourceSnapshot = collectProductionSourceEvidence(options.sourceDatabase, options.sourceCorpusRoot);
  const fixtureArtifact = artifactSnapshot(options.fixture, 'capacity fixture evidence');
  const fixture = validateCapacityFixtureArtifact(fixtureArtifact, preflightResult.profile);
  const preflightEvidence = validateFixturePreflight(
    preflightResult,
    preflightArtifact,
    sourceSnapshot,
    fixture,
    mount,
    mount.inspection.Image,
    null,
    preflightResult.profile,
    preflightResult.phase,
  );
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${mount.database}${suffix}`),
      `phase freeze database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const database = digestRegularFile(mount.database, 'phase freeze database');
  invariant(database.device === preflightEvidence.databaseDevice
    && database.inode === preflightEvidence.databaseInode,
  'phase freeze database inode differs from preflight');
  const frozenAt = new Date().toISOString();
  const containerStartedAt = mount.inspection.State?.StartedAt;
  const startedAtMs = Date.parse(containerStartedAt);
  const frozenAtMs = Date.parse(frozenAt);
  invariant(Number.isFinite(startedAtMs) && Number.isFinite(frozenAtMs)
    && frozenAtMs >= startedAtMs,
  'phase freeze cannot bind the owned container lifetime');
  const longRunning = frozenAtMs - startedAtMs >= ORPHAN_RECLAIM_MS;
  const evidence = {
    schemaVersion: 1,
    type: 'cascade-capacity-phase-freeze',
    phase: preflightEvidence.phase,
    profile: preflightEvidence.profile,
    imageId: mount.inspection.Image,
    containerId: mount.inspection.Id,
    mountSourceSha256: mount.mountSourceSha256,
    databaseSha256: database.sha256,
    databaseBytes: database.bytes,
    databaseDevice: database.device,
    databaseInode: database.inode,
    runtime: containerRuntimeEvidence(mount.inspection),
    baseline: databaseBaseline(mount.database),
    identity: validateFixtureDatabaseIdentity(mount.database, fixtureArtifact),
    candidateCorpus: validateCandidateCorpus(
      options.sourceCorpusRoot,
      mount,
      mount.database,
      fixtureArtifact,
      { postRun: true },
    ),
    sourceRows: compareProductionRows(
      options.sourceDatabase,
      mount.database,
      {
        profileName: preflightEvidence.profile,
        phase: 'post-run',
        allowOrphanReclaim: longRunning,
      },
    ),
    orphanState: validateBaselineOrphanState(mount.database, longRunning),
    phaseWorkload: phaseWorkloadEvidence(mount.database, preflightEvidence.phase),
    snapshotScratch,
    containerState: {
      running: mount.inspection.State.Running,
      restartCount: mount.inspection.RestartCount,
      oomKilled: mount.inspection.State.OOMKilled,
    },
    containerStartedAt,
    walPresent: false,
    shmPresent: false,
    frozenAt,
  };
  const output = writeExclusiveJson(options.output, evidence);
  process.stdout.write(`${output}\n`);
}
export function certify(options) {
  invariant(options.image, '--image is required');
  invariant(options.monitor, '--monitor is required');
  invariant(options.sourceDatabase, '--source-database is required');
  invariant(options.sourceCorpusRoot, '--source-corpus-root is required');
  invariant(options.fixture, '--fixture is required');
  invariant(options.loadDriver, '--load-driver is required');
  invariant(options.reconciliationDriver, '--reconciliation-driver is required');
  invariant(options.reconciliation, '--reconciliation is required');
  invariant(options.fixturePreflight, '--fixture-preflight is required for phase A');
  invariant(options.faultPreflight, '--fault-preflight is required for phase B');
  invariant(options.soakPreflight, '--soak-preflight is required for phase C');
  invariant(options.runtimeProof, '--runtime-proof is required');
  invariant(options.mainFreeze, '--main-freeze is required');
  invariant(options.faultFreeze, '--fault-freeze is required');
  invariant(options.soakFreeze, '--soak-freeze is required');
  configureSnapshotScratch(options.scratchDirectory);
  invariant(options.loadResults.length > 0, '--load-result is required for every shard');
  invariant(options.faultResults.length === REQUIRED_FAULTS.size,
    '--fault-result is required for runner restart and SQLite lock recovery');
  invariant(options.soakResult, '--soak-result is required for the 5,000-user two-hour soak');
  const inspection = inspectImage(options.image);
  const imageId = runtimeImageId(inspection);
  const revision = inspection.Config?.Labels?.['org.opencontainers.image.revision'];
  invariant(SHA_PATTERN.test(revision || ''), 'image has no full Git revision label');
  invariant(options.image === `cascade:certified-${revision}`, 'certification requires the canonical revision tag');
  requireExactCheckout(revision, true);

  const monitorArtifact = artifactSnapshot(options.monitor, 'capacity monitor evidence');
  const monitorRecords = monitorArtifact.text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const { start, finish } = validateMonitorEvidence(monitorRecords, imageId);
  validateServerLogArtifact(start, finish);
  const loadArtifacts = options.loadResults.map((filename) => artifactSnapshot(filename, 'load-shard evidence'));
  const loadResults = loadArtifacts.map((artifact) => JSON.parse(artifact.text));
  const load = validateLoadEvidence(loadResults, start, finish, loadArtifacts);
  const sourceSnapshot = collectProductionSourceEvidence(options.sourceDatabase, options.sourceCorpusRoot);
  const fixtureArtifact = artifactSnapshot(options.fixture, 'capacity fixture evidence');
  const fixture = validateCapacityFixtureArtifact(fixtureArtifact);
  const loadDriverArtifact = digestRegularFile(options.loadDriver, 'capacity load-driver evidence');
  const reconciliationDriverArtifact = digestRegularFile(
    options.reconciliationDriver,
    'capacity reconciliation-driver evidence',
  );
  const preflightInputs = [
    ['main10k', options.fixturePreflight, start.observedAt],
    ['faults', options.faultPreflight, null],
    ['soak5k', options.soakPreflight, null],
  ];
  const preflights = Object.fromEntries(preflightInputs.map(([phase, filename, monitorStartedAt]) => {
    const artifact = artifactSnapshot(filename, `${phase} fixture preflight evidence`);
    const result = JSON.parse(artifact.text);
    const mount = inspectContainerDataMount(result.containerId || '');
    const evidence = validateFixturePreflight(
      result,
      artifact,
      sourceSnapshot,
      fixture,
      mount,
      imageId,
      monitorStartedAt,
      'final10k',
      phase,
    );
    return [phase, { artifact, result, mount, evidence }];
  }));
  const distinctPreflightValues = (selector, label) => {
    const values = Object.values(preflights).map((entry) => selector(entry.evidence));
    invariant(new Set(values).size === values.length, `capacity phase ${label} values are not pairwise distinct`);
  };
  distinctPreflightValues((entry) => entry.containerId, 'container');
  distinctPreflightValues((entry) => entry.mountSourceSha256, 'data-root');
  distinctPreflightValues((entry) => `${entry.databaseDevice}:${entry.databaseInode}`, 'database inode');
  invariant(preflights.main10k.evidence.containerId === start.containerId,
    'main monitor container differs from phase A preflight');
  const runtimeProofArtifact = artifactSnapshot(options.runtimeProof, 'owned runtime proof');
  const runtimeProof = validateRuntimeProof(
    JSON.parse(runtimeProofArtifact.text),
    runtimeProofArtifact,
    preflights.main10k.evidence,
    imageId,
    revision,
    loadDriverArtifact,
    reconciliationDriverArtifact,
  );
  invariant(Date.parse(runtimeProof.executedAt) >= Date.parse(preflights.main10k.evidence.createdAt)
    && Date.parse(runtimeProof.executedAt) <= Date.parse(start.observedAt),
  'owned runtime proof is stale or later than monitor start');
  const loadDriver = validateLoadProvenance(loadResults, loadDriverArtifact, fixture);
  const reconciliationArtifact = artifactSnapshot(options.reconciliation, 'capacity reconciliation evidence');
  const reconciliationResult = JSON.parse(reconciliationArtifact.text);
  const reconciliation = validateReconciliationEvidence(
    reconciliationResult,
    reconciliationArtifact,
    sourceSnapshot,
    fixture,
    fixtureArtifact,
    loadResults,
    loadArtifacts,
    preflights.main10k.mount,
    preflights.main10k.evidence,
    finish.observedAt,
    reconciliationDriverArtifact,
    runtimeProof.embedded.reconciliationDriverSha256,
  );
  const faultArtifacts = options.faultResults.map((filename) => artifactSnapshot(filename, 'fault-recovery evidence'));
  const faultResults = faultArtifacts.map((artifact) => JSON.parse(artifact.text));
  const faults = validateFaultEvidence(
    faultResults,
    faultArtifacts,
    imageId,
    revision,
    start.monitorConfig.expectedLoad.target,
    fixtureArtifact.sha256,
  );
  invariant(faultResults.every((result) => result.containerId === preflights.faults.evidence.containerId),
    'fault evidence did not run in the owned phase B container');
  const soakArtifact = artifactSnapshot(options.soakResult, 'two-hour soak evidence');
  const soakResult = JSON.parse(soakArtifact.text);
  const soakJournalArtifact = artifactSnapshot(
    soakResult.journal?.path || '',
    'two-hour soak runtime journal',
  );
  const soakFixtureArtifact = artifactSnapshot(
    soakResult.fixtures?.path || '',
    'two-hour soak fixture artifact',
  );
  const soakServerLogArtifact = artifactSnapshot(
    soakResult.serverLogs?.output || '',
    'two-hour soak server-log artifact',
  );
  const soak = validateSoakEvidence(
    soakResult,
    soakArtifact,
    soakJournalArtifact,
    soakFixtureArtifact,
    soakServerLogArtifact,
    imageId,
    revision,
    start.monitorConfig.expectedLoad.target,
  );
  invariant(soak.containerId === preflights.soak5k.evidence.containerId,
    'two-hour soak did not run in the owned phase C container');
  invariant(soak.fixtures.sha256 === fixtureArtifact.sha256,
    'two-hour soak used a different authenticated fixture cohort');
  const freezeInputs = [
    ['main10k', options.mainFreeze],
    ['faults', options.faultFreeze],
    ['soak5k', options.soakFreeze],
  ];
  const freezes = Object.fromEntries(freezeInputs.map(([phase, filename]) => {
    const artifact = artifactSnapshot(filename, `${phase} freeze evidence`);
    const evidence = validateFreezeEvidence(
      JSON.parse(artifact.text), artifact, preflights[phase].evidence, imageId,
    );
    return [phase, evidence];
  }));
  for (const phase of ['main10k', 'faults', 'soak5k']) {
    validateFrozenPhaseAgainstMount(
      options.sourceDatabase,
      options.sourceCorpusRoot,
      fixtureArtifact,
      preflights[phase].evidence,
      freezes[phase],
      preflights[phase].mount,
    );
  }
  validatePhaseChronology(
    Object.fromEntries(Object.entries(preflights).map(([phase, entry]) => [phase, entry.evidence])),
    freezes,
    reconciliation,
    faultResults,
    soak,
  );
  invariant(freezes.main10k.phaseWorkload?.runs === reconciliation.expected.successfulRuns
    && freezes.main10k.phaseWorkload?.completedRuns === reconciliation.expected.successfulRuns
    && freezes.main10k.phaseWorkload?.runEvents === reconciliation.expected.successfulRuns * 4
    && freezes.main10k.phaseWorkload?.messages === reconciliation.expected.successfulChatWrites,
  'phase A freeze workload differs from reconciliation evidence');
  validateFaultPersistence(freezes.faults.phaseWorkload, faults);
  invariant(freezes.soak5k.phaseWorkload?.runs === soak.runCount
    && freezes.soak5k.phaseWorkload?.completedRuns === soak.runCount
    && freezes.soak5k.phaseWorkload?.runEvents === soak.persistedEventCount
    && freezes.soak5k.phaseWorkload?.messages === 0,
  'phase C freeze workload differs from two-hour soak evidence');
  validatePhaseTableDeltas(freezes.main10k, fixture, reconciliation.expected);
  validatePhaseTableDeltas(freezes.faults, fixture, freezes.faults.phaseWorkload);
  validatePhaseTableDeltas(freezes.soak5k, fixture, soak);
  const output = path.resolve(options.output || path.join(root, '.cascade-release', `${revision}.json`));
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const manifest = validateManifest({
    schemaVersion: 2,
    status: 'certified',
    revision,
    image: { id: imageId, tag: options.image },
    certification: {
      certifiedAt: new Date().toISOString(),
      totalUsers: load.users,
      shardCount: load.shardCount,
      target: start.monitorConfig.expectedLoad.target,
      provenance: {
        sourceSnapshot,
        fixture,
        loadDriver,
        runtimeProof,
        preflights: Object.fromEntries(Object.entries(preflights).map(
          ([phase, entry]) => [phase, entry.evidence],
        )),
        freezes,
        reconciliation,
      },
      monitor: {
        sha256: monitorArtifact.sha256,
        imageId: start.imageId,
        containerId: start.containerId,
        containerStartedAt: finish.containerState.startedAt,
        serverLogs: {
          policy: start.serverLogEvidence.policy,
          baselineCursor: finish.serverLogs.baselineCursor,
          finishCursor: finish.serverLogs.finishCursor,
          readError: finish.serverLogs.readError,
          sha256: finish.serverLogs.sha256,
          totalBytes: finish.serverLogs.totalBytes,
          totalLines: finish.serverLogs.totalLines,
          matchedErrorLines: finish.serverLogs.matchedErrorLines,
          matchesTruncated: finish.serverLogs.matchesTruncated,
        },
        runtimeEnvelope: {
          cpus: start.expectedShape.cpus,
          cpuset: start.hostConfig.cpusetCpus,
          memoryBytes: start.hostConfig.memory,
          memorySwapBytes: start.hostConfig.memorySwap,
          pidsLimit: start.hostConfig.pidsLimit,
          nofileSoft: start.hostConfig.ulimits.find((entry) => entry.Name === 'nofile').Soft,
          nofileHard: start.hostConfig.ulimits.find((entry) => entry.Name === 'nofile').Hard,
        },
        runtimeConfiguration: start.expectedShape.runtime,
        sessions: start.expectedShape.sessions,
        runners: start.expectedShape.runners,
        memberships: start.expectedShape.memberships,
        durationSeconds: start.monitorConfig.durationSeconds,
        gateWindowSeconds: start.monitorConfig.gateWindowSeconds,
        gateStartAt: load.gateStartAt,
        gateEndAt: load.gateEndAt,
        coverage: {
          sessions: finish.evaluation.observed.sessionCoverage,
          runners: finish.evaluation.observed.runnerCoverage,
          memberships: finish.evaluation.observed.membershipCoverage,
          sessionsEnd: finish.evaluation.observed.sessionsEnd,
          runnersEnd: finish.evaluation.observed.runnersEnd,
          membershipsEnd: finish.evaluation.observed.membershipsEnd,
        },
        realtime: validateRealtimeEvidence(
          start.expectedShape.realtime,
          finish.workload.presencePlan,
          finish.evaluation.observed,
          start.expectedShape.sessions,
          start.expectedShape.runners,
        ),
        workload: {
          finishedAt: finish.workload.finishedAt,
          elapsedSeconds: finish.workload.elapsedSeconds,
          postWorkloadSeconds: finish.workload.postWorkloadSeconds,
          users: finish.workload.users,
          shardCount: finish.workload.shards.length,
          presencePlan: finish.workload.presencePlan,
          shards: finish.workload.shards.map((shard) => ({
            shard: shard.index,
            sha256: shard.sha256,
            initialOwnedChatChannels: shard.initialOwnedChatChannels,
            forcedReconnectOwnedChatChannels: shard.forcedReconnectOwnedChatChannels,
            forcedReconnectStrategy: shard.forcedReconnectStrategy,
            forcedReconnectOwnerUserIds: shard.forcedReconnectOwnerUserIds,
            successfulMessageIdsCount: shard.successfulMessageIdsCount,
            successfulMessageIdsSha256: shard.successfulMessageIdsSha256,
            requestedRunIdsCount: shard.requestedRunIdsCount,
            requestedRunIdsSha256: shard.requestedRunIdsSha256,
          })),
        },
        evaluation: finish.evaluation.ok ? 'passed' : 'failed',
      },
      loads: options.loadResults.map((filename, index) => ({
        shard: loadResults[index].shard.index,
        sha256: loadArtifacts[index].sha256,
        users: loadResults[index].requestedUsers,
        sourceIp: loadResults[index].sourceIp,
        rampSeconds: loadResults[index].rampSeconds,
        soakSeconds: loadResults[index].soakSeconds,
        pollingPercent: loadResults[index].pollingPercent,
        reconnectPercent: loadResults[index].reconnectPercent,
        reconnectAtSeconds: loadResults[index].reconnectAtSeconds,
        selectionPlan: {
          forcedReconnectStrategy: loadResults[index].selectionPlan.forcedReconnectStrategy,
          forcedReconnectOwnerUserIds: loadResults[index].selectionPlan.forcedReconnectOwnerUserIds,
        },
        presencePlan: loadResults[index].presencePlan,
        rates: loadResults[index].rates,
        thresholds: loadResults[index].thresholds,
        successfulChatWrites: loadResults[index].metrics.workload.chat.succeeded,
        successfulRuns: loadResults[index].metrics.workload.run.succeeded,
        workloadIdentity: {
          successfulMessageIdsCount: loadResults[index].workloadIdentity.successfulMessageIdsCount,
          successfulMessageIdsSha256: loadResults[index].workloadIdentity.successfulMessageIdsSha256,
          requestedRunIdsCount: loadResults[index].workloadIdentity.requestedRunIdsCount,
          requestedRunIdsSha256: loadResults[index].workloadIdentity.requestedRunIdsSha256,
        },
        rampCompletedAt: loadResults[index].rampCompletedAt,
        soakStartedAt: loadResults[index].soakStartedAt,
        workloadFinishedAt: loadResults[index].workloadFinishedAt,
        finishedAt: loadResults[index].finishedAt,
        configurationSha256: loadResults[index].provenance.configurationSha256,
        evaluation: loadResults[index].evaluation.ok ? 'passed' : 'failed',
      })),
      faults,
      soak,
    },
  });

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, manifestBytes, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, output);
  fs.chmodSync(output, 0o600);
  const checksumTemporary = `${output}.sha256.tmp-${process.pid}`;
  fs.writeFileSync(checksumTemporary, `${manifestDigest}  ${path.basename(output)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(checksumTemporary, `${output}.sha256`);
  fs.chmodSync(`${output}.sha256`, 0o600);
  process.stdout.write(`${output}\n`);
}

export function verify(options) {
  invariant(options.manifest, '--manifest is required');
  const manifestPath = path.resolve(options.manifest);
  const artifact = artifactSnapshot(manifestPath, 'certification manifest');
  const manifest = validateManifest(JSON.parse(artifact.text));
  verifyChecksum(manifestPath, artifact.sha256);
  requireExactCheckout(manifest.revision, false);
  verifyImage(manifest);
  process.stdout.write(`${manifest.image.id}\n`);
}

export function field(options) {
  invariant(options.manifest && options.name, '--manifest and --name are required');
  const manifestPath = path.resolve(options.manifest);
  const artifact = artifactSnapshot(manifestPath, 'certification manifest');
  const manifest = validateManifest(JSON.parse(artifact.text));
  verifyChecksum(manifestPath, artifact.sha256);
  const fields = {
    revision: manifest.revision,
    'image.id': manifest.image.id,
    'image.tag': manifest.image.tag,
  };
  invariant(Object.hasOwn(fields, options.name), `unsupported manifest field ${options.name}`);
  process.stdout.write(`${fields[options.name]}\n`);
}

export function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'preflight') preflight(options);
  else if (command === 'freeze') freeze(options);
  else if (command === 'certify') certify(options);
  else if (command === 'verify') verify(options);
  else if (command === 'field') field(options);
  else throw new Error('usage: certified-image.mjs <preflight|freeze|certify|verify|field> [options]');
}
