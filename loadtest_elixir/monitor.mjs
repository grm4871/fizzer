#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (inline !== undefined) result[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) result[key] = argv[++i];
    else result[key] = true;
  }
  return result;
}

function numberOption(args, key, fallback, min = 0) {
  const value = args[key] == null ? fallback : Number(args[key]);
  if (!Number.isFinite(value) || value < min) throw new Error(`--${key} must be >= ${min}`);
  return value;
}

function booleanOption(args, key, fallback) {
  if (args[key] == null) return fallback;
  if (args[key] === true || args[key] === 'true') return true;
  if (args[key] === 'false') return false;
  throw new Error(`--${key} must be true or false`);
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim();
}

function docker(...args) {
  return command('docker', args);
}

export function analyzeServerLogs(raw) {
  const lines = String(raw || '').split(/\r?\n/u).filter(Boolean);
  const errorPattern = /\[(?:error|critical|alert|emergency)\]|\b(?:CRASH REPORT|SUPERVISOR REPORT)\b|GenServer .* terminating|\*\* \((?:EXIT|stop)\)|\b(?:Out of memory|Killed process)\b/iu;
  const matches = lines.filter((line) => errorPattern.test(line));
  return {
    totalBytes: Buffer.byteLength(String(raw || '')),
    totalLines: lines.length,
    matchedErrorLines: matches.length,
    matches: matches.slice(0, 100),
    matchesTruncated: matches.length > 100,
  };
}

