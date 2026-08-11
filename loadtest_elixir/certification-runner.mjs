#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const certifiedImage = path.join(root, 'deploy', 'certified-image.mjs');
const tools = Object.freeze({
  load: path.join(here, 'load.mjs'),
  marker: path.join(here, 'write-workload-marker.mjs'),
  monitor: path.join(here, 'monitor.mjs'),
  reconcile: path.join(here, 'reconcile-capacity.mjs'),
  runnerRestart: path.join(here, 'runner-restart-recovery.mjs'),
  sqliteLock: path.join(here, 'sqlite-lock-recovery.mjs'),
  soak: path.join(here, 'soak-invariants.mjs'),
});
const stateName = '.certification-runner-state.json';
const journalName = 'command-journal.jsonl';
const manifestName = 'command-manifest.json';
const scratchName = 'sqlite-snapshot-scratch';
const minimumScratchBytes = 2 * 1024 ** 3;
const finalPhases = Object.freeze([
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
const diagnosticPhases = Object.freeze([
  'preflight-diagnostic',
  'run-diagnostic',
  'freeze-diagnostic',
]);
const profiles = Object.freeze({
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
const loadThresholdArgs = Object.freeze([
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

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
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

function canonicalPath(filename, kind) {
  const resolved = path.resolve(String(filename || ''));
  const metadata = fs.lstatSync(resolved);
  invariant(!metadata.isSymbolicLink(), `${kind} must not be a symbolic link`);
  if (kind.endsWith('root')) invariant(metadata.isDirectory(), `${kind} must be a directory`);
  else invariant(metadata.isFile(), `${kind} must be a regular file`);
  invariant(fs.realpathSync(resolved) === resolved, `${kind} must be canonical`);
  return resolved;
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function fileEvidence(filename) {
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

function treeEvidence(directory) {
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

function normalizedCpuSet(specification) {
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

function processAffinity(pid = process.pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = status.match(/^Cpus_allowed_list:\s*(.+)$/mu);
  invariant(match, `could not read CPU affinity for PID ${pid}`);
  return { raw: match[1].trim(), normalized: normalizedCpuSet(match[1].trim()) };
}

function validateAffinity() {
  invariant(process.env.CASCADE_CAPACITY_AFFINITY_BOUND === '1',
    'certification runner must be entered through the capacity affinity wrapper');
  const requested = normalizedCpuSet(process.env.CASCADE_CAPACITY_GENERATOR_CPUSET || '');
  const actual = processAffinity();
  invariant(actual.normalized === requested, 'certification runner affinity differs from the wrapper boundary');
  invariant(!requested.split(',').some((cpu) => cpu === '0' || cpu === '1'),
    'certification runner affinity includes candidate CPUs 0-1');
  return actual;
}

function validateOptions(raw) {
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

function inputEvidence(options) {
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${options.sourceDatabase}${suffix}`),
      `approved source database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  return {
    sourceDatabase: fileEvidence(options.sourceDatabase),
    sourceCorpus: treeEvidence(options.sourceCorpusRoot),
    fixture: fileEvidence(options.fixture),
    controller: fileEvidence(fileURLToPath(import.meta.url)),
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

function writeExclusiveJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
}

function atomicState(filename, value) {
  if (fs.existsSync(filename)) {
    const metadata = fs.lstatSync(filename);
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), 'runner state is not a regular file');
  }
  const temporary = `${filename}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  fs.renameSync(temporary, filename);
}

function readJson(filename, label) {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(descriptor);
    invariant(metadata.isFile(), `${label} is not a regular file`);
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally {
    fs.closeSync(descriptor);
  }
}

function currentPhase() {
  const phase = process.env.CASCADE_CAPACITY_PHASE || '';
  invariant(phase, 'certification runner may run only inside capacity-run.sh');
  invariant(/^[a-f0-9]{64}$/u.test(process.env.CASCADE_CAPACITY_CONTAINER_ID || ''),
    'capacity wrapper did not provide an immutable container ID');
  invariant(/^cascade-elixir-capacity(?:-[a-zA-Z0-9_.-]+)?$/u.test(
    process.env.CASCADE_CAPACITY_CONTAINER_NAME || '',
  ), 'capacity wrapper did not provide a reserved container name');
  invariant(/^http:\/\/127\.0\.0\.1:\d+$/u.test(process.env.CASCADE_CAPACITY_TARGET || ''),
    'capacity wrapper target must be an isolated loopback candidate');
  const dataDir = path.resolve(process.env.CASCADE_CAPACITY_DATA_DIR || '');
  invariant(dataDir !== '/' && fs.statSync(dataDir).isDirectory(), 'capacity wrapper data root is invalid');
  return {
    phase,
    containerId: process.env.CASCADE_CAPACITY_CONTAINER_ID,
    containerName: process.env.CASCADE_CAPACITY_CONTAINER_NAME,
    target: process.env.CASCADE_CAPACITY_TARGET,
    dataDir,
    createdAt: process.env.CASCADE_CAPACITY_CONTAINER_CREATED_AT || null,
    startedAt: process.env.CASCADE_CAPACITY_CONTAINER_STARTED_AT || null,
    stoppedAt: process.env.CASCADE_CAPACITY_CONTAINER_STOPPED_AT || null,
    databaseSha256: process.env.CASCADE_CAPACITY_DATABASE_SHA256 || null,
    databaseDeviceInode: process.env.CASCADE_CAPACITY_DATABASE_DEVICE_INODE || null,
    databaseFrozenAt: process.env.CASCADE_CAPACITY_DATABASE_FROZEN_AT || null,
  };
}

function validateRunRoots(options, phase) {
  const candidates = [
    phase.dataDir,
    process.env.CASCADE_CAPACITY_10K_DATA_DIR,
    process.env.CASCADE_CAPACITY_FAULT_DATA_DIR,
    process.env.CASCADE_CAPACITY_SOAK_DATA_DIR,
  ].filter(Boolean).map((directory) => path.resolve(directory));
  for (const dataRoot of new Set(candidates)) {
    invariant(options.resultsDir !== dataRoot
      && !options.resultsDir.startsWith(`${dataRoot}${path.sep}`)
      && !dataRoot.startsWith(`${options.resultsDir}${path.sep}`),
    'results/evidence root must be disjoint from every mutable capacity data root');
  }
}

function initializeOrLoad(options, phase, affinity) {
  const phaseSequence = options.profile === 'final10k' ? finalPhases : diagnosticPhases;
  invariant(phaseSequence.includes(phase.phase),
    `${options.profile} cannot execute wrapper phase ${phase.phase}`);
  const stateFile = path.join(options.resultsDir, stateName);
  const journalFile = path.join(options.resultsDir, journalName);
  if (phase.phase === phaseSequence[0]) {
    invariant(!fs.existsSync(options.resultsDir), `results directory must be fresh and absent: ${options.resultsDir}`);
    const inputs = inputEvidence(options);
    fs.mkdirSync(options.resultsDir, { mode: 0o700 });
    fs.writeFileSync(journalFile, '', { mode: 0o600, flag: 'wx' });
    const scratchDirectory = path.join(options.resultsDir, scratchName);
    fs.mkdirSync(scratchDirectory, { mode: 0o700 });
    const scratchMetadata = fs.lstatSync(scratchDirectory);
    const state = {
      schemaVersion: 1,
      type: 'cascade-capacity-controller-state',
      profile: options.profile,
      options,
      affinity,
      inputs,
      scratch: {
        path: scratchDirectory,
        device: String(scratchMetadata.dev),
        inode: String(scratchMetadata.ino),
      },
      completed: [],
      containers: {},
      createdAt: new Date().toISOString(),
    };
    atomicState(stateFile, state);
    return { state, stateFile, journalFile, phaseSequence };
  }
  invariant(fs.realpathSync(options.resultsDir) === options.resultsDir,
    'results directory identity changed');
  const state = readJson(stateFile, 'runner state');
  invariant(state.schemaVersion === 1 && state.type === 'cascade-capacity-controller-state',
    'runner state schema is invalid');
  invariant(stableJson(state.options) === stableJson(options), 'controller options changed between phases');
  invariant(stableJson(state.inputs) === stableJson(inputEvidence(options)),
    'frozen source, fixture, controller, or configuration inputs changed between phases');
  invariant(stableJson(state.affinity) === stableJson(affinity), 'controller affinity changed between phases');
  return { state, stateFile, journalFile, phaseSequence };
}

let activeScratch = null;

function validateScratch(state) {
  const scratch = state.scratch;
  invariant(scratch?.path === path.join(state.options.resultsDir, scratchName),
    'SQLite scratch path escaped the locked results root');
  const metadata = fs.lstatSync(scratch.path);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink()
    && metadata.uid === process.getuid() && (metadata.mode & 0o777) === 0o700,
  'SQLite scratch must be a real owned mode-0700 directory');
  invariant(String(metadata.dev) === scratch.device && String(metadata.ino) === scratch.inode,
    'SQLite scratch directory identity changed between phases');
  activeScratch = scratch;
  const filesystem = fs.statfsSync(scratch.path);
  const filesystemType = BigInt.asUintN(64, BigInt(filesystem.type));
  invariant(filesystemType !== 0x01021994n && filesystemType !== 0x858458f6n,
    'SQLite scratch must be on disk-backed storage, not tmpfs or ramfs');
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  invariant(Number.isSafeInteger(freeBytes) && freeBytes >= minimumScratchBytes,
    `SQLite scratch has ${freeBytes} free bytes, expected at least ${minimumScratchBytes}`);
  return { ...scratch, freeBytes };
}

function assertScratchEmpty(scratch) {
  invariant(fs.readdirSync(scratch.path).length === 0,
    'SQLite comparator left files in the owned scratch directory');
}

function cleanupScratch({ requireEmpty = false } = {}) {
  if (!activeScratch) return;
  const scratch = activeScratch;
  activeScratch = null;
  let metadata;
  try { metadata = fs.lstatSync(scratch.path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink()
    && String(metadata.dev) === scratch.device && String(metadata.ino) === scratch.inode,
  'refusing cleanup because SQLite scratch ownership identity changed');
  if (requireEmpty) assertScratchEmpty(scratch);
  fs.rmSync(scratch.path, { recursive: true });
}

function appendJournal(filename, record) {
  const priorLines = fs.readFileSync(filename, 'utf8').split(/\r?\n/u).filter(Boolean);
  const priorDigest = priorLines.length ? JSON.parse(priorLines.at(-1)).digest : '0'.repeat(64);
  const body = { ...record, priorDigest };
  const entry = { ...body, digest: sha256(stableJson(body)) };
  const descriptor = fs.openSync(filename,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  try { fs.writeSync(descriptor, `${JSON.stringify(entry)}\n`); } finally { fs.closeSync(descriptor); }
  return entry;
}

const activeChildren = new Set();

function childCommand(command, args) {
  const fake = process.env.CASCADE_CAPACITY_TESTING === '1'
    ? process.env.CASCADE_CAPACITY_TEST_COMMAND
    : '';
  return fake ? { command: fake, args: [command, ...args] } : { command, args };
}

function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION|CREDENTIAL)/iu.test(name)));
}

async function spawnTracked(context, command, args, label) {
  invariant(!args.some((value) => /(?:^|[._-])(?:token|secret|password|cookie)(?:$|[._-])/iu.test(value)),
    `secret-bearing argument is forbidden for ${label}`);
  const actual = childCommand(command, args);
  const child = spawn(actual.command, actual.args, {
    cwd: root,
    env: childEnvironment(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  let affinity;
  try {
    affinity = processAffinity(child.pid);
    invariant(affinity.normalized === context.affinity.normalized,
      `${label} PID ${child.pid} escaped controller CPU affinity`);
  } catch (error) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ }
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
    throw error;
  }
  const startedAt = new Date().toISOString();
  const started = appendJournal(context.journalFile, {
    type: 'command-start', phase: context.phase.phase, label,
    command, argv: args, pid: child.pid, affinity, startedAt,
  });
  let stdout = '';
  let stderr = '';
  const retain = (prior, chunk) => `${prior}${chunk}`.slice(-4 * 1024 * 1024);
  child.stdout.on('data', (chunk) => { stdout = retain(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = retain(stderr, chunk); });
  const handle = {
    child, pid: child.pid, label, started, stdout: () => stdout, stderr: () => stderr,
    exit: new Promise((resolve) => child.once('exit', (status, signal) => {
      activeChildren.delete(handle);
      const finishedAt = new Date().toISOString();
      appendJournal(context.journalFile, {
        type: 'command-finish', phase: context.phase.phase, label,
        pid: child.pid, startDigest: started.digest, status, signal, finishedAt,
      });
      resolve({ status, signal, stdout, stderr, finishedAt });
    })),
  };
  activeChildren.add(handle);
  return handle;
}

async function waitPassed(handle) {
  const result = await handle.exit;
  invariant(result.status === 0 && !result.signal,
    `${handle.label} failed (${result.signal || result.status}): ${result.stderr.trim().slice(-2_000)}`);
  return result;
}

async function runCommand(context, command, args, label) {
  return waitPassed(await spawnTracked(context, command, args, label));
}

async function terminateChildren(signal = 'SIGTERM') {
  const handles = [...activeChildren];
  for (const handle of handles) {
    try { process.kill(-handle.pid, signal); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  if (!handles.length) return;
  let timer;
  await Promise.race([
    Promise.allSettled(handles.map((handle) => handle.exit)),
    new Promise((resolve) => { timer = setTimeout(resolve, 5_000); }),
  ]);
  clearTimeout(timer);
  for (const handle of [...activeChildren]) {
    try { process.kill(-handle.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  await Promise.allSettled(handles.map((handle) => handle.exit));
}

function output(options, name) {
  return path.join(options.resultsDir, name);
}

function preflightPath(options, phase) {
  return output(options, `fixture-preflight-${phase}.json`);
}

function freezePath(options, phase) {
  return output(options, `freeze-${phase}.json`);
}

function assertArtifactAbsent(filename) {
  invariant(!fs.existsSync(filename), `artifact must be fresh and absent: ${filename}`);
}

function readPassingArtifact(filename, type, phase = null) {
  const result = readJson(filename, path.basename(filename));
  if (type) invariant(result.type === type, `${filename} has the wrong artifact type`);
  if (phase) invariant(result.phase === phase, `${filename} has the wrong phase`);
  if (result.evaluation) invariant(result.evaluation.ok === true, `${filename} did not pass`);
  return result;
}

async function runPreflight(context, phaseName, profileName) {
  const filename = preflightPath(context.options, phaseName);
  assertArtifactAbsent(filename);
  await runCommand(context, process.execPath, [
    certifiedImage, 'preflight',
    '--phase', phaseName,
    '--profile', profileName,
    '--container', context.phase.containerId,
    '--source-database', context.options.sourceDatabase,
    '--source-corpus-root', context.options.sourceCorpusRoot,
    '--fixture', context.options.fixture,
    '--scratch-directory', context.scratch.path,
    '--output', filename,
  ], `preflight-${phaseName}`);
  const result = readPassingArtifact(filename, 'cascade-capacity-fixture-preflight', phaseName);
  invariant(result.profile === profileName && result.containerId === context.phase.containerId
    && result.imageId === context.options.imageId,
  `${phaseName} preflight identity differs from the wrapper candidate`);
}

function parseSha256sum(raw, label) {
  const match = raw.trim().match(/^([a-f0-9]{64})\s+/u);
  invariant(match, `${label} did not return one SHA-256 digest`);
  return match[1];
}

async function writeRuntimeProof(context) {
  const filename = output(context.options, 'runtime-proof.json');
  assertArtifactAbsent(filename);
  const id = context.phase.containerId;
  const gate = await runCommand(context, 'docker', [
    'exec', id, '/app/release/bin/cascade_elixir', 'eval',
    'if CascadeWeb.RouteCatalog.swap_ready?(), do: IO.puts("swap-ready"), else: System.halt(42)',
  ], 'embedded-swap-ready');
  invariant(gate.stdout.trim().split(/\r?\n/u).at(-1) === 'swap-ready',
    'embedded swap gate did not print swap-ready');
  const load = await runCommand(context, 'docker', [
    'exec', id, 'sha256sum', '/app/loadtest_elixir/load.mjs',
  ], 'embedded-load-driver-sha256');
  const reconciliation = await runCommand(context, 'docker', [
    'exec', id, 'sha256sum', '/app/loadtest_elixir/reconcile-capacity.mjs',
  ], 'embedded-reconciliation-driver-sha256');
  const embedded = {
    loadDriverSha256: parseSha256sum(load.stdout, 'embedded load driver'),
    reconciliationDriverSha256: parseSha256sum(
      reconciliation.stdout, 'embedded reconciliation driver',
    ),
  };
  invariant(embedded.loadDriverSha256 === context.state.inputs.tools.load.sha256
    && embedded.reconciliationDriverSha256 === context.state.inputs.tools.reconcile.sha256,
  'embedded workload drivers differ from the frozen host inputs');
  writeExclusiveJson(filename, {
    schemaVersion: 1,
    type: 'cascade-owned-runtime-proof',
    phase: 'main10k',
    profile: 'final10k',
    imageId: context.options.imageId,
    containerId: id,
    revision: context.options.revision,
    executedAt: new Date().toISOString(),
    swapReady: true,
    embedded,
  });
}

function loadArgs(context, profile, shardIndex, filename) {
  return [
    tools.load,
    '--target', context.phase.target,
    '--fixtures', context.options.fixture,
    '--users', String(profile.usersPerShard),
    '--shard-index', String(shardIndex),
    '--shard-count', '4',
    '--ramp-seconds', String(profile.rampSeconds),
    '--soak-seconds', String(profile.soakSeconds),
    '--chat-rps', String(profile.chatRps),
    '--read-rps', String(profile.readRps),
    '--run-rps', String(profile.runRps),
    '--source-ip', context.options.sourceIps[shardIndex],
    '--polling-percent', '5',
    '--reconnect-percent', '10',
    '--reconnect-at-seconds', String(profile.reconnectAtSeconds),
    ...loadThresholdArgs,
    '--output', filename,
  ];
}

function monitorArgs(context, profile, marker, monitor) {
  return [
    tools.monitor,
    '--container', context.phase.containerId,
    '--output', monitor,
    '--server-log-output', `${monitor}.container.log`,
    '--duration-seconds', String(profile.monitorSeconds),
    '--gate-window-seconds', String(profile.gateSeconds),
    '--expected-image', context.options.imageId,
    '--expected-cpus', '2',
    '--expected-memory-gib', '3',
    '--expected-sessions', String(profile.users),
    '--expected-runners', String(profile.users),
    '--expected-memberships', String(profile.users * 5),
    '--expected-sqlite-pool-size', '20',
    '--workload-finished-marker', marker,
    '--minimum-workload-seconds', String(profile.workloadSeconds),
    '--minimum-post-workload-seconds', '30',
    '--expected-load-target', context.phase.target,
    '--expected-shard-count', '4',
    '--expected-ramp-seconds', String(profile.rampSeconds),
    '--expected-soak-seconds', String(profile.soakSeconds),
    '--expected-polling-percent', '5',
    '--expected-reconnect-percent', '10',
    '--expected-reconnect-at-seconds', String(profile.reconnectAtSeconds),
    '--expected-source-ips', context.options.sourceIps.join(','),
    '--expected-chat-rps', String(profile.chatRps),
    '--expected-read-rps', String(profile.readRps),
    '--expected-run-rps', String(profile.runRps),
    '--expected-http-acceptors', '4',
    '--expected-http-max-connections', '32768',
    '--expected-http-backlog', '65535',
    '--expected-network-mode', 'true',
    '--expected-trust-proxy-hops', '1',
    '--expected-qmd-worker-enabled', 'true',
    '--expected-realtime-hibernate-after-ms', '5000',
    '--expected-runner-orphan-reclaim-ms', '600000',
    '--expected-sqlite-busy-timeout-ms', '5000',
    '--interval-seconds', '5',
  ];
}

async function waitForMonitorStart(handle, filename, context, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filename)) {
      const first = fs.readFileSync(filename, 'utf8').split(/\r?\n/u).find(Boolean);
      if (first) {
        const start = JSON.parse(first);
        invariant(start.type === 'start' && start.containerId === context.phase.containerId
          && start.imageId === context.options.imageId,
        'monitor start identity differs from the owned main candidate');
        invariant(Array.isArray(start.preflightFailures) && start.preflightFailures.length === 0,
          `monitor preflight failed: ${(start.preflightFailures || []).join('; ')}`);
        return;
      }
    }
    const exited = await Promise.race([
      handle.exit.then((result) => result),
      new Promise((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (exited) throw new Error(`monitor exited before readiness: ${exited.stderr}`);
  }
  throw new Error('monitor did not produce a valid start record within 60 seconds');
}

function validateLoadResult(filename, profile, index, sourceIp, fixtureSha256, loadDriverSha256) {
  const result = readPassingArtifact(filename, null);
  invariant(result.shard?.index === index && result.shard?.count === 4,
    `load shard ${index} identity is invalid`);
  invariant(result.requestedUsers === profile.usersPerShard
    && result.rampSeconds === profile.rampSeconds
    && result.soakSeconds === profile.soakSeconds
    && result.pollingPercent === 5 && result.reconnectPercent === 10
    && result.reconnectAtSeconds === profile.reconnectAtSeconds
    && result.rates?.chatRps === profile.chatRps
    && result.rates?.readRps === profile.readRps
    && result.rates?.runRps === profile.runRps
    && result.selectionPlan?.forcedReconnectStrategy === 'owner-stratified-v1'
    && result.presencePlan?.strategy === 'owner-stratified-v1',
  `load shard ${index} differs from the fixed ${profile.users}-user profile`);
  invariant(result.sourceIp === sourceIp
    && result.provenance?.fixtureSha256 === fixtureSha256
    && result.provenance?.loadDriverSha256 === loadDriverSha256,
    `load shard ${index} provenance is missing`);
}

function validateMonitorFinish(filename) {
  const records = fs.readFileSync(filename, 'utf8').split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line));
  const finish = records.findLast((record) => record.type === 'finish');
  invariant(finish?.evaluation?.ok === true, 'capacity monitor did not pass');
}

async function runShardedProfile(context, profile) {
  const prefix = context.options.profile === 'final10k' ? '' : 'diagnostic-';
  const monitor = output(context.options, `${prefix}monitor.jsonl`);
  const marker = output(context.options, `${prefix}workload-finished.json`);
  const shards = Array.from({ length: 4 }, (_unused, index) =>
    output(context.options, `${prefix}shard-${index}.json`));
  for (const filename of [monitor, `${monitor}.container.log`, marker, ...shards]) {
    assertArtifactAbsent(filename);
  }
  const monitorHandle = await spawnTracked(
    context, process.execPath, monitorArgs(context, profile, marker, monitor), `${prefix}monitor`,
  );
  await waitForMonitorStart(monitorHandle, monitor, context);
  const shardHandles = await Promise.all(shards.map((filename, index) =>
    spawnTracked(context, process.execPath, loadArgs(context, profile, index, filename),
      `${prefix}load-shard-${index}`)));
  const shardResults = await Promise.all(shardHandles.map((handle) => handle.exit));
  const shardFailures = shardResults.flatMap((result, index) => (
    result.status === 0 && !result.signal ? [] : [`shard ${index}: ${result.stderr.trim()}`]
  ));
  invariant(shardFailures.length === 0, `load shards failed: ${shardFailures.join('; ')}`);
  shards.forEach((filename, index) => validateLoadResult(
    filename, profile, index, context.options.sourceIps[index],
    context.state.inputs.fixture.sha256, context.state.inputs.tools.load.sha256,
  ));
  await runCommand(context, process.execPath, [
    tools.marker, '--output', marker, '--expected-shards', '4',
    ...shards.flatMap((filename) => ['--shard', filename]),
  ], `${prefix}workload-marker`);
  await waitPassed(monitorHandle);
  validateMonitorFinish(monitor);
}

async function runReconciliationAndFreeze(context) {
  invariant(context.phase.databaseSha256 && context.phase.databaseDeviceInode
    && context.phase.databaseFrozenAt && context.phase.stoppedAt,
  'main10k reconciliation requires the wrapper stopped/checkpointed boundary');
  const preflight = readPassingArtifact(
    preflightPath(context.options, 'main10k'), 'cascade-capacity-fixture-preflight', 'main10k',
  );
  const shards = Array.from({ length: 4 }, (_unused, index) => output(context.options, `shard-${index}.json`));
  const reconciliation = output(context.options, 'reconciliation.json');
  assertArtifactAbsent(reconciliation);
  await runCommand(context, process.execPath, [
    tools.reconcile,
    '--database', path.join(context.phase.dataDir, 'docs.db'),
    '--output', reconciliation,
    '--fixture-prefix', context.options.fixturePrefix,
    '--expected-shards', '4',
    '--shards', shards.join(','),
    '--expected-users', String(preflight.baseline.users),
    '--expected-vaults', String(preflight.baseline.vaults),
    '--expected-memberships', String(preflight.baseline.memberships),
    '--expected-channels', String(preflight.identity.groups),
    '--baseline-max-run-id', String(preflight.baseline.maxRunId),
  ], 'main10k-reconciliation');
  readPassingArtifact(reconciliation, 'cascade-capacity-reconciliation');
  await runFreeze(context, 'main10k');
}

async function runFreeze(context, phaseName) {
  invariant(context.phase.databaseSha256 && context.phase.databaseDeviceInode
    && context.phase.databaseFrozenAt && context.phase.stoppedAt,
  `${phaseName} freeze requires the wrapper stopped/checkpointed boundary`);
  const filename = freezePath(context.options, phaseName);
  assertArtifactAbsent(filename);
  await runCommand(context, process.execPath, [
    certifiedImage, 'freeze',
    '--container', context.phase.containerId,
    '--source-database', context.options.sourceDatabase,
    '--source-corpus-root', context.options.sourceCorpusRoot,
    '--fixture', context.options.fixture,
    '--preflight', preflightPath(context.options, phaseName),
    '--scratch-directory', context.scratch.path,
    '--output', filename,
  ], `freeze-${phaseName}`);
  const result = readPassingArtifact(filename, 'cascade-capacity-phase-freeze', phaseName);
  invariant(result.containerId === context.phase.containerId
    && result.imageId === context.options.imageId
    && result.databaseSha256 === context.phase.databaseSha256
    && `${result.databaseDevice}:${result.databaseInode}` === context.phase.databaseDeviceInode,
  `${phaseName} freeze differs from the wrapper-owned database boundary`);
  invariant(Date.parse(result.frozenAt) >= Date.parse(context.phase.databaseFrozenAt),
    `${phaseName} certification freeze predates the wrapper checkpoint`);
  context.phase.databaseFrozenAt = result.frozenAt;
}

async function runFaults(context) {
  const restart = output(context.options, 'runner-restart.json');
  const lock = output(context.options, 'sqlite-lock.json');
  assertArtifactAbsent(restart);
  assertArtifactAbsent(lock);
  await runCommand(context, process.execPath, [
    tools.runnerRestart,
    '--target', context.phase.target,
    '--fixtures', context.options.fixture,
    '--container', context.phase.containerId,
    '--output', restart,
  ], 'runner-restart-recovery');
  readPassingArtifact(restart, 'cascade-fault-recovery');
  await runCommand(context, process.execPath, [
    tools.sqliteLock,
    '--target', context.phase.target,
    '--fixtures', context.options.fixture,
    '--container', context.phase.containerId,
    '--db-path', path.join(context.phase.dataDir, 'docs.db'),
    '--output', lock,
  ], 'sqlite-lock-recovery');
  readPassingArtifact(lock, 'cascade-fault-recovery');
}

async function runSoak(context) {
  const soak = output(context.options, 'soak-invariants.json');
  assertArtifactAbsent(soak);
  await runCommand(context, process.execPath, [
    tools.soak,
    '--target', context.phase.target,
    '--fixtures', context.options.fixture,
    '--container', context.phase.containerId,
    '--output', soak,
    '--expected-image', context.options.imageId,
    '--expected-revision', context.options.revision,
    '--source-ip', context.options.soakSourceIp,
    '--users', '5000',
    '--ramp-seconds', '300',
    '--soak-seconds', '7200',
    '--churn-interval-seconds', '300',
    '--churn-percent', '10',
    '--run-rps', '1',
    '--sample-interval-seconds', '5',
    '--recovery-timeout-seconds', '180',
    '--recovery-consecutive-samples', '3',
  ], 'soak5k-two-hour');
  readPassingArtifact(soak, 'cascade-elixir-two-hour-soak-invariants');
}

function artifactEvidence(directory) {
  return fs.readdirSync(directory).sort().flatMap((name) => {
    if ([stateName, journalName, manifestName, scratchName].includes(name) || name.endsWith('.tmp')) return [];
    const filename = path.join(directory, name);
    const metadata = fs.lstatSync(filename);
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), `result artifact is not regular: ${name}`);
    return [[name, fileEvidence(filename)]];
  });
}

function validateJournal(filename) {
  const records = fs.readFileSync(filename, 'utf8').split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line));
  let priorDigest = '0'.repeat(64);
  for (const record of records) {
    invariant(record.priorDigest === priorDigest, 'command journal hash chain is broken');
    const { digest, ...body } = record;
    invariant(digest === sha256(stableJson(body)), 'command journal record digest is invalid');
    priorDigest = digest;
  }
  return { records, sha256: sha256(fs.readFileSync(filename)), tailDigest: priorDigest };
}

async function runCertification(context) {
  const certificate = output(context.options, 'certification.json');
  assertArtifactAbsent(certificate);
  const shards = Array.from({ length: 4 }, (_unused, index) => output(context.options, `shard-${index}.json`));
  await runCommand(context, process.execPath, [
    certifiedImage, 'certify',
    '--image', context.options.image,
    '--source-database', context.options.sourceDatabase,
    '--source-corpus-root', context.options.sourceCorpusRoot,
    '--fixture', context.options.fixture,
    '--load-driver', tools.load,
    '--reconciliation-driver', tools.reconcile,
    '--fixture-preflight', preflightPath(context.options, 'main10k'),
    '--fault-preflight', preflightPath(context.options, 'faults'),
    '--soak-preflight', preflightPath(context.options, 'soak5k'),
    '--runtime-proof', output(context.options, 'runtime-proof.json'),
    '--monitor', output(context.options, 'monitor.jsonl'),
    ...shards.flatMap((filename) => ['--load-result', filename]),
    '--reconciliation', output(context.options, 'reconciliation.json'),
    '--main-freeze', freezePath(context.options, 'main10k'),
    '--fault-result', output(context.options, 'runner-restart.json'),
    '--fault-result', output(context.options, 'sqlite-lock.json'),
    '--fault-freeze', freezePath(context.options, 'faults'),
    '--soak-result', output(context.options, 'soak-invariants.json'),
    '--soak-freeze', freezePath(context.options, 'soak5k'),
    '--scratch-directory', context.scratch.path,
    '--output', certificate,
  ], 'final-image-certification');
  invariant(fs.existsSync(certificate) && fs.existsSync(`${certificate}.sha256`),
    'final certifier did not create the manifest and checksum');
}

function validateFinalPhaseIsolation(state) {
  const candidates = ['main10k', 'faults', 'soak5k'].map((phase) => state.containers[phase]);
  invariant(candidates.every((candidate) => candidate?.identity?.containerId
    && candidate.identity.dataDir && candidate.databaseDeviceInode
    && candidate.databaseSha256 && candidate.databaseFrozenAt),
  'final capacity candidates are missing stopped/frozen identities');
  for (const [selector, label] of [
    [(candidate) => candidate.identity.containerId, 'container IDs'],
    [(candidate) => candidate.identity.dataDir, 'data roots'],
    [(candidate) => candidate.databaseDeviceInode, 'database inodes'],
  ]) {
    invariant(new Set(candidates.map(selector)).size === candidates.length,
      `final capacity ${label} are not pairwise distinct`);
  }
  const mainFrozenAt = Date.parse(candidates[0].databaseFrozenAt);
  invariant(Number.isFinite(mainFrozenAt)
    && candidates.slice(1).every((candidate) => Date.parse(candidate.startedAt) >= mainFrozenAt),
  'fault or soak phase started before main10k reconciliation/freeze completed');
}

async function executePhase(context) {
  switch (context.phase.phase) {
    case 'preflight-diagnostic':
      await runPreflight(context, 'diagnostic', 'diagnostic1k');
      break;
    case 'run-diagnostic':
      await runShardedProfile(context, profiles.diagnostic1k);
      break;
    case 'freeze-diagnostic':
      await runFreeze(context, 'diagnostic');
      break;
    case 'preflight-main10k':
      await runPreflight(context, 'main10k', 'final10k');
      break;
    case 'run-main10k':
      await writeRuntimeProof(context);
      await runShardedProfile(context, profiles.final10k);
      break;
    case 'reconcile-main10k':
      await runReconciliationAndFreeze(context);
      break;
    case 'preflight-faults':
      await runPreflight(context, 'faults', 'final10k');
      break;
    case 'run-faults':
      await runFaults(context);
      break;
    case 'freeze-faults':
      await runFreeze(context, 'faults');
      break;
    case 'preflight-soak5k':
      await runPreflight(context, 'soak5k', 'final10k');
      break;
    case 'run-soak5k':
      await runSoak(context);
      break;
    case 'freeze-soak5k':
      await runFreeze(context, 'soak5k');
      break;
    case 'certify':
      validateFinalPhaseIsolation(context.state);
      await runCertification(context);
      break;
    default:
      throw new Error(`unsupported capacity phase ${context.phase.phase}`);
  }
}

function recordContainer(state, phase) {
  const logical = phase.phase === 'certify'
    ? 'main10k'
    : phase.phase.replace(/^(?:preflight-|run-|reconcile-|freeze-)/u, '');
  const prior = state.containers[logical];
  const identity = {
    containerId: phase.containerId,
    containerName: phase.containerName,
    target: phase.target,
    dataDir: phase.dataDir,
  };
  if (prior) invariant(stableJson(prior.identity) === stableJson(identity),
    `${logical} container/data identity changed between lifecycle phases`);
  const finalizing = phase.phase === 'reconcile-main10k' || phase.phase.startsWith('freeze-');
  state.containers[logical] = {
    identity,
    createdAt: phase.createdAt || prior?.createdAt || null,
    startedAt: phase.startedAt || prior?.startedAt || null,
    stoppedAt: phase.stoppedAt || prior?.stoppedAt || null,
    databaseSha256: finalizing
      ? phase.databaseSha256 : prior?.databaseSha256 || phase.databaseSha256 || null,
    databaseDeviceInode: finalizing
      ? phase.databaseDeviceInode : prior?.databaseDeviceInode || phase.databaseDeviceInode || null,
    databaseFrozenAt: finalizing
      ? phase.databaseFrozenAt : prior?.databaseFrozenAt || phase.databaseFrozenAt || null,
  };
}

function finishManifest(context) {
  const filename = output(context.options, manifestName);
  assertArtifactAbsent(filename);
  const journal = validateJournal(context.journalFile);
  const artifacts = Object.fromEntries(artifactEvidence(context.options.resultsDir));
  const manifest = {
    schemaVersion: 1,
    type: 'cascade-capacity-command-manifest',
    profile: context.options.profile,
    imageId: context.options.imageId,
    revision: context.options.revision,
    target: context.phase.target,
    completedAt: new Date().toISOString(),
    affinity: context.affinity,
    frozenInputs: context.state.inputs,
    containers: context.state.containers,
    commands: {
      journal: context.journalFile,
      sha256: journal.sha256,
      tailDigest: journal.tailDigest,
      records: journal.records,
    },
    artifacts,
  };
  writeExclusiveJson(filename, manifest);
}

export async function main(argv = process.argv.slice(2)) {
  const options = validateOptions(parseArgs(argv));
  const affinity = validateAffinity();
  const phase = currentPhase();
  validateRunRoots(options, phase);
  const loaded = initializeOrLoad(options, phase, affinity);
  const context = { ...loaded, options, phase, affinity };
  context.scratch = validateScratch(context.state);
  const expectedIndex = context.state.completed.length;
  invariant(context.phaseSequence[expectedIndex] === phase.phase,
    `capacity phase ${phase.phase} is out of order; expected ${context.phaseSequence[expectedIndex] || 'none'}`);
  recordContainer(context.state, phase);
  try {
    await executePhase(context);
    assertScratchEmpty(context.scratch);
  } catch (error) {
    cleanupScratch();
    throw error;
  }
  context.state.completed.push(phase.phase);
  context.state.updatedAt = new Date().toISOString();
  recordContainer(context.state, phase);
  atomicState(context.stateFile, context.state);
  if (context.state.completed.length === context.phaseSequence.length) {
    cleanupScratch({ requireEmpty: true });
    finishManifest(context);
  }
}

let signalExit = false;
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    if (signalExit) return;
    signalExit = true;
    void terminateChildren(signal).finally(() => {
      try { cleanupScratch(); } catch (error) {
        console.error(`[capacity-certification-runner] scratch cleanup failed: ${error.message}`);
      }
      process.exit(exitCode);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    try { await terminateChildren(); } catch (cleanupError) {
      console.error(`[capacity-certification-runner] child cleanup failed: ${cleanupError.stack || cleanupError}`);
    }
    try { cleanupScratch(); } catch (cleanupError) {
      console.error(`[capacity-certification-runner] scratch cleanup failed: ${cleanupError.stack || cleanupError}`);
    }
    console.error(`[capacity-certification-runner] fatal: ${error.stack || error}`);
    process.exitCode = 1;
  });
}
