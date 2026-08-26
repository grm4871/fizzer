import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { sha256, stable, stableJson, finalPhases, diagnosticPhases, profiles, inputEvidence, invariant, stateName, journalName, scratchName, minimumScratchBytes, root, processAffinity } from './certification-inputs.mjs';

/**
 * Certification state seam: journal/state persistence, child lifecycle, and scratch ownership.
 * Failure mode: interrupted phases resume only from identity-checked, append-only evidence.
 */
export function writeExclusiveJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
}

export function atomicState(filename, value) {
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

export function readJson(filename, label) {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(descriptor);
    invariant(metadata.isFile(), `${label} is not a regular file`);
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally {
    fs.closeSync(descriptor);
  }
}

export function currentPhase() {
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

export function validateRunRoots(options, phase) {
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

export function initializeOrLoad(options, phase, affinity) {
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

export function validateScratch(state) {
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

export function assertScratchEmpty(scratch) {
  invariant(fs.readdirSync(scratch.path).length === 0,
    'SQLite comparator left files in the owned scratch directory');
}

export function cleanupScratch({ requireEmpty = false } = {}) {
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

export function appendJournal(filename, record) {
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

export function childCommand(command, args) {
  const fake = process.env.CASCADE_CAPACITY_TESTING === '1'
    ? process.env.CASCADE_CAPACITY_TEST_COMMAND
    : '';
  return fake ? { command: fake, args: [command, ...args] } : { command, args };
}

export function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION|CREDENTIAL)/iu.test(name)));
}

export async function spawnTracked(context, command, args, label) {
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

export async function waitPassed(handle) {
  const result = await handle.exit;
  invariant(result.status === 0 && !result.signal,
    `${handle.label} failed (${result.signal || result.status}): ${result.stderr.trim().slice(-2_000)}`);
  return result;
}

export async function runCommand(context, command, args, label) {
  return waitPassed(await spawnTracked(context, command, args, label));
}

export async function terminateChildren(signal = 'SIGTERM') {
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

export function output(options, name) {
  return path.join(options.resultsDir, name);
}

export function preflightPath(options, phase) {
  return output(options, `fixture-preflight-${phase}.json`);
}

export function freezePath(options, phase) {
  return output(options, `freeze-${phase}.json`);
}

export function assertArtifactAbsent(filename) {
  invariant(!fs.existsSync(filename), `artifact must be fresh and absent: ${filename}`);
}

export function readPassingArtifact(filename, type, phase = null) {
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
