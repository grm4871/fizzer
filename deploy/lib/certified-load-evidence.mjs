// Workload evidence: bind load shards, reconciliation, fault recovery, and phase chronology.
// Inputs are evaluated workload artifacts and phase records; outputs are reduced identity evidence; failures throw.
// Ordering validates artifact provenance before database reconciliation and lifecycle ordering.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as p from './certified-primitives.mjs';
import * as source from './certified-source-evidence.mjs';
import * as db from './certified-database-evidence.mjs';
import * as phase from './certified-phase-evidence.mjs';
import { loadConfiguration } from '../../loadtest_elixir/load.mjs';
import { queryDatabase as queryReconciliationDatabase, evaluateReconciliation } from '../../loadtest_elixir/reconcile-capacity.mjs';

const { stableJson, invariant, DIGEST_PATTERN, REQUIRED_SHARDS, REQUIRED_USERS, REQUIRED_RAMP_SECONDS,
  REQUIRED_SOAK_SECONDS, REQUIRED_GATE_SECONDS, REQUIRED_POST_WORKLOAD_SECONDS, REQUIRED_LOAD_THRESHOLDS,
  REQUIRED_FAULTS, PRODUCTION_SOURCE_DATABASE, PRODUCTION_APPLICATION_TABLES,
  PRODUCTION_APPLICATION_TABLES_SHA256, root, artifactSnapshot, digestRegularFile } = p;
const { compareProductionRows, phaseWorkloadEvidence } = db;
const { validateFixturePreflight, validateFreezeEvidence, validatePhaseTableDeltas } = phase;

export function validateLoadProvenance(results, driverArtifact, fixtureEvidence) {
  invariant(driverArtifact?.path === path.join(root, 'loadtest_elixir', 'load.mjs'),
    'capacity load driver is not the checked-out authoritative load.mjs');
  invariant(DIGEST_PATTERN.test(driverArtifact?.sha256 || '')
    && Number.isInteger(driverArtifact?.bytes) && driverArtifact.bytes > 0,
  'capacity load driver artifact is missing or unbound');
  invariant(DIGEST_PATTERN.test(fixtureEvidence?.sha256 || ''),
    'capacity fixture evidence is missing or unbound');
  const configurations = [];
  for (const result of results) {
    const shard = result.shard?.index;
    const provenance = result.provenance;
    const configurationSha256 = createHash('sha256')
      .update(stableJson(loadConfiguration(result)))
      .digest('hex');
    invariant(provenance?.schemaVersion === 1
      && provenance.loadDriverSha256 === driverArtifact.sha256
      && provenance.loadDriverBytes === driverArtifact.bytes,
    `load shard ${shard ?? '?'} did not execute the certified load-driver bytes`);
    invariant(provenance.fixtureSha256 === fixtureEvidence.sha256
      && provenance.fixtureBytes === fixtureEvidence.bytes,
    `load shard ${shard ?? '?'} did not execute the certified fixture bytes`);
    invariant(provenance.configurationSha256 === configurationSha256,
      `load shard ${shard ?? '?'} configuration digest is stale or invalid`);
    configurations.push({ shard, sha256: configurationSha256 });
  }
  configurations.sort((left, right) => left.shard - right.shard);
  return {
    sha256: driverArtifact.sha256,
    bytes: driverArtifact.bytes,
    configurations,
    configurationsSha256: createHash('sha256').update(stableJson(configurations)).digest('hex'),
  };
}

export function validateRuntimeProof(
  result,
  artifact,
  mainPreflight,
  imageId,
  revision,
  loadDriverArtifact,
  reconciliationDriverArtifact,
) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'owned runtime proof checksum is invalid');
  invariant(result?.schemaVersion === 1 && result?.type === 'cascade-owned-runtime-proof'
    && result.phase === 'main10k' && result.profile === 'final10k',
  'owned runtime proof schema or phase is invalid');
  invariant(result.imageId === imageId && result.containerId === mainPreflight.containerId
    && result.revision === revision,
  'owned runtime proof image/container/revision differs from main preflight');
  invariant(result.swapReady === true && Number.isFinite(Date.parse(result.executedAt)),
    'owned runtime proof did not pass the embedded route swap gate');
  invariant(result.embedded?.loadDriverSha256 === loadDriverArtifact.sha256
    && result.embedded?.reconciliationDriverSha256 === reconciliationDriverArtifact.sha256,
  'owned runtime proof host/commit/embedded driver checksums differ');
  return {
    sha256: artifact.sha256,
    phase: result.phase,
    profile: result.profile,
    imageId,
    containerId: result.containerId,
    revision,
    executedAt: result.executedAt,
    swapReady: true,
    embedded: result.embedded,
  };
}

