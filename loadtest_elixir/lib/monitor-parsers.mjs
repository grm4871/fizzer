import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Monitor parser seam: Docker/cgroup readers and server-log evidence.
 * Evidence invariant: parser failures are represented explicitly, never mistaken for zero errors.
 */
export function parseArgs(argv) {
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

export function numberOption(args, key, fallback, min = 0) {
  const value = args[key] == null ? fallback : Number(args[key]);
  if (!Number.isFinite(value) || value < min) throw new Error(`--${key} must be >= ${min}`);
  return value;
}

export function booleanOption(args, key, fallback) {
  if (args[key] == null) return fallback;
  if (args[key] === true || args[key] === 'true') return true;
  if (args[key] === 'false') return false;
  throw new Error(`--${key} must be true or false`);
}

export function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim();
}

export function docker(...args) {
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

export function captureServerLogs(container, baselineCursor, finishCursor, output) {
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

export function dockerJson(args) {
  return JSON.parse(docker(...args));
}

export function releaseRpc(container, expression) {
  return docker('exec', container, '/app/release/bin/cascade_elixir', 'rpc', expression);
}

export function parseLastJson(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* keep searching */ }
  }
  throw new Error(`RPC did not return JSON: ${output.slice(-500)}`);
}

export function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

export function readNumber(file) {
  const value = Number(readText(file));
  return Number.isFinite(value) ? value : null;
}

export function parseKeyValues(raw) {
  if (!raw) return {};
  return Object.fromEntries(raw.split(/\r?\n/).flatMap((line) => {
    const [key, value] = line.trim().split(/\s+/, 2);
    return key && value != null ? [[key, Number(value)]] : [];
  }));
}

export function cgroupPath(pid) {
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

export function cpuLimit(hostConfig) {
  if (hostConfig.NanoCpus > 0) return hostConfig.NanoCpus / 1_000_000_000;
  return cpuSetCount(hostConfig.CpusetCpus) || null;
}

export function nofileLimit(hostConfig) {
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

export function maxFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}
