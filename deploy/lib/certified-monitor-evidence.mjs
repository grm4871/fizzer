// Monitor evidence: validate runtime identity, server logs, load gates, and fixture summaries.
// Inputs are JSONL monitor/load artifacts and expected image IDs; outputs are reduced certification evidence.
// Ordering validates container identity before duration, gate, and workload accounting.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as p from './certified-primitives.mjs';
import { SOAK_RUNTIME_CONFIGURATION } from '../../loadtest_elixir/soak-invariants.mjs';

const { stableJson, invariant, sameIntegerSet, runtimeShapeMatches, validateRealtimeEvidence,
  artifactSnapshot, DIGEST_PATTERN, CERTIFIED_CPUS, CERTIFIED_MEMORY_BYTES, REQUIRED_USERS,
  REQUIRED_MEMBERSHIPS, REQUIRED_SHARDS, REQUIRED_RAMP_SECONDS, REQUIRED_SOAK_SECONDS,
  REQUIRED_MONITOR_SECONDS, REQUIRED_GATE_SECONDS, REQUIRED_POST_WORKLOAD_SECONDS,
  REQUIRED_FIXTURE_GROUP_SIZE, MINIMUM_COVERAGE_RATIO, REQUIRED_LOAD_THRESHOLDS,
  CAPACITY_PROFILES } = p;