export function validateReconciliationEvidence(
  result,
  artifact,
  sourceSnapshot,
  fixtureEvidence,
  fixtureArtifact,
  loadResults,
  loadArtifacts,
  containerMount,
  preflightEvidence,
  monitorFinishedAt,
  reconciliationDriverArtifact,
  embeddedReconciliationDriverSha256,
) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'capacity reconciliation checksum is invalid');
  invariant(result?.schemaVersion === 1 && result?.type === 'cascade-capacity-reconciliation',
    'capacity reconciliation schema is invalid');
  invariant(result.evaluation?.ok === true
    && Array.isArray(result.evaluation?.failures) && result.evaluation.failures.length === 0,
  `capacity reconciliation failed: ${(result.evaluation?.failures || ['missing evaluation']).join('; ')}`);
  const reconciliationFinishedAt = Date.parse(result.finishedAt);
  const latestLoadFinishedAt = Math.max(...loadResults.map((load) => Date.parse(load.finishedAt)));
  invariant(Number.isFinite(reconciliationFinishedAt)
    && reconciliationFinishedAt >= latestLoadFinishedAt
    && reconciliationFinishedAt >= Date.parse(monitorFinishedAt),
  'capacity reconciliation is stale or predates load/monitor completion');
  invariant(reconciliationDriverArtifact?.path === path.join(root, 'loadtest_elixir', 'reconcile-capacity.mjs')
    && result.provenance?.driverSha256 === reconciliationDriverArtifact.sha256
    && result.provenance?.driverBytes === reconciliationDriverArtifact.bytes
    && embeddedReconciliationDriverSha256 === reconciliationDriverArtifact.sha256,
  'capacity reconciliation did not execute host/commit/embedded authoritative driver bytes');
  invariant(containerMount.inspection.State?.Running === false
    && containerMount.inspection.RestartCount === 0
    && containerMount.inspection.State?.OOMKilled === false,
  'capacity reconciliation did not run against a cleanly stopped candidate');
  invariant(fs.realpathSync(result.database || '') === fs.realpathSync(containerMount.database),
    'capacity reconciliation database is not the candidate mounted fixture database');
  const postDatabase = digestRegularFile(result.database || '', 'reconciled capacity database');
  invariant(postDatabase.sha256 === result.databaseSha256,
    'capacity reconciliation database checksum differs from the reconciled bytes');
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${postDatabase.path}${suffix}`),
      `reconciled capacity database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  invariant(postDatabase.device === preflightEvidence.databaseDevice
    && postDatabase.inode === preflightEvidence.databaseInode,
  'capacity reconciliation database inode differs from the preflight fixture');
  invariant(result.baselineMaxRunId === sourceSnapshot.database.counts.maxRunId,
    'capacity reconciliation run baseline differs from the production source snapshot');
  invariant(/^[a-z][a-z0-9_-]{2,30}$/u.test(result.fixturePrefix || ''),
    'capacity reconciliation fixture prefix is invalid');
  const expected = {
    users: sourceSnapshot.database.counts.users + fixtureEvidence.users,
    vaults: sourceSnapshot.database.counts.vaults + fixtureEvidence.groups,
    memberships: sourceSnapshot.database.counts.memberships + fixtureEvidence.users,
    channels: fixtureEvidence.groups,
    successfulChatWrites: loadResults.reduce(
      (sum, load) => sum + (load.metrics?.workload?.chat?.succeeded || 0), 0,
    ),
    successfulRuns: loadResults.reduce(
      (sum, load) => sum + (load.metrics?.workload?.run?.succeeded || 0), 0,
    ),
    successfulMessageIds: loadResults
      .flatMap((load) => load.workloadIdentity?.successfulMessageIds || []).sort(),
    requestedRunIds: loadResults
      .flatMap((load) => load.workloadIdentity?.requestedRunIds || [])
      .sort((left, right) => left - right),
  };
  expected.successfulMessageIdsSha256 = createHash('sha256')
    .update(stableJson(expected.successfulMessageIds)).digest('hex');
  expected.requestedRunIdsSha256 = createHash('sha256')
    .update(stableJson(expected.requestedRunIds)).digest('hex');
  expected.shardWorkloadIdentities = loadResults
    .map((load) => ({
      shard: load.shard.index,
      successfulMessageIdsCount: load.workloadIdentity.successfulMessageIdsCount,
      successfulMessageIdsSha256: load.workloadIdentity.successfulMessageIdsSha256,
      requestedRunIdsCount: load.workloadIdentity.requestedRunIdsCount,
      requestedRunIdsSha256: load.workloadIdentity.requestedRunIdsSha256,
    }))
    .sort((left, right) => left.shard - right.shard);
  invariant(stableJson(result.expected) === stableJson(expected),
    'capacity reconciliation expected counts differ from source, fixture, or load evidence');
  invariant(Array.isArray(result.shards) && result.shards.length === REQUIRED_SHARDS,
    'capacity reconciliation does not bind all four load shards');
  const shardEvidence = new Map(result.shards.map((shard) => [shard.index, shard]));
  for (let index = 0; index < loadResults.length; index += 1) {
    const load = loadResults[index];
    const shard = shardEvidence.get(load.shard.index);
    invariant(shard?.sha256 === loadArtifacts[index]?.sha256
      && shard?.successfulChatWrites === load.metrics?.workload?.chat?.succeeded
      && shard?.successfulRuns === load.metrics?.workload?.run?.succeeded
      && shard?.successfulMessageIdsCount === load.workloadIdentity?.successfulMessageIdsCount
      && shard?.successfulMessageIdsSha256 === load.workloadIdentity?.successfulMessageIdsSha256
      && stableJson(shard?.successfulMessageIds)
        === stableJson(load.workloadIdentity?.successfulMessageIds)
      && shard?.requestedRunIdsCount === load.workloadIdentity?.requestedRunIdsCount
      && shard?.requestedRunIdsSha256 === load.workloadIdentity?.requestedRunIdsSha256
      && stableJson(shard?.requestedRunIds) === stableJson(load.workloadIdentity?.requestedRunIds),
    `capacity reconciliation shard ${load.shard.index} differs from load evidence`);
  }
  const recomputedObserved = queryReconciliationDatabase(
    postDatabase.path,
    result.fixturePrefix,
    result.baselineMaxRunId,
  );
  invariant(stableJson(recomputedObserved) === stableJson(result.observed),
    'capacity reconciliation claimed observations differ from an independent database query');
  const recomputedEvaluation = evaluateReconciliation(recomputedObserved, expected);
  invariant(stableJson(recomputedEvaluation) === stableJson(result.evaluation)
    && recomputedEvaluation.ok,
  'capacity reconciliation evaluation differs from independently recomputed evidence');
  const observed = recomputedObserved;
  invariant(observed.users === expected.users
    && observed.vaults === expected.vaults
    && observed.memberships === expected.memberships
    && observed.fixtureChannelCount === expected.channels
    && observed.loadMessageCount === expected.successfulChatWrites
    && observed.loadMessageDistinctIds === expected.successfulChatWrites
    && observed.loadMessageChannels === expected.channels
    && observed.loadRunCount === expected.successfulRuns
    && observed.completedLoadRuns === expected.successfulRuns,
  'capacity reconciliation observed counts do not match the bound workload');
  invariant(['duplicateMessageIds', 'unexercisedFixtureChannels', 'badMessageScope',
    'badMessageBodies', 'unexpectedNewRuns', 'badRunPrompts', 'badRunRows',
    'badTerminalEventCounts', 'badEventSequences',
    'badRunEventSignatures', 'openDelegatedRuns',
    'foreignKeyViolations'].every((key) => observed[key] === 0)
    && observed.quickCheck === 'ok',
  'capacity reconciliation integrity or scope checks failed');
  const expectedLoadRunEvents = expected.successfulRuns * 4;
  invariant(observed.totalNotes === sourceSnapshot.database.counts.notes + fixtureEvidence.groups
    && observed.totalMessages === sourceSnapshot.database.counts.messages + expected.successfulChatWrites
    && observed.totalRuns === sourceSnapshot.database.counts.runs + expected.successfulRuns
    && observed.loadRunEventCount === expectedLoadRunEvents
    && observed.totalRunEvents === sourceSnapshot.database.counts.runEvents
      + expectedLoadRunEvents + sourceSnapshot.database.counts.openDelegatedRuns
    && observed.totalDelegatedRuns === 0,
  'capacity reconciliation does not preserve exact production totals and workload deltas');
  const fixtureIdentity = validateFixtureDatabaseIdentity(postDatabase.path, fixtureArtifact);
  invariant(fixtureIdentity.userMismatches === 0, 'capacity fixture identities changed after the run');
  const { successfulMessageIds: _successfulMessageIds, requestedRunIds: _requestedRunIds,
    ...expectedSummary } = expected;
  const { loadMessageIds: _loadMessageIds, loadRunIds: _loadRunIds, ...observedSummary } = observed;
  return {
    sha256: artifact.sha256,
    databaseSha256: postDatabase.sha256,
    driverSha256: reconciliationDriverArtifact.sha256,
    fixturePrefixSha256: createHash('sha256').update(result.fixturePrefix || '').digest('hex'),
    baselineMaxRunId: result.baselineMaxRunId,
    expected: expectedSummary,
    observed: observedSummary,
    fixtureIdentity,
    finishedAt: result.finishedAt,
    evaluation: 'passed',
  };
}

