import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Certification input seam: immutable inputs, profiles, affinity, and option validation.
 * Evidence invariant: all source bytes and runtime parameters are hashed before phase one.
 */
export const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const root = path.resolve(here, '..');
export const certifiedImage = path.join(root, 'deploy', 'certified-image.mjs');
export const tools = Object.freeze({
  load: path.join(here, 'load.mjs'),
  marker: path.join(here, 'write-workload-marker.mjs'),
  monitor: path.join(here, 'monitor.mjs'),
  reconcile: path.join(here, 'reconcile-capacity.mjs'),
  runnerRestart: path.join(here, 'runner-restart-recovery.mjs'),
  sqliteLock: path.join(here, 'sqlite-lock-recovery.mjs'),
  soak: path.join(here, 'soak-invariants.mjs'),
});
export const stateName = '.certification-runner-state.json';
export const journalName = 'command-journal.jsonl';
export const manifestName = 'command-manifest.json';
export const scratchName = 'sqlite-snapshot-scratch';
export const minimumScratchBytes = 2 * 1024 ** 3;
export const finalPhases = Object.freeze([
  'preflight-main10k',
  'run-main10k',
  'reconcile-main10k',
  'preflight-faults',
  'run-faults',
  'freeze-faults',
  'preflight-soak5k',
  'run-soak5k',
  'freeze-soak5k',
  'certify',
]);
export const diagnosticPhases = Object.freeze([
  'preflight-diagnostic',
  'run-diagnostic',
  'freeze-diagnostic',
]);
export const profiles = Object.freeze({
  final10k: Object.freeze({
    phase: 'main10k', users: 10_000, usersPerShard: 2_500,
    rampSeconds: 300, soakSeconds: 1_860, reconnectAtSeconds: 600,
    monitorSeconds: 2_250, gateSeconds: 1_800, workloadSeconds: 2_160,
    chatRps: 6.25, readRps: 12.5, runRps: 0.25,
  }),
  diagnostic1k: Object.freeze({
    phase: 'diagnostic', users: 1_000, usersPerShard: 250,
    rampSeconds: 60, soakSeconds: 120, reconnectAtSeconds: 30,
    monitorSeconds: 320, gateSeconds: 60, workloadSeconds: 180,
    chatRps: 6.25, readRps: 12.5, runRps: 0.25,
  }),
});
export const loadThresholdArgs = Object.freeze([
  '--min-connect-success', '0.999',
  '--connect-p99-ms', '5000',
  '--max-http-error-rate', '0.001',
  '--http-read-p99-ms', '1000',
  '--http-write-p99-ms', '1000',
  '--event-p99-ms', '1000',
  '--min-reconnect-within10-success', '0.99',
  '--min-realtime-receipt-success', '0.999',
  '--min-realtime-run-completion-success', '0.999',
  '--min-workload-scheduled-ratio', '0.99',
  '--min-workload-attempted-ratio', '0.99',
  '--min-workload-completed-ratio', '0.999',
  '--min-workload-succeeded-ratio', '0.999',
]);

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseArgs(argv) {
  const result = { sourceIps: [] };
  const known = new Set([
    'profile', 'image', 'image-id', 'revision', 'source-database',
    'source-corpus-root', 'fixture', 'results-dir', 'source-ip',
    'soak-source-ip', 'fixture-prefix',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(key.startsWith('--') && known.has(key.slice(2)), `unsupported option ${key}`);
    invariant(value && !value.startsWith('--'), `${key} requires a value`);
    index += 1;
    const name = key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (name === 'sourceIp') result.sourceIps.push(value);
    else {
      invariant(result[name] == null, `${key} may only be supplied once`);
      result[name] = value;
    }
  }
  return result;
}

export function canonicalPath(filename, kind) {
  const resolved = path.resolve(String(filename || ''));
  const metadata = fs.lstatSync(resolved);
  invariant(!metadata.isSymbolicLink(), `${kind} must not be a symbolic link`);
  if (kind.endsWith('root')) invariant(metadata.isDirectory(), `${kind} must be a directory`);
  else invariant(metadata.isFile(), `${kind} must be a regular file`);
  invariant(fs.realpathSync(resolved) === resolved, `${kind} must be canonical`);
  return resolved;
}

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function fileEvidence(filename) {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(descriptor);
    invariant(metadata.isFile(), `frozen input is not a regular file: ${filename}`);
    const bytes = fs.readFileSync(descriptor);
    return {
      path: filename,
      sha256: sha256(bytes),
      bytes: metadata.size,
      device: String(metadata.dev),
      inode: String(metadata.ino),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function treeEvidence(directory) {
  const entries = [];
  let bytes = 0;
  const visit = (current, relative = '') => {
    const names = fs.readdirSync(current).sort();
    for (const name of names) {
      const absolute = path.join(current, name);
      const child = relative ? `${relative}/${name}` : name;
      const metadata = fs.lstatSync(absolute);
      invariant(!metadata.isSymbolicLink(), `frozen corpus contains a symbolic link: ${child}`);
      if (metadata.isDirectory()) {
        entries.push(`d\0${child}\0${metadata.mode & 0o777}\n`);
        visit(absolute, child);
      } else {
        invariant(metadata.isFile(), `frozen corpus contains a special file: ${child}`);
        const contents = fs.readFileSync(absolute);
        bytes += contents.byteLength;
        entries.push(`f\0${child}\0${metadata.mode & 0o777}\0${contents.byteLength}\0${sha256(contents)}\n`);
      }
    }
  };
  visit(directory);
  return { path: directory, sha256: sha256(entries.join('')), bytes, entries: entries.length };
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

export function normalizedCpuSet(specification) {
  const cpus = [];
  invariant(/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(specification || ''),
    `invalid CPU affinity ${specification || 'missing'}`);
  for (const segment of specification.split(',')) {
    const [firstText, lastText = firstText] = segment.split('-');
    const first = Number(firstText);
    const last = Number(lastText);
    invariant(first <= last, `invalid CPU affinity segment ${segment}`);
    for (let cpu = first; cpu <= last; cpu += 1) cpus.push(cpu);
  }
  return [...new Set(cpus)].sort((left, right) => left - right).join(',');
}

export function processAffinity(pid = process.pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = status.match(/^Cpus_allowed_list:\s*(.+)$/mu);
  invariant(match, `could not read CPU affinity for PID ${pid}`);
  return { raw: match[1].trim(), normalized: normalizedCpuSet(match[1].trim()) };
}

export function validateAffinity() {
  invariant(process.env.CASCADE_CAPACITY_AFFINITY_BOUND === '1',
    'certification runner must be entered through the capacity affinity wrapper');
  const requested = normalizedCpuSet(process.env.CASCADE_CAPACITY_GENERATOR_CPUSET || '');
  const actual = processAffinity();
  invariant(actual.normalized === requested, 'certification runner affinity differs from the wrapper boundary');
  invariant(!requested.split(',').some((cpu) => cpu === '0' || cpu === '1'),
    'certification runner affinity includes candidate CPUs 0-1');
  return actual;
}

export function validateOptions(raw) {
  invariant(profiles[raw.profile], '--profile must be diagnostic1k or final10k');
  invariant(/^sha256:[a-f0-9]{64}$/u.test(raw.imageId || ''), '--image-id must be immutable sha256');
  invariant(/^[a-f0-9]{40}$/u.test(raw.revision || ''), '--revision must be a full Git revision');
  invariant(raw.sourceIps.length === 4 && new Set(raw.sourceIps).size === 4
    && raw.sourceIps.every((address) => net.isIP(address) !== 0),
  'exactly four distinct valid --source-ip values are required');
  if (raw.profile === 'final10k') {
    invariant(raw.image === `cascade:certified-${raw.revision}`,
      '--image must be the canonical immutable-revision tag');
    invariant(net.isIP(raw.soakSourceIp || '') !== 0, '--soak-source-ip is required');
  } else {
    invariant(!raw.image && !raw.soakSourceIp,
      'diagnostic1k cannot accept final image certification or soak options');
  }
  invariant(/^[a-z][a-z0-9_-]{2,30}$/u.test(raw.fixturePrefix || 'capacity'),
    '--fixture-prefix is invalid');
  const resultsDir = path.resolve(String(raw.resultsDir || ''));
  invariant(path.isAbsolute(String(raw.resultsDir || '')) && resultsDir !== '/',
    '--results-dir must be an absolute non-root path');
  const resultsParent = path.dirname(resultsDir);
  const resultsParentMetadata = fs.lstatSync(resultsParent);
  invariant(resultsParentMetadata.isDirectory() && !resultsParentMetadata.isSymbolicLink()
    && fs.realpathSync(resultsParent) === resultsParent,
  '--results-dir parent must be a real canonical directory');
  return {
    profile: raw.profile,
    image: raw.image || null,
    imageId: raw.imageId,
    revision: raw.revision,
    sourceDatabase: canonicalPath(raw.sourceDatabase, 'source database'),
    sourceCorpusRoot: canonicalPath(raw.sourceCorpusRoot, 'source corpus root'),
    fixture: canonicalPath(raw.fixture, 'fixture'),
    resultsDir,
    sourceIps: raw.sourceIps,
    soakSourceIp: raw.soakSourceIp || null,
    fixturePrefix: raw.fixturePrefix || 'capacity',
  };
}

export function inputEvidence(options) {
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${options.sourceDatabase}${suffix}`),
      `approved source database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  return {
    sourceDatabase: fileEvidence(options.sourceDatabase),
    sourceCorpus: treeEvidence(options.sourceCorpusRoot),
    fixture: fileEvidence(options.fixture),
    controller: fileEvidence(path.join(here, 'certification-runner.mjs')),
    certifier: fileEvidence(certifiedImage),
    tools: Object.fromEntries(Object.entries(tools).map(([name, filename]) => [name, fileEvidence(filename)])),
    configurationSha256: sha256(stableJson({
      profile: options.profile,
      image: options.image,
      imageId: options.imageId,
      revision: options.revision,
      sourceIps: options.sourceIps,
      soakSourceIp: options.soakSourceIp,
      fixturePrefix: options.fixturePrefix,
      fixedProfile: profiles[options.profile],
      loadThresholdArgs,
    })),
  };
}
