// Manifest validator: enforce the certified release schema and all provenance contracts.
// Input is a parsed manifest; output is the same validated object; failures throw before any image use.
// Ordering checks secrets/schema first, then identity, workload, phases, and soak metadata.

import { createHash } from 'node:crypto';
import * as p from './certified-primitives.mjs';
import * as monitor from './certified-monitor-evidence.mjs';
import * as phase from './certified-phase-evidence.mjs';
import * as source from './certified-source-evidence.mjs';
import * as load from './certified-load-evidence.mjs';
import { loadConfiguration } from '../../loadtest_elixir/load.mjs';
import { SOAK_PROFILE, SOAK_RUNTIME_CONFIGURATION, databaseReconciliation as reconcileLongSoakDatabase } from '../../loadtest_elixir/soak-invariants.mjs';

const { stableJson, invariant, assertNoManifestSecrets, DIGEST_PATTERN, SHA_PATTERN, IMAGE_ID_PATTERN,
  CERTIFIED_CPUS, CERTIFIED_CPUSET, CERTIFIED_MEMORY_BYTES, CERTIFIED_PIDS, CERTIFIED_NOFILE,
  REQUIRED_USERS, REQUIRED_MEMBERSHIPS, REQUIRED_SHARDS, REQUIRED_RAMP_SECONDS, REQUIRED_SOAK_SECONDS,
  REQUIRED_MONITOR_SECONDS, REQUIRED_GATE_SECONDS, REQUIRED_POST_WORKLOAD_SECONDS, MINIMUM_COVERAGE_RATIO,
  REQUIRED_FAULTS, REQUIRED_LONG_SOAK_USERS, REQUIRED_LONG_SOAK_SECONDS, REQUIRED_LONG_SOAK_CHURN_PERCENT,
  REQUIRED_LONG_SOAK_CHURN_INTERVAL_SECONDS, REQUIRED_LONG_SOAK_RUN_RPS, CAPACITY_PROFILES,
  PRODUCTION_SOURCE_DATABASE, PRODUCTION_APPLICATION_TABLES, PRODUCTION_APPLICATION_TABLES_SHA256,
} = p;
const { sameIntegerSet, validateRealtimeEvidence } = p;
const { validateProductionSourceSummary } = source;
const { validateCapacityFixtureSummary } = monitor;
const { validatePhaseChronology, validateFaultPersistence } = load;
const { validatePhaseTableDeltas } = phase;