export function validateFaultEvidence(results, artifacts, imageId, revision, target, fixtureSha256) {
  invariant(DIGEST_PATTERN.test(fixtureSha256 || ''),
    'fault certification requires the exact fixture checksum');
  invariant(results.length === REQUIRED_FAULTS.size,
    `capacity certification requires exactly ${REQUIRED_FAULTS.size} fault-recovery artifacts`);
  invariant(artifacts.length === results.length, 'every fault result must have an artifact checksum');
  const observed = new Set();

  return results.map((result, index) => {
    const artifact = artifacts[index];
    invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'fault-recovery artifact checksum is invalid');
    invariant(result.schemaVersion === 1 && result.type === 'cascade-fault-recovery',
      'fault-recovery artifact schema is invalid');
    invariant(REQUIRED_FAULTS.has(result.fault), `unsupported fault-recovery proof ${result.fault || 'missing'}`);
    invariant(!observed.has(result.fault), `duplicate fault-recovery proof ${result.fault}`);
    observed.add(result.fault);
    invariant(result.imageId === imageId, `fault proof ${result.fault} exercised a different image`);
    invariant(result.revision === revision, `fault proof ${result.fault} exercised a different revision`);
    invariant(result.target === target, `fault proof ${result.fault} exercised a different target`);
    invariant(result.fixtureSha256 === fixtureSha256,
      `fault proof ${result.fault} used a different authenticated fixture cohort`);
    invariant(typeof result.containerId === 'string' && result.containerId !== '',
      `fault proof ${result.fault} has no container identity`);
    invariant(Number.isFinite(Date.parse(result.startedAt))
      && Number.isFinite(Date.parse(result.finishedAt))
      && Date.parse(result.finishedAt) >= Date.parse(result.startedAt),
    `fault proof ${result.fault} timestamps are invalid`);
    invariant(result.evaluation?.ok === true
      && Array.isArray(result.evaluation.failures)
      && result.evaluation.failures.length === 0,
    `fault proof ${result.fault} failed`);

    const observations = result.observations || {};
    if (result.fault === 'runner-restart-reclaim') {
      invariant(Number.isInteger(observations.runId)
        && observations.runId > PRODUCTION_SOURCE_DATABASE.counts.maxRunId,
      'runner restart proof has no exact post-baseline run identity');
      invariant(observations.sameContainer === true && observations.sameImage === true
        && observations.containerRestarted === true,
      'runner restart proof did not restart the same image/container');
      invariant(observations.restartMs <= 120_000 && observations.reclaimedActiveRun === true,
        'runner restart proof exceeded 120 seconds or did not reclaim the active run');
      invariant(observations.delegations === 1 && observations.completedTerminalEvents === 1
        && observations.finalStatus === 'completed',
      'runner restart proof contains duplicate delegation/terminal state or no completion');
    } else if (result.fault === 'sqlite-write-lock') {
      invariant(typeof observations.blockedId === 'string' && observations.blockedId.startsWith('fault-lock-blocked-')
        && typeof observations.recoveryId === 'string' && observations.recoveryId.startsWith('fault-lock-recovery-')
        && observations.blockedId !== observations.recoveryId
        && typeof observations.vaultId === 'string' && observations.vaultId
        && typeof observations.channelId === 'string' && observations.channelId,
      'SQLite lock proof has no exact blocked/recovery message scope');
      invariant([429, 503].includes(observations.boundedFailureStatus)
        && observations.boundedFailureMs <= 7_000,
      'SQLite lock proof did not shed the blocked write within seven seconds');
      invariant(observations.failedWriteAbsent === true
        && observations.recoveryStatus === 201
        && observations.recoveryMs <= 1_000
        && observations.recoveryWritePersisted === true,
      'SQLite lock proof has a phantom failure or did not recover within one second');
    }

    return {
      fault: result.fault,
      sha256: artifact.sha256,
      fixtureSha256: result.fixtureSha256,
      containerId: result.containerId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      evaluation: 'passed',
      observations,
    };
  });
}

