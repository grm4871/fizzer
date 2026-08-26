import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { docker, readText, readNumber, parseKeyValues } from './monitor-parsers.mjs';
import { validateWorkloadResults } from './monitor-headroom.mjs';

/**
 * Monitor artifact seam: workload markers, identity, and final cgroup snapshots.
 * Evidence invariant: artifact checksums and container identity are validated before acceptance.
 */
export function readWorkloadMarker(
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

export function beamOpenFiles(cgroup) {
  if (!cgroup) return null;
  const pids = (readText(path.join(cgroup, 'cgroup.procs')) || '').split(/\s+/).filter(Boolean);
  for (const pid of pids) {
    if (readText(`/proc/${pid}/comm`) === 'beam.smp') {
      try { return { pid: Number(pid), count: fs.readdirSync(`/proc/${pid}/fd`).length }; } catch { return null; }
    }
  }
  return null;
}

export function containerBeamOpenFiles(container) {
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

export function parsePercent(value) {
  const result = Number(String(value || '').replace(/%$/, ''));
  return Number.isFinite(result) ? result : null;
}

export function cgroupSnapshot(cgroup) {
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