export function validateManifest(manifest) {
  assertNoManifestSecrets(manifest);
  invariant(manifest.schemaVersion === 2, 'unsupported certification manifest version');
  invariant(manifest.status === 'certified', 'image manifest is not certified');
  invariant(SHA_PATTERN.test(manifest.revision || ''), 'manifest revision is invalid');
  invariant(IMAGE_ID_PATTERN.test(manifest.image?.id || ''), 'manifest image ID is invalid');
  invariant(manifest.image?.tag === `cascade:certified-${manifest.revision}`, 'manifest image tag is not canonical');
  const certification = manifest.certification;
  const monitor = certification?.monitor;
  invariant(certification?.totalUsers === REQUIRED_USERS, 'manifest does not certify exactly 10,000 users');
  invariant(certification?.shardCount === REQUIRED_SHARDS, 'manifest does not certify exactly four shards');
  invariant(typeof certification?.target === 'string' && certification.target !== '',
    'manifest does not identify the staging target');
  const provenance = certification?.provenance;
  const sourceSnapshot = validateProductionSourceSummary(provenance?.sourceSnapshot);
  const fixture = validateCapacityFixtureSummary(provenance?.fixture);
  const loadDriver = provenance?.loadDriver;
  invariant(DIGEST_PATTERN.test(loadDriver?.sha256 || '')
    && Number.isInteger(loadDriver?.bytes) && loadDriver.bytes > 0
    && DIGEST_PATTERN.test(loadDriver?.configurationsSha256 || '')
    && Array.isArray(loadDriver?.configurations) && loadDriver.configurations.length === REQUIRED_SHARDS,
  'manifest load-driver provenance is missing or unbound');
  const runtimeProof = provenance?.runtimeProof;
  invariant(runtimeProof?.phase === 'main10k' && runtimeProof?.profile === 'final10k'
    && runtimeProof?.imageId === manifest.image.id && runtimeProof?.revision === manifest.revision
    && runtimeProof?.swapReady === true && DIGEST_PATTERN.test(runtimeProof?.sha256 || '')
    && runtimeProof?.embedded?.loadDriverSha256 === loadDriver.sha256
    && DIGEST_PATTERN.test(runtimeProof?.embedded?.reconciliationDriverSha256 || ''),
  'manifest owned runtime proof is missing, failed, or unbound');
  const preflights = provenance?.preflights;
  const freezes = provenance?.freezes;
  const phases = ['main10k', 'faults', 'soak5k'];
  invariant(phases.every((phase) => (
    preflights?.[phase]?.phase === phase
    && preflights[phase].profile === 'final10k'
    && preflights[phase].imageId === manifest.image.id
    && preflights[phase].sourceDatabaseSha256 === sourceSnapshot.database.sha256
    && preflights[phase].sourceCorpusSha256 === sourceSnapshot.corpus.sha256
    && preflights[phase].fixtureSha256 === fixture.sha256
    && DIGEST_PATTERN.test(preflights[phase].sha256 || '')
    && DIGEST_PATTERN.test(preflights[phase].databaseSha256 || '')
    && freezes?.[phase]?.phase === phase
    && freezes[phase].profile === 'final10k'
    && freezes[phase].imageId === manifest.image.id
    && freezes[phase].containerId === preflights[phase].containerId
    && freezes[phase].mountSourceSha256 === preflights[phase].mountSourceSha256
    && freezes[phase].databaseDevice === preflights[phase].databaseDevice
    && freezes[phase].databaseInode === preflights[phase].databaseInode
    && DIGEST_PATTERN.test(freezes[phase].sha256 || '')
    && DIGEST_PATTERN.test(freezes[phase].databaseSha256 || '')
  )), 'manifest A/B/C preflight or freeze provenance is incomplete or inconsistent');
  invariant(new Set(phases.map((phase) => preflights[phase].containerId)).size === phases.length
    && new Set(phases.map((phase) => preflights[phase].mountSourceSha256)).size === phases.length
    && new Set(phases.map(
      (phase) => `${preflights[phase].databaseDevice}:${preflights[phase].databaseInode}`,
    )).size === phases.length,
  'manifest A/B/C containers, data roots, or database inodes are reused');
  invariant(runtimeProof.containerId === preflights.main10k.containerId,
    'manifest runtime proof does not belong to phase A');
  const reconciliation = provenance?.reconciliation;
  invariant(reconciliation?.evaluation === 'passed'
    && DIGEST_PATTERN.test(reconciliation?.sha256 || '')
    && DIGEST_PATTERN.test(reconciliation?.databaseSha256 || '')
    && DIGEST_PATTERN.test(reconciliation?.fixturePrefixSha256 || '')
    && reconciliation?.driverSha256 === runtimeProof.embedded.reconciliationDriverSha256
    && reconciliation?.baselineMaxRunId === sourceSnapshot.database.counts.maxRunId
    && reconciliation?.expected?.successfulMessageIdsSha256
      === reconciliation?.observed?.loadMessageIdsSha256
    && reconciliation?.expected?.requestedRunIdsSha256
      === reconciliation?.observed?.loadRunIdsSha256
    && DIGEST_PATTERN.test(reconciliation?.expected?.successfulMessageIdsSha256 || '')
    && DIGEST_PATTERN.test(reconciliation?.expected?.requestedRunIdsSha256 || '')
    && Number.isFinite(Date.parse(reconciliation?.finishedAt)),
  'manifest capacity reconciliation provenance is missing, failed, or unbound');
  invariant(monitor?.evaluation === 'passed', 'manifest monitor gate did not pass');
  invariant(DIGEST_PATTERN.test(monitor?.sha256 || ''), 'manifest monitor checksum is invalid');
  invariant(monitor?.imageId === manifest.image.id, 'manifest monitor image differs from the certified image');
  invariant(typeof monitor?.containerId === 'string' && monitor.containerId !== '',
    'manifest monitor container identity is missing');
  invariant(typeof monitor?.containerStartedAt === 'string' && Number.isFinite(Date.parse(monitor.containerStartedAt)),
    'manifest monitor container start identity is missing');
  const serverLogs = monitor?.serverLogs;
  invariant(serverLogs?.policy === 'zero fatal/error lines from container start through monitor finish',
    'manifest server-log policy is missing or different');
  invariant(serverLogs?.baselineCursor === monitor.containerStartedAt
    && Number.isFinite(Date.parse(serverLogs?.finishCursor)),
  'manifest server-log capture identity is missing or different');
  invariant(serverLogs?.readError === null
    && DIGEST_PATTERN.test(serverLogs?.sha256 || '')
    && Number.isInteger(serverLogs?.totalBytes) && serverLogs.totalBytes >= 0
    && Number.isInteger(serverLogs?.totalLines) && serverLogs.totalLines >= 0
    && serverLogs?.matchedErrorLines === 0
    && serverLogs?.matchesTruncated === false,
  'manifest server-log evidence is incomplete or contains errors');
  invariant(monitor?.runtimeEnvelope?.cpus === CERTIFIED_CPUS
    && monitor?.runtimeEnvelope?.cpuset === CERTIFIED_CPUSET
    && monitor?.runtimeEnvelope?.memoryBytes === CERTIFIED_MEMORY_BYTES
    && monitor?.runtimeEnvelope?.memorySwapBytes === CERTIFIED_MEMORY_BYTES
    && monitor?.runtimeEnvelope?.pidsLimit === CERTIFIED_PIDS
    && monitor?.runtimeEnvelope?.nofileSoft === CERTIFIED_NOFILE
    && monitor?.runtimeEnvelope?.nofileHard === CERTIFIED_NOFILE,
  'manifest runtime envelope differs from the certified shape');
  invariant(stableJson(monitor?.runtimeConfiguration) === stableJson(SOAK_RUNTIME_CONFIGURATION),
    'manifest runtime configuration differs from the certified release contract');
  invariant(monitor?.sessions >= REQUIRED_USERS && monitor?.runners >= REQUIRED_USERS
    && monitor?.memberships >= REQUIRED_MEMBERSHIPS,
  'manifest monitor shape does not include 10,000 sessions/runners and 50,000 memberships');
  invariant(monitor?.durationSeconds >= REQUIRED_MONITOR_SECONDS
    && monitor?.gateWindowSeconds >= REQUIRED_GATE_SECONDS,
  'manifest monitor duration or gate window is below the release contract');
  invariant(monitor?.coverage?.sessions >= MINIMUM_COVERAGE_RATIO
    && monitor?.coverage?.runners >= MINIMUM_COVERAGE_RATIO
    && monitor?.coverage?.memberships >= MINIMUM_COVERAGE_RATIO,
  'manifest monitor coverage is below the release contract');
  invariant(monitor?.coverage?.sessionsEnd >= REQUIRED_USERS
    && monitor?.coverage?.runnersEnd >= REQUIRED_USERS
    && monitor?.coverage?.membershipsEnd >= REQUIRED_MEMBERSHIPS,
  'manifest monitor end-state coverage is below the release contract');
  const gateStartAt = Date.parse(monitor?.gateStartAt);
  const gateEndAt = Date.parse(monitor?.gateEndAt);
  invariant(Number.isFinite(gateStartAt) && Number.isFinite(gateEndAt)
    && gateEndAt - gateStartAt >= REQUIRED_GATE_SECONDS * 1_000,
  'manifest does not contain a literal 30-minute concurrent gate');
  invariant(Date.parse(serverLogs.finishCursor) >= gateEndAt,
    'manifest server-log capture does not span the certified interval');
  invariant(monitor?.workload?.users === REQUIRED_USERS
    && monitor?.workload?.shardCount === REQUIRED_SHARDS
    && monitor?.workload?.elapsedSeconds >= REQUIRED_RAMP_SECONDS + REQUIRED_SOAK_SECONDS
    && monitor?.workload?.postWorkloadSeconds >= REQUIRED_POST_WORKLOAD_SECONDS
    && Date.parse(monitor?.workload?.finishedAt) >= gateEndAt,
  'manifest workload marker does not satisfy the release contract');
  validateRealtimeEvidence(
    monitor?.realtime?.expected,
    monitor?.realtime?.presencePlan,
    monitor?.realtime?.observed,
    monitor?.sessions,
    monitor?.runners,
  );
  const manifestPresenceShards = monitor?.workload?.shards || [];
  const manifestReconnectOwnerIds = manifestPresenceShards.flatMap(
    (shard) => shard.forcedReconnectOwnerUserIds || [],
  );
  invariant(manifestPresenceShards.length === REQUIRED_SHARDS
    && manifestPresenceShards.every((shard) => (
      shard.initialOwnedChatChannels === 100
      && shard.forcedReconnectOwnedChatChannels === 10
      && shard.forcedReconnectStrategy === 'owner-stratified-v1'
      && Array.isArray(shard.forcedReconnectOwnerUserIds)
      && shard.forcedReconnectOwnerUserIds.length === 10
      && new Set(shard.forcedReconnectOwnerUserIds).size === 10
      && shard.forcedReconnectOwnerUserIds.every(Number.isInteger)
    ))
    && sameIntegerSet(
      manifestReconnectOwnerIds,
      monitor.realtime.presencePlan.forcedReconnectOwnerUserIds,
    ),
  'manifest workload reconnect-owner strategy, counts, or IDs differ from the certified plan');
  invariant(certification?.loads?.length === certification?.shardCount,
    'manifest load-shard evidence is incomplete');
  invariant(certification?.loads?.every((entry) => entry.evaluation === 'passed'),
    'manifest contains a failed load shard');
  const shards = new Set(certification.loads.map((entry) => entry.shard));
  invariant(shards.size === certification.shardCount,
    'manifest load-shard identities are incomplete');
  const sourceIps = new Set(certification.loads.map((entry) => entry.sourceIp));
  invariant(sourceIps.size === REQUIRED_SHARDS && !sourceIps.has(undefined),
    'manifest load-generator source IPs are incomplete');
  const workloadDigests = new Map((monitor.workload.shards || []).map((entry) => [entry.shard, entry.sha256]));
  const workloadShards = new Map((monitor.workload.shards || []).map((entry) => [entry.shard, entry]));
  invariant(workloadDigests.size === REQUIRED_SHARDS,
    'manifest workload marker shard checksums are incomplete');
  const firstLoad = certification.loads[0];
  const commonConfiguration = JSON.stringify({
    rampSeconds: firstLoad.rampSeconds,
    soakSeconds: firstLoad.soakSeconds,
    pollingPercent: firstLoad.pollingPercent,
    reconnectPercent: firstLoad.reconnectPercent,
    reconnectAtSeconds: firstLoad.reconnectAtSeconds,
    rates: firstLoad.rates,
  });
  for (const entry of certification.loads) {
    invariant(entry.users === REQUIRED_USERS / REQUIRED_SHARDS,
      `manifest load shard ${entry.shard} does not cover 2,500 users`);
    invariant(DIGEST_PATTERN.test(entry.sha256 || '') && workloadDigests.get(entry.shard) === entry.sha256,
      `manifest load shard ${entry.shard} is not bound to the workload marker checksum`);
    invariant(entry.rampSeconds === REQUIRED_RAMP_SECONDS
      && entry.soakSeconds === REQUIRED_SOAK_SECONDS
      && entry.pollingPercent === 5
      && entry.reconnectPercent === 10
      && entry.reconnectAtSeconds === 600
      && stableJson(entry.rates) === stableJson({ chatRps: 6.25, readRps: 12.5, runRps: 0.25 }),
    `manifest load shard ${entry.shard} does not match the workload plan`);
    const markerShard = workloadShards.get(entry.shard);
    invariant(entry.selectionPlan?.forcedReconnectStrategy === 'owner-stratified-v1'
      && entry.presencePlan?.strategy === entry.selectionPlan.forcedReconnectStrategy
      && entry.presencePlan?.initialOwnedChatChannels === 100
      && entry.presencePlan?.forcedReconnectOwnedChatChannels === 10
      && stableJson(entry.selectionPlan?.forcedReconnectOwnerUserIds)
        === stableJson(entry.presencePlan?.forcedReconnectOwnerUserIds)
      && stableJson(entry.presencePlan?.forcedReconnectOwnerUserIds)
        === stableJson(markerShard?.forcedReconnectOwnerUserIds),
    `manifest load shard ${entry.shard} reconnect-owner evidence differs from the workload marker`);
    invariant(JSON.stringify({
      rampSeconds: entry.rampSeconds,
      soakSeconds: entry.soakSeconds,
      pollingPercent: entry.pollingPercent,
      reconnectPercent: entry.reconnectPercent,
      reconnectAtSeconds: entry.reconnectAtSeconds,
      rates: entry.rates,
    }) === commonConfiguration, `manifest load shard ${entry.shard} has an inconsistent workload configuration`);
    const configurationSha256 = createHash('sha256')
      .update(stableJson(loadConfiguration(entry)))
      .digest('hex');
    invariant(entry.configurationSha256 === configurationSha256,
      `manifest load shard ${entry.shard} configuration checksum is invalid`);
    invariant(Number.isInteger(entry.successfulChatWrites) && entry.successfulChatWrites > 0
      && Number.isInteger(entry.successfulRuns) && entry.successfulRuns > 0,
    `manifest load shard ${entry.shard} has no exact successful workload counts`);
    invariant(entry.workloadIdentity?.successfulMessageIdsCount === entry.successfulChatWrites
      && entry.workloadIdentity?.requestedRunIdsCount === entry.successfulRuns
      && DIGEST_PATTERN.test(entry.workloadIdentity?.successfulMessageIdsSha256 || '')
      && DIGEST_PATTERN.test(entry.workloadIdentity?.requestedRunIdsSha256 || '')
      && markerShard?.successfulMessageIdsCount === entry.successfulChatWrites
      && markerShard?.successfulMessageIdsSha256
        === entry.workloadIdentity.successfulMessageIdsSha256
      && markerShard?.requestedRunIdsCount === entry.successfulRuns
      && markerShard?.requestedRunIdsSha256 === entry.workloadIdentity.requestedRunIdsSha256,
    `manifest load shard ${entry.shard} workload identities differ from its artifact marker`);
    invariant(Date.parse(entry.soakStartedAt) <= gateStartAt
      && Date.parse(entry.rampCompletedAt) <= gateStartAt
      && Date.parse(entry.workloadFinishedAt) >= gateEndAt
      && Date.parse(entry.finishedAt) >= gateEndAt,
    `manifest load shard ${entry.shard} does not span the full concurrent gate`);
  }
  invariant(certification.loads.reduce((total, entry) => total + entry.users, 0)
    === certification.totalUsers, 'manifest load user total is inconsistent');
  const configurationEvidence = certification.loads
    .map((entry) => ({ shard: entry.shard, sha256: entry.configurationSha256 }))
    .sort((left, right) => left.shard - right.shard);
  invariant(stableJson(loadDriver.configurations) === stableJson(configurationEvidence)
    && loadDriver.configurationsSha256 === createHash('sha256')
      .update(stableJson(configurationEvidence)).digest('hex'),
  'manifest load-driver configuration evidence differs from its shards');
  const expectedReconciliation = {
    users: sourceSnapshot.database.counts.users + fixture.users,
    vaults: sourceSnapshot.database.counts.vaults + fixture.groups,
    memberships: sourceSnapshot.database.counts.memberships + fixture.users,
    channels: fixture.groups,
    successfulChatWrites: certification.loads.reduce(
      (sum, entry) => sum + entry.successfulChatWrites, 0,
    ),
    successfulRuns: certification.loads.reduce((sum, entry) => sum + entry.successfulRuns, 0),
    successfulMessageIdsSha256: reconciliation.expected.successfulMessageIdsSha256,
    requestedRunIdsSha256: reconciliation.expected.requestedRunIdsSha256,
    shardWorkloadIdentities: certification.loads
      .map((entry) => ({ shard: entry.shard, ...entry.workloadIdentity }))
      .sort((left, right) => left.shard - right.shard),
  };
  invariant(stableJson(reconciliation.expected) === stableJson(expectedReconciliation),
    'manifest reconciliation expectations differ from source, fixture, or load evidence');
  const reconciledObserved = reconciliation.observed || {};
  invariant(reconciledObserved.users === expectedReconciliation.users
    && reconciledObserved.vaults === expectedReconciliation.vaults
    && reconciledObserved.memberships === expectedReconciliation.memberships
    && reconciledObserved.fixtureChannelCount === expectedReconciliation.channels
    && reconciledObserved.loadMessageCount === expectedReconciliation.successfulChatWrites
    && reconciledObserved.loadMessageDistinctIds === expectedReconciliation.successfulChatWrites
    && reconciledObserved.loadMessageChannels === expectedReconciliation.channels
    && reconciledObserved.loadRunCount === expectedReconciliation.successfulRuns
    && reconciledObserved.completedLoadRuns === expectedReconciliation.successfulRuns
    && ['duplicateMessageIds', 'unexercisedFixtureChannels', 'badMessageScope',
      'badMessageBodies', 'unexpectedNewRuns', 'badRunPrompts', 'badRunRows',
      'badTerminalEventCounts', 'badEventSequences',
      'badRunEventSignatures', 'openDelegatedRuns',
      'foreignKeyViolations'].every((key) => reconciledObserved[key] === 0)
    && reconciledObserved.quickCheck === 'ok',
  'manifest reconciliation counts, scope, or integrity evidence is invalid');
  const faults = certification?.faults;
  invariant(Array.isArray(faults) && faults.length === REQUIRED_FAULTS.size,
    'manifest fault-recovery evidence is incomplete');
  invariant(new Set(faults.map((entry) => entry.fault)).size === REQUIRED_FAULTS.size
    && faults.every((entry) => REQUIRED_FAULTS.has(entry.fault)),
  'manifest fault-recovery identities are incomplete');
  invariant(faults.every((entry) => entry.evaluation === 'passed'
    && DIGEST_PATTERN.test(entry.sha256 || '')
    && entry.fixtureSha256 === fixture.sha256
    && entry.containerId === preflights.faults.containerId),
  'manifest contains failed or unbound fault-recovery evidence');
  const soak = certification?.soak;
  invariant(soak?.evaluation === 'passed'
    && DIGEST_PATTERN.test(soak?.sha256 || '')
    && DIGEST_PATTERN.test(soak?.journal?.sha256 || '')
    && DIGEST_PATTERN.test(soak?.fixtures?.sha256 || '')
    && DIGEST_PATTERN.test(soak?.fixtures?.selectedIdentitySha256 || '')
    && DIGEST_PATTERN.test(soak?.serverLogs?.sha256 || '')
    && DIGEST_PATTERN.test(soak?.postDbEventDigest || '')
    && DIGEST_PATTERN.test(soak?.liveEventDigest || ''),
  'manifest two-hour soak evidence is missing, failed, or unbound');
  invariant(soak?.imageId === manifest.image.id
    && soak?.revision === manifest.revision
    && soak?.target === certification.target
    && soak?.containerId === preflights.soak5k.containerId,
  'manifest two-hour soak image, revision, or target differs from the release certificate');
  validatePhaseChronology(preflights, freezes, reconciliation, faults, soak);
  invariant(soak?.users === REQUIRED_LONG_SOAK_USERS
    && soak?.rampSeconds === SOAK_PROFILE.rampSeconds
    && soak?.soakSeconds === REQUIRED_LONG_SOAK_SECONDS
    && soak?.sampleIntervalSeconds === SOAK_PROFILE.sampleIntervalSeconds
    && soak?.recoveryConsecutiveSamples === SOAK_PROFILE.recoveryConsecutiveSamples
    && soak?.churnPercent === REQUIRED_LONG_SOAK_CHURN_PERCENT
    && soak?.churnIntervalSeconds === REQUIRED_LONG_SOAK_CHURN_INTERVAL_SECONDS
    && soak?.runRps === REQUIRED_LONG_SOAK_RUN_RPS,
  'manifest two-hour soak workload differs from the release contract');
  invariant(Number.isFinite(Date.parse(soak?.rampStartedAt))
    && Number.isFinite(Date.parse(soak?.rampCompletedAt))
    && Number.isFinite(Date.parse(soak?.soakStartedAt))
    && Date.parse(soak.rampCompletedAt) <= Date.parse(soak.soakStartedAt)
    && Date.parse(soak.rampCompletedAt) - Date.parse(soak.rampStartedAt)
      >= SOAK_PROFILE.rampSeconds * 1_000
    && Date.parse(soak.rampCompletedAt) - Date.parse(soak.rampStartedAt)
      <= (SOAK_PROFILE.rampSeconds + 10) * 1_000,
  'manifest two-hour soak does not bind the observed 300-second ramp');
  invariant(soak?.fixtures?.users === REQUIRED_LONG_SOAK_USERS
    && soak?.fixtures?.groups === REQUIRED_LONG_SOAK_USERS / 25
    && soak?.fixtures?.sha256 === fixture.sha256
    && Number.isInteger(soak?.fixtures?.bytes) && soak.fixtures.bytes > 0,
  'manifest two-hour soak fixture evidence is incomplete');
  invariant(soak?.serverLogs?.policy === 'zero fatal/error lines from container start through soak finish'
    && soak?.serverLogs?.baselineCursor === soak?.containerStartedAt
    && Number.isFinite(Date.parse(soak?.serverLogs?.finishCursor))
    && soak?.serverLogs?.readError === null
    && soak?.serverLogs?.matchedErrorLines === 0
    && soak?.serverLogs?.matchesTruncated === false
    && Number.isInteger(soak?.serverLogs?.totalBytes)
    && Number.isInteger(soak?.serverLogs?.totalLines),
  'manifest two-hour soak server-log evidence is incomplete');
  invariant(Date.parse(soak.serverLogs.finishCursor) >= Date.parse(soak.finishedAt),
    'manifest two-hour soak server-log capture does not span the certified interval');
  invariant(soak?.database?.baseline && soak?.database?.final
    && Array.isArray(soak?.database?.failures) && soak.database.failures.length === 0
    && soak.database.final.foreignKeyViolations === 0
    && soak.database.final.quickCheck === 'ok',
  'manifest two-hour soak SQLite reconciliation is incomplete');
  const manifestSoakDatabase = reconcileLongSoakDatabase(
    soak.database.baseline,
    soak.database.final,
    soak.runCount,
    soak.persistedEventCount,
  );
  invariant(stableJson(soak.database) === stableJson(manifestSoakDatabase)
    && manifestSoakDatabase.failures.length === 0,
  'manifest two-hour soak SQLite counts or approved orphan transition do not reconcile');
  invariant(freezes.main10k.phaseWorkload?.runs === expectedReconciliation.successfulRuns
    && freezes.main10k.phaseWorkload?.completedRuns === expectedReconciliation.successfulRuns
    && freezes.main10k.phaseWorkload?.runEvents === expectedReconciliation.successfulRuns * 4
    && freezes.main10k.phaseWorkload?.messages === expectedReconciliation.successfulChatWrites,
  'manifest phase A workload differs from reconciliation evidence');
  validateFaultPersistence(freezes.faults.phaseWorkload, faults);
  invariant(freezes.soak5k.phaseWorkload?.runs === soak.runCount
    && freezes.soak5k.phaseWorkload?.completedRuns === soak.runCount
    && freezes.soak5k.phaseWorkload?.runEvents === soak.persistedEventCount
    && freezes.soak5k.phaseWorkload?.messages === 0,
  'manifest phase C workload differs from soak evidence');
  validatePhaseTableDeltas(freezes.main10k, fixture, expectedReconciliation);
  validatePhaseTableDeltas(freezes.faults, fixture, freezes.faults.phaseWorkload);
  validatePhaseTableDeltas(freezes.soak5k, fixture, soak);
  const soakHeadroom = soak?.journalHeadroom;
  invariant(soakHeadroom
    && [
      soakHeadroom.cpuMaxPct,
      soakHeadroom.memoryMaxPct,
      soakHeadroom.schedulerMaxPct,
      soakHeadroom.poolSaturationRatio,
      soakHeadroom.dbQueueP99Us,
      soakHeadroom.dbQueryP99Us,
      soakHeadroom.dbWriteLockWaitP99Us,
      soakHeadroom.dbWriteLockHoldP99Us,
      soakHeadroom.mailboxMax,
      soakHeadroom.walMaxBytes,
      soakHeadroom.walGrowthBytes,
      soakHeadroom.sessionCoverage,
      soakHeadroom.runnerCoverage,
      soakHeadroom.membershipCoverage,
    ].every(Number.isFinite)
    && soakHeadroom.cpuMaxPct <= 70
    && soakHeadroom.memoryMaxPct <= 70
    && soakHeadroom.schedulerMaxPct <= 80
    && soakHeadroom.poolSaturationRatio <= 0.05
    && soakHeadroom.dbQueueP99Us <= 50_000
    && soakHeadroom.dbQueryP99Us <= 100_000
    && soakHeadroom.dbWriteLockWaitP99Us <= 100_000
    && soakHeadroom.dbWriteLockHoldP99Us <= 100_000
    && soakHeadroom.dbErrors === 0
    && soakHeadroom.dbBusyOrLockedErrors === 0
    && soakHeadroom.dbWriteLockOwnerDeaths === 0
    && soakHeadroom.probeErrors === 0
    && soakHeadroom.mailboxMax <= 500
    && soakHeadroom.walMaxBytes <= 128 * 1024 ** 2
    && soakHeadroom.walGrowthBytes <= 64 * 1024 ** 2
    && soakHeadroom.restarts === 0
    && soakHeadroom.oomKilled === false
    && soakHeadroom.rpcErrors === 0
    && soakHeadroom.sessionCoverage >= 0.95
    && soakHeadroom.runnerCoverage >= 0.95
    && soakHeadroom.membershipCoverage >= 0.95,
  'manifest two-hour soak headroom evidence is missing or outside the release gate');
  invariant(soak?.probeUninstalled === true,
    'manifest two-hour soak capacity probe was not cleanly uninstalled');
  invariant(soak?.teardown?.runnerDisconnectFlushes === 1
    && soak.teardown.runnerDisconnectFlushOwners >= Math.floor(REQUIRED_LONG_SOAK_USERS * 0.99)
    && soak.teardown.runnerDisconnectFlushOwners <= REQUIRED_LONG_SOAK_USERS
    && soak.teardown.runnerDelegatedSnapshotReads === 1
    && soak.teardown.runnerDelegatedOwnerReads === 0
    && soak.teardown.presenceDispatcher?.completed === soak.teardown.presenceDispatcher?.dispatched
    && soak.teardown.presenceDispatcher?.completed === soak.teardown.presenceDispatcher?.refreshed
    && soak.teardown.presenceDispatcher?.failed === 0
    && soak.teardown.presenceDispatcher?.noop === 0
    && soak.teardown.presenceDispatcher?.startFailed === 0
    && soak.teardown.presenceDispatcher?.taskFailed === 0
    && soak.teardown.presenceDispatcher?.active === 0
    && soak.teardown.presenceDispatcher?.pending === 0
    && soak.teardown.presenceDispatcher?.queued === 0,
  'manifest two-hour soak teardown batching or dispatcher drain is invalid');
  invariant(typeof soak?.containerId === 'string' && soak.containerId !== ''
    && Number.isFinite(Date.parse(soak?.containerStartedAt))
    && Number.isFinite(Date.parse(soak?.startedAt))
    && Number.isFinite(Date.parse(soak?.finishedAt))
    && Date.parse(soak.finishedAt) > Date.parse(soak.startedAt),
  'manifest two-hour soak identity or timestamps are invalid');
  invariant(faults.every((entry) => Date.parse(entry.startedAt) >= Date.parse(freezes.main10k.frozenAt)
    && Date.parse(entry.finishedAt) <= Date.parse(freezes.faults.frozenAt))
    && Date.parse(soak.startedAt) >= Date.parse(freezes.main10k.frozenAt)
    && Date.parse(soak.finishedAt) <= Date.parse(freezes.soak5k.frozenAt),
  'manifest phase B/C workload timestamps are outside their owned lifecycle');
  invariant(Number.isInteger(soak?.journal?.bytes) && soak.journal.bytes >= 0
    && Number.isInteger(soak?.journal?.samples) && soak.journal.samples >= 10,
  'manifest two-hour soak journal metadata is invalid');
  return manifest;
}