export function validateFaultPersistence(phaseWorkload, faults) {
  invariant(phaseWorkload?.runs === 1
    && phaseWorkload?.completedRuns === 1
    && phaseWorkload?.messages === 1,
  'phase B freeze workload differs from the two exact fault proofs');
  const runnerFault = faults.find((fault) => fault.fault === 'runner-restart-reclaim');
  const sqliteFault = faults.find((fault) => fault.fault === 'sqlite-write-lock');
  invariant(runnerFault && sqliteFault, 'phase B is missing a required fault proof');
  const [persistedFaultRun] = phaseWorkload.workloadRuns || [];
  const persistedFaultEvents = phaseWorkload.workloadRunEvents || [];
  const [persistedRecoveryMessage] = phaseWorkload.workloadMessages || [];
  let persistedTerminalPayload;
  try { persistedTerminalPayload = JSON.parse(persistedFaultRun?.lastPayload || 'null'); } catch {
    persistedTerminalPayload = null;
  }
  invariant(persistedFaultRun?.id === runnerFault.observations.runId
    && persistedFaultRun?.status === 'completed'
    && persistedFaultRun?.summary === 'restart recovery passed'
    && persistedFaultRun?.eventCount === 3
    && persistedFaultRun?.completedTerminalEvents === 1
    && persistedFaultRun?.lastType === 'status'
    && persistedTerminalPayload?.status === 'completed'
    && persistedTerminalPayload?.summary === 'restart recovery passed'
    && persistedTerminalPayload?.sessionId === `fault-session-${runnerFault.observations.runId}`,
  'phase B database does not contain the exact runner-restart run/event signature');
  const expectedFaultEvents = [
    { seq: 1, type: 'status', payload: { status: 'queued' } },
    { seq: 2, type: 'status', payload: { status: 'running' } },
    {
      seq: 3,
      type: 'status',
      payload: {
        status: 'completed',
        summary: 'restart recovery passed',
        sessionId: `fault-session-${runnerFault.observations.runId}`,
      },
    },
  ];
  invariant(persistedFaultEvents.length === expectedFaultEvents.length
    && persistedFaultEvents.every((event, index) => {
      let payload;
      try { payload = JSON.parse(event.payloadJson); } catch { payload = null; }
      const expected = expectedFaultEvents[index];
      return event.runId === runnerFault.observations.runId
        && event.seq === expected.seq && event.type === expected.type
        && stableJson(payload) === stableJson(expected.payload);
    }),
  'phase B runner restart events differ from the exact queued/running/completed sequence');
  invariant(persistedRecoveryMessage?.id === sqliteFault.observations.recoveryId
    && persistedRecoveryMessage?.vaultId === sqliteFault.observations.vaultId
    && persistedRecoveryMessage?.channelId === sqliteFault.observations.channelId
    && persistedRecoveryMessage?.body === 'dependency recovered'
    && !(phaseWorkload.workloadMessages || []).some(
      (message) => message.id === sqliteFault.observations.blockedId,
    ),
  'phase B database does not contain only the exact scoped SQLite recovery message');
  return true;
}