export function validateMonitorEvidence(records, imageId) {
  const start = records.find((record) => record.type === 'start');
  const finish = [...records].reverse().find((record) => record.type === 'finish');
  const samples = records.filter((record) => record.type === 'sample');
  invariant(start && finish, 'capacity monitor evidence must contain start and finish records');
  invariant(typeof start.containerId === 'string' && start.containerId !== '',
    'capacity monitor start evidence has no immutable container ID');
  invariant(samples.length > 0, 'capacity monitor evidence contains no identity-bound samples');
  const monitorStartedAt = Date.parse(start.observedAt);
  const monitorFinishedAt = Date.parse(finish.observedAt);
  invariant(Number.isFinite(monitorStartedAt) && Number.isFinite(monitorFinishedAt)
    && monitorFinishedAt > monitorStartedAt, 'capacity monitor timestamps are invalid');
  invariant(start.imageId === imageId, `capacity monitor exercised ${start.imageId}, expected ${imageId}`);
  invariant(start.expectedShape?.imageId === imageId, 'capacity monitor immutable-image expectation is missing or different');
  invariant(start.expectedShape?.cpus === CERTIFIED_CPUS
    && start.expectedShape?.memoryBytes === CERTIFIED_MEMORY_BYTES,
  'capacity monitor expected a different CPU or memory envelope');
  invariant(runtimeShapeMatches(start.hostConfig),
    'capacity monitor start evidence differs from the certified runtime envelope');
  const containerStartedAt = samples[0]?.containerState?.startedAt;
  invariant(typeof containerStartedAt === 'string' && containerStartedAt !== '',
    'capacity monitor sample evidence has no container start identity');
  const serverLogStart = start.serverLogEvidence;
  const serverLogs = finish.serverLogs;
  const serverLogBaselineAt = Date.parse(serverLogStart?.baselineCursor);
  const serverLogFinishAt = Date.parse(serverLogs?.finishCursor);
  invariant(Number.isFinite(serverLogBaselineAt)
    && serverLogStart.baselineCursor === containerStartedAt
    && serverLogStart.monitorStartedAt === start.observedAt,
  'server-log baseline is not bound to the monitored container and start time');
  invariant(serverLogStart.policy === 'zero fatal/error lines from container start through monitor finish',
    'server-log zero-error policy is missing or different');
  invariant(typeof serverLogStart.output === 'string' && serverLogStart.output !== ''
    && serverLogs?.output === serverLogStart.output,
  'server-log artifact path is missing or changed');
  invariant(serverLogs?.baselineCursor === serverLogStart.baselineCursor
    && Number.isFinite(serverLogFinishAt)
    && serverLogFinishAt >= Date.parse(samples.at(-1)?.observedAt)
    && serverLogFinishAt <= monitorFinishedAt,
  'server-log capture interval is missing, stale, or outside the monitor interval');
  invariant(serverLogs?.readError === null, `server-log capture failed: ${serverLogs?.readError || 'missing evidence'}`);
  invariant(DIGEST_PATTERN.test(serverLogs?.sha256 || ''), 'server-log artifact checksum is invalid');
  invariant(Number.isInteger(serverLogs?.totalBytes) && serverLogs.totalBytes >= 0
    && Number.isInteger(serverLogs?.totalLines) && serverLogs.totalLines >= 0,
  'server-log artifact size or line count is invalid');
  invariant(serverLogs?.matchedErrorLines === 0
    && Array.isArray(serverLogs.matches) && serverLogs.matches.length === 0
    && serverLogs.matchesTruncated === false,
  'server-log evidence contains fatal/error lines or incomplete match evidence');
  for (const sample of samples) {
    invariant(sample.containerState?.containerId === start.containerId
      && sample.containerState?.imageId === imageId
      && sample.containerState?.startedAt === containerStartedAt,
    `capacity monitor container/image identity drifted at ${sample.observedAt || 'an unknown sample'}`);
    invariant(runtimeShapeMatches(sample.containerState),
      `capacity monitor runtime envelope drifted at ${sample.observedAt || 'an unknown sample'}`);
  }
  invariant(start.expectedShape?.sessions >= REQUIRED_USERS, 'capacity monitor did not require 10,000 sessions');
  invariant(start.expectedShape?.runners >= REQUIRED_USERS, 'capacity monitor did not require 10,000 runners');
  invariant(start.expectedShape?.memberships >= REQUIRED_MEMBERSHIPS,
    'capacity monitor did not require 50,000 namespace/room memberships');
  invariant(stableJson(start.expectedShape?.runtime) === stableJson(SOAK_RUNTIME_CONFIGURATION),
    'capacity monitor did not bind the exact production runtime configuration');
  invariant(start.monitorConfig?.durationSeconds >= REQUIRED_MONITOR_SECONDS,
    'capacity monitor duration is shorter than 2,250 seconds');
  invariant(start.monitorConfig?.gateWindowSeconds >= REQUIRED_GATE_SECONDS,
    'capacity headroom window is shorter than 30 minutes');
  invariant(typeof start.monitorConfig?.workloadFinishedMarker === 'string'
    && start.monitorConfig.workloadFinishedMarker !== '', 'capacity monitor did not require a workload-finished marker');
  invariant(start.monitorConfig?.minimumWorkloadSeconds >= REQUIRED_RAMP_SECONDS + REQUIRED_SOAK_SECONDS,
    'capacity monitor allowed the workload marker before the 300-second ramp and 1,860-second soak');
  invariant(start.monitorConfig?.minimumPostWorkloadSeconds >= REQUIRED_POST_WORKLOAD_SECONDS,
    'capacity monitor post-workload observation is shorter than 30 seconds');
  const expectedLoad = start.monitorConfig?.expectedLoad;
  invariant(typeof expectedLoad?.target === 'string' && expectedLoad.target !== '',
    'capacity monitor did not bind the staging target');
  invariant(expectedLoad?.shardCount === REQUIRED_SHARDS,
    'capacity monitor did not bind exactly four load shards');
  invariant(expectedLoad?.rampSeconds === REQUIRED_RAMP_SECONDS
    && expectedLoad?.soakSeconds === REQUIRED_SOAK_SECONDS
    && expectedLoad?.pollingPercent === 5
    && expectedLoad?.reconnectPercent === 10
    && expectedLoad?.reconnectAtSeconds === 600
    && stableJson(expectedLoad?.rates) === stableJson({ chatRps: 6.25, readRps: 12.5, runRps: 0.25 }),
  'capacity monitor did not bind the exact 10,000-user workload configuration');
  invariant(Array.isArray(expectedLoad?.sourceIps) && expectedLoad.sourceIps.length === REQUIRED_SHARDS
    && new Set(expectedLoad.sourceIps).size === REQUIRED_SHARDS,
  'capacity monitor did not bind four distinct load-generator source IPs');
  invariant((monitorFinishedAt - monitorStartedAt) / 1_000
    >= REQUIRED_MONITOR_SECONDS - Math.max((start.monitorConfig?.intervalSeconds || 0) * 2, 2),
  'capacity monitor finish evidence is shorter than its 2,250-second contract');
  invariant(Array.isArray(start.preflightFailures) && start.preflightFailures.length === 0,
    `capacity monitor preflight failed: ${(start.preflightFailures || []).join('; ')}`);
  invariant(finish.evaluation?.ok === true,
    `capacity monitor failed: ${(finish.evaluation?.failures || ['missing evaluation']).join('; ')}`);

  const gateStartSeconds = finish.evaluation?.gateStartSeconds;
  const gateEndSeconds = finish.evaluation?.gateEndSeconds;
  invariant(Number.isFinite(gateStartSeconds) && Number.isFinite(gateEndSeconds)
    && gateEndSeconds - gateStartSeconds >= REQUIRED_GATE_SECONDS,
  'capacity finish evidence does not contain a literal 30-minute gate window');
  invariant(gateEndSeconds <= (monitorFinishedAt - monitorStartedAt) / 1_000,
    'capacity gate ends after the monitor finished');
  const observed = finish.evaluation?.observed;
  invariant(observed?.sessionCoverage >= MINIMUM_COVERAGE_RATIO
    && observed?.sessionsEnd >= REQUIRED_USERS,
  'capacity finish evidence does not prove 10,000-session coverage');
  invariant(observed?.runnerCoverage >= MINIMUM_COVERAGE_RATIO
    && observed?.runnersEnd >= REQUIRED_USERS,
  'capacity finish evidence does not prove 10,000-runner coverage');
  invariant(observed?.membershipCoverage >= MINIMUM_COVERAGE_RATIO
    && observed?.membershipsEnd >= REQUIRED_MEMBERSHIPS,
  'capacity finish evidence does not prove 50,000-membership coverage');

  const workload = finish.workload;
  invariant(workload && Array.isArray(workload.shards), 'capacity finish evidence has no workload marker');
  const workloadGateStartAt = Date.parse(workload.gateStartAt);
  const workloadGateEndAt = Date.parse(workload.gateEndAt);
  invariant(Number.isFinite(workloadGateStartAt) && Number.isFinite(workloadGateEndAt)
    && workloadGateEndAt - workloadGateStartAt >= REQUIRED_GATE_SECONDS * 1_000,
  'workload marker does not identify a literal 30-minute concurrent gate');
  invariant(Math.abs(workloadGateStartAt - (monitorStartedAt + gateStartSeconds * 1_000)) <= 1_000
    && Math.abs(workloadGateEndAt - (monitorStartedAt + gateEndSeconds * 1_000)) <= 1_000
    && Math.abs(workload.gateEndSeconds - gateEndSeconds) <= 1,
  'capacity evaluation gate is not bound to the workload marker gate');
  const workloadFinishedAt = Date.parse(workload.finishedAt);
  const expectedElapsedSeconds = (workloadFinishedAt - monitorStartedAt) / 1_000;
  invariant(Number.isFinite(workloadFinishedAt) && workloadFinishedAt > monitorStartedAt
    && workloadFinishedAt <= monitorFinishedAt, 'workload-finished marker timestamp is stale or invalid');
  invariant(Number.isFinite(workload.elapsedSeconds)
    && Math.abs(workload.elapsedSeconds - expectedElapsedSeconds) <= 1,
  'workload-finished marker elapsed time does not match its timestamp');
  invariant(workload.elapsedSeconds >= start.monitorConfig.minimumWorkloadSeconds,
    'workload-finished marker arrived before the required workload duration');
  invariant(workload.postWorkloadSeconds >= start.monitorConfig.minimumPostWorkloadSeconds
    && workload.postWorkloadSamples > 0,
  'capacity monitor did not observe the required fresh post-workload interval');
  invariant((monitorFinishedAt - workloadFinishedAt) / 1_000 >= start.monitorConfig.minimumPostWorkloadSeconds,
    'capacity finish timestamp does not prove the required post-workload interval');
  invariant(workload.users === REQUIRED_USERS, 'workload-finished marker does not cover exactly 10,000 users');
  invariant(workload.shards.length === REQUIRED_SHARDS, 'workload-finished marker does not cover four shards');
  const workloadShardIndexes = new Set();
  const workloadSourceIps = new Set();
  const workloadReconnectOwnerUserIds = [];
  for (const shard of workload.shards) {
    invariant(Number.isInteger(shard.index) && shard.index >= 0 && shard.index < REQUIRED_SHARDS,
      'workload-finished marker contains an invalid shard index');
    invariant(!workloadShardIndexes.has(shard.index), `workload-finished marker duplicates shard ${shard.index}`);
    workloadShardIndexes.add(shard.index);
    invariant(shard.users === REQUIRED_USERS / REQUIRED_SHARDS,
      `workload-finished marker shard ${shard.index} does not cover 2,500 users`);
    invariant(DIGEST_PATTERN.test(shard.sha256 || ''),
      `workload-finished marker shard ${shard.index} has an invalid checksum`);
    invariant(shard.markerSha256 === shard.sha256,
      `workload-finished marker shard ${shard.index} checksum is not bound to the artifact`);
    invariant(typeof shard.path === 'string' && shard.path !== '',
      `workload-finished marker shard ${shard.index} has no artifact path`);
    invariant(typeof shard.sourceIp === 'string' && shard.sourceIp !== ''
      && !workloadSourceIps.has(shard.sourceIp),
    `workload-finished marker shard ${shard.index} has a missing or duplicate source IP`);
    workloadSourceIps.add(shard.sourceIp);
    invariant(Date.parse(shard.soakStartedAt) <= workloadGateStartAt
      && Date.parse(shard.workloadFinishedAt) >= workloadGateEndAt
      && Date.parse(shard.finishedAt) <= workloadFinishedAt,
    `workload-finished marker shard ${shard.index} does not span the full concurrent gate`);
    invariant(Number.isInteger(shard.initialOwnedChatChannels)
      && shard.initialOwnedChatChannels === start.expectedShape.realtime.groupCount / REQUIRED_SHARDS
      && Number.isInteger(shard.forcedReconnectOwnedChatChannels)
      && shard.forcedReconnectOwnedChatChannels
        === Math.round(start.expectedShape.realtime.groupCount * 0.1) / REQUIRED_SHARDS
      && shard.forcedReconnectStrategy === 'owner-stratified-v1'
      && Array.isArray(shard.forcedReconnectOwnerUserIds)
      && shard.forcedReconnectOwnerUserIds.length === shard.forcedReconnectOwnedChatChannels
      && new Set(shard.forcedReconnectOwnerUserIds).size === shard.forcedReconnectOwnedChatChannels
      && shard.forcedReconnectOwnerUserIds.every(Number.isInteger),
    `workload-finished marker shard ${shard.index} has an invalid presence-owner plan`);
    workloadReconnectOwnerUserIds.push(...shard.forcedReconnectOwnerUserIds);
  }
  validateRealtimeEvidence(
    start.expectedShape.realtime,
    workload.presencePlan,
    observed,
    start.expectedShape.sessions,
    start.expectedShape.runners,
  );
  invariant(workload.shards.reduce((sum, shard) => sum + shard.initialOwnedChatChannels, 0)
      === workload.presencePlan.initialOwnedChatChannels
    && workload.shards.reduce((sum, shard) => sum + shard.forcedReconnectOwnedChatChannels, 0)
      === workload.presencePlan.forcedReconnectOwnedChatChannels,
  'workload-finished marker aggregate presence-owner plan differs from its shards');
  invariant(sameIntegerSet(
    workloadReconnectOwnerUserIds,
    workload.presencePlan.forcedReconnectOwnerUserIds,
  ), 'workload-finished marker reconnect-owner IDs differ from its shards');
  invariant(finish.containerState?.running === true, 'capacity container was not running at certification finish');
  invariant(finish.containerState?.containerId === start.containerId
    && finish.containerState?.imageId === imageId
    && finish.containerState?.startedAt === containerStartedAt,
  'capacity finish container/image identity differs from the monitored image');
  invariant(runtimeShapeMatches(finish.containerState),
    'capacity finish runtime envelope differs from the certified shape');
  invariant(finish.containerState?.oomKilled === false, 'capacity container was OOM-killed');
  invariant(finish.containerState?.restartCount === 0, 'capacity container restarted during certification');
  return { start, finish };
}