function captureServerLogs(container, baselineCursor, finishCursor, output) {
  const result = spawnSync(
    'docker',
    ['logs', '--timestamps', '--since', baselineCursor, '--until', finishCursor, container],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const raw = `${result.stdout || ''}${result.stderr || ''}`;
  const evidence = {
    baselineCursor,
    finishCursor,
    output,
    readError: null,
    sha256: createHash('sha256').update(raw).digest('hex'),
    ...analyzeServerLogs(raw),
  };

  if (result.error || result.status !== 0) {
    evidence.readError = result.error?.message || `docker logs exited ${result.status}`;
    return evidence;
  }

  try {
    fs.writeFileSync(output, raw, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    evidence.readError = `could not create bound server-log artifact: ${error.message}`;
  }
  return evidence;
}

export function serverLogFailures(evidence) {
  const failures = [];
  if (!evidence || evidence.readError) {
    failures.push(`server-log evidence failed: ${evidence?.readError || 'missing evidence'}`);
  } else if (evidence.matchedErrorLines > 0) {
    failures.push(`${evidence.matchedErrorLines} fatal/error server log lines`);
  }
  return failures;
}

function dockerJson(args) {
  return JSON.parse(docker(...args));
}

function releaseRpc(container, expression) {
  return docker('exec', container, '/app/release/bin/cascade_elixir', 'rpc', expression);
}

function parseLastJson(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* keep searching */ }
  }
  throw new Error(`RPC did not return JSON: ${output.slice(-500)}`);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function readNumber(file) {
  const value = Number(readText(file));
  return Number.isFinite(value) ? value : null;
}

function parseKeyValues(raw) {
  if (!raw) return {};
  return Object.fromEntries(raw.split(/\r?\n/).flatMap((line) => {
    const [key, value] = line.trim().split(/\s+/, 2);
    return key && value != null ? [[key, Number(value)]] : [];
  }));
}

function cgroupPath(pid) {
  const line = readText(`/proc/${pid}/cgroup`)?.split(/\r?\n/).find((entry) => entry.startsWith('0::'));
  if (!line) return null;
  return path.join('/sys/fs/cgroup', line.slice(3));
}

export function cpuSetCount(value) {
  if (!value) return 0;
  return value.split(',').reduce((total, section) => {
    const [startRaw, endRaw] = section.trim().split('-', 2);
    const start = Number(startRaw);
    const end = endRaw == null ? start : Number(endRaw);
    return Number.isInteger(start) && Number.isInteger(end) && end >= start
      ? total + end - start + 1
      : total;
  }, 0);
}

function cpuLimit(hostConfig) {
  if (hostConfig.NanoCpus > 0) return hostConfig.NanoCpus / 1_000_000_000;
  return cpuSetCount(hostConfig.CpusetCpus) || null;
}

function nofileLimit(hostConfig) {
  const limit = (hostConfig.Ulimits || []).find((entry) => entry.Name === 'nofile');
  return limit ? Math.min(Number(limit.Soft) || 0, Number(limit.Hard) || 0) : 0;
}

export function shapeFailures(hostConfig, expectedCpus, expectedMemoryBytes) {
  const failures = [];
  const limitedCpus = cpuLimit(hostConfig);
  const pinnedCpus = cpuSetCount(hostConfig.CpusetCpus);
  if (limitedCpus !== expectedCpus) failures.push(`CPU quota is ${limitedCpus ?? 'unset'}, expected ${expectedCpus}`);
  if (pinnedCpus !== expectedCpus) failures.push(`CPU set contains ${pinnedCpus}, expected ${expectedCpus}`);
  if (hostConfig.Memory !== expectedMemoryBytes) failures.push(`memory limit is ${hostConfig.Memory}, expected ${expectedMemoryBytes}`);
  if (hostConfig.MemorySwap !== expectedMemoryBytes) failures.push(`memory+swap limit is ${hostConfig.MemorySwap}, expected ${expectedMemoryBytes} (swap disabled)`);
  if ((hostConfig.PidsLimit || 0) < 100_000) failures.push(`PID limit is ${hostConfig.PidsLimit ?? 'unset'}, expected at least 100000`);
  if (nofileLimit(hostConfig) < 200_000) failures.push(`nofile is ${nofileLimit(hostConfig)}, expected at least 200000`);
  return failures;
}

export function histogramDelta(first = {}, last = {}) {
  const bounds = new Set([...Object.keys(first), ...Object.keys(last)]);
  return Object.fromEntries([...bounds].map((bound) => [bound, Math.max(0, (last[bound] || 0) - (first[bound] || 0))]));
}

export function histogramPercentile(histogram, percentile) {
  const entries = Object.entries(histogram)
    .map(([bound, count]) => [bound === 'infinity' ? Infinity : Number(bound), count])
    .sort((left, right) => left[0] - right[0]);
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  if (!total) return null;
  const wanted = Math.ceil(total * percentile);
  let seen = 0;
  for (const [bound, count] of entries) {
    seen += count;
    if (seen >= wanted) return Number.isFinite(bound) ? bound : 'infinity';
  }
  return null;
}

function maxFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

export function headroomEvaluation(
  samples,
  gateWindowSeconds,
  memoryLimit,
  expectedCpus,
  expectedSessions,
  expectedRunners,
  expectedMemberships,
  preflightFailures,
  expectedRuntime = {},
  minimumDurationSeconds = 0,
  expectedIntervalSeconds = 5,
  gateEndSeconds = null,
  expectedRealtime = null,
) {
  const failures = [...preflightFailures];
  const observedLast = samples.at(-1);
  const lastElapsed = observedLast?.elapsedSeconds || 0;
  const effectiveGateEnd = Number.isFinite(gateEndSeconds)
    ? Math.min(gateEndSeconds, lastElapsed)
    : lastElapsed;
  const gateStart = Math.max(0, effectiveGateEnd - gateWindowSeconds);
  const window = samples.filter((sample) =>
    sample.elapsedSeconds >= gateStart && sample.elapsedSeconds <= effectiveGateEnd);
  const first = window[0];
  const last = window.at(-1);
  if (!first || !last) return { ok: false, failures: [...failures, 'no monitoring samples'], gateStartSeconds: gateStart };
  const gateObservedSeconds = last.elapsedSeconds - first.elapsedSeconds;
  const durationTolerance = Math.max(expectedIntervalSeconds * 2, 2);
  const minimumGateSamples = Math.floor(gateWindowSeconds / expectedIntervalSeconds * 0.9);
  if (minimumDurationSeconds > 0 && lastElapsed < minimumDurationSeconds - durationTolerance) {
    failures.push(`monitor ended at ${lastElapsed.toFixed(1)}s, expected at least ${minimumDurationSeconds - durationTolerance}s`);
  }
  if (gateObservedSeconds < gateWindowSeconds - durationTolerance) {
    failures.push(`headroom window covers ${gateObservedSeconds.toFixed(1)}s, expected ${gateWindowSeconds}s`);
  }
  if (window.length < minimumGateSamples) {
    failures.push(`headroom window has ${window.length} samples, expected at least ${minimumGateSamples}`);
  }

  const cpuMaxPct = maxFinite(window.map((sample) => sample.normalizedCpuPct));
  const memoryMaxBytes = maxFinite(window.map((sample) => sample.memoryCurrent));
  const schedulerMaxPct = maxFinite(window.map((sample) => sample.beam?.beam?.schedulerUtilizationPct));
  const schedulerSingleMaxPct = maxFinite(window.map((sample) => sample.beam?.beam?.schedulerMaxUtilizationPct));
  const poolMaxPct = maxFinite(window.map((sample) => sample.beam?.pool?.utilizationPct));
  const fdMax = maxFinite(window.map((sample) => sample.beamOpenFiles?.count));
  const maxRunQueue = maxFinite(window.map((sample) => sample.beam?.beam?.runQueue));
  const schedulersOnline = last.beam?.beam?.schedulersOnline;
  let longestBusyRunSeconds = 0;
  let busyRunStarted = null;
  for (const sample of window) {
    if (Number.isFinite(schedulersOnline) && sample.beam?.beam?.runQueue > schedulersOnline) {
      if (busyRunStarted == null) busyRunStarted = sample.elapsedSeconds;
      longestBusyRunSeconds = Math.max(longestBusyRunSeconds, sample.elapsedSeconds - busyRunStarted);
    } else {
      busyRunStarted = null;
    }
  }

  const metricAt = (sample, name) => sample.beam?.metrics?.[name] || {};
  const metricDelta = (name) => histogramDelta(metricAt(first, name).histogram, metricAt(last, name).histogram);
  const metricCount = (sample, name) => {
    const metric = sample.beam?.metrics?.[name];
    return typeof metric === 'number' ? metric : metric?.count || 0;
  };
  const counterDelta = (name) => Math.max(0, metricCount(last, name) - metricCount(first, name));
  const dbQueueP99Us = histogramPercentile(metricDelta('db_queue_us'), 0.99);
  const dbQueryP99Us = histogramPercentile(metricDelta('db_query_us'), 0.99);
  const dbWriteLockWaitP99Us = histogramPercentile(metricDelta('db_write_lock_wait_us'), 0.99);
  const dbWriteLockHoldP99Us = histogramPercentile(metricDelta('db_write_lock_hold_us'), 0.99);
  const dbWriteLockQueueDepthMax = metricAt(observedLast, 'db_write_lock_queue_depth').max;
  const dbWriteLockOwnerDeaths = metricCount(observedLast, 'db_write_lock_owner_deaths');
  const poolSamples = counterDelta('db_pool_utilization_pct');
  const poolSaturatedSamples = counterDelta('db_pool_samples_above_80_pct');
  const poolSaturationRatio = poolSamples > 0 ? poolSaturatedSamples / poolSamples : null;
  const dbErrors = metricCount(observedLast, 'db_errors');
  const dbBusyOrLockedErrors = metricCount(observedLast, 'db_busy_or_locked_errors');
  const probeErrors = ['probe_pool_errors', 'probe_beam_errors', 'probe_deep_errors']
    .reduce((sum, name) => sum + metricCount(observedLast, name), 0);
  const restarts = Math.max(...samples.map((sample) => sample.containerState?.restartCount || 0));
  const oomKilled = samples.some((sample) => sample.containerState?.oomKilled);
  const rpcErrors = samples.reduce((sum, sample) => sum + (sample.errors?.length || 0), 0);
  const sessionSamples = window.map((sample) => sample.beam?.beam?.realtimeSessions).filter(Number.isFinite);
  const runnerSamples = window.map((sample) => sample.beam?.deep?.registeredRunners).filter(Number.isFinite);
  const membershipSamples = window.map((sample) => sample.beam?.deep?.realtimeMemberships).filter(Number.isFinite);
  const cgroupSamples = window.map((sample) => sample.beam?.deep?.cgroup).filter(Boolean);
  const allCgroupSamples = samples.map((sample) => sample.beam?.deep?.cgroup).filter(Boolean);
  const firstCgroup = cgroupSamples[0];
  const lastCgroup = cgroupSamples.at(-1);
  const delta = (before, after) => Number.isFinite(before) && Number.isFinite(after) ? Math.max(0, after - before) : null;
  const cpuUsageDeltaUsec = delta(firstCgroup?.cpu?.usage_usec, lastCgroup?.cpu?.usage_usec);
  const cpuThrottledDeltaUsec = delta(firstCgroup?.cpu?.throttled_usec, lastCgroup?.cpu?.throttled_usec);
  const cpuThrottleRatio = cpuUsageDeltaUsec > 0 && cpuThrottledDeltaUsec != null
    ? cpuThrottledDeltaUsec / cpuUsageDeltaUsec
    : null;
  const cgroupMemoryPeakBytes = maxFinite(cgroupSamples.map((cgroup) => cgroup.memoryPeak));
  const cgroupPidsPeak = maxFinite(cgroupSamples.map((cgroup) => cgroup.pidsPeak));
  const firstRunCgroup = allCgroupSamples[0];
  const lastRunCgroup = allCgroupSamples.at(-1);
  const memoryEventDelta = Object.fromEntries(
    ['low', 'high', 'max', 'oom', 'oom_kill', 'oom_group_kill'].map((event) => [
      event,
      delta(firstRunCgroup?.memoryEvents?.[event], lastRunCgroup?.memoryEvents?.[event]),
    ]),
  );
  const pressurePeak = (resource, kind) => maxFinite(cgroupSamples.map((cgroup) => cgroup?.[resource]?.[kind]?.avg10));
  const walSamples = window.map((sample) => sample.beam?.beam?.walBytes).filter(Number.isFinite);
  const walMaxBytes = maxFinite(walSamples);
  const walGrowthBytes = walSamples.length ? walSamples.at(-1) - walSamples[0] : null;
  const mailboxMax = maxFinite(window.map((sample) => sample.beam?.deep?.mailboxes?.max));
  const sessionCoverage = expectedSessions > 0 && sessionSamples.length
    ? sessionSamples.filter((value) => value >= expectedSessions * 0.999).length / sessionSamples.length
    : null;
  const runnerCoverage = expectedRunners > 0 && runnerSamples.length
    ? runnerSamples.filter((value) => value >= expectedRunners * 0.999).length / runnerSamples.length
    : null;
  const membershipCoverage = expectedMemberships > 0 && membershipSamples.length
    ? membershipSamples.filter((value) => value >= expectedMemberships * 0.999).length / membershipSamples.length
    : null;
  const schedulersObserved = last.beam?.beam?.schedulersOnline;
  const runtimeConfiguration = last.beam?.configuration;
  const realtimeAuthFull = metricCount(observedLast, 'realtime_auth_full');
  const realtimeAuthCacheHits = metricCount(observedLast, 'realtime_auth_cache_hits');
  const realtimeVerifiedTokenCacheHits = metricCount(observedLast, 'realtime_verified_token_cache_hits');
  const realtimeVerifiedTokenCacheMisses = metricCount(observedLast, 'realtime_verified_token_cache_misses');
  const realtimeAuthConflicts = metricCount(observedLast, 'realtime_auth_conflicts');
  const realtimeAuthUnknown = metricCount(observedLast, 'realtime_auth_unknown');
  const presenceUserChannelReads = metricCount(observedLast, 'presence_user_channel_reads');
  const presenceChannelSourceReads = metricCount(observedLast, 'presence_channel_source_reads');
  const presenceParticipantSnapshotReads = metricCount(observedLast, 'presence_participant_snapshot_reads');
  const presenceSnapshotInitial = metricCount(observedLast, 'presence_snapshot_initial');
  const presenceSnapshotDirect = metricCount(observedLast, 'presence_snapshot_direct');
  const presenceSnapshotDispatcher = metricCount(observedLast, 'presence_snapshot_dispatcher');
  const presenceSnapshotOther = metricCount(observedLast, 'presence_snapshot_other');
  const chatListRouteReads = metricCount(observedLast, 'chat_list_route_reads');
  const chatListRouteMessage = metricCount(observedLast, 'chat_list_route_message');
  const chatListRouteDirect = metricCount(observedLast, 'chat_list_route_direct');
  const chatListRouteDispatcher = metricCount(observedLast, 'chat_list_route_dispatcher');
  const chatListRouteOther = metricCount(observedLast, 'chat_list_route_other');
  const runnerDelegatedSnapshotReads = metricCount(observedLast, 'runner_delegated_snapshot_reads');
  const runnerDelegatedOwnerReads = metricCount(observedLast, 'runner_delegated_owner_reads');
  const runnerDisconnectFlushes = metricCount(observedLast, 'runner_disconnect_flushes');
  const runnerDisconnectFlushOwners = metricCount(observedLast, 'runner_disconnect_flush_owners');
  const presenceDispatcher = observedLast?.beam?.deep?.presenceDispatcher;

  if (schedulersObserved !== expectedCpus) failures.push(`BEAM exposes ${schedulersObserved ?? 'missing'} online schedulers, expected ${expectedCpus}`);
  if (!runtimeConfiguration) {
    failures.push('effective Cascade runtime configuration is missing');
  } else {
    for (const [key, expected] of Object.entries(expectedRuntime)) {
      if (runtimeConfiguration[key] !== expected) {
        failures.push(`runtime ${key} is ${runtimeConfiguration[key] ?? 'missing'}, expected ${expected}`);
      }
    }
  }
  if (cpuMaxPct == null || cpuMaxPct > 70) failures.push(`normalized app CPU peak is ${cpuMaxPct ?? 'missing'}%, expected <=70%`);
  if (memoryMaxBytes == null || memoryMaxBytes > memoryLimit * 0.7) failures.push(`memory peak is ${memoryMaxBytes ?? 'missing'}, expected <=70% of ${memoryLimit}`);
  if (schedulerMaxPct == null || schedulerMaxPct > 80) failures.push(`aggregate scheduler utilization peak is ${schedulerMaxPct ?? 'missing'}%, expected <=80%`);
  if (poolSaturationRatio == null || poolSaturationRatio > 0.05) {
    failures.push(`DB pool saturation is ${poolSaturationRatio == null ? 'missing' : `${(poolSaturationRatio * 100).toFixed(2)}%`}, expected <=5% of 100ms samples`);
  }
  if (dbQueueP99Us == null || dbQueueP99Us > 50_000) failures.push(`DB queue p99 is ${dbQueueP99Us ?? 'missing'}us, expected <=50000us`);
  if (dbQueryP99Us == null || dbQueryP99Us > 100_000) failures.push(`DB query p99 is ${dbQueryP99Us ?? 'missing'}us, expected <=100000us`);
  if (dbWriteLockWaitP99Us == null || dbWriteLockWaitP99Us > 100_000) {
    failures.push(`DB write-lock wait p99 is ${dbWriteLockWaitP99Us ?? 'missing'}us, expected <=100000us`);
  }
  if (dbWriteLockHoldP99Us == null || dbWriteLockHoldP99Us > 100_000) {
    failures.push(`DB write-lock hold p99 is ${dbWriteLockHoldP99Us ?? 'missing'}us, expected <=100000us`);
  }
  if (!Number.isFinite(dbWriteLockQueueDepthMax) || dbWriteLockQueueDepthMax > 64) {
    failures.push(`DB write-lock queue depth max is ${dbWriteLockQueueDepthMax ?? 'missing'}, expected <=64`);
  }
  if (dbWriteLockOwnerDeaths > 0) failures.push(`${dbWriteLockOwnerDeaths} DB write-lock owner deaths`);
  if (realtimeAuthUnknown > 0) failures.push(`${realtimeAuthUnknown} unknown realtime auth telemetry outcomes`);
  if (dbErrors > 0) failures.push(`${dbErrors} DB query errors`);
  if (dbBusyOrLockedErrors > 0) failures.push(`${dbBusyOrLockedErrors} SQLite busy/locked errors`);
  if (longestBusyRunSeconds > 15) failures.push(`run queue exceeded online schedulers for ${longestBusyRunSeconds.toFixed(1)}s`);
  if (restarts > 0) failures.push(`${restarts} container restarts`);
  if (oomKilled) failures.push('container was OOM-killed');
  if (rpcErrors > 0) failures.push(`${rpcErrors} monitor sample errors`);
  if (probeErrors > 0) failures.push(`${probeErrors} in-node probe sampling errors`);
  if (!firstCgroup || !lastCgroup) failures.push('container cgroup telemetry is missing');
  if ((memoryEventDelta.oom || 0) > 0 || (memoryEventDelta.oom_kill || 0) > 0 || (memoryEventDelta.oom_group_kill || 0) > 0) {
    failures.push(`cgroup OOM events changed: ${JSON.stringify(memoryEventDelta)}`);
  }
  if ((memoryEventDelta.max || 0) > 0) failures.push(`${memoryEventDelta.max} cgroup memory.max events`);
  if (cpuThrottleRatio != null && cpuThrottleRatio > 0.01) failures.push(`CPU throttling ratio is ${(cpuThrottleRatio * 100).toFixed(2)}%, expected <=1%`);
  if (fdMax == null || fdMax > 140_000) failures.push(`BEAM open files peak is ${fdMax ?? 'missing'}, expected <=140000`);
  if (mailboxMax == null || mailboxMax > 500) failures.push(`mailbox peak is ${mailboxMax ?? 'missing'}, expected <=500`);
  if (walMaxBytes == null || walMaxBytes > 128 * 1024 ** 2) failures.push(`SQLite WAL peak is ${walMaxBytes ?? 'missing'} bytes, expected <=128MiB`);
  if (walGrowthBytes != null && walGrowthBytes > 64 * 1024 ** 2) failures.push(`SQLite WAL grew ${walGrowthBytes} bytes during the gate window`);
  if (expectedSessions > 0 && (sessionCoverage == null || sessionCoverage < 0.95)) {
    failures.push(`10k-session coverage is ${sessionCoverage == null ? 'missing' : `${(sessionCoverage * 100).toFixed(2)}%`}, expected >=95% of gate samples`);
  }
  if (expectedRunners > 0 && (runnerCoverage == null || runnerCoverage < 0.95)) {
    failures.push(`runner coverage is ${runnerCoverage == null ? 'missing' : `${(runnerCoverage * 100).toFixed(2)}%`}, expected >=95% of gate samples`);
  }
  if (expectedMemberships > 0 && (membershipCoverage == null || membershipCoverage < 0.95)) {
    failures.push(`namespace/room membership coverage is ${membershipCoverage == null ? 'missing' : `${(membershipCoverage * 100).toFixed(2)}%`}, expected >=95% of gate samples`);
  }
  if (expectedRealtime?.enabled) {
    const expectedAuthFull = expectedRealtime.authFull;
    const expectedAuthCacheHits = expectedAuthFull * 2;
    const groupCount = expectedRealtime.groupCount;
    const expectedDirectSnapshots = expectedRealtime.initialOwnedChatChannels
      + expectedRealtime.forcedReconnectOwnedChatChannels;

    if (realtimeAuthFull !== expectedAuthFull) {
      failures.push(`realtime full auth count is ${realtimeAuthFull}, expected ${expectedAuthFull}`);
    }
    if (realtimeAuthCacheHits !== expectedAuthCacheHits) {
      failures.push(`realtime auth cache hits are ${realtimeAuthCacheHits}, expected ${expectedAuthCacheHits}`);
    }
    if (realtimeAuthConflicts !== 0) failures.push(`${realtimeAuthConflicts} realtime auth conflicts`);
    if (presenceUserChannelReads < Math.floor(expectedSessions * 0.99)
        || presenceUserChannelReads > expectedSessions) {
      failures.push(`presence user-channel reads are ${presenceUserChannelReads}, expected 99-100% of ${expectedSessions}`);
    }
    if (presenceChannelSourceReads > groupCount * 3) {
      failures.push(`presence channel-source reads are ${presenceChannelSourceReads}, expected <=${groupCount * 3}`);
    }
    if (expectedRunners > 0 && (runnerDelegatedSnapshotReads < 1 || runnerDelegatedSnapshotReads > 2)) {
      failures.push(`runner delegated snapshot reads are ${runnerDelegatedSnapshotReads}, expected 1-2 including startup orphan reconciliation`);
    }
    if (runnerDelegatedOwnerReads !== 0) {
      failures.push(`${runnerDelegatedOwnerReads} per-owner delegated-run reads`);
    }
    if (expectedRunners > 0 && runnerDisconnectFlushes !== 1) {
      failures.push(`runner disconnect flushes are ${runnerDisconnectFlushes}, expected 1`);
    }
    if (expectedRunners > 0 && (runnerDisconnectFlushOwners < Math.floor(expectedRunners * 0.99)
        || runnerDisconnectFlushOwners > expectedRunners)) {
      failures.push(`runner disconnect flush owners are ${runnerDisconnectFlushOwners}, expected 99-100% of ${expectedRunners}`);
    }
    if (!presenceDispatcher) {
      failures.push('presence dispatcher telemetry is missing');
    } else {
      const dispatchBudget = groupCount * 6;
      if (presenceDispatcher.requested < expectedSessions) {
        failures.push(`presence dispatcher requests are ${presenceDispatcher.requested}, expected >=${expectedSessions}`);
      }
      if (presenceDispatcher.dispatched > dispatchBudget) {
        failures.push(`presence dispatcher dispatches are ${presenceDispatcher.dispatched}, expected <=${dispatchBudget}`);
      }
      if (presenceDispatcher.noop !== 0) {
        failures.push(`presence dispatcher noops are ${presenceDispatcher.noop}, expected 0`);
      }
      if (presenceDispatcher.startFailed !== 0 || presenceDispatcher.taskFailed !== 0) {
        failures.push(`presence dispatcher start/task failures are ${presenceDispatcher.startFailed}/${presenceDispatcher.taskFailed}, expected 0/0`);
      }
      const classifiedJobs = presenceDispatcher.refreshed + presenceDispatcher.noop
        + presenceDispatcher.taskFailed;
      if (presenceDispatcher.completed !== classifiedJobs) {
        failures.push(`presence dispatcher completed jobs are ${presenceDispatcher.completed}, expected refreshed ${presenceDispatcher.refreshed} + noop ${presenceDispatcher.noop} + task failures ${presenceDispatcher.taskFailed} = ${classifiedJobs}`);
      }
      if (presenceDispatcher.dispatched !== presenceDispatcher.completed + presenceDispatcher.active) {
        failures.push(`presence dispatcher jobs are ${presenceDispatcher.dispatched}, expected completed ${presenceDispatcher.completed} + active ${presenceDispatcher.active}`);
      }
      if (presenceSnapshotInitial !== expectedAuthFull) {
        failures.push(`initial presence snapshots are ${presenceSnapshotInitial}, expected realtime full auth ${expectedAuthFull}`);
      }
      if (presenceSnapshotDirect !== expectedDirectSnapshots) {
        failures.push(`direct presence snapshots are ${presenceSnapshotDirect}, expected initial owned channels ${expectedRealtime.initialOwnedChatChannels} + reconnect owned channels ${expectedRealtime.forcedReconnectOwnedChatChannels} = ${expectedDirectSnapshots}`);
      }
      if (presenceSnapshotDispatcher !== presenceDispatcher.refreshed) {
        failures.push(`dispatcher presence snapshots are ${presenceSnapshotDispatcher}, expected refreshed jobs ${presenceDispatcher.refreshed}`);
      }
      if (presenceSnapshotOther !== 0) {
        failures.push(`other presence snapshots are ${presenceSnapshotOther}, expected 0`);
      }
      const classifiedSnapshots = presenceSnapshotInitial + presenceSnapshotDirect
        + presenceSnapshotDispatcher + presenceSnapshotOther;
      if (presenceParticipantSnapshotReads !== classifiedSnapshots) {
        failures.push(`presence participant snapshots are ${presenceParticipantSnapshotReads}, expected exact reason sum ${classifiedSnapshots}`);
      }
      if (chatListRouteMessage !== expectedRealtime.successfulChatWrites) {
        failures.push(`message list-route reads are ${chatListRouteMessage}, expected successful chat writes ${expectedRealtime.successfulChatWrites}`);
      }
      if (chatListRouteDirect !== presenceSnapshotDirect) {
        failures.push(`direct list-route reads are ${chatListRouteDirect}, expected direct presence snapshots ${presenceSnapshotDirect}`);
      }
      if (chatListRouteDispatcher !== presenceDispatcher.refreshed
          || chatListRouteDispatcher !== presenceSnapshotDispatcher) {
        failures.push(`dispatcher list-route reads are ${chatListRouteDispatcher}, expected refreshed jobs/snapshots ${presenceDispatcher.refreshed}/${presenceSnapshotDispatcher}`);
      }
      if (chatListRouteOther !== 0) {
        failures.push(`other list-route reads are ${chatListRouteOther}, expected 0`);
      }
      const classifiedRouteReads = chatListRouteMessage + chatListRouteDirect
        + chatListRouteDispatcher + chatListRouteOther;
      if (chatListRouteReads !== classifiedRouteReads) {
        failures.push(`chat list-route reads are ${chatListRouteReads}, expected exact reason sum ${classifiedRouteReads}`);
      }
      if (presenceDispatcher.completed !== presenceDispatcher.dispatched
          || presenceDispatcher.failed !== 0
          || presenceDispatcher.active !== 0
          || presenceDispatcher.pending !== 0
          || presenceDispatcher.queued !== 0) {
        failures.push(`presence dispatcher did not drain cleanly: ${JSON.stringify(presenceDispatcher)}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    gateStartSeconds: gateStart,
    gateEndSeconds: effectiveGateEnd,
    gateSamples: window.length,
    gateObservedSeconds,
    observed: {
      cpuMaxPct,
      memoryMaxBytes,
      memoryMaxPct: memoryLimit > 0 && memoryMaxBytes != null ? memoryMaxBytes / memoryLimit * 100 : null,
      schedulerMaxPct,
      schedulerSingleMaxPct,
      poolMaxPct,
      poolSaturatedSamples,
      poolSamples,
      poolSaturationRatio,
      dbQueueP99Us,
      dbQueryP99Us,
      dbWriteLockWaitP99Us,
      dbWriteLockHoldP99Us,
      dbWriteLockQueueDepthMax,
      dbWriteLockQueueDepthEnd: last.beam?.deep?.writeCoordinator?.queue_depth,
      dbWriteLockOwnerDeaths,
      dbErrors,
      dbBusyOrLockedErrors,
      maxRunQueue,
      longestBusyRunSeconds,
      fdMax,
      cgroupMemoryPeakBytes,
      cgroupPidsPeak,
      memoryEventDelta,
      cpuUsageDeltaUsec,
      cpuThrottledDeltaUsec,
      cpuThrottleRatio,
      cpuPressureSomeAvg10Max: pressurePeak('cpuPressure', 'some'),
      cpuPressureFullAvg10Max: pressurePeak('cpuPressure', 'full'),
      memoryPressureSomeAvg10Max: pressurePeak('memoryPressure', 'some'),
      memoryPressureFullAvg10Max: pressurePeak('memoryPressure', 'full'),
      ioPressureSomeAvg10Max: pressurePeak('ioPressure', 'some'),
      ioPressureFullAvg10Max: pressurePeak('ioPressure', 'full'),
      ioStart: firstCgroup?.io,
      ioEnd: lastCgroup?.io,
      walMaxBytes,
      walGrowthBytes,
      restarts,
      oomKilled,
      rpcErrors,
      probeErrors,
      schedulersObserved,
      runtimeConfiguration,
      realtimeAuthFull,
      realtimeAuthCacheHits,
      realtimeVerifiedTokenCacheHits,
      realtimeVerifiedTokenCacheMisses,
      realtimeAuthConflicts,
      realtimeAuthUnknown,
      presenceUserChannelReads,
      presenceChannelSourceReads,
      presenceParticipantSnapshotReads,
      presenceSnapshotInitial,
      presenceSnapshotDirect,
      presenceSnapshotDispatcher,
      presenceSnapshotOther,
      chatListRouteReads,
      chatListRouteMessage,
      chatListRouteDirect,
      chatListRouteDispatcher,
      chatListRouteOther,
      runnerDelegatedSnapshotReads,
      runnerDelegatedOwnerReads,
      runnerDisconnectFlushes,
      runnerDisconnectFlushOwners,
      presenceDispatcher,
      sessionCoverage,
      runnerCoverage,
      membershipCoverage,
      processCountStart: first.beam?.beam?.processCount,
      processCountEnd: last.beam?.beam?.processCount,
      etsBytesStart: first.beam?.deep?.etsBytes,
      etsBytesEnd: last.beam?.deep?.etsBytes,
      walBytesStart: first.beam?.beam?.walBytes,
      walBytesEnd: last.beam?.beam?.walBytes,
      mailboxMax,
      sessionsEnd: last.beam?.beam?.realtimeSessions,
      membershipsEnd: last.beam?.deep?.realtimeMemberships,
      runnersEnd: last.beam?.deep?.registeredRunners,
      banditConnectionsEnd: last.beam?.deep?.banditConnections,
    },
  };
}

export function validateWorkloadResults(
  marker,
  artifacts,
  startedAt,
  expectedSessions,
  minimumWorkloadSeconds,
  expected,
) {
  if (marker.status !== 'passed') throw new Error('workload-finished marker status is not passed');
  const finishedAtMs = Date.parse(marker.finishedAt);
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(finishedAtMs) || finishedAtMs <= startedAtMs) {
    throw new Error('workload-finished marker timestamp is invalid or stale');
  }
  const elapsedSeconds = (finishedAtMs - startedAtMs) / 1_000;
  if (elapsedSeconds < minimumWorkloadSeconds) {
    throw new Error(`workload marker arrived at ${elapsedSeconds.toFixed(1)}s, expected >=${minimumWorkloadSeconds}s`);
  }
  if (!Array.isArray(marker.shards) || marker.shards.length === 0) {
    throw new Error('workload-finished marker has no shard artifacts');
  }

  const shardIndexes = new Set();
  const sourceIps = new Set();
  const reconnectOwnerUserIds = new Set();
  let users = 0;
  const shards = artifacts.map(({ entry, result, filename, digest }) => {
    const index = result.shard?.index;
    if (result.evaluation?.ok !== true) throw new Error(`shard ${result.shard?.index ?? '?'} did not pass`);
    const resultStartedAtMs = Date.parse(result.metrics?.startedAt);
    const soakStartedAtMs = Date.parse(result.soakStartedAt);
    const workloadFinishedAtMs = Date.parse(result.workloadFinishedAt);
    const resultFinishedAtMs = Date.parse(result.finishedAt);
    if (!Number.isFinite(resultStartedAtMs) || resultStartedAtMs < startedAtMs) {
      throw new Error(`shard ${index ?? '?'} started before this monitor`);
    }
    if (![soakStartedAtMs, workloadFinishedAtMs, resultFinishedAtMs].every(Number.isFinite)
      || soakStartedAtMs < resultStartedAtMs
      || workloadFinishedAtMs < soakStartedAtMs
      || resultFinishedAtMs < workloadFinishedAtMs
      || resultFinishedAtMs > finishedAtMs) {
      throw new Error(`shard ${index ?? '?'} has invalid or stale timestamps`);
    }
    if (result.target !== expected.target) throw new Error(`shard ${index} target differs from expected`);
    if (result.shard?.count !== expected.shardCount) throw new Error(`shard ${index} count differs from expected`);
    if (result.rampSeconds !== expected.rampSeconds || result.soakSeconds !== expected.soakSeconds) {
      throw new Error(`shard ${index} ramp/soak differs from expected`);
    }
    if (result.pollingPercent !== expected.pollingPercent
      || result.reconnectPercent !== expected.reconnectPercent
      || result.reconnectAtSeconds !== expected.reconnectAtSeconds) {
      throw new Error(`shard ${index} transport/reconnect config differs from expected`);
    }
    for (const [name, value] of Object.entries(expected.rates)) {
      if (result.rates?.[name] !== value) throw new Error(`shard ${index} ${name} differs from expected`);
    }
    if (expected.sourceIps.length > 0 && !expected.sourceIps.includes(result.sourceIp)) {
      throw new Error(`shard ${index} source IP differs from expected`);
    }
    if (sourceIps.has(result.sourceIp)) throw new Error(`duplicate source IP ${result.sourceIp}`);
    sourceIps.add(result.sourceIp);
    if (result.metrics?.connected !== result.requestedUsers || result.metrics?.connectFailures !== 0) {
      throw new Error(`shard ${index} did not connect every requested user`);
    }
    const workloadIdentity = result.workloadIdentity || {};
    const messageIds = workloadIdentity.successfulMessageIds;
    const runIds = workloadIdentity.requestedRunIds;
    if (!Array.isArray(messageIds) || !Array.isArray(runIds)
      || messageIds.length !== result.metrics?.workload?.chat?.succeeded
      || runIds.length !== result.metrics?.workload?.run?.succeeded
      || workloadIdentity.successfulMessageIdsCount !== messageIds.length
      || workloadIdentity.requestedRunIdsCount !== runIds.length
      || new Set(messageIds).size !== messageIds.length
      || new Set(runIds).size !== runIds.length
      || messageIds.some((id) => typeof id !== 'string' || !id.startsWith('load-'))
      || runIds.some((id) => !Number.isInteger(id) || id <= 1_897)
      || JSON.stringify(messageIds) !== JSON.stringify([...messageIds].sort())
      || JSON.stringify(runIds) !== JSON.stringify([...runIds].sort((left, right) => left - right))
      || workloadIdentity.successfulMessageIdsSha256
        !== createHash('sha256').update(JSON.stringify(messageIds)).digest('hex')
      || workloadIdentity.requestedRunIdsSha256
        !== createHash('sha256').update(JSON.stringify(runIds)).digest('hex')) {
      throw new Error(`shard ${index} has invalid successful message/run identity evidence`);
    }
    if (expectedSessions % expected.shardCount !== 0
      || result.requestedUsers !== expectedSessions / expected.shardCount) {
      throw new Error(`shard ${index} user count differs from the equal certified partition`);
    }
    const plannedCount = (percent) => {
      const totalSelected = Math.round(expectedSessions * percent / 100);
      return Math.floor(totalSelected / expected.shardCount)
        + (index < totalSelected % expected.shardCount ? 1 : 0);
    };
    const expectedPolling = plannedCount(expected.pollingPercent);
    const expectedReconnects = plannedCount(expected.reconnectPercent);
    const selectionOwnerUserIds = result.selectionPlan?.forcedReconnectOwnerUserIds;
    if (result.selectionPlan?.pollingOnly !== expectedPolling
      || result.selectionPlan?.forcedReconnects !== expectedReconnects
      || result.selectionPlan?.forcedReconnectStrategy !== 'owner-stratified-v1'
      || !Array.isArray(selectionOwnerUserIds)) {
      throw new Error(`shard ${index} recorded selection plan differs from expected`);
    }
    if (result.metrics?.pollingOnly !== expectedPolling
      || result.metrics?.forcedReconnectsExpected !== expectedReconnects) {
      throw new Error(`shard ${index} did not exercise the exact transport/reconnect split`);
    }
    const initialOwnedChatChannels = result.presencePlan?.initialOwnedChatChannels;
    const forcedReconnectOwnedChatChannels = result.presencePlan?.forcedReconnectOwnedChatChannels;
    const forcedReconnectOwnerUserIds = result.presencePlan?.forcedReconnectOwnerUserIds;
    const expectedOwnersPerShard = Math.ceil(expectedSessions / 25) / expected.shardCount;
    const expectedReconnectOwners = Math.round(
      initialOwnedChatChannels * expected.reconnectPercent / 100,
    );
    if (!Number.isInteger(initialOwnedChatChannels) || initialOwnedChatChannels < 0
      || !Number.isInteger(expectedOwnersPerShard)
      || initialOwnedChatChannels !== expectedOwnersPerShard
      || !Number.isInteger(forcedReconnectOwnedChatChannels)
      || forcedReconnectOwnedChatChannels < 0
      || forcedReconnectOwnedChatChannels > initialOwnedChatChannels
      || result.presencePlan?.strategy !== 'owner-stratified-v1'
      || !Array.isArray(forcedReconnectOwnerUserIds)
      || forcedReconnectOwnedChatChannels !== expectedReconnectOwners
      || forcedReconnectOwnerUserIds.length !== forcedReconnectOwnedChatChannels
      || forcedReconnectOwnerUserIds.some((userId) => !Number.isInteger(userId) || userId <= 0)
      || new Set(forcedReconnectOwnerUserIds).size !== forcedReconnectOwnerUserIds.length
      || selectionOwnerUserIds.length !== forcedReconnectOwnerUserIds.length
      || selectionOwnerUserIds.some((userId, ownerIndex) => (
        userId !== forcedReconnectOwnerUserIds[ownerIndex]
      ))) {
      throw new Error(`shard ${index} has an invalid explicit presence-owner plan`);
    }
    for (const userId of forcedReconnectOwnerUserIds) {
      if (reconnectOwnerUserIds.has(userId)) {
        throw new Error(`reconnect owner user ${userId} appears in multiple shards`);
      }
      reconnectOwnerUserIds.add(userId);
    }
    if (shardIndexes.has(index)) throw new Error(`duplicate shard ${index}`);
    shardIndexes.add(index);
    users += result.requestedUsers || 0;
    return {
      index,
      users: result.requestedUsers,
      sourceIp: result.sourceIp,
      startedAt: result.metrics.startedAt,
      soakStartedAt: result.soakStartedAt,
      workloadFinishedAt: result.workloadFinishedAt,
      finishedAt: result.finishedAt,
      forcedReconnectStrategy: result.selectionPlan.forcedReconnectStrategy,
      initialOwnedChatChannels,
      forcedReconnectOwnedChatChannels,
      forcedReconnectOwnerUserIds,
      successfulMessageIdsCount: workloadIdentity.successfulMessageIdsCount,
      successfulMessageIdsSha256: workloadIdentity.successfulMessageIdsSha256,
      requestedRunIdsCount: workloadIdentity.requestedRunIdsCount,
      requestedRunIdsSha256: workloadIdentity.requestedRunIdsSha256,
      path: filename,
      sha256: digest,
      markerSha256: entry.sha256,
    };
  });
  if (shards.length !== expected.shardCount || shardIndexes.size !== expected.shardCount) {
    throw new Error(`marker covers ${shards.length}/${expected.shardCount} shards`);
  }
  for (let index = 0; index < expected.shardCount; index += 1) {
    if (!shardIndexes.has(index)) throw new Error(`marker is missing shard ${index}`);
  }
  if (users !== expectedSessions) throw new Error(`marker covers ${users} users, expected exactly ${expectedSessions}`);
  const initialOwnedChatChannels = shards.reduce(
    (sum, shard) => sum + shard.initialOwnedChatChannels,
    0,
  );
  const forcedReconnectOwnedChatChannels = shards.reduce(
    (sum, shard) => sum + shard.forcedReconnectOwnedChatChannels,
    0,
  );
  const expectedOwnerChannels = Math.ceil(expectedSessions / 25);
  if (initialOwnedChatChannels !== expectedOwnerChannels) {
    throw new Error(`marker records ${initialOwnedChatChannels} initial owned chat channels, expected ${expectedOwnerChannels}`);
  }
  const expectedReconnectOwnerChannels = Math.round(
    expectedOwnerChannels * expected.reconnectPercent / 100,
  );
  if (forcedReconnectOwnedChatChannels !== expectedReconnectOwnerChannels
    || reconnectOwnerUserIds.size !== expectedReconnectOwnerChannels) {
    throw new Error(`marker records ${forcedReconnectOwnedChatChannels} reconnect-owned chat channels, expected ${expectedReconnectOwnerChannels}`);
  }

  const gateEndMs = Math.min(...shards.map((shard) => Date.parse(shard.workloadFinishedAt)));
  const gateStartMs = gateEndMs - expected.gateWindowSeconds * 1_000;
  for (const shard of shards) {
    if (Date.parse(shard.soakStartedAt) > gateStartMs || Date.parse(shard.workloadFinishedAt) < gateEndMs) {
      throw new Error(`shard ${shard.index} does not span the full concurrent gate window`);
    }
  }

  return {
    finishedAt: marker.finishedAt,
    elapsedSeconds,
    gateEndSeconds: (gateEndMs - startedAtMs) / 1_000,
    gateStartAt: new Date(gateStartMs).toISOString(),
    gateEndAt: new Date(gateEndMs).toISOString(),
    users,
    presencePlan: {
      strategy: 'owner-stratified-v1',
      initialOwnedChatChannels,
      forcedReconnectOwnedChatChannels,
      forcedReconnectOwnerUserIds: [...reconnectOwnerUserIds].sort((left, right) => left - right),
    },
    shards,
  };
}

function readWorkloadMarker(
  filename,
  startedAt,
  expectedSessions,
  minimumWorkloadSeconds,
  expected,
) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile()) throw new Error('workload-finished marker is not a regular file');
  const marker = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const artifacts = marker.shards.map((entry) => {
    if (!entry.path) throw new Error('workload marker contains an empty shard path');
    const filename = path.resolve(String(entry.path));
    if (!fs.statSync(filename).isFile()) throw new Error(`missing shard artifact ${filename}`);
    const contents = fs.readFileSync(filename);
    const digest = createHash('sha256').update(contents).digest('hex');
    if (digest !== entry.sha256) throw new Error(`shard artifact checksum changed: ${filename}`);
    return { entry, filename, digest, result: JSON.parse(contents.toString('utf8')) };
  });
  return validateWorkloadResults(
    marker,
    artifacts,
    startedAt,
    expectedSessions,
    minimumWorkloadSeconds,
    expected,
  );
}

export function containerIdentityFailures(containerState, expectedIdentity = {}) {
  const failures = [];
  if (expectedIdentity.containerId && containerState?.containerId !== expectedIdentity.containerId) {
    failures.push(
      `container ID drifted to ${containerState?.containerId || 'missing'}, expected ${expectedIdentity.containerId}`,
    );
  }
  if (expectedIdentity.imageId && containerState?.imageId !== expectedIdentity.imageId) {
    failures.push(
      `container image drifted to ${containerState?.imageId || 'missing'}, expected ${expectedIdentity.imageId}`,
    );
  }
  if (expectedIdentity.startedAt && containerState?.startedAt !== expectedIdentity.startedAt) {
    failures.push(
      `container start time drifted to ${containerState?.startedAt || 'missing'}, expected ${expectedIdentity.startedAt}`,
    );
  }
  return failures;
}

export function finalizationFailures(probeSummary, uninstallError, containerState, expectedIdentity = {}) {
  const failures = [];
  failures.push(...containerIdentityFailures(containerState, expectedIdentity));
  if (!probeSummary?.metrics) failures.push('final capacity-probe summary is missing');
  if (uninstallError) failures.push(`capacity-probe uninstall failed: ${uninstallError}`);
  if (!containerState?.running) failures.push('container is not running at monitor finish');
  if ((containerState?.restartCount || 0) !== 0) failures.push(`${containerState.restartCount} final container restarts`);
  if (containerState?.oomKilled) failures.push('container is OOM-killed at monitor finish');
  const metricCount = (name) => {
    const metric = probeSummary?.metrics?.[name];
    return typeof metric === 'number' ? metric : metric?.count || 0;
  };
  for (const [name, label] of [
    ['db_errors', 'DB query errors'],
    ['db_busy_or_locked_errors', 'SQLite busy/locked errors'],
    ['db_write_lock_owner_deaths', 'DB write-lock owner deaths'],
    ['probe_pool_errors', 'probe pool errors'],
    ['probe_beam_errors', 'probe BEAM errors'],
    ['probe_deep_errors', 'probe deep-sample errors'],
  ]) {
    const count = metricCount(name);
    if (count > 0) failures.push(`${count} final ${label}`);
  }
  return failures;
}

function beamOpenFiles(cgroup) {
  if (!cgroup) return null;
  const pids = (readText(path.join(cgroup, 'cgroup.procs')) || '').split(/\s+/).filter(Boolean);
  for (const pid of pids) {
    if (readText(`/proc/${pid}/comm`) === 'beam.smp') {
      try { return { pid: Number(pid), count: fs.readdirSync(`/proc/${pid}/fd`).length }; } catch { return null; }
    }
  }
  return null;
}

function containerBeamOpenFiles(container) {
  try {
    const output = docker(
      'exec',
      container,
      'sh',
      '-c',
      'for proc in /proc/[0-9]*; do read name < "$proc/comm" || continue; if test "$name" = beam.smp; then set -- "$proc"/fd/*; echo "${proc##*/} $#"; exit 0; fi; done; exit 1',
    );
    const [pid, count] = output.split(/\s+/, 2).map(Number);
    return Number.isFinite(pid) && Number.isFinite(count) ? { pid, count } : null;
  } catch {
    return null;
  }
}

function parsePercent(value) {
  const result = Number(String(value || '').replace(/%$/, ''));
  return Number.isFinite(result) ? result : null;
}

function cgroupSnapshot(cgroup) {
  if (!cgroup) return null;
  return {
    cpu: parseKeyValues(readText(path.join(cgroup, 'cpu.stat'))),
    memoryCurrent: readNumber(path.join(cgroup, 'memory.current')),
    memoryPeak: readNumber(path.join(cgroup, 'memory.peak')),
    memoryMax: readText(path.join(cgroup, 'memory.max')),
    memoryEvents: parseKeyValues(readText(path.join(cgroup, 'memory.events'))),
    pidsCurrent: readNumber(path.join(cgroup, 'pids.current')),
    pidsPeak: readNumber(path.join(cgroup, 'pids.peak')),
    pidsMax: readText(path.join(cgroup, 'pids.max')),
    io: readText(path.join(cgroup, 'io.stat')),
    cpuPressure: readText(path.join(cgroup, 'cpu.pressure')),
    memoryPressure: readText(path.join(cgroup, 'memory.pressure')),
    ioPressure: readText(path.join(cgroup, 'io.pressure')),
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const container = String(args.container || 'cascade-elixir-capacity');
  const output = path.resolve(String(args.output || `/tmp/${container}-monitor.jsonl`));
  const serverLogOutput = path.resolve(String(args.serverLogOutput || `${output}.container.log`));
  const intervalSeconds = numberOption(args, 'intervalSeconds', 5, 0.5);
  const durationSeconds = numberOption(args, 'durationSeconds', 0, 0);
  const gateWindowSeconds = numberOption(args, 'gateWindowSeconds', 1_800, 1);
  const expectedCpus = numberOption(args, 'expectedCpus', 2, 1);
  const expectedMemoryGiB = numberOption(args, 'expectedMemoryGib', 3, 1);
  const expectedMemoryBytes = expectedMemoryGiB * 1024 ** 3;
  const expectedSessions = numberOption(args, 'expectedSessions', 10_000, 0);
  const expectedRunners = numberOption(args, 'expectedRunners', 10_000, 0);
  const expectedMemberships = numberOption(args, 'expectedMemberships', 50_000, 0);
  const expectedImage = String(args.expectedImage || '').trim();
  const workloadFinishedMarker = args.workloadFinishedMarker
    ? path.resolve(String(args.workloadFinishedMarker))
    : '';
  const minimumWorkloadSeconds = numberOption(args, 'minimumWorkloadSeconds', 0, 0);
  const minimumPostWorkloadSeconds = numberOption(args, 'minimumPostWorkloadSeconds', 30, 0);
  const expectedLoad = {
    target: String(args.expectedLoadTarget || '').replace(/\/$/u, ''),
    shardCount: numberOption(args, 'expectedShardCount', 4, 1),
    rampSeconds: numberOption(args, 'expectedRampSeconds', 300, 0),
    soakSeconds: numberOption(args, 'expectedSoakSeconds', 1_860, 1),
    pollingPercent: numberOption(args, 'expectedPollingPercent', 5, 0),
    reconnectPercent: numberOption(args, 'expectedReconnectPercent', 10, 0),
    reconnectAtSeconds: numberOption(args, 'expectedReconnectAtSeconds', 600, 0),
    sourceIps: String(args.expectedSourceIps || '').split(',').map((value) => value.trim()).filter(Boolean),
    gateWindowSeconds,
    rates: {
      chatRps: numberOption(args, 'expectedChatRps', 6.25, 0),
      readRps: numberOption(args, 'expectedReadRps', 12.5, 0),
      runRps: numberOption(args, 'expectedRunRps', 0.25, 0),
    },
  };
  const expectedRuntime = {
    httpAcceptors: numberOption(args, 'expectedHttpAcceptors', 4, 1),
    httpMaxConnections: numberOption(args, 'expectedHttpMaxConnections', 32_768, 1),
    httpBacklog: numberOption(args, 'expectedHttpBacklog', 65_535, 1),
    networkMode: booleanOption(args, 'expectedNetworkMode', true),
    trustProxyHops: numberOption(args, 'expectedTrustProxyHops', 1, 0),
    qmdWorkerEnabled: booleanOption(args, 'expectedQmdWorkerEnabled', true),
    realtimeHibernateAfterMs: numberOption(args, 'expectedRealtimeHibernateAfterMs', 5_000, 1_000),
    runnerOrphanReclaimMs: numberOption(args, 'expectedRunnerOrphanReclaimMs', 600_000, 120_000),
    sqlitePoolSize: numberOption(args, 'expectedSqlitePoolSize', 20, 1),
    sqliteBusyTimeoutMs: numberOption(args, 'expectedSqliteBusyTimeoutMs', 5_000, 1),
  };
  const expectedRealtime = {
    enabled: expectedSessions > 0 && Boolean(workloadFinishedMarker),
    authFull:
      expectedSessions + Math.round(expectedSessions * expectedLoad.reconnectPercent / 100),
    groupCount: Math.ceil(expectedSessions / 25),
    successfulChatWrites:
      (expectedLoad.rates.chatRps > 0
        ? Math.max(1, Math.floor(expectedLoad.rates.chatRps * expectedLoad.soakSeconds))
        : 0) * expectedLoad.shardCount,
  };
  const probePath = path.resolve(String(args.probe || path.join(path.dirname(fileURLToPath(import.meta.url)), 'capacity_probe.exs')));
  if (!fs.existsSync(probePath)) throw new Error(`capacity probe not found: ${probePath}`);
  const probeSha256 = createHash('sha256').update(fs.readFileSync(probePath)).digest('hex');
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const inspect = dockerJson(['inspect', container])[0];
  const expectedIdentity = {
    containerId: inspect.Id,
    imageId: expectedImage,
    startedAt: inspect.State.StartedAt,
  };
  const cgroup = cgroupPath(inspect.State.Pid);
  let image = null;
  let imageInspectError = null;
  try {
    image = dockerJson(['image', 'inspect', inspect.Image])[0];
  } catch (error) {
    imageInspectError = error.message;
  }
  const preflightFailures = shapeFailures(inspect.HostConfig, expectedCpus, expectedMemoryBytes);
  if (workloadFinishedMarker && fs.existsSync(workloadFinishedMarker)) {
    preflightFailures.push(`workload-finished marker already exists: ${workloadFinishedMarker}`);
  }
  if (fs.existsSync(serverLogOutput)) {
    preflightFailures.push(`server-log output already exists: ${serverLogOutput}`);
  }
  if (workloadFinishedMarker && !expectedLoad.target) {
    preflightFailures.push('--expected-load-target is required with a workload-finished marker');
  }
  if (workloadFinishedMarker && expectedLoad.sourceIps.length !== expectedLoad.shardCount) {
    preflightFailures.push(
      `expected ${expectedLoad.shardCount} source IPs, received ${expectedLoad.sourceIps.length}`,
    );
  }
  if (!image) preflightFailures.push(`running image ${inspect.Image} is not locally inspectable`);
  if (!expectedImage) {
    preflightFailures.push('--expected-image is required (use the immutable sha256 image ID)');
  } else if (!expectedImage.startsWith('sha256:')) {
    preflightFailures.push('--expected-image must be an immutable sha256 image ID');
  } else if (inspect.Image !== expectedImage) {
    preflightFailures.push(`running image ${inspect.Image} does not match ${expectedImage}`);
  }
  const startedAt = new Date().toISOString();
  let stopping = false;
  let priorCpu = null;
  let priorAt = null;
  let sampleCount = 0;
  const samples = [];

  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  docker('cp', probePath, `${container}:/tmp/cascade-capacity-probe.exs`);
  const install = releaseRpc(
    container,
    'Code.eval_file("/tmp/cascade-capacity-probe.exs"); {:ok, snapshot} = CascadeCapacityProbe.install(); Jason.encode!(snapshot) |> IO.puts()',
  );

  fs.writeFileSync(output, `${JSON.stringify({
    type: 'start',
    observedAt: startedAt,
    container,
    containerId: inspect.Id,
    imageId: inspect.Image,
    imageRepoDigests: image?.RepoDigests || [],
    imageCreated: image?.Created || null,
    imageInspectError,
    probeSha256,
    hostConfig: {
      nanoCpus: inspect.HostConfig.NanoCpus,
      cpusetCpus: inspect.HostConfig.CpusetCpus,
      memory: inspect.HostConfig.Memory,
      memorySwap: inspect.HostConfig.MemorySwap,
      pidsLimit: inspect.HostConfig.PidsLimit,
      ulimits: inspect.HostConfig.Ulimits,
    },
    cgroup,
    expectedShape: {
      cpus: expectedCpus,
      memoryBytes: expectedMemoryBytes,
      sessions: expectedSessions,
      runners: expectedRunners,
      memberships: expectedMemberships,
      imageId: expectedImage,
      runtime: expectedRuntime,
      realtime: expectedRealtime,
    },
    monitorConfig: {
      intervalSeconds,
      durationSeconds,
      gateWindowSeconds,
      workloadFinishedMarker: workloadFinishedMarker || null,
      minimumWorkloadSeconds,
      minimumPostWorkloadSeconds,
      expectedLoad,
    },
    serverLogEvidence: {
      baselineCursor: inspect.State.StartedAt,
      monitorStartedAt: startedAt,
      output: serverLogOutput,
      policy: 'zero fatal/error lines from container start through monitor finish',
    },
    preflightFailures,
    probe: parseLastJson(install),
  })}\n`, { mode: 0o600 });

  const deadline = durationSeconds > 0 ? Date.now() + durationSeconds * 1_000 : Infinity;
  while (!stopping && Date.now() < deadline) {
    const observedAt = new Date().toISOString();
    const sampleStarted = performance.now();
    const currentInspect = dockerJson(['inspect', container])[0];
    const cgroupData = cgroupSnapshot(cgroup);
    const usageUsec = cgroupData?.cpu?.usage_usec ?? null;
    let normalizedCpuPct = null;

    if (usageUsec != null && priorCpu != null && priorAt != null) {
      const elapsedUsec = (Date.now() - priorAt) * 1_000;
      const allocatedCpus = cpuLimit(currentInspect.HostConfig) || 1;
      normalizedCpuPct = elapsedUsec > 0 ? (usageUsec - priorCpu) / elapsedUsec / allocatedCpus * 100 : null;
    }
    priorCpu = usageUsec;
    priorAt = Date.now();

    let beam;
    let stats;
    const errors = [];
    errors.push(...containerIdentityFailures(
      {
        containerId: currentInspect.Id,
        imageId: currentInspect.Image,
        startedAt: currentInspect.State.StartedAt,
      },
      expectedIdentity,
    ));
    errors.push(...shapeFailures(currentInspect.HostConfig, expectedCpus, expectedMemoryBytes));
    try {
      beam = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()'));
    } catch (error) {
      errors.push(`beam: ${error.message}`);
    }
    try {
      stats = JSON.parse(docker('stats', '--no-stream', '--format', '{{json .}}', container));
    } catch (error) {
      errors.push(`docker stats: ${error.message}`);
    }

    const allocatedCpus = cpuLimit(currentInspect.HostConfig) || 1;
    if (normalizedCpuPct == null) {
      const dockerCpuPct = parsePercent(stats?.CPUPerc);
      normalizedCpuPct = dockerCpuPct == null ? null : dockerCpuPct / allocatedCpus;
    }
    const dockerMemoryPct = parsePercent(stats?.MemPerc);
    const memoryCurrent = cgroupData?.memoryCurrent ?? (dockerMemoryPct == null
      ? null
      : dockerMemoryPct / 100 * currentInspect.HostConfig.Memory);
    const openFiles = beamOpenFiles(cgroup) || containerBeamOpenFiles(container);

    const sample = {
      type: 'sample',
      observedAt,
      elapsedSeconds: (Date.parse(observedAt) - Date.parse(startedAt)) / 1_000,
      sampleDurationMs: Math.round((performance.now() - sampleStarted) * 10) / 10,
      normalizedCpuPct,
      memoryCurrent,
      dockerStats: stats,
      cgroup: cgroupData,
      beamOpenFiles: openFiles,
      containerState: {
        containerId: currentInspect.Id,
        imageId: currentInspect.Image,
        startedAt: currentInspect.State.StartedAt,
        nanoCpus: currentInspect.HostConfig.NanoCpus,
        cpusetCpus: currentInspect.HostConfig.CpusetCpus,
        memory: currentInspect.HostConfig.Memory,
        memorySwap: currentInspect.HostConfig.MemorySwap,
        pidsLimit: currentInspect.HostConfig.PidsLimit,
        ulimits: currentInspect.HostConfig.Ulimits,
        running: currentInspect.State.Running,
        restartCount: currentInspect.RestartCount,
        oomKilled: currentInspect.State.OOMKilled,
        exitCode: currentInspect.State.ExitCode,
      },
      beam,
      errors,
    };
    samples.push(sample);
    fs.appendFileSync(output, `${JSON.stringify(sample)}\n`);

    sampleCount += 1;
    if (sampleCount % Math.max(1, Math.round(60 / intervalSeconds)) === 0) {
      process.stdout.write(`[capacity-monitor] samples=${sampleCount} cpu=${normalizedCpuPct?.toFixed(1) ?? 'n/a'}% memory=${cgroupData?.memoryCurrent ?? 'n/a'} sessions=${beam?.beam?.realtimeSessions ?? 'n/a'}\n`);
    }

    const remaining = intervalSeconds * 1_000 - (performance.now() - sampleStarted);
    if (remaining > 0) await sleep(remaining);
  }

  let probeSummary;
  let uninstallError = null;
  try {
    probeSummary = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.summary() |> Jason.encode!() |> IO.puts()'));
    releaseRpc(container, 'CascadeCapacityProbe.uninstall() |> Jason.encode!() |> IO.puts()');
  } catch (error) {
    uninstallError = error.message;
  }
  const finalInspect = dockerJson(['inspect', container])[0];
  const serverLogs = captureServerLogs(
    container,
    inspect.State.StartedAt,
    new Date().toISOString(),
    serverLogOutput,
  );
  const finalContainerState = {
    containerId: finalInspect.Id,
    imageId: finalInspect.Image,
    startedAt: finalInspect.State.StartedAt,
    nanoCpus: finalInspect.HostConfig.NanoCpus,
    cpusetCpus: finalInspect.HostConfig.CpusetCpus,
    memory: finalInspect.HostConfig.Memory,
    memorySwap: finalInspect.HostConfig.MemorySwap,
    pidsLimit: finalInspect.HostConfig.PidsLimit,
    ulimits: finalInspect.HostConfig.Ulimits,
    running: finalInspect.State.Running,
    restartCount: finalInspect.RestartCount,
    oomKilled: finalInspect.State.OOMKilled,
    exitCode: finalInspect.State.ExitCode,
  };
  preflightFailures.push(...finalizationFailures(
    probeSummary,
    uninstallError,
    finalContainerState,
    expectedIdentity,
  ));
  preflightFailures.push(...shapeFailures(finalInspect.HostConfig, expectedCpus, expectedMemoryBytes));
  preflightFailures.push(...serverLogFailures(serverLogs));
  let workload = null;
  if (workloadFinishedMarker) {
    try {
      workload = readWorkloadMarker(
        workloadFinishedMarker,
        startedAt,
        expectedSessions,
        minimumWorkloadSeconds,
        expectedLoad,
      );
      const postWorkloadSeconds = (samples.at(-1)?.elapsedSeconds || 0) - workload.elapsedSeconds;
      workload.postWorkloadSeconds = postWorkloadSeconds;
      workload.postWorkloadSamples = samples.filter((sample) =>
        sample.elapsedSeconds > workload.elapsedSeconds).length;
      if (postWorkloadSeconds < minimumPostWorkloadSeconds) {
        preflightFailures.push(
          `post-workload monitoring covers ${postWorkloadSeconds.toFixed(1)}s, expected >=${minimumPostWorkloadSeconds}s`,
        );
      }
    } catch (error) {
      preflightFailures.push(`invalid workload-finished marker: ${error.message}`);
    }
  }

  const evaluation = headroomEvaluation(
    samples,
    gateWindowSeconds,
    expectedMemoryBytes,
    expectedCpus,
    expectedSessions,
    expectedRunners,
    expectedMemberships,
    preflightFailures,
    expectedRuntime,
    durationSeconds,
    intervalSeconds,
    workload?.gateEndSeconds ?? null,
    {
      ...expectedRealtime,
      initialOwnedChatChannels: workload?.presencePlan?.initialOwnedChatChannels,
      forcedReconnectOwnedChatChannels:
        workload?.presencePlan?.forcedReconnectOwnedChatChannels,
    },
  );
  fs.appendFileSync(output, `${JSON.stringify({
    type: 'finish',
    observedAt: new Date().toISOString(),
    samples: sampleCount,
    probeSummary,
    uninstallError,
    workload,
    serverLogs,
    evaluation,
    containerState: finalContainerState,
  })}\n`);
  process.stdout.write(`[capacity-monitor] wrote ${sampleCount} samples and final probe summary to ${output}\n`);
  if (!evaluation.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(`[capacity-monitor] fatal: ${error.stack || error}`);
    process.exitCode = 1;
  });
}