export function validatePhaseChronology(preflights, freezes, reconciliation, faults, soak) {
  const mainFrozenAt = Date.parse(freezes.main10k?.frozenAt);
  const faultPreflightAt = Date.parse(preflights.faults?.createdAt);
  const soakPreflightAt = Date.parse(preflights.soak5k?.createdAt);
  invariant(Number.isFinite(mainFrozenAt)
    && Number.isFinite(faultPreflightAt) && Number.isFinite(soakPreflightAt),
  'phase lifecycle timestamps are missing or invalid');
  invariant(Date.parse(reconciliation.finishedAt) <= mainFrozenAt,
    'phase A freeze predates its authoritative reconciliation');
  invariant(faults.every((result) => Date.parse(result.finishedAt) <= Date.parse(freezes.faults.frozenAt))
    && Date.parse(soak.finishedAt) <= Date.parse(freezes.soak5k.frozenAt),
  'phase B/C freeze predates its workload evidence');
  invariant(faults.every((result) => Date.parse(result.startedAt) >= mainFrozenAt)
    && Date.parse(soak.startedAt) >= mainFrozenAt,
  'phase B/C started before phase A was reconciled and frozen');
  invariant(faultPreflightAt >= mainFrozenAt && soakPreflightAt >= mainFrozenAt,
    'phase B/C preflight was created before phase A was reconciled and frozen');
  invariant(faults.every((result) => faultPreflightAt <= Date.parse(result.startedAt))
    && soakPreflightAt <= Date.parse(soak.startedAt),
  'phase B/C workload started before its never-started preflight was captured');
  return true;
}