export function validateServerLogArtifact(start, finish) {
  const serverLogArtifact = artifactSnapshot(finish.serverLogs.output, 'server-log evidence');
  invariant(serverLogArtifact.path === path.resolve(start.serverLogEvidence.output),
    'server-log artifact path differs from the monitor contract');
  invariant(serverLogArtifact.sha256 === finish.serverLogs.sha256,
    'server-log artifact checksum differs from monitor evidence');
  invariant(Buffer.byteLength(serverLogArtifact.text) === finish.serverLogs.totalBytes,
    'server-log artifact byte count differs from monitor evidence');
  invariant(serverLogArtifact.text.split(/\r?\n/u).filter(Boolean).length === finish.serverLogs.totalLines,
    'server-log artifact line count differs from monitor evidence');
  return serverLogArtifact;
}

export function validateLoadEvidence(results, monitorStart, monitorFinish, artifacts) {
  invariant(results.length > 0, 'at least one load-generator result is required');
  const shardCount = results[0].shard?.count;
  invariant(shardCount === REQUIRED_SHARDS, 'capacity certification requires exactly four load shards');
  invariant(results.length === shardCount, `received ${results.length} load results for ${shardCount} shards`);
  invariant(Array.isArray(artifacts) && artifacts.length === results.length,
    'every load result must be bound to its artifact checksum');
  const shardIndexes = new Set();
  const target = results[0].target;
  invariant(typeof target === 'string' && target !== '', 'load target is missing');
  const expectedLoad = monitorStart.monitorConfig.expectedLoad;
  invariant(target === expectedLoad.target, 'load target differs from the monitor contract');
  const commonConfiguration = JSON.stringify({
    rampSeconds: results[0].rampSeconds,
    soakSeconds: results[0].soakSeconds,
    pollingPercent: results[0].pollingPercent,
    reconnectPercent: results[0].reconnectPercent,
    reconnectAtSeconds: results[0].reconnectAtSeconds,
    rates: results[0].rates,
    thresholds: results[0].thresholds,
  });
  const monitorStartedAt = Date.parse(monitorStart.observedAt);
  const gateStartAt = monitorStartedAt + monitorFinish.evaluation.gateStartSeconds * 1_000;
  const gateEndAt = monitorStartedAt + monitorFinish.evaluation.gateEndSeconds * 1_000;
  invariant(Number.isFinite(gateStartAt) && Number.isFinite(gateEndAt)
    && gateEndAt - gateStartAt >= REQUIRED_GATE_SECONDS * 1_000,
  'monitor gate interval is invalid');
  const markerShards = new Map(monitorFinish.workload.shards.map((shard) => [shard.index, shard]));
  const sourceIps = new Set();
  let users = 0;

  for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
    const result = results[resultIndex];
    const artifact = artifacts[resultIndex];
    invariant(result.evaluation?.ok === true,
      `load shard ${result.shard?.index ?? '?'} failed: ${(result.evaluation?.failures || ['missing evaluation']).join('; ')}`);
    invariant(result.shard?.count === shardCount, 'load results disagree on shard count');
    invariant(result.target === target, 'load results target different staging endpoints');
    invariant(JSON.stringify({
      rampSeconds: result.rampSeconds,
      soakSeconds: result.soakSeconds,
      pollingPercent: result.pollingPercent,
      reconnectPercent: result.reconnectPercent,
      reconnectAtSeconds: result.reconnectAtSeconds,
      rates: result.rates,
      thresholds: result.thresholds,
    }) === commonConfiguration, 'load shards used inconsistent workload configurations');
    invariant(result.rampSeconds === expectedLoad.rampSeconds
      && result.soakSeconds === expectedLoad.soakSeconds
      && result.pollingPercent === expectedLoad.pollingPercent
      && result.reconnectPercent === expectedLoad.reconnectPercent
      && result.reconnectAtSeconds === expectedLoad.reconnectAtSeconds
      && JSON.stringify(result.rates) === JSON.stringify(expectedLoad.rates),
    `load shard ${result.shard?.index ?? '?'} differs from the monitor workload contract`);
    invariant(stableJson(result.thresholds) === stableJson(REQUIRED_LOAD_THRESHOLDS),
      `load shard ${result.shard?.index ?? '?'} thresholds differ from the release contract`);
    invariant(Number.isInteger(result.shard?.index), 'load shard index is missing');
    invariant(!shardIndexes.has(result.shard.index), `duplicate load shard ${result.shard.index}`);
    shardIndexes.add(result.shard.index);
    invariant(result.requestedUsers === REQUIRED_USERS / REQUIRED_SHARDS,
      `load shard ${result.shard.index} does not cover exactly 2,500 users`);
    invariant(result.rampSeconds >= REQUIRED_RAMP_SECONDS,
      `load shard ${result.shard.index} ramped for less than 300 seconds`);
    invariant(result.soakSeconds >= REQUIRED_SOAK_SECONDS,
      `load shard ${result.shard.index} soaked for less than 1,860 seconds`);
    invariant(expectedLoad.sourceIps.includes(result.sourceIp),
      `load shard ${result.shard.index} source IP differs from the monitor contract`);
    invariant(!sourceIps.has(result.sourceIp), `duplicate load-generator source IP ${result.sourceIp}`);
    sourceIps.add(result.sourceIp);
    invariant(result.metrics?.connected === result.requestedUsers && result.metrics?.connectFailures === 0,
      `load shard ${result.shard.index} did not connect every requested user`);
    const messageIds = result.workloadIdentity?.successfulMessageIds;
    const runIds = result.workloadIdentity?.requestedRunIds;
    invariant(Array.isArray(messageIds) && Array.isArray(runIds)
      && messageIds.length === result.metrics?.workload?.chat?.succeeded
      && runIds.length === result.metrics?.workload?.run?.succeeded
      && result.workloadIdentity.successfulMessageIdsCount === messageIds.length
      && result.workloadIdentity.requestedRunIdsCount === runIds.length
      && new Set(messageIds).size === messageIds.length && new Set(runIds).size === runIds.length
      && stableJson(messageIds) === stableJson([...messageIds].sort())
      && stableJson(runIds) === stableJson([...runIds].sort((left, right) => left - right))
      && result.workloadIdentity.successfulMessageIdsSha256
        === createHash('sha256').update(stableJson(messageIds)).digest('hex')
      && result.workloadIdentity.requestedRunIdsSha256
        === createHash('sha256').update(stableJson(runIds)).digest('hex'),
    `load shard ${result.shard.index} has invalid successful message/run identity evidence`);
    const selectedCount = (percent) => Math.floor(result.requestedUsers / 100) * percent
      + Math.min(result.requestedUsers % 100, percent);
    invariant(result.metrics?.pollingOnly === selectedCount(result.pollingPercent),
      `load shard ${result.shard.index} did not exercise the configured polling split`);
    invariant(result.metrics?.forcedReconnectsExpected === selectedCount(result.reconnectPercent),
      `load shard ${result.shard.index} did not force the exact 10% reconnect storm`);
    invariant(result.metrics?.forcedReconnectsRecovered === result.metrics?.forcedReconnectsExpected,
      `load shard ${result.shard.index} did not recover every forced reconnect`);
    invariant(result.metrics?.forcedReconnectsWithin20s === result.metrics?.forcedReconnectsExpected,
      `load shard ${result.shard.index} exceeded the 20-second reconnect deadline`);
    const withinTen = result.metrics?.forcedReconnectsWithin10s / result.metrics?.forcedReconnectsExpected;
    invariant(withinTen >= 0.99, `load shard ${result.shard.index} recovered fewer than 99% within 10 seconds`);
    const soakStartedAt = Date.parse(result.soakStartedAt);
    const rampCompletedAt = Date.parse(result.rampCompletedAt);
    const workloadFinishedAt = Date.parse(result.workloadFinishedAt);
    const loadFinishedAt = Date.parse(result.finishedAt);
    invariant(Number.isFinite(soakStartedAt) && Number.isFinite(rampCompletedAt)
      && Number.isFinite(workloadFinishedAt) && Number.isFinite(loadFinishedAt),
    `load shard ${result.shard.index} has invalid interval timestamps`);
    const loadStartedAt = Date.parse(result.metrics?.startedAt);
    invariant(Number.isFinite(loadStartedAt) && loadStartedAt >= monitorStartedAt
      && rampCompletedAt >= loadStartedAt && soakStartedAt >= rampCompletedAt
      && workloadFinishedAt >= soakStartedAt && loadFinishedAt >= workloadFinishedAt,
    `load shard ${result.shard.index} has stale or out-of-order interval timestamps`);
    invariant(soakStartedAt <= gateStartAt && rampCompletedAt <= gateStartAt,
      `load shard ${result.shard.index} was not ready before the monitor gate started`);
    invariant(workloadFinishedAt >= gateEndAt && loadFinishedAt >= gateEndAt,
      `load shard ${result.shard.index} ended before the monitor gate finished`);
    invariant(workloadFinishedAt - soakStartedAt >= result.soakSeconds * 1_000,
      `load shard ${result.shard.index} ended before its declared soak elapsed`);
    invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''),
      `load shard ${result.shard.index} artifact checksum is invalid`);
    const markerShard = markerShards.get(result.shard.index);
    invariant(markerShard?.sha256 === artifact.sha256,
      `load shard ${result.shard.index} checksum differs from the workload marker`);
    invariant(markerShard?.users === result.requestedUsers,
      `load shard ${result.shard.index} user count differs from the workload marker`);
    invariant(markerShard?.successfulMessageIdsCount === messageIds.length
      && markerShard?.successfulMessageIdsSha256
        === result.workloadIdentity.successfulMessageIdsSha256
      && markerShard?.requestedRunIdsCount === runIds.length
      && markerShard?.requestedRunIdsSha256 === result.workloadIdentity.requestedRunIdsSha256,
    `load shard ${result.shard.index} workload identity differs from the workload marker`);
    invariant(markerShard?.sourceIp === result.sourceIp
      && markerShard?.soakStartedAt === result.soakStartedAt
      && markerShard?.workloadFinishedAt === result.workloadFinishedAt
      && markerShard?.finishedAt === result.finishedAt,
    `load shard ${result.shard.index} interval differs from the workload marker`);
    invariant(Number.isInteger(result.presencePlan?.initialOwnedChatChannels)
      && Number.isInteger(result.presencePlan?.forcedReconnectOwnedChatChannels)
      && result.presencePlan.initialOwnedChatChannels === markerShard?.initialOwnedChatChannels
      && result.presencePlan.forcedReconnectOwnedChatChannels
        === markerShard?.forcedReconnectOwnedChatChannels
      && result.selectionPlan?.forcedReconnectStrategy === 'owner-stratified-v1'
      && result.presencePlan.strategy === result.selectionPlan.forcedReconnectStrategy
      && markerShard?.forcedReconnectStrategy === result.selectionPlan.forcedReconnectStrategy
      && stableJson(result.selectionPlan.forcedReconnectOwnerUserIds)
        === stableJson(result.presencePlan.forcedReconnectOwnerUserIds)
      && stableJson(result.presencePlan.forcedReconnectOwnerUserIds)
        === stableJson(markerShard?.forcedReconnectOwnerUserIds),
    `load shard ${result.shard.index} presence-owner plan differs from the workload marker`);
    invariant(typeof artifact?.path === 'string' && artifact.path !== ''
      && path.resolve(markerShard.path || '') === path.resolve(artifact.path),
      `load shard ${result.shard.index} path differs from the workload marker`);
    invariant(loadFinishedAt <= Date.parse(monitorFinish.workload.finishedAt),
      `load shard ${result.shard.index} finished after the workload marker`);
    users += result.requestedUsers;
  }

  invariant(users === REQUIRED_USERS, `load evidence covers ${users} users, expected exactly 10,000`);
  invariant(monitorFinish.workload.users === users, 'workload marker user count differs from load evidence');
  for (let index = 0; index < shardCount; index += 1) {
    invariant(shardIndexes.has(index), `load shard ${index} is missing`);
  }
  return {
    shardCount,
    users,
    gateStartAt: new Date(gateStartAt).toISOString(),
    gateEndAt: new Date(gateEndAt).toISOString(),
  };
}

