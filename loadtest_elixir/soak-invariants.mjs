#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Manager } from 'socket.io-client';

import { parseArgs, readFixtures } from './load.mjs';
import {
  analyzeServerLogs,
  headroomEvaluation,
  serverLogFailures,
  shapeFailures,
} from './monitor.mjs';

const PRODUCTION_CPUS = 2;
const PRODUCTION_MEMORY_BYTES = 3 * 1024 ** 3;

export const SOAK_PROFILE = Object.freeze({
  users: 5_000,
  rampSeconds: 300,
  soakSeconds: 7_200,
  churnIntervalSeconds: 300,
  churnPercent: 10,
  runRps: 1,
  sampleIntervalSeconds: 5,
  recoveryTimeoutSeconds: 180,
  recoveryConsecutiveSamples: 3,
});

export const SOAK_RUNTIME_CONFIGURATION = Object.freeze({
  httpAcceptors: 4,
  httpMaxConnections: 32_768,
  httpBacklog: 65_535,
  networkMode: true,
  trustProxyHops: 1,
  qmdWorkerEnabled: true,
  realtimeHibernateAfterMs: 5_000,
  runnerOrphanReclaimMs: 600_000,
  sqlitePoolSize: 20,
  sqliteBusyTimeoutMs: 5_000,
});

const SOAK_MEMBERSHIPS = SOAK_PROFILE.users * 5;
const SOAK_FIXTURE_GROUP_SIZE = 25;
const SOAK_FIXTURE_GROUPS = SOAK_PROFILE.users / SOAK_FIXTURE_GROUP_SIZE;
const SERVER_LOG_POLICY = 'zero fatal/error lines from container start through soak finish';
const RAMP_TOLERANCE_SECONDS = 10;
const EXPECTED_LIVE_EVENT_SIGNATURE = Object.freeze([
  '2:status:running',
  '3:text',
  '4:status:completed',
]);
const BASELINE_ORPHAN_RECLAIM_SUMMARY =
  'Desktop agent runner did not reclaim this run after server restart.';
const BASELINE_ORPHANS = Object.freeze([
  { id: 1_896, ownerUserId: 1, queuedSeq: 1_913, failedSeq: 1_914 },
  { id: 1_897, ownerUserId: 4, queuedSeq: 27, failedSeq: 28 },
]);

export const RETURN_THRESHOLDS = Object.freeze({
  processCountRatio: 1.05,
  processCountSlack: 32,
  etsBytesRatio: 1.10,
  etsBytesSlack: 8 * 1024 ** 2,
  memoryBytesRatio: 1.10,
  memoryBytesSlack: 64 * 1024 ** 2,
  openFilesRatio: 1.10,
  openFilesSlack: 32,
  poolBusySlack: 1,
  poolQueueSlack: 0,
});

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim();
}

function docker(...args) {
  return command('docker', args);
}

function dockerJson(args) {
  return JSON.parse(docker(...args));
}

function releaseRpc(container, expression) {
  return docker('exec', container, '/app/release/bin/cascade_elixir', 'rpc', expression);
}

