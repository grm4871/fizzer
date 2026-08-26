import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shapeFailures } from '../monitor.mjs';

/**
 * Soak input seam: fixed profile, runtime identity, and resource baseline primitives.
 * Failure mode: Docker/RPC identity or production envelope drift is surfaced as evidence failure.
 */
export const PRODUCTION_CPUS = 2;
export const PRODUCTION_MEMORY_BYTES = 3 * 1024 ** 3;

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

export const SOAK_MEMBERSHIPS = SOAK_PROFILE.users * 5;
export const SOAK_FIXTURE_GROUP_SIZE = 25;
export const SOAK_FIXTURE_GROUPS = SOAK_PROFILE.users / SOAK_FIXTURE_GROUP_SIZE;
export const SERVER_LOG_POLICY = 'zero fatal/error lines from container start through soak finish';
export const RAMP_TOLERANCE_SECONDS = 10;
export const EXPECTED_LIVE_EVENT_SIGNATURE = Object.freeze([
  '2:status:running',
  '3:text',
  '4:status:completed',
]);
export const BASELINE_ORPHAN_RECLAIM_SUMMARY =
  'Desktop agent runner did not reclaim this run after server restart.';
export const BASELINE_ORPHANS = Object.freeze([
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

export function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim();
}

export function docker(...args) {
  return command('docker', args);
}

export function dockerJson(args) {
  return JSON.parse(docker(...args));
}

export function releaseRpc(container, expression) {
  return docker('exec', container, '/app/release/bin/cascade_elixir', 'rpc', expression);
}

export function parseLastJson(output) {
  const lines = String(output).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* keep looking */ }
  }
  throw new Error(`RPC did not return JSON: ${String(output).slice(-500)}`);
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function bearer(token, sourceIp = '') {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(sourceIp ? { 'X-Forwarded-For': sourceIp } : {}),
  };
}

export function percentile(values, percentileValue) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * percentileValue) - 1)];
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stable(value));
}

export function sortedNumeric(values) {
  return [...values].map(Number).sort((left, right) => left - right);
}

export function sameNumericSet(left, right) {
  const leftValues = sortedNumeric(left || []);
  const rightValues = sortedNumeric(right || []);
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => Number.isInteger(value) && value === rightValues[index]);
}

export function exactProfileFailures(profile) {
  return Object.entries(SOAK_PROFILE).flatMap(([key, expected]) => (
    profile?.[key] === expected ? [] : [`soak ${key} is ${profile?.[key] ?? 'missing'}, expected exactly ${expected}`]
  ));
}

export function exactRuntimeFailures(configuration) {
  return Object.entries(SOAK_RUNTIME_CONFIGURATION).flatMap(([key, expected]) => (
    configuration?.[key] === expected
      ? []
      : [`runtime ${key} is ${configuration?.[key] ?? 'missing'}, expected ${expected}`]
  ));
}

export function normalizedHostConfig(hostConfig) {
  return {
    nanoCpus: hostConfig?.NanoCpus ?? hostConfig?.nanoCpus,
    cpusetCpus: hostConfig?.CpusetCpus ?? hostConfig?.cpusetCpus,
    memory: hostConfig?.Memory ?? hostConfig?.memory,
    memorySwap: hostConfig?.MemorySwap ?? hostConfig?.memorySwap,
    pidsLimit: hostConfig?.PidsLimit ?? hostConfig?.pidsLimit,
    ulimits: hostConfig?.Ulimits ?? hostConfig?.ulimits,
  };
}

export function certifiedShapeFailures(hostConfig) {
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

export function currentIdentity(container) {
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

export function runtimeIdentity(container) {
  return parseLastJson(releaseRpc(
    container,
    'Jason.encode!(%{elixir: System.version(), otpRelease: List.to_string(:erlang.system_info(:otp_release)), ertsVersion: List.to_string(:erlang.system_info(:version)), schedulersOnline: System.schedulers_online(), processLimit: :erlang.system_info(:process_limit), portLimit: :erlang.system_info(:port_limit), cascadeVersion: Application.spec(:cascade_elixir, :vsn) |> to_string(), httpAcceptors: Application.get_env(:cascade_elixir, :http_acceptors), httpMaxConnections: Application.get_env(:cascade_elixir, :http_max_connections), httpBacklog: Application.get_env(:cascade_elixir, :http_backlog), networkMode: Application.get_env(:cascade_elixir, :network_mode), trustProxyHops: Application.get_env(:cascade_elixir, :trust_proxy_hops), qmdWorkerEnabled: Application.get_env(:cascade_elixir, :qmd_worker_enabled), realtimeHibernateAfterMs: Application.get_env(:cascade_elixir, :realtime_hibernate_after_ms), runnerOrphanReclaimMs: Application.get_env(:cascade_elixir, :runner_orphan_reclaim_ms), sqlitePoolSize: Cascade.DB.Repo.config()[:pool_size], sqliteBusyTimeoutMs: Cascade.DB.Repo.config()[:busy_timeout]}) |> IO.puts()',
  ));
}

export function containerBeamOpenFiles(container) {
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

export function resourceVector(sample) {
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

export function referenceVector(samples) {
  const vectors = samples.map(resourceVector);
  return Object.fromEntries(Object.keys(vectors[0] || {}).map((key) => {
    const values = vectors.map((vector) => vector[key]).filter(Number.isFinite);
    return [key, values.length ? Math.max(...values) : null];
  }));
}

export function allowed(reference, ratio, slack) {
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