export function validateCapacityFixtureSummary(summary, profileName = 'final10k') {
  const profile = CAPACITY_PROFILES[profileName];
  invariant(profile, `unsupported capacity fixture profile ${profileName}`);
  invariant(DIGEST_PATTERN.test(summary?.sha256 || '')
    && DIGEST_PATTERN.test(summary?.identitySha256 || '')
    && DIGEST_PATTERN.test(summary?.groupShapeSha256 || '')
    && Number.isInteger(summary?.bytes) && summary.bytes > 0,
  'capacity fixture summary is missing or unbound');
  invariant(summary.lines === profile.users && summary.users === profile.users
    && summary.groups === profile.groups
    && summary.groupSize === REQUIRED_FIXTURE_GROUP_SIZE
    && summary.runners === profile.users
    && summary.ownedChatChannels === profile.groups,
    `capacity fixture summary differs from the exact ${profile.users.toLocaleString('en-US')}-user/${profile.groups}-group shape`);
  return summary;
}

export function validateCapacityFixtureArtifact(artifact, profileName = 'final10k') {
  const profile = CAPACITY_PROFILES[profileName];
  invariant(profile, `unsupported capacity fixture profile ${profileName}`);
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'capacity fixture checksum is invalid');
  const fixtures = artifact.text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let fixture;
    try { fixture = JSON.parse(line); } catch (error) {
      throw new Error(`capacity fixture line ${index + 1} is invalid JSON: ${error.message}`);
    }
    invariant(typeof fixture.token === 'string' && fixture.token
      && typeof fixture.vaultId === 'string' && fixture.vaultId
      && typeof fixture.channelId === 'string' && fixture.channelId
      && Number.isInteger(fixture.ownedChatChannels) && fixture.ownedChatChannels >= 0
      && fixture.runner === true,
    `capacity fixture line ${index + 1} is incomplete`);
    let claims;
    try {
      const parts = fixture.token.split('.');
      invariant(parts.length === 3, 'not a JWT');
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new Error(`capacity fixture line ${index + 1} has no JWT identity`);
    }
    invariant(Number.isInteger(claims?.id)
      && typeof claims?.username === 'string' && claims.username,
    `capacity fixture line ${index + 1} has no valid user identity`);
    return {
      sourceIndex: index,
      token: fixture.token,
      authenticatedUserId: claims.id,
      username: claims.username,
      vaultId: fixture.vaultId,
      channelId: fixture.channelId,
      ownedChatChannels: fixture.ownedChatChannels,
      runner: fixture.runner,
    };
  });
  invariant(fixtures.length === profile.users,
    `capacity fixture contains ${fixtures.length} users, expected exactly ${profile.users}`);
  invariant(new Set(fixtures.map((fixture) => fixture.token)).size === profile.users
    && new Set(fixtures.map((fixture) => fixture.authenticatedUserId)).size === profile.users
    && new Set(fixtures.map((fixture) => fixture.username)).size === profile.users,
  'capacity fixture reuses a token, authenticated user, or username');
  const groups = new Map();
  for (const fixture of fixtures) {
    const key = `${fixture.vaultId}\u0000${fixture.channelId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fixture);
  }
  invariant(groups.size === profile.groups,
    `capacity fixture does not contain exactly ${profile.groups} vault/channel groups`);
  const groupShape = [...groups.entries()].map(([key, group]) => {
    const [vaultId, channelId] = key.split('\u0000');
    const owners = group.reduce((sum, fixture) => sum + fixture.ownedChatChannels, 0);
    invariant(group.length === REQUIRED_FIXTURE_GROUP_SIZE && owners === 1,
      `capacity fixture group ${key} must contain 25 users and exactly one owner`);
    return { vaultId, channelId, users: group.length, owners };
  }).sort((left, right) => `${left.vaultId}\u0000${left.channelId}`
    .localeCompare(`${right.vaultId}\u0000${right.channelId}`));
  const identities = fixtures.map(({ token: _token, ...fixture }) => fixture);
  return validateCapacityFixtureSummary({
    sha256: artifact.sha256,
    bytes: Buffer.byteLength(artifact.text),
    lines: fixtures.length,
    users: fixtures.length,
    groups: groups.size,
    groupSize: REQUIRED_FIXTURE_GROUP_SIZE,
    runners: fixtures.filter((fixture) => fixture.runner).length,
    ownedChatChannels: groupShape.reduce((sum, group) => sum + group.owners, 0),
    identitySha256: createHash('sha256').update(stableJson(identities)).digest('hex'),
    groupShapeSha256: createHash('sha256').update(stableJson(groupShape)).digest('hex'),
  }, profileName);
}