function parseLastJson(output) {
  const lines = String(output).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* keep looking */ }
  }
  throw new Error(`RPC did not return JSON: ${String(output).slice(-500)}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function bearer(token, sourceIp = '') {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(sourceIp ? { 'X-Forwarded-For': sourceIp } : {}),
  };
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * percentileValue) - 1)];
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function sortedNumeric(values) {
  return [...values].map(Number).sort((left, right) => left - right);
}

function sameNumericSet(left, right) {
  const leftValues = sortedNumeric(left || []);
  const rightValues = sortedNumeric(right || []);
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => Number.isInteger(value) && value === rightValues[index]);
}

function exactProfileFailures(profile) {
  return Object.entries(SOAK_PROFILE).flatMap(([key, expected]) => (
    profile?.[key] === expected ? [] : [`soak ${key} is ${profile?.[key] ?? 'missing'}, expected exactly ${expected}`]
  ));
}

function exactRuntimeFailures(configuration) {
  return Object.entries(SOAK_RUNTIME_CONFIGURATION).flatMap(([key, expected]) => (
    configuration?.[key] === expected
      ? []
      : [`runtime ${key} is ${configuration?.[key] ?? 'missing'}, expected ${expected}`]
  ));
}

function normalizedHostConfig(hostConfig) {
  return {
    nanoCpus: hostConfig?.NanoCpus ?? hostConfig?.nanoCpus,
    cpusetCpus: hostConfig?.CpusetCpus ?? hostConfig?.cpusetCpus,
    memory: hostConfig?.Memory ?? hostConfig?.memory,
    memorySwap: hostConfig?.MemorySwap ?? hostConfig?.memorySwap,
    pidsLimit: hostConfig?.PidsLimit ?? hostConfig?.pidsLimit,
    ulimits: hostConfig?.Ulimits ?? hostConfig?.ulimits,
  };
}

function certifiedShapeFailures(hostConfig) {
  const normalized = normalizedHostConfig(hostConfig);
  const failures = shapeFailures({
    NanoCpus: normalized.nanoCpus,
    CpusetCpus: normalized.cpusetCpus,
    Memory: normalized.memory,
    MemorySwap: normalized.memorySwap,
    PidsLimit: normalized.pidsLimit,
    Ulimits: normalized.ulimits,
  }, PRODUCTION_CPUS, PRODUCTION_MEMORY_BYTES);
  const nofile = normalized.ulimits?.find((entry) => entry.Name === 'nofile');
  if (normalized.nanoCpus !== 2_000_000_000
      || normalized.cpusetCpus !== '0-1'
      || normalized.memory !== PRODUCTION_MEMORY_BYTES
      || normalized.memorySwap !== PRODUCTION_MEMORY_BYTES
      || normalized.pidsLimit !== 100_000
      || nofile?.Soft !== 200_000
      || nofile?.Hard !== 200_000) {
    failures.push('runtime envelope differs from the exact 10,000-user certification shape');
  }
  return [...new Set(failures)];
}

function currentIdentity(container) {
  const [inspection] = dockerJson(['inspect', container]);
  const [image] = dockerJson(['image', 'inspect', inspection.Image]);
  return {
    container: {
      id: inspection.Id,
      imageId: inspection.Image,
      startedAt: inspection.State.StartedAt,
      running: inspection.State.Running,
      restartCount: inspection.RestartCount,
      oomKilled: inspection.State.OOMKilled,
      hostConfig: {
        nanoCpus: inspection.HostConfig.NanoCpus,
        cpusetCpus: inspection.HostConfig.CpusetCpus,
        memory: inspection.HostConfig.Memory,
        memorySwap: inspection.HostConfig.MemorySwap,
        pidsLimit: inspection.HostConfig.PidsLimit,
        ulimits: inspection.HostConfig.Ulimits,
      },
    },
    image: {
      id: image.Id,
      repoDigests: image.RepoDigests || [],
      created: image.Created,
      revision: image.Config?.Labels?.['org.opencontainers.image.revision'] || '',
    },
    rawHostConfig: inspection.HostConfig,
  };
}

function runtimeIdentity(container) {
  return parseLastJson(releaseRpc(
    container,
    'Jason.encode!(%{elixir: System.version(), otpRelease: List.to_string(:erlang.system_info(:otp_release)), ertsVersion: List.to_string(:erlang.system_info(:version)), schedulersOnline: System.schedulers_online(), processLimit: :erlang.system_info(:process_limit), portLimit: :erlang.system_info(:port_limit), cascadeVersion: Application.spec(:cascade_elixir, :vsn) |> to_string(), httpAcceptors: Application.get_env(:cascade_elixir, :http_acceptors), httpMaxConnections: Application.get_env(:cascade_elixir, :http_max_connections), httpBacklog: Application.get_env(:cascade_elixir, :http_backlog), networkMode: Application.get_env(:cascade_elixir, :network_mode), trustProxyHops: Application.get_env(:cascade_elixir, :trust_proxy_hops), qmdWorkerEnabled: Application.get_env(:cascade_elixir, :qmd_worker_enabled), realtimeHibernateAfterMs: Application.get_env(:cascade_elixir, :realtime_hibernate_after_ms), runnerOrphanReclaimMs: Application.get_env(:cascade_elixir, :runner_orphan_reclaim_ms), sqlitePoolSize: Cascade.DB.Repo.config()[:pool_size], sqliteBusyTimeoutMs: Cascade.DB.Repo.config()[:busy_timeout]}) |> IO.puts()',
  ));
}

function containerBeamOpenFiles(container) {
  const output = docker(
    'exec',
    container,
    'sh',
    '-lc',
    'for proc in /proc/[0-9]*; do read name < "$proc/comm" || continue; if test "$name" = beam.smp; then set -- "$proc"/fd/*; echo "${proc##*/} $#"; exit 0; fi; done; exit 1',
  );
  const [pid, count] = output.trim().split(/\s+/, 2).map(Number);
  if (!Number.isInteger(pid) || !Number.isInteger(count)) throw new Error(`invalid BEAM open-file sample: ${output}`);
  return { pid, count };
}

function resourceVector(sample) {
  return {
    processCount: sample?.beam?.beam?.processCount,
    etsBytes: sample?.beam?.deep?.etsBytes,
    memoryBytes: sample?.beam?.beam?.memory?.total,
    openFiles: sample?.beamOpenFiles?.count,
    poolBusy: sample?.beam?.pool?.busy,
    poolQueue: sample?.beam?.pool?.queue,
    sessions: sample?.beam?.beam?.realtimeSessions,
    runners: sample?.beam?.deep?.registeredRunners,
    memberships: sample?.beam?.deep?.realtimeMemberships,
  };
}

function referenceVector(samples) {
  const vectors = samples.map(resourceVector);
  return Object.fromEntries(Object.keys(vectors[0] || {}).map((key) => {
    const values = vectors.map((vector) => vector[key]).filter(Number.isFinite);
    return [key, values.length ? Math.max(...values) : null];
  }));
}

function allowed(reference, ratio, slack) {
  if (!Number.isFinite(reference)) return null;
  return Math.ceil(reference * ratio + slack);
}

export function returnToBaselineFailures(baseline, observed, thresholds = RETURN_THRESHOLDS) {
  const failures = [];
  const checks = [
    ['processCount', thresholds.processCountRatio, thresholds.processCountSlack, 'BEAM process count'],
    ['etsBytes', thresholds.etsBytesRatio, thresholds.etsBytesSlack, 'ETS bytes'],
    ['memoryBytes', thresholds.memoryBytesRatio, thresholds.memoryBytesSlack, 'BEAM memory'],
    ['openFiles', thresholds.openFilesRatio, thresholds.openFilesSlack, 'BEAM open files'],
    ['poolBusy', 1, thresholds.poolBusySlack, 'DB pool busy connections'],
    ['poolQueue', 1, thresholds.poolQueueSlack, 'DB pool queue'],
    ['sessions', 1, 0, 'realtime sessions'],
    ['runners', 1, 0, 'registered runners'],
    ['memberships', 1, 0, 'realtime memberships'],
  ];
  for (const [key, ratio, slack, label] of checks) {
    const limit = allowed(baseline?.[key], ratio, slack);
    const value = observed?.[key];
    if (!Number.isFinite(limit) || !Number.isFinite(value)) {
      failures.push(`${label} baseline/recovery metric is missing`);
    } else if (value > limit) {
      failures.push(`${label} recovered to ${value}, expected <=${limit} from baseline ${baseline[key]}`);
    }
  }
  return failures;
}

function identityFailures(identity, expectedImage, expectedRevision) {
  const failures = [];
  const initial = identity?.initial;
  const final = identity?.final;
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedImage || '')) failures.push('expected image is not an immutable sha256 image ID');
  if (initial?.container?.imageId !== expectedImage) failures.push(`initial image is ${initial?.container?.imageId || 'missing'}, expected ${expectedImage || 'missing'}`);
  if (final?.container?.imageId !== expectedImage) failures.push(`final image is ${final?.container?.imageId || 'missing'}, expected ${expectedImage || 'missing'}`);
  if (!initial?.container?.id || initial.container.id !== final?.container?.id) failures.push('container identity changed during soak');
  if (!initial?.container?.startedAt || initial.container.startedAt !== final?.container?.startedAt) failures.push('container start identity changed during soak');
  if (initial?.container?.restartCount !== 0 || final?.container?.restartCount !== 0) failures.push('container restart count must remain exactly zero');
  if (!final?.container?.running) failures.push('container was not running at final inspection');
  if (final?.container?.oomKilled) failures.push('container was OOM-killed');
  failures.push(...certifiedShapeFailures(initial?.container?.hostConfig));
  if (stableJson(initial?.container?.hostConfig) !== stableJson(final?.container?.hostConfig)) {
    failures.push('container runtime envelope changed during soak');
  }
  if (!/^[a-f0-9]{40}$/u.test(initial?.image?.revision || '')) failures.push('image has no full Git revision label');
  if (initial?.image?.revision !== final?.image?.revision) failures.push('image revision changed during soak');
  if (expectedRevision && initial?.image?.revision !== expectedRevision) failures.push(`image revision is ${initial?.image?.revision || 'missing'}, expected ${expectedRevision}`);
  if (!identity?.runtimeInitial || JSON.stringify(identity.runtimeInitial) !== JSON.stringify(identity.runtimeFinal)) {
    failures.push('Elixir/OTP/application runtime identity changed during soak');
  }
  failures.push(...exactRuntimeFailures(identity?.runtimeInitial));
  return failures;
}

function sampleInvariantFailures(sample, evidence) {
  const failures = [];
  const state = sample?.containerState;
  const initial = evidence?.identity?.initial;
  if (sample?.type !== 'runtime-sample') failures.push('journal record is not a runtime sample');
  if (!['baseline', 'soak', 'post-leave'].includes(sample?.phase)) failures.push(`invalid journal phase ${sample?.phase ?? 'missing'}`);
  if (!Number.isFinite(Date.parse(sample?.observedAt))) failures.push('journal sample timestamp is invalid');
  if (state?.id !== initial?.container?.id) failures.push('container ID changed');
  if (state?.imageId !== evidence?.expectedImage) failures.push('image ID changed');
  if (state?.startedAt !== initial?.container?.startedAt) failures.push('container start changed');
  if (state?.imageRevision !== evidence?.expectedRevision) failures.push('image revision changed');
  if (state?.running !== true) failures.push('container is not running');
  if (state?.restartCount !== 0) failures.push(`container restart count is ${state?.restartCount ?? 'missing'}`);
  if (state?.oomKilled !== false) failures.push('container was OOM-killed');
  failures.push(...certifiedShapeFailures(state?.hostConfig));
  if (stableJson(state?.hostConfig) !== stableJson(initial?.container?.hostConfig)) failures.push('container runtime envelope changed');
  failures.push(...exactRuntimeFailures(sample?.beam?.configuration));
  if (sample?.beam?.beam?.error || sample?.beam?.pool?.error || sample?.beam?.deep?.error) {
    failures.push('capacity probe sample contains an error');
  }
  if (!Array.isArray(sample?.errors)) failures.push('sample error list is missing');
  else failures.push(...sample.errors);
  return [...new Set(failures)];
}

export function parseSoakJournal(raw) {
  const lines = String(raw || '').split(/\r?\n/u).filter(Boolean);
  if (!lines.length) throw new Error('two-hour soak runtime journal is empty');
  return lines.map((line, index) => {
    try { return JSON.parse(line); } catch (error) {
      throw new Error(`invalid two-hour soak journal JSON on line ${index + 1}: ${error.message}`);
    }
  });
}

function phaseOrderFailures(records) {
  const failures = [];
  const order = { baseline: 0, soak: 1, 'post-leave': 2 };
  let priorPhase = 0;
  let priorAt = -Infinity;
  for (const [index, record] of records.entries()) {
    const phase = order[record?.phase];
    const observedAt = Date.parse(record?.observedAt);
    if (!Number.isInteger(phase) || phase < priorPhase) failures.push(`journal phase order changed at sample ${index}`);
    if (!Number.isFinite(observedAt) || observedAt <= priorAt) failures.push(`journal timestamps are not strictly increasing at sample ${index}`);
    if (Number.isInteger(phase)) priorPhase = phase;
    if (Number.isFinite(observedAt)) priorAt = observedAt;
  }
  return failures;
}

function runtimeCoverage(samples, profile) {
  return {
    samples: samples.length,
    sessionsAtCapacityRatio: samples.filter((sample) => sample.beam?.beam?.realtimeSessions >= profile.users).length / Math.max(samples.length, 1),
    runnersAtCapacityRatio: samples.filter((sample) => sample.beam?.deep?.registeredRunners >= profile.users).length / Math.max(samples.length, 1),
    membershipsAtCapacityRatio: samples.filter((sample) => sample.beam?.deep?.realtimeMemberships >= SOAK_MEMBERSHIPS).length / Math.max(samples.length, 1),
    maxima: referenceVector(samples),
  };
}

export function recomputeSoakJournal(evidence, records) {
  const failures = [...phaseOrderFailures(records)];
  for (const [index, record] of records.entries()) {
    failures.push(...sampleInvariantFailures(record, evidence).map((failure) => `journal sample ${index}: ${failure}`));
  }
  const baselineRecords = records.filter((record) => record.phase === 'baseline');
  const soakRecords = records.filter((record) => record.phase === 'soak');
  const recoveryRecords = records.filter((record) => record.phase === 'post-leave');
  if (baselineRecords.length !== 3) failures.push(`baseline journal samples are ${baselineRecords.length}/3`);
  if (recoveryRecords.length < SOAK_PROFILE.recoveryConsecutiveSamples) {
    failures.push(`post-leave journal samples are ${recoveryRecords.length}/${SOAK_PROFILE.recoveryConsecutiveSamples}`);
  }
  const soakStartedMs = Date.parse(evidence.soakStartedAt);
  for (const [index, record] of [...soakRecords, ...recoveryRecords].entries()) {
    const wallElapsed = (Date.parse(record.observedAt) - soakStartedMs) / 1_000;
    if (!Number.isFinite(record.elapsedSeconds) || !Number.isFinite(wallElapsed)
        || Math.abs(record.elapsedSeconds - wallElapsed) > 2) {
      failures.push(`journal sample elapsedSeconds is not bound to observedAt at record ${index}`);
    }
  }
  for (let index = 1; index < soakRecords.length; index += 1) {
    const elapsedGap = soakRecords[index].elapsedSeconds - soakRecords[index - 1].elapsedSeconds;
    const wallGap = (Date.parse(soakRecords[index].observedAt) - Date.parse(soakRecords[index - 1].observedAt)) / 1_000;
    if (!(elapsedGap > 0 && elapsedGap <= SOAK_PROFILE.sampleIntervalSeconds * 3)
        || !(wallGap > 0 && wallGap <= SOAK_PROFILE.sampleIntervalSeconds * 3)) {
      failures.push(`soak journal sampling gap at record ${index} exceeds the fixed five-second cadence tolerance`);
    }
  }
  const baselineReference = referenceVector(baselineRecords);
  let consecutivePassing = 0;
  for (const record of recoveryRecords) {
    consecutivePassing = returnToBaselineFailures(baselineReference, resourceVector(record)).length === 0
      ? consecutivePassing + 1
      : 0;
  }
  const coverage = runtimeCoverage(soakRecords, SOAK_PROFILE);
  const finalSoak = soakRecords.at(-1);
  if (finalSoak?.beam?.beam?.realtimeSessions !== SOAK_PROFILE.users
      || finalSoak?.beam?.deep?.registeredRunners !== SOAK_PROFILE.users
      || finalSoak?.beam?.deep?.realtimeMemberships < SOAK_MEMBERSHIPS) {
    failures.push('final pre-leave sample does not hold exactly 5,000 sessions/runners and at least 25,000 memberships');
  }
  const headroom = headroomEvaluation(
    soakRecords,
    SOAK_PROFILE.soakSeconds,
    PRODUCTION_MEMORY_BYTES,
    PRODUCTION_CPUS,
    SOAK_PROFILE.users,
    SOAK_PROFILE.users,
    SOAK_MEMBERSHIPS,
    failures,
    SOAK_RUNTIME_CONFIGURATION,
    SOAK_PROFILE.soakSeconds,
    SOAK_PROFILE.sampleIntervalSeconds,
    SOAK_PROFILE.soakSeconds,
    null,
  );
  return {
    records: records.length,
    phases: { baseline: baselineRecords.length, soak: soakRecords.length, postLeave: recoveryRecords.length },
    baseline: { samples: baselineRecords.map(resourceVector), reference: baselineReference },
    runtimeCoverage: coverage,
    recovery: {
      samples: recoveryRecords.map(resourceVector),
      final: recoveryRecords.length ? resourceVector(recoveryRecords.at(-1)) : null,
      consecutivePassing,
    },
    headroom,
    failures: headroom.failures,
  };
}

export function evaluateSoakEvidence(evidence) {
  const failures = [...(evidence.preflightFailures || [])];
  const profile = evidence.profile || {};
  failures.push(...exactProfileFailures(profile));
  if (!(evidence.observed?.soakSeconds >= SOAK_PROFILE.soakSeconds - 2)) failures.push(`observed soak is ${evidence.observed?.soakSeconds ?? 'missing'}s, expected >=${SOAK_PROFILE.soakSeconds - 2}s`);
  const soakStartedAt = Date.parse(evidence.soakStartedAt);
  const soakFinishedAt = Date.parse(evidence.soakFinishedAt);
  if (!Number.isFinite(soakStartedAt) || !Number.isFinite(soakFinishedAt)
      || Math.abs((soakFinishedAt - soakStartedAt) / 1_000 - evidence.observed?.soakSeconds) > 0.001) {
    failures.push('observed soak duration is not bound to its start/finish timestamps');
  }
  const rampStartedAt = Date.parse(evidence.workload?.rampStartedAt);
  const rampCompletedAt = Date.parse(evidence.workload?.rampCompletedAt);
  const observedRampSeconds = (rampCompletedAt - rampStartedAt) / 1_000;
  if (!Number.isFinite(rampStartedAt) || !Number.isFinite(rampCompletedAt)
      || rampCompletedAt > soakStartedAt
      || observedRampSeconds < SOAK_PROFILE.rampSeconds
      || observedRampSeconds > SOAK_PROFILE.rampSeconds + RAMP_TOLERANCE_SECONDS) {
    failures.push(`observed connection ramp is ${Number.isFinite(observedRampSeconds) ? observedRampSeconds : 'missing'}s, expected ${SOAK_PROFILE.rampSeconds}-${SOAK_PROFILE.rampSeconds + RAMP_TOLERANCE_SECONDS}s before soak start`);
  }

  failures.push(...identityFailures(evidence.identity, evidence.expectedImage, evidence.expectedRevision));

  const fixtures = evidence.fixtures || {};
  if (!/^[a-f0-9]{64}$/u.test(fixtures.sha256 || '')
      || !/^[a-f0-9]{64}$/u.test(fixtures.selectedIdentitySha256 || '')
      || fixtures.users !== SOAK_PROFILE.users
      || fixtures.groups !== SOAK_FIXTURE_GROUPS
      || fixtures.groupSize !== SOAK_FIXTURE_GROUP_SIZE
      || !Array.isArray(fixtures.groupIdentities)
      || fixtures.groupIdentities.length !== SOAK_FIXTURE_GROUPS
      || fixtures.groupIdentities.some((group) => group?.users !== SOAK_FIXTURE_GROUP_SIZE
        || group?.owners !== 1)
      || !Array.isArray(fixtures.churnCohortDigests)
      || fixtures.churnCohortDigests.length !== 10
      || fixtures.churnCohortDigests.some((value) => !/^[a-f0-9]{64}$/u.test(value))) {
    failures.push('fixture artifact/hash/user/group identity is incomplete or differs from the release contract');
  }

  const workload = evidence.workload || {};
  if (workload.initialConnected !== SOAK_PROFILE.users) failures.push(`initial connections are ${workload.initialConnected ?? 'missing'}/${SOAK_PROFILE.users}`);
  if (workload.initialConnectionFailures !== 0) failures.push(`${workload.initialConnectionFailures ?? 'missing'} initial connection failures`);
  const expectedChurnCycles = Math.floor((profile.soakSeconds - 20) / profile.churnIntervalSeconds);
  if ((workload.churnCycles?.length || 0) !== expectedChurnCycles) failures.push(`churn cycles are ${workload.churnCycles?.length || 0}/${expectedChurnCycles}`);
  const cohortCounts = Array(10).fill(0);
  for (const [cycleIndex, cycle] of (workload.churnCycles || []).entries()) {
    const expectedSelected = Math.round(profile.users * profile.churnPercent / 100);
    const expectedCohort = cycleIndex % 10;
    cohortCounts[expectedCohort] += 1;
    if (cycle.index !== cycleIndex || cycle.cohort !== expectedCohort
        || cycle.selectedIdentitySha256 !== evidence.fixtures?.churnCohortDigests?.[expectedCohort]) {
      failures.push(`churn cycle ${cycleIndex} identity/cohort evidence differs from deterministic cohort ${expectedCohort}`);
    }
    if (cycle.selected !== expectedSelected) failures.push(`churn cycle ${cycle.index} selected ${cycle.selected}/${expectedSelected}`);
    if (cycle.recovered !== cycle.selected) failures.push(`churn cycle ${cycle.index} recovered ${cycle.recovered}/${cycle.selected}`);
    if ((cycle.within10 || 0) / Math.max(cycle.selected, 1) < 0.99) failures.push(`churn cycle ${cycle.index} recovered <99% within 10s`);
    if (cycle.within20 !== cycle.selected) failures.push(`churn cycle ${cycle.index} did not fully recover within 20s`);
    if ((cycle.failures || []).length) failures.push(`churn cycle ${cycle.index} reported ${cycle.failures.length} failures`);
  }
  const expectedCohortCounts = Array.from({ length: 10 }, (_unused, cohort) => (
    Math.floor(expectedChurnCycles / 10) + (cohort < expectedChurnCycles % 10 ? 1 : 0)
  ));
  if (stableJson(cohortCounts) !== stableJson(expectedCohortCounts)) {
    failures.push(`churn cohort coverage is ${stableJson(cohortCounts)}, expected ${stableJson(expectedCohortCounts)}`);
  }

  const coverage = workload.runtimeCoverage || {};
  const minimumRuntimeSamples = Math.floor(profile.soakSeconds / profile.sampleIntervalSeconds * 0.99);
  if ((coverage.samples || 0) < minimumRuntimeSamples) failures.push(`soak runtime samples are ${coverage.samples || 0}/${minimumRuntimeSamples}`);
  if ((coverage.sessionsAtCapacityRatio || 0) < 0.9) failures.push(`realtime sessions held capacity for ${((coverage.sessionsAtCapacityRatio || 0) * 100).toFixed(2)}% of soak samples`);
  if ((coverage.runnersAtCapacityRatio || 0) < 0.9) failures.push(`registered runners held capacity for ${((coverage.runnersAtCapacityRatio || 0) * 100).toFixed(2)}% of soak samples`);
  if ((coverage.membershipsAtCapacityRatio || 0) < 0.9) failures.push(`realtime memberships held capacity for ${((coverage.membershipsAtCapacityRatio || 0) * 100).toFixed(2)}% of soak samples`);

  const runs = workload.runs || {};
  const minimumRuns = Math.floor(profile.runRps * profile.soakSeconds * 0.99);
  if ((runs.scheduled || 0) < minimumRuns) failures.push(`runs scheduled ${runs.scheduled || 0}/${minimumRuns}`);
  if (runs.created !== runs.scheduled) failures.push(`runs created ${runs.created || 0}/${runs.scheduled || 0}`);
  if (runs.delegated !== runs.created) failures.push(`runs delegated ${runs.delegated || 0}/${runs.created || 0}`);
  if (runs.completed !== runs.created) failures.push(`runs completed ${runs.completed || 0}/${runs.created || 0}`);
  if ((runs.duplicates || 0) > 0) failures.push(`${runs.duplicates} duplicate run delegations`);
  if ((runs.orderingViolations || 0) > 0) failures.push(`${runs.orderingViolations} run-event ordering violations`);
  if ((runs.requestErrors || 0) / Math.max(runs.scheduled || 0, 1) > 0.001) failures.push('run request error rate exceeds 0.1%');
  const runIds = workload.runIds || {};
  if (!sameNumericSet(runIds.requested, runIds.delegated)
      || !sameNumericSet(runIds.requested, runIds.terminal)
      || !sameNumericSet(runIds.requested, runIds.liveComplete)
      || !sameNumericSet(runIds.requested, evidence.postDb?.runIds)
      || runIds.requested?.length !== runs.created) {
    failures.push('requested, delegated, live-complete, terminal, and persisted run-ID sets are not exactly equal');
  }
  const liveEvents = workload.liveEvents || [];
  if (liveEvents.length !== runs.created
      || !sameNumericSet(liveEvents.map((entry) => entry.runId), runIds.requested)
      || liveEvents.some((entry) => stableJson(entry.signature) !== stableJson(EXPECTED_LIVE_EVENT_SIGNATURE))
      || workload.liveEventDigest !== digest(stableJson(liveEvents))) {
    failures.push('live run-event evidence is missing, duplicated, gapped, unordered, or not exactly seq 2/3/4');
  }
  if (evidence.postDb?.failures?.length || evidence.postDb?.runs !== runs.created
      || evidence.postDb?.completed !== runs.created
      || evidence.postDb?.eventsReconciled !== runs.created
      || !/^[a-f0-9]{64}$/u.test(evidence.postDb?.eventDigest || '')) {
    failures.push('post-soak DB run/event reconciliation is incomplete or failed');
  }
  if (!evidence.database?.baseline || !evidence.database?.final || evidence.database?.failures?.length) {
    failures.push('post-soak SQLite count/integrity reconciliation is incomplete or failed');
  }

  if (!evidence.journal?.sha256 || !Number.isInteger(evidence.journal?.samples) || evidence.journal.samples < 10) failures.push('bound runtime sample journal is missing or too short');
  if (evidence.journal?.validation?.failures?.length
      || evidence.journal?.validation?.headroom?.ok !== true) {
    failures.push('runtime journal recomputation or full capacity headroom gate failed');
  }
  if (JSON.stringify(evidence.returnThresholds) !== JSON.stringify(RETURN_THRESHOLDS)) failures.push('post-leave return thresholds differ from the certified policy');
  if (!evidence.baseline?.reference) failures.push('baseline resource sample is missing');
  if (!evidence.recovery?.final) failures.push('post-leave resource sample is missing');
  if ((evidence.recovery?.consecutivePassing || 0) < (profile.recoveryConsecutiveSamples || SOAK_PROFILE.recoveryConsecutiveSamples)) {
    failures.push(`post-leave baseline held for ${evidence.recovery?.consecutivePassing || 0}/${profile.recoveryConsecutiveSamples || SOAK_PROFILE.recoveryConsecutiveSamples} samples`);
  }
  if (evidence.baseline?.reference && evidence.recovery?.final) {
    failures.push(...returnToBaselineFailures(evidence.baseline.reference, evidence.recovery.final, RETURN_THRESHOLDS));
  }
  if (evidence.probe?.owned !== true || evidence.probe?.uninstallError !== null
      || evidence.probe?.postUninstall?.error !== 'capacity probe is not installed'
      || !evidence.probe?.summary?.metrics) {
    failures.push('capacity probe ownership, final summary, or uninstall evidence is invalid');
  }
  const metricCount = (name) => {
    const metric = evidence.probe?.summary?.metrics?.[name];
    return typeof metric === 'number' ? metric : metric?.count || 0;
  };
  for (const name of ['db_errors', 'db_busy_or_locked_errors', 'db_write_lock_owner_deaths', 'probe_pool_errors', 'probe_beam_errors', 'probe_deep_errors']) {
    if (metricCount(name) !== 0) failures.push(`final capacity-probe metric ${name} is ${metricCount(name)}, expected zero`);
  }
  const finalWrite = evidence.probe?.summary?.snapshot?.deep?.writeCoordinator;
  if (finalWrite?.locked !== false || finalWrite?.queue_depth !== 0 || (finalWrite?.owner_deaths || 0) !== 0) {
    failures.push('final DB write coordinator is locked, queued, or recorded owner deaths');
  }
  const teardown = evidence.teardown;
  if (teardown?.runnerDisconnectFlushes !== 1
      || teardown?.runnerDisconnectFlushOwners < Math.floor(SOAK_PROFILE.users * 0.99)
      || teardown?.runnerDisconnectFlushOwners > SOAK_PROFILE.users
      || teardown?.runnerDelegatedSnapshotReads !== 1
      || teardown?.runnerDelegatedOwnerReads !== 0) {
    failures.push('runner teardown did not use one batched flush with 99-100% owners and bounded delegated snapshots');
  }
  const dispatcher = teardown?.presenceDispatcher;
  if (!dispatcher || dispatcher.completed !== dispatcher.dispatched
      || dispatcher.completed !== dispatcher.refreshed
      || dispatcher.failed !== 0 || dispatcher.noop !== 0
      || dispatcher.startFailed !== 0 || dispatcher.taskFailed !== 0
      || dispatcher.active !== 0 || dispatcher.pending !== 0 || dispatcher.queued !== 0) {
    failures.push('presence dispatcher did not drain cleanly after simultaneous teardown');
  }
  if (evidence.serverLogs?.policy !== SERVER_LOG_POLICY
      || evidence.serverLogs?.baselineCursor !== evidence.identity?.initial?.container?.startedAt
      || evidence.serverLogs?.readError !== null
      || evidence.serverLogs?.matchedErrorLines !== 0
      || evidence.serverLogs?.matchesTruncated !== false
      || !/^[a-f0-9]{64}$/u.test(evidence.serverLogs?.sha256 || '')) {
    failures.push('two-hour server-log evidence is incomplete, unbound, or contains fatal/error lines');
  }
  return { ok: failures.length === 0, failures };
}

function waitForReady(context, generation, timeoutMs) {
  const required = new Set(['vault', 'presence', 'runs', 'runners', 'runner:registered']);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (context.engineOpens >= generation && [...required].every((signal) => context.ready.has(signal))) {
        resolve(performance.now());
      } else if (Date.now() >= deadline) {
        reject(new Error(`fixture ${context.fixture.sourceIndex} did not restore all namespace/room signals`));
      } else {
        setTimeout(check, 25);
      }
    };
    check();
  });
}

function attachClient(target, fixture, ordinal, sourceIp, metrics) {
  const manager = new Manager(target, {
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2_000,
    timeout: 20_000,
    autoConnect: false,
    ...(sourceIp ? { extraHeaders: { 'X-Forwarded-For': sourceIp } } : {}),
  });
  const auth = { token: fixture.token };
  const vault = manager.socket('/vault', { auth });
  const runs = manager.socket('/runs', { auth });
  const runner = manager.socket('/runners', { auth });
  const context = {
    fixture,
    ordinal,
    manager,
    vault,
    runs,
    runner,
    engineOpens: 0,
    ready: new Set(),
    activeRunIds: new Set(),
    closing: false,
  };

  manager.on('open', () => { context.engineOpens += 1; });
  vault.on('connect', () => {
    vault.emit('joinVault', fixture.vaultId);
    vault.emit('joinChatChannel', fixture.channelId);
    context.ready.add('vault');
  });
  vault.on('vault:chatPresence', () => context.ready.add('presence'));
  runs.on('connect', () => {
    for (const runId of context.activeRunIds) runs.emit('joinRun', runId);
    context.ready.add('runs');
  });
  runs.on('event', (event) => {
    const runId = Number(event?.run_id);
    const seq = Number(event?.seq);
    if (!Number.isFinite(runId) || !Number.isFinite(seq)) return;
    const prior = metrics.lastRunSeq.get(runId) || 0;
    const expectedSeq = prior ? prior + 1 : 2;
    if (seq !== expectedSeq) metrics.runs.orderingViolations += 1;
    metrics.lastRunSeq.set(runId, seq);
    let payload = event?.payload;
    if (!payload && typeof event?.payload_json === 'string') {
      try { payload = JSON.parse(event.payload_json); } catch { payload = {}; }
    }
    if (metrics.delegatedRunIds.has(runId)) {
      if (!metrics.liveEvents.has(runId)) metrics.liveEvents.set(runId, []);
      const kind = event.type === 'status' ? `status:${payload?.status || 'missing'}` : event.type;
      metrics.liveEvents.get(runId).push(`${seq}:${kind}`);
    }
    if (event.type === 'status' && payload?.status === 'completed' && metrics.delegatedRunIds.has(runId)) {
      if (!metrics.terminalRunIds.has(runId)) metrics.runs.completed += 1;
      metrics.terminalRunIds.add(runId);
      context.activeRunIds.delete(runId);
    }
  });
  runner.on('connect', () => {
    runner.emit('runner:register', {
      activeRunIds: [...context.activeRunIds],
      runnerInstanceId: `soak-${fixture.sourceIndex}`,
    });
    context.ready.add('runners');
  });
  runner.on('runner:registered', () => context.ready.add('runner:registered'));
  runner.on('run:delegate', (payload) => {
    const runId = Number(payload?.runId);
    if (!Number.isFinite(runId)) return;
    if (metrics.delegatedRunIds.has(runId)) metrics.runs.duplicates += 1;
    else {
      metrics.delegatedRunIds.add(runId);
      metrics.runs.delegated += 1;
    }
    context.activeRunIds.add(runId);
    runs.emit('joinRun', runId);
    setTimeout(() => {
      if (context.closing || !runner.connected) return;
      runner.emit('runner:runEvent', { runId, type: 'status', payload: { status: 'running' } });
      runner.emit('runner:runEvent', {
        runId,
        type: 'text',
        payload: { message: { content: [{ type: 'text', text: `two-hour soak event ${runId}` }] }, chatVisible: true },
      });
      runner.emit('runner:runEvent', {
        runId,
        type: 'status',
        payload: { status: 'completed', summary: `two-hour soak ${runId}`, sessionId: `soak-session-${runId}` },
      });
      context.activeRunIds.delete(runId);
    }, 25);
  });
  runner.on('run:cancel', ({ runId }, acknowledge) => {
    context.activeRunIds.delete(Number(runId));
    acknowledge?.({ success: true });
  });
  return context;
}

async function jsonRequest(url, options, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `${response.status} ${url}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function captureSample(container, identity, phase, elapsedSeconds = 0, priorCpu = null) {
  const current = currentIdentity(container);
  const beam = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()'));
  const cgroup = beam?.deep?.cgroup;
  const cpuUsageUsec = cgroup?.cpu?.usage_usec;
  const observedAt = new Date().toISOString();
  const observedMs = Date.parse(observedAt);
  const normalizedCpuPct = Number.isFinite(cpuUsageUsec) && Number.isFinite(priorCpu?.usageUsec)
    && observedMs > priorCpu.observedMs
    ? (cpuUsageUsec - priorCpu.usageUsec) / ((observedMs - priorCpu.observedMs) * 1_000) / PRODUCTION_CPUS * 100
    : 0;
  const sample = {
    type: 'runtime-sample',
    phase,
    observedAt,
    elapsedSeconds,
    normalizedCpuPct,
    memoryCurrent: cgroup?.memoryCurrent,
    cgroup,
    containerState: {
      id: current.container.id,
      imageId: current.container.imageId,
      startedAt: current.container.startedAt,
      imageRevision: current.image.revision,
      hostConfig: current.container.hostConfig,
      running: current.container.running,
      restartCount: current.container.restartCount,
      oomKilled: current.container.oomKilled,
    },
    beamOpenFiles: containerBeamOpenFiles(container),
    beam,
    errors: [],
  };
  if (sample.containerState.id !== identity.container.id) sample.errors.push('container ID changed');
  if (sample.containerState.imageId !== identity.container.imageId) sample.errors.push('image ID changed');
  if (sample.containerState.startedAt !== identity.container.startedAt) sample.errors.push('container start changed');
  if (sample.containerState.imageRevision !== identity.image.revision) sample.errors.push('image revision changed');
  if (!sample.containerState.running) sample.errors.push('container stopped');
  if (sample.containerState.restartCount !== 0) sample.errors.push(`container restart count is ${sample.containerState.restartCount}`);
  if (sample.containerState.oomKilled) sample.errors.push('container was OOM-killed');
  sample.errors.push(...certifiedShapeFailures(current.rawHostConfig));
  sample.errors.push(...exactRuntimeFailures(beam?.configuration));
  return { sample, cpu: { usageUsec: cpuUsageUsec, observedMs } };
}

function fixtureEvidence(fixturesFile, fixtures) {
  const raw = fs.readFileSync(fixturesFile);
  const groups = new Map();
  for (const fixture of fixtures) {
    const key = `${fixture.vaultId}\u0000${fixture.channelId}`;
    if (!Number.isInteger(fixture.ownedChatChannels) || fixture.ownedChatChannels < 0) {
      throw new Error(`fixture ${fixture.sourceIndex} has invalid ownedChatChannels`);
    }
    const group = groups.get(key) || { users: 0, owners: 0 };
    group.users += 1;
    group.owners += fixture.ownedChatChannels;
    groups.set(key, group);
  }
  const groupIdentities = [...groups.entries()]
    .map(([key, group]) => {
      const [vaultId, channelId] = key.split('\u0000');
      return { vaultId, channelId, users: group.users, owners: group.owners };
    })
    .sort((left, right) => `${left.vaultId}\u0000${left.channelId}`.localeCompare(`${right.vaultId}\u0000${right.channelId}`));
  const selectedIdentity = fixtures.map((fixture) => ({
    authenticatedUserId: fixture.authenticatedUserId,
    sourceIndex: fixture.sourceIndex,
    vaultId: fixture.vaultId,
    channelId: fixture.channelId,
    ownedChatChannels: fixture.ownedChatChannels,
    runner: fixture.runner,
  }));
  const churnCohortDigests = Array.from({ length: 10 }, (_unused, cohort) => digest(stableJson(
    fixtures.filter((_fixture, ordinal) => ordinal % 10 === cohort).map((fixture) => ({
      authenticatedUserId: fixture.authenticatedUserId,
      sourceIndex: fixture.sourceIndex,
    })),
  )));
  return {
    path: fixturesFile,
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: raw.length,
    lines: raw.toString('utf8').split(/\r?\n/u).filter(Boolean).length,
    users: fixtures.length,
    groups: groupIdentities.length,
    groupSize: SOAK_FIXTURE_GROUP_SIZE,
    groupIdentities,
    selectedIdentitySha256: digest(stableJson(selectedIdentity)),
    churnCohortDigests,
  };
}

function captureServerLogs(container, baselineCursor, finishCursor, output) {
  const result = spawnSync(
    'docker',
    ['logs', '--timestamps', '--since', baselineCursor, '--until', finishCursor, container],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  const raw = `${result.stdout || ''}${result.stderr || ''}`;
  const evidence = {
    policy: SERVER_LOG_POLICY,
    baselineCursor,
    finishCursor,
    output,
    readError: null,
    sha256: digest(raw),
    ...analyzeServerLogs(raw),
  };
  if (result.error || result.status !== 0) {
    evidence.readError = result.error?.message || `docker logs exited ${result.status}`;
    return evidence;
  }
  try { fs.writeFileSync(output, raw, { flag: 'wx', mode: 0o600 }); } catch (error) {
    evidence.readError = `could not create bound server-log artifact: ${error.message}`;
  }
  return evidence;
}

async function mapConcurrent(values, concurrency, task) {
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await task(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function persistedEventFailures(runId, events) {
  const failures = [];
  let prior = 0;
  const signature = [];
  for (const event of events || []) {
    const seq = Number(event?.seq);
    if (!Number.isInteger(seq) || seq !== prior + 1) failures.push(`run ${runId} has non-contiguous persisted event sequence`);
    prior = seq;
    let payload = event?.payload;
    if (!payload && typeof event?.payload_json === 'string') {
      try { payload = JSON.parse(event.payload_json); } catch { payload = {}; }
    }
    signature.push(event?.type === 'status' ? `status:${payload?.status || 'missing'}` : event?.type || 'missing');
  }
  const expected = ['status:queued', 'status:running', 'text', 'status:completed'];
  if (stableJson(signature) !== stableJson(expected)) {
    failures.push(`run ${runId} persisted event signature is ${stableJson(signature)}, expected ${stableJson(expected)}`);
  }
  return { failures, signature, eventCount: events?.length || 0 };
}

async function reconcilePersistedRuns(target, metrics) {
  const requested = sortedNumeric(metrics.requestedRunIds);
  const failures = [];
  const rows = await mapConcurrent(requested, 32, async (runId) => {
    const fixture = metrics.runOwners.get(runId);
    if (!fixture) return { runId, failures: [`run ${runId} has no fixture owner`] };
    try {
      const [runBody, eventBody] = await Promise.all([
        jsonRequest(`${target}/api/runs/${runId}`, { headers: bearer(fixture.token) }),
        jsonRequest(`${target}/api/runs/${runId}/events`, { headers: bearer(fixture.token) }),
      ]);
      const run = runBody?.run;
      const events = eventBody?.events;
      const rowFailures = [];
      if (Number(run?.id) !== runId || String(run?.vault_id) !== String(fixture.vaultId)) rowFailures.push(`run ${runId} persisted in the wrong vault`);
      if (run?.status !== 'completed') rowFailures.push(`run ${runId} persisted status is ${run?.status || 'missing'}`);
      const eventResult = persistedEventFailures(runId, events);
      rowFailures.push(...eventResult.failures);
      return { runId, status: run?.status, eventCount: eventResult.eventCount, signature: eventResult.signature, failures: rowFailures };
    } catch (error) {
      return { runId, failures: [`run ${runId} reconciliation failed: ${error.message}`] };
    }
  });
  for (const row of rows) failures.push(...row.failures);
  const persisted = rows.filter((row) => row.status === 'completed' && row.failures.length === 0).map((row) => row.runId);
  return {
    runs: rows.length,
    completed: rows.filter((row) => row.status === 'completed').length,
    eventsReconciled: rows.filter((row) => row.eventCount > 0 && row.failures.length === 0).length,
    totalEvents: rows.reduce((total, row) => total + (row.eventCount || 0), 0),
    runIds: persisted,
    eventDigest: digest(stableJson(rows.map(({ failures: _failures, ...row }) => row))),
    failures,
  };
}

function databaseSnapshot(container) {
  return parseLastJson(releaseRpc(
    container,
    'scalar = fn sql -> case Cascade.Accounts.SQL.one(sql) do [value] -> value; _ -> nil end end; orphans = Cascade.Accounts.SQL.all("SELECT r.id,r.status,r.summary,d.owner_user_id,(SELECT max(seq) FROM run_events e WHERE e.run_id=r.id),(SELECT type FROM run_events e WHERE e.run_id=r.id ORDER BY seq DESC LIMIT 1),(SELECT payload_json FROM run_events e WHERE e.run_id=r.id ORDER BY seq DESC LIMIT 1) FROM runs r LEFT JOIN delegated_runs d ON d.run_id=r.id WHERE r.id IN (1896,1897) ORDER BY r.id") |> Enum.map(fn [id,status,summary,owner_user_id,max_seq,last_type,last_payload] -> %{id: id,status: status,summary: summary,ownerUserId: owner_user_id,maxSeq: max_seq,lastType: last_type,lastPayload: last_payload} end); Jason.encode!(%{users: scalar.("SELECT count(*) FROM users"), vaults: scalar.("SELECT count(*) FROM vaults"), memberships: scalar.("SELECT count(*) FROM vault_members"), runs: scalar.("SELECT count(*) FROM runs"), runEvents: scalar.("SELECT count(*) FROM run_events"), delegatedRuns: scalar.("SELECT count(*) FROM delegated_runs"), baselineOrphans: orphans, foreignKeyViolations: scalar.("SELECT count(*) FROM pragma_foreign_key_check"), quickCheck: scalar.("SELECT group_concat(quick_check, \'\') FROM pragma_quick_check")}) |> IO.puts()',
  ));
}

function parsePayload(payload) {
  try { return JSON.parse(payload); } catch { return null; }
}

function baselineOrphanFailures(baseline, final) {
  const failures = [];
  if (!Array.isArray(baseline?.baselineOrphans)
      || baseline.baselineOrphans.length !== BASELINE_ORPHANS.length) {
    failures.push('database baseline does not contain the two approved queued delegated runs');
    return failures;
  }
  if (!Array.isArray(final?.baselineOrphans)
      || final.baselineOrphans.length !== BASELINE_ORPHANS.length) {
    failures.push('database final state does not contain the two approved orphaned runs');
    return failures;
  }
  for (const expected of BASELINE_ORPHANS) {
    const before = baseline.baselineOrphans.find((row) => row.id === expected.id);
    const after = final.baselineOrphans.find((row) => row.id === expected.id);
    if (!before || before.status !== 'queued' || before.summary != null
        || before.ownerUserId !== expected.ownerUserId || before.maxSeq !== expected.queuedSeq) {
      failures.push(`database baseline orphan run ${expected.id} is not the exact queued delegation`);
    }
    const payload = parsePayload(after?.lastPayload);
    if (!after || after.status !== 'failed' || after.summary !== BASELINE_ORPHAN_RECLAIM_SUMMARY
        || after.ownerUserId != null || after.maxSeq !== expected.failedSeq
        || after.lastType !== 'status'
        || stableJson(payload) !== stableJson({
          status: 'failed', summary: BASELINE_ORPHAN_RECLAIM_SUMMARY,
        })) {
      failures.push(`database final orphan run ${expected.id} lacks the exact reclaim terminal event`);
    }
  }
  return failures;
}

export function databaseReconciliation(baseline, final, runs, totalEvents) {
  const failures = [];
  for (const key of ['users', 'vaults', 'memberships']) {
    if (!Number.isInteger(baseline?.[key]) || final?.[key] !== baseline[key]) {
      failures.push(`database ${key} changed from ${baseline?.[key] ?? 'missing'} to ${final?.[key] ?? 'missing'}`);
    }
  }
  if (final?.runs - baseline?.runs !== runs) failures.push(`database run delta is ${final?.runs - baseline?.runs}, expected ${runs}`);
  if (baseline?.delegatedRuns !== BASELINE_ORPHANS.length || final?.delegatedRuns !== 0) {
    failures.push(`database delegated-run transition is ${baseline?.delegatedRuns ?? 'missing'} to ${final?.delegatedRuns ?? 'missing'}, expected 2 to 0`);
  }
  if (final?.runEvents - baseline?.runEvents !== totalEvents + BASELINE_ORPHANS.length) {
    failures.push(`database run-event delta is ${final?.runEvents - baseline?.runEvents}, expected ${totalEvents + BASELINE_ORPHANS.length}`);
  }
  failures.push(...baselineOrphanFailures(baseline, final));
  if (final?.foreignKeyViolations !== 0) failures.push(`${final?.foreignKeyViolations ?? 'missing'} SQLite foreign-key violations`);
  if (final?.quickCheck !== 'ok') failures.push(`SQLite quick_check is ${final?.quickCheck ?? 'missing'}, expected ok`);
  return { baseline, final, failures };
}

function probeMetricCount(snapshot, name) {
  const metric = snapshot?.metrics?.[name];
  return typeof metric === 'number' ? metric : metric?.count || 0;
}

export function teardownProbeEvidence(before, summary) {
  const after = summary?.snapshot;
  const delta = (name) => probeMetricCount(after, name) - probeMetricCount(before, name);
  return {
    runnerDisconnectFlushes: delta('runner_disconnect_flushes'),
    runnerDisconnectFlushOwners: delta('runner_disconnect_flush_owners'),
    runnerDelegatedSnapshotReads: delta('runner_delegated_snapshot_reads'),
    runnerDelegatedOwnerReads: delta('runner_delegated_owner_reads'),
    presenceDispatcher: after?.deep?.presenceDispatcher || null,
  };
}

async function runMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const target = String(args.target || '').replace(/\/$/u, '');
  const fixturesFile = path.resolve(String(args.fixtures || ''));
  const container = String(args.container || '');
  const output = path.resolve(String(args.output || ''));
  const expectedImage = String(args.expectedImage || '');
  const expectedRevision = String(args.expectedRevision || '');
  if (!target || !args.fixtures || !container || !args.output || !expectedImage || !expectedRevision) {
    throw new Error('--target, --fixtures, --container, --output, --expected-image, and --expected-revision are required');
  }
  for (const [key, expected] of Object.entries(SOAK_PROFILE)) {
    if (args[key] != null && Number(args[key]) !== expected) {
      throw new Error(`--${key} is fixed at ${expected} for release certification`);
    }
  }
  const profile = { ...SOAK_PROFILE };
  const sourceIp = String(args.sourceIp || '');
  const journalFile = `${output}.samples.jsonl`;
  const serverLogFile = `${output}.container.log`;
  if (fs.existsSync(output) || fs.existsSync(journalFile) || fs.existsSync(serverLogFile)) {
    throw new Error(`output, sample journal, or server-log artifact already exists: ${output}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const fixtures = readFixtures(fixturesFile, { users: profile.users });
  if (fixtures.length !== profile.users) throw new Error(`fixtures contain ${fixtures.length}/${profile.users} selected users`);
  if (fixtures.some((fixture) => fixture.runner !== true)) throw new Error('every two-hour soak fixture must enable a desktop runner');
  const fixtureArtifact = fixtureEvidence(fixturesFile, fixtures);
  if (fixtureArtifact.groups !== SOAK_FIXTURE_GROUPS
      || fixtureArtifact.groupIdentities.some((group) => (
        group.users !== SOAK_FIXTURE_GROUP_SIZE || group.owners !== 1
      ))) {
    throw new Error(`fixtures must contain exactly ${SOAK_FIXTURE_GROUPS} complete ${SOAK_FIXTURE_GROUP_SIZE}-user vault/channel groups with one owner each`);
  }

  const identity = { initial: currentIdentity(container), final: null, runtimeInitial: null, runtimeFinal: null };
  const preflightFailures = shapeFailures(identity.initial.rawHostConfig, PRODUCTION_CPUS, PRODUCTION_MEMORY_BYTES);
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedImage)) preflightFailures.push('--expected-image must be an immutable sha256 image ID');
  if (identity.initial.container.imageId !== expectedImage) preflightFailures.push(`running image ${identity.initial.container.imageId} does not match ${expectedImage}`);
  if (!identity.initial.container.running) preflightFailures.push('candidate container is not running');
  if (identity.initial.container.restartCount !== 0) preflightFailures.push('candidate container restart count is not zero');
  if (identity.initial.container.oomKilled) preflightFailures.push('candidate container was OOM-killed');
  preflightFailures.push(...exactRuntimeFailures(runtimeIdentity(container)));
  if (!/^[a-f0-9]{40}$/u.test(expectedRevision)) preflightFailures.push('--expected-revision must be a full 40-character Git revision');
  if (identity.initial.image.revision !== expectedRevision) preflightFailures.push(`running image revision ${identity.initial.image.revision || 'missing'} does not match ${expectedRevision}`);
  if (preflightFailures.length) throw new Error(`soak preflight failed: ${preflightFailures.join('; ')}`);
  const cleanupTasks = [];
  const contexts = [];
  let probeInstalled = false;
  cleanupTasks.push(() => {
    for (const context of contexts) {
      context.closing = true;
      context.manager.disconnect();
    }
  });
  try {
  fs.writeFileSync(journalFile, '', { flag: 'wx', mode: 0o600 });
  const probePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'capacity_probe.exs');
  const probeSha256 = sha256File(probePath);
  docker('cp', probePath, `${container}:/tmp/cascade-soak-probe.exs`);
  const priorProbe = parseLastJson(releaseRpc(
    container,
    'snapshot = if Code.ensure_loaded?(CascadeCapacityProbe), do: CascadeCapacityProbe.snapshot(), else: %{error: "capacity probe is not installed"}; Jason.encode!(snapshot) |> IO.puts()',
  ));
  const ownsProbe = priorProbe?.error === 'capacity probe is not installed';
  if (!ownsProbe) throw new Error('capacity probe was already installed; counters are not isolated to this soak');
  parseLastJson(releaseRpc(
    container,
    'Code.eval_file("/tmp/cascade-soak-probe.exs"); {:ok, snapshot} = CascadeCapacityProbe.install(); Jason.encode!(snapshot) |> IO.puts()',
  ));
  probeInstalled = true;
  cleanupTasks.push(() => {
    if (probeInstalled) {
      parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.uninstall() |> Jason.encode!() |> IO.puts()'));
      const post = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()'));
      if (post?.error !== 'capacity probe is not installed') throw new Error('capacity probe remained installed after cleanup');
      probeInstalled = false;
    }
  });
  identity.runtimeInitial = runtimeIdentity(container);

  const runtimeSampleFailures = [];
  let priorCpu = null;
  const appendSample = async (phase, elapsedSeconds = 0) => {
    const captured = await captureSample(container, identity.initial, phase, elapsedSeconds, priorCpu);
    const sample = captured.sample;
    priorCpu = captured.cpu;
    runtimeSampleFailures.push(...sample.errors.map((error) => `${phase} runtime sample: ${error}`));
    fs.appendFileSync(journalFile, `${JSON.stringify(sample)}\n`);
    return sample;
  };
  await sleep(11_000);
  const baselineSamples = [];
  for (let index = 0; index < 3; index += 1) {
    baselineSamples.push(await appendSample('baseline'));
    if (index < 2) await sleep(profile.sampleIntervalSeconds * 1_000);
  }
  const baselineReference = referenceVector(baselineSamples);
  const databaseBaseline = databaseSnapshot(container);

  const metrics = {
    runs: { scheduled: 0, created: 0, delegated: 0, completed: 0, duplicates: 0, orderingViolations: 0, requestErrors: 0 },
    requestedRunIds: new Set(),
    delegatedRunIds: new Set(),
    terminalRunIds: new Set(),
    lastRunSeq: new Map(),
    liveEvents: new Map(),
    runOwners: new Map(),
  };
  let stopping = false;
  let interruptedSignal = '';
  const requestStop = (signal) => {
    interruptedSignal = signal;
    stopping = true;
  };
  const onSigint = () => requestStop('SIGINT');
  const onSigterm = () => requestStop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  cleanupTasks.push(() => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  });
  let initialConnectionFailures = 0;
  const rampDelayMs = profile.users > 1 ? profile.rampSeconds * 1_000 / (profile.users - 1) : 0;
  const rampStartedAt = new Date().toISOString();
  const rampStarted = performance.now();
  for (let index = 0; index < fixtures.length; index += 1) {
    if (stopping) break;
    const scheduledAt = rampStarted + index * rampDelayMs;
    const untilScheduled = scheduledAt - performance.now();
    if (untilScheduled > 0) await sleep(untilScheduled);
    const context = attachClient(target, fixtures[index], index, sourceIp, metrics);
    contexts.push(context);
    context.manager.open();
    context.vault.connect();
    context.runs.connect();
    context.runner.connect();
    try { await waitForReady(context, 1, 20_000); } catch { initialConnectionFailures += 1; }
  }
  let remainingRamp = rampStarted + profile.rampSeconds * 1_000 - performance.now();
  while (remainingRamp > 0) {
    await sleep(remainingRamp);
    remainingRamp = rampStarted + profile.rampSeconds * 1_000 - performance.now();
  }
  const rampCompletedAt = new Date().toISOString();

  const connectedContexts = contexts.filter((context) => (
    context.vault.connected && context.runs.connected && context.runner.connected
  ));
  const churnCycles = [];
  const inFlightRuns = new Set();
  let nextRunner = 0;
  let churnRunning = false;
  const soakStartedAt = new Date().toISOString();
  const soakStarted = performance.now();
  await appendSample('soak', 0);
  let sampleChain = Promise.resolve();
  const sampleTimer = setInterval(() => {
    sampleChain = sampleChain
      .then(() => appendSample('soak', (performance.now() - soakStarted) / 1_000))
      .catch((error) => preflightFailures.push(`runtime sample failed: ${error.message}`));
  }, profile.sampleIntervalSeconds * 1_000);
  cleanupTasks.push(() => clearInterval(sampleTimer));

  const runIntervalMs = Math.max(1, 1_000 / profile.runRps);
  const runTimer = setInterval(() => {
    if (stopping) return;
    metrics.runs.scheduled += 1;
    const task = (async () => {
      let context = null;
      for (let attempts = 0; attempts < connectedContexts.length; attempts += 1) {
        const candidate = connectedContexts[nextRunner++ % connectedContexts.length];
        if (candidate?.runner.connected && candidate.runs.connected && candidate.activeRunIds.size === 0) {
          context = candidate;
          break;
        }
      }
      if (!context) {
        metrics.runs.requestErrors += 1;
        return;
      }
      try {
        const data = await jsonRequest(
          `${target}/api/vaults/${encodeURIComponent(context.fixture.vaultId)}/runs`,
          {
            method: 'POST',
            headers: bearer(context.fixture.token, sourceIp),
            body: JSON.stringify({ prompt: 'two-hour soak invariant proof', agent: 'grok', note_id: null }),
          },
        );
        const runId = Number(data?.run?.id);
        if (!Number.isFinite(runId)) throw new Error('run response has no numeric ID');
        metrics.runs.created += 1;
        metrics.requestedRunIds.add(runId);
        metrics.runOwners.set(runId, context.fixture);
        context.activeRunIds.add(runId);
        context.runs.emit('joinRun', runId);
      } catch {
        metrics.runs.requestErrors += 1;
      }
    })().finally(() => inFlightRuns.delete(task));
    inFlightRuns.add(task);
  }, runIntervalMs);
  cleanupTasks.push(() => clearInterval(runTimer));

  let churnIndex = 0;
  const runChurn = async () => {
    if (stopping || churnRunning || performance.now() - soakStarted > (profile.soakSeconds - 20) * 1_000) return;
    churnRunning = true;
    const cohortCount = Math.max(1, Math.round(100 / profile.churnPercent));
    const selected = connectedContexts.filter((context) => context.ordinal % cohortCount === churnIndex % cohortCount);
    const cycle = {
      index: churnIndex,
      cohort: churnIndex % 10,
      selectedIdentitySha256: digest(stableJson(selected.map((context) => ({
        authenticatedUserId: context.fixture.authenticatedUserId,
        sourceIndex: context.fixture.sourceIndex,
      })))),
      startedAt: new Date().toISOString(),
      selected: selected.length,
      recovered: 0,
      within10: 0,
      within20: 0,
      p99Ms: null,
      failures: [],
    };
    churnIndex += 1;
    const tasks = selected.map(async (context) => {
      context.ready.clear();
      const generation = context.engineOpens + 1;
      const started = performance.now();
      context.manager.engine?.close();
      try {
        await waitForReady(context, generation, 20_000);
        const elapsed = performance.now() - started;
        cycle.recovered += 1;
        if (elapsed <= 10_000) cycle.within10 += 1;
        if (elapsed <= 20_000) cycle.within20 += 1;
        return elapsed;
      } catch (error) {
        cycle.failures.push({ fixtureIndex: context.fixture.sourceIndex, error: error.message });
        return null;
      }
    });
    const latencies = (await Promise.all(tasks)).filter(Number.isFinite);
    cycle.p99Ms = percentile(latencies, 0.99);
    cycle.finishedAt = new Date().toISOString();
    churnCycles.push(cycle);
    churnRunning = false;
  };
  const churnTimer = setInterval(() => {
    runChurn().catch((error) => {
      preflightFailures.push(`churn cycle failed: ${error.message}`);
      churnRunning = false;
    });
  }, profile.churnIntervalSeconds * 1_000);
  cleanupTasks.push(() => clearInterval(churnTimer));

  const soakDeadline = soakStarted + profile.soakSeconds * 1_000;
  while (!stopping && performance.now() < soakDeadline) {
    await sleep(Math.min(1_000, Math.max(1, soakDeadline - performance.now())));
  }
  stopping = true;
  clearInterval(sampleTimer);
  clearInterval(runTimer);
  clearInterval(churnTimer);
  while (churnRunning) await sleep(50);
  await sampleChain;
  await sleep(2);
  await appendSample('soak', (performance.now() - soakStarted) / 1_000);
  const soakFinishedAt = new Date().toISOString();
  await Promise.allSettled([...inFlightRuns]);
  const terminalDeadline = Date.now() + 15_000;
  while (metrics.runs.completed < metrics.runs.created && Date.now() < terminalDeadline) await sleep(50);
  const liveEvents = [...metrics.liveEvents.entries()]
    .map(([runId, signature]) => ({ runId, signature }))
    .sort((left, right) => left.runId - right.runId);
  const liveCompleteRunIds = liveEvents
    .filter((entry) => stableJson(entry.signature) === stableJson(EXPECTED_LIVE_EVENT_SIGNATURE))
    .map((entry) => entry.runId);
  const postDb = await reconcilePersistedRuns(target, metrics);
  const database = databaseReconciliation(
    databaseBaseline,
    databaseSnapshot(container),
    metrics.runs.created,
    postDb.totalEvents,
  );
  const workloadFinishedAt = new Date().toISOString();
  if (interruptedSignal) preflightFailures.push(`soak interrupted by ${interruptedSignal}`);
  const preTeardownProbe = parseLastJson(releaseRpc(
    container,
    'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()',
  ));
  for (const context of contexts) {
    context.closing = true;
    context.manager.disconnect();
  }

  const recoverySamples = [];
  let consecutivePassing = 0;
  const recoveryDeadline = Date.now() + profile.recoveryTimeoutSeconds * 1_000;
  while (!interruptedSignal && Date.now() < recoveryDeadline && consecutivePassing < profile.recoveryConsecutiveSamples) {
    await sleep(Math.max(10, profile.sampleIntervalSeconds) * 1_000);
    const sample = await appendSample('post-leave', (Date.now() - Date.parse(soakStartedAt)) / 1_000);
    recoverySamples.push(sample);
    const failures = returnToBaselineFailures(baselineReference, resourceVector(sample));
    consecutivePassing = failures.length === 0 ? consecutivePassing + 1 : 0;
  }

  let probeSummary = null;
  let postUninstall = null;
  let uninstallError = null;
  if (ownsProbe) {
    try {
      probeSummary = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.summary() |> Jason.encode!() |> IO.puts()'));
      parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.uninstall() |> Jason.encode!() |> IO.puts()'));
      postUninstall = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()'));
      if (postUninstall?.error !== 'capacity probe is not installed') {
        throw new Error('capacity probe remained installed after uninstall');
      }
      probeInstalled = false;
    } catch (error) {
      uninstallError = error.message;
    }
  }
  identity.final = currentIdentity(container);
  identity.runtimeFinal = runtimeIdentity(container);
  preflightFailures.push(...runtimeSampleFailures);
  if (uninstallError) preflightFailures.push(`capacity probe uninstall failed: ${uninstallError}`);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  const finishedAt = new Date().toISOString();
  const serverLogs = captureServerLogs(
    container,
    identity.initial.container.startedAt,
    finishedAt,
    serverLogFile,
  );
  preflightFailures.push(...serverLogFailures(serverLogs));
  const journalRaw = fs.readFileSync(journalFile, 'utf8');
  const journal = {
    path: journalFile,
    sha256: digest(journalRaw),
    bytes: Buffer.byteLength(journalRaw),
    samples: journalRaw.split(/\r?\n/u).filter(Boolean).length,
  };
  const evidence = {
    schemaVersion: 1,
    type: 'cascade-elixir-two-hour-soak-invariants',
    expectedImage,
    expectedRevision,
    target,
    sourceIp: sourceIp || null,
    profile,
    fixtures: fixtureArtifact,
    returnThresholds: RETURN_THRESHOLDS,
    identity,
    probe: {
      path: probePath,
      sha256: probeSha256,
      owned: ownsProbe,
      summary: probeSummary,
      uninstallError,
      postUninstall,
    },
    startedAt: baselineSamples[0]?.observedAt,
    soakStartedAt,
    soakFinishedAt,
    workloadFinishedAt,
    finishedAt,
    observed: { soakSeconds: (Date.parse(soakFinishedAt) - Date.parse(soakStartedAt)) / 1_000 },
    journal,
    serverLogs,
    baseline: { samples: baselineSamples.map(resourceVector), reference: baselineReference },
    workload: {
      rampStartedAt,
      rampCompletedAt,
      initialConnected: connectedContexts.length,
      initialConnectionFailures,
      churnCycles,
      runs: metrics.runs,
      runIds: {
        requested: sortedNumeric(metrics.requestedRunIds),
        delegated: sortedNumeric(metrics.delegatedRunIds),
        terminal: sortedNumeric(metrics.terminalRunIds),
        liveComplete: sortedNumeric(liveCompleteRunIds),
      },
      liveEvents,
      liveEventDigest: digest(stableJson(liveEvents)),
      runtimeCoverage: null,
    },
    recovery: {
      samples: recoverySamples.map(resourceVector),
      final: recoverySamples.length ? resourceVector(recoverySamples.at(-1)) : null,
      consecutivePassing,
    },
    postDb,
    database,
    teardown: teardownProbeEvidence(preTeardownProbe, probeSummary),
    preflightFailures,
  };
  const journalValidation = recomputeSoakJournal(evidence, parseSoakJournal(journalRaw));
  evidence.baseline = journalValidation.baseline;
  evidence.workload.runtimeCoverage = journalValidation.runtimeCoverage;
  evidence.recovery = journalValidation.recovery;
  evidence.journal.validation = {
    records: journalValidation.records,
    phases: journalValidation.phases,
    headroom: journalValidation.headroom,
    failures: journalValidation.failures,
  };
  evidence.evaluation = evaluateSoakEvidence(evidence);
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, journal, evaluation: evidence.evaluation }, null, 2)}\n`);
  if (!evidence.evaluation.ok) process.exitCode = 1;
  } finally {
    const cleanupFailures = [];
    for (const cleanup of cleanupTasks.reverse()) {
      try { await cleanup(); } catch (error) { cleanupFailures.push(error.message); }
    }
    if (cleanupFailures.length) throw new Error(`soak cleanup failed: ${cleanupFailures.join('; ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain().catch((error) => {
    console.error(`[soak-invariants] fatal: ${error.stack || error}`);
    process.exitCode = 1;
  });
}
