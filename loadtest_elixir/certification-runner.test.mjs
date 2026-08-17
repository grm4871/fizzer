import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'certification-runner.mjs');
const imageId = `sha256:${'a'.repeat(64)}`;
const revision = 'b'.repeat(40);

function digest(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function fixture(parent = os.homedir()) {
  const root = fs.mkdtempSync(path.join(parent, '.cascade-certification-runner-test-'));
  const sourceDatabase = path.join(root, 'source.db');
  const sourceCorpusRoot = path.join(root, 'source-corpus');
  const fixtureFile = path.join(root, 'fixtures.jsonl');
  const resultsDir = path.join(root, 'results');
  const commandLog = path.join(root, 'fake-commands.jsonl');
  const fakeCommand = path.join(root, 'fake-command.mjs');
  fs.writeFileSync(sourceDatabase, 'closed production snapshot');
  fs.mkdirSync(sourceCorpusRoot);
  fs.writeFileSync(path.join(sourceCorpusRoot, 'approved.txt'), 'approved corpus');
  fs.writeFileSync(fixtureFile, '{"redacted":"fixture"}\n');
  fs.writeFileSync(fakeCommand, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const originalCommand = process.argv[2];
const argv = process.argv.slice(3);
const value = (name) => argv[argv.indexOf(name) + 1];
const has = (name) => argv.includes(name);
const tool = path.basename(argv[0] || originalCommand);
fs.appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({ originalCommand, argv, pid: process.pid }) + '\\n');
await sleep(30);
if (process.env.CAPACITY_JWT_SECRET || process.env.CAPACITY_RELEASE_COOKIE) {
  process.stderr.write('capacity secret leaked to child\\n');
  process.exit(93);
}

if (originalCommand === 'docker') {
  if (argv.includes('eval')) process.stdout.write('swap-ready\\n');
  else if (argv.includes('/app/loadtest_elixir/load.mjs')) {
    process.stdout.write(process.env.TEST_LOAD_SHA + '  /app/loadtest_elixir/load.mjs\\n');
  } else if (argv.includes('/app/loadtest_elixir/reconcile-capacity.mjs')) {
    process.stdout.write(process.env.TEST_RECONCILE_SHA + '  /app/loadtest_elixir/reconcile-capacity.mjs\\n');
  } else process.exitCode = 91;
} else if (tool === 'certified-image.mjs' && argv[1] === 'preflight') {
  fs.writeFileSync(value('--output'), JSON.stringify({
    schemaVersion: 1,
    type: 'cascade-capacity-fixture-preflight',
    phase: value('--phase'),
    profile: value('--profile'),
    containerId: value('--container'),
    imageId: process.env.TEST_IMAGE_ID,
    baseline: { users: 10007, vaults: 412, memberships: 10015, maxRunId: 1897 },
    identity: { groups: 400 },
  }));
} else if (tool === 'certified-image.mjs' && argv[1] === 'freeze') {
  const [databaseDevice, databaseInode] = process.env.CASCADE_CAPACITY_DATABASE_DEVICE_INODE.split(':');
  fs.writeFileSync(value('--output'), JSON.stringify({
    schemaVersion: 1,
    type: 'cascade-capacity-phase-freeze',
    phase: JSON.parse(fs.readFileSync(value('--preflight'), 'utf8')).phase,
    containerId: value('--container'),
    imageId: process.env.TEST_IMAGE_ID,
    databaseSha256: process.env.CASCADE_CAPACITY_DATABASE_SHA256,
    databaseDevice,
    databaseInode,
    frozenAt: new Date().toISOString(),
  }));
} else if (tool === 'certified-image.mjs' && argv[1] === 'certify') {
  fs.writeFileSync(value('--output'), '{"status":"certified"}\\n');
  fs.writeFileSync(value('--output') + '.sha256', '0'.repeat(64) + '  certification.json\\n');
} else if (tool === 'monitor.mjs') {
  const output = value('--output');
  fs.writeFileSync(output, JSON.stringify({
    type: 'start',
    containerId: value('--container'),
    imageId: value('--expected-image'),
    preflightFailures: [],
  }) + '\\n');
  const marker = value('--workload-finished-marker');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(10);
  if (!fs.existsSync(marker)) process.exitCode = 92;
  else fs.appendFileSync(output, JSON.stringify({ type: 'finish', evaluation: { ok: true, failures: [] } }) + '\\n');
} else if (tool === 'load.mjs') {
  const fixtureBytes = fs.readFileSync(value('--fixtures'));
  fs.writeFileSync(value('--output'), JSON.stringify({
    shard: { index: Number(value('--shard-index')), count: Number(value('--shard-count')) },
    requestedUsers: Number(value('--users')),
    rampSeconds: Number(value('--ramp-seconds')),
    soakSeconds: Number(value('--soak-seconds')),
    pollingPercent: Number(value('--polling-percent')),
    reconnectPercent: Number(value('--reconnect-percent')),
    reconnectAtSeconds: Number(value('--reconnect-at-seconds')),
    sourceIp: value('--source-ip'),
    rates: {
      chatRps: Number(value('--chat-rps')),
      readRps: Number(value('--read-rps')),
      runRps: Number(value('--run-rps')),
    },
    selectionPlan: { forcedReconnectStrategy: 'owner-stratified-v1' },
    presencePlan: { strategy: 'owner-stratified-v1' },
    provenance: {
      fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
      loadDriverSha256: process.env.TEST_LOAD_SHA,
    },
    evaluation: { ok: true, failures: [] },
  }));
} else if (tool === 'write-workload-marker.mjs') {
  fs.writeFileSync(value('--output'), JSON.stringify({ status: 'passed' }), { flag: 'wx' });
} else if (tool === 'reconcile-capacity.mjs') {
  fs.writeFileSync(value('--output'), JSON.stringify({
    schemaVersion: 1, type: 'cascade-capacity-reconciliation', evaluation: { ok: true, failures: [] },
  }));
} else if (tool === 'runner-restart-recovery.mjs') {
  fs.writeFileSync(value('--output'), JSON.stringify({
    schemaVersion: 1, type: 'cascade-fault-recovery', fault: 'runner-restart-reclaim',
    evaluation: { ok: true, failures: [] },
  }));
} else if (tool === 'sqlite-lock-recovery.mjs') {
  fs.writeFileSync(value('--output'), JSON.stringify({
    schemaVersion: 1, type: 'cascade-fault-recovery', fault: 'sqlite-write-lock',
    evaluation: { ok: true, failures: [] },
  }));
} else if (tool === 'soak-invariants.mjs') {
  fs.writeFileSync(value('--output'), JSON.stringify({
    schemaVersion: 1, type: 'cascade-elixir-two-hour-soak-invariants',
    evaluation: { ok: true, failures: [] },
  }));
} else {
  process.stderr.write('unexpected fake command: ' + originalCommand + ' ' + argv.join(' ') + '\\n');
  process.exitCode = 90;
}
`, { mode: 0o700 });
  return {
    root, sourceDatabase, sourceCorpusRoot, fixtureFile, resultsDir, commandLog, fakeCommand,
  };
}

function dataRoot(item, name) {
  const directory = path.join(item.root, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'docs.db'), `${name} database`);
  return directory;
}

function baseArgs(item) {
  return [
    runner,
    '--profile', 'final10k',
    '--image', `cascade:certified-${revision}`,
    '--image-id', imageId,
    '--revision', revision,
    '--source-database', item.sourceDatabase,
    '--source-corpus-root', item.sourceCorpusRoot,
    '--fixture', item.fixtureFile,
    '--results-dir', item.resultsDir,
    '--source-ip', '127.0.0.2',
    '--source-ip', '127.0.0.3',
    '--source-ip', '127.0.0.4',
    '--source-ip', '127.0.0.5',
    '--soak-source-ip', '127.0.0.6',
    '--fixture-prefix', 'capacity',
  ];
}

function diagnosticArgs(item) {
  return [
    runner,
    '--profile', 'diagnostic1k',
    '--image-id', imageId,
    '--revision', revision,
    '--source-database', item.sourceDatabase,
    '--source-corpus-root', item.sourceCorpusRoot,
    '--fixture', item.fixtureFile,
    '--results-dir', item.resultsDir,
    '--source-ip', '127.0.0.2',
    '--source-ip', '127.0.0.3',
    '--source-ip', '127.0.0.4',
    '--source-ip', '127.0.0.5',
    '--fixture-prefix', 'capacity',
  ];
}

function runnerEnv(item, phase, containerId, dataDir, lifecycle) {
  const database = path.join(dataDir, 'docs.db');
  const stat = fs.statSync(database);
  const stopped = lifecycle === 'stopped';
  return {
    ...process.env,
    CASCADE_CAPACITY_TESTING: '1',
    CASCADE_CAPACITY_TEST_COMMAND: item.fakeCommand,
    CASCADE_CAPACITY_AFFINITY_BOUND: '1',
    CASCADE_CAPACITY_GENERATOR_CPUSET: '2',
    CASCADE_CAPACITY_PHASE: phase,
    CASCADE_CAPACITY_CONTAINER_ID: containerId,
    CASCADE_CAPACITY_CONTAINER_NAME: phase.includes('fault')
      ? 'cascade-elixir-capacity-fault'
      : phase.includes('soak') ? 'cascade-elixir-capacity-soak'
        : phase.includes('diagnostic') ? 'cascade-elixir-capacity-1k' : 'cascade-elixir-capacity',
    CASCADE_CAPACITY_TARGET: 'http://127.0.0.1:39094',
    CASCADE_CAPACITY_DATA_DIR: dataDir,
    CASCADE_CAPACITY_CONTAINER_CREATED_AT: new Date().toISOString(),
    CASCADE_CAPACITY_CONTAINER_STARTED_AT: lifecycle === 'created' ? '' : new Date().toISOString(),
    CASCADE_CAPACITY_CONTAINER_STOPPED_AT: stopped ? new Date().toISOString() : '',
    CASCADE_CAPACITY_DATABASE_SHA256: stopped ? digest(database) : '',
    CASCADE_CAPACITY_DATABASE_DEVICE_INODE: stopped ? `${stat.dev}:${stat.ino}` : '',
    CASCADE_CAPACITY_DATABASE_FROZEN_AT: stopped ? new Date().toISOString() : '',
    CAPACITY_JWT_SECRET: 'must-not-leak-to-child',
    CAPACITY_RELEASE_COOKIE: 'must-not-leak-to-child',
    TEST_COMMAND_LOG: item.commandLog,
    TEST_IMAGE_ID: imageId,
    TEST_LOAD_SHA: digest(path.join(here, 'load.mjs')),
    TEST_RECONCILE_SHA: digest(path.join(here, 'reconcile-capacity.mjs')),
  };
}

function invoke(item, args, env) {
  return spawnSync('taskset', ['-c', '2', process.execPath, ...args], {
    env, encoding: 'utf8', timeout: 20_000,
  });
}

test('final controller serializes A reconciliation/freeze before isolated B/C and records exact commands', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const roots = {
    main10k: dataRoot(item, 'main10k'),
    faults: dataRoot(item, 'faults'),
    soak5k: dataRoot(item, 'soak5k'),
  };
  const ids = {
    main10k: 'c'.repeat(64),
    faults: 'd'.repeat(64),
    soak5k: 'e'.repeat(64),
  };
  const phases = [
    ['preflight-main10k', 'main10k', 'created'],
    ['run-main10k', 'main10k', 'running'],
    ['reconcile-main10k', 'main10k', 'stopped'],
    ['preflight-faults', 'faults', 'created'],
    ['run-faults', 'faults', 'running'],
    ['freeze-faults', 'faults', 'stopped'],
    ['preflight-soak5k', 'soak5k', 'created'],
    ['run-soak5k', 'soak5k', 'running'],
    ['freeze-soak5k', 'soak5k', 'stopped'],
    ['certify', 'main10k', 'stopped'],
  ];
  for (const [phase, candidate, lifecycle] of phases) {
    const result = invoke(item, baseArgs(item), runnerEnv(
      item, phase, ids[candidate], roots[candidate], lifecycle,
    ));
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(item.resultsDir, 'command-manifest.json'), 'utf8'));
  assert.equal(manifest.profile, 'final10k');
  assert.deepEqual(Object.keys(manifest.containers).sort(), ['faults', 'main10k', 'soak5k']);
  assert.equal(new Set(Object.values(manifest.containers).map((entry) => entry.identity.containerId)).size, 3);
  assert.equal(new Set(Object.values(manifest.containers).map((entry) => entry.identity.dataDir)).size, 3);
  assert.equal(new Set(Object.values(manifest.containers).map((entry) => entry.databaseDeviceInode)).size, 3);
  assert.ok(manifest.commands.records.every((record) => record.affinity == null
    || record.affinity.normalized === '2'));
  const starts = manifest.commands.records.filter((record) => record.type === 'command-start');
  const labels = starts.map((record) => record.label);
  assert.ok(labels.indexOf('main10k-reconciliation') < labels.indexOf('freeze-main10k'));
  assert.ok(labels.indexOf('freeze-main10k') < labels.indexOf('preflight-faults'));
  assert.ok(labels.indexOf('freeze-faults') < labels.indexOf('preflight-soak5k'));
  assert.equal(labels.filter((label) => label === 'load-shard-0').length, 1);
  assert.equal(labels.filter((label) => /^load-shard-[0-3]$/u.test(label)).length, 4);
  assert.ok(labels.indexOf('monitor') < labels.indexOf('load-shard-0'));
  assert.ok(labels.indexOf('load-shard-3') < labels.indexOf('workload-marker'));
  assert.ok(labels.includes('embedded-swap-ready'));
  assert.ok(labels.includes('runner-restart-recovery'));
  assert.ok(labels.includes('sqlite-lock-recovery'));
  assert.ok(labels.includes('soak5k-two-hour'));
  assert.ok(labels.includes('final-image-certification'));
  assert.ok(!starts.some((record) => record.argv.join(' ').includes('docker rm')));
  const snapshotCommands = starts.filter((record) =>
    /^preflight-|^freeze-/u.test(record.label));
  assert.equal(snapshotCommands.length, 6);
  assert.deepEqual(new Set(snapshotCommands.map((record) =>
    record.argv[record.argv.indexOf('--scratch-directory') + 1])),
  new Set([path.join(item.resultsDir, 'sqlite-snapshot-scratch')]));
  assert.equal(fs.existsSync(path.join(item.resultsDir, 'sqlite-snapshot-scratch')), false);
  assert.equal(fs.existsSync(path.join(item.resultsDir, 'certification.json')), true);
});

test('diagnostic controller fixes four 1k shards, owner-stratified reconnect at 30, and never certifies', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const data = dataRoot(item, 'diagnostic');
  const id = 'f'.repeat(64);
  for (const [phase, lifecycle] of [
    ['preflight-diagnostic', 'created'],
    ['run-diagnostic', 'running'],
    ['freeze-diagnostic', 'stopped'],
  ]) {
    const result = invoke(item, diagnosticArgs(item), runnerEnv(item, phase, id, data, lifecycle));
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(item.resultsDir, 'command-manifest.json'), 'utf8'));
  assert.equal(manifest.profile, 'diagnostic1k');
  assert.deepEqual(Object.keys(manifest.containers), ['diagnostic']);
  const starts = manifest.commands.records.filter((record) => record.type === 'command-start');
  const shards = starts.filter((record) => /^diagnostic-load-shard-[0-3]$/u.test(record.label));
  assert.equal(shards.length, 4);
  for (const shard of shards) {
    const value = (name) => shard.argv[shard.argv.indexOf(name) + 1];
    assert.equal(value('--users'), '250');
    assert.equal(value('--shard-count'), '4');
    assert.equal(value('--ramp-seconds'), '60');
    assert.equal(value('--soak-seconds'), '120');
    assert.equal(value('--reconnect-percent'), '10');
    assert.equal(value('--reconnect-at-seconds'), '30');
    assert.equal(value('--chat-rps'), '6.25');
    assert.equal(value('--read-rps'), '12.5');
    assert.equal(value('--run-rps'), '0.25');
  }
  const monitor = starts.find((record) => record.label === 'diagnostic-monitor');
  const monitorValue = (name) => monitor.argv[monitor.argv.indexOf(name) + 1];
  assert.equal(monitorValue('--duration-seconds'), '320');
  assert.equal(monitorValue('--gate-window-seconds'), '60');
  assert.equal(monitorValue('--minimum-workload-seconds'), '180');
  assert.equal(monitorValue('--minimum-post-workload-seconds'), '30');
  assert.ok(starts.some((record) => record.label === 'freeze-diagnostic'));
  assert.ok(!starts.some((record) => /fault|soak|certif/iu.test(record.label)));
  assert.equal(fs.existsSync(path.join(item.resultsDir, 'certification.json')), false);
});

test('runner rejects out-of-order final phases before starting a child command', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const data = dataRoot(item, 'main10k');
  const result = invoke(item, baseArgs(item), runnerEnv(
    item, 'run-main10k', 'c'.repeat(64), data, 'running',
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /results|out of order/u);
  assert.equal(fs.existsSync(item.commandLog), false);
});

test('runner rejects tmpfs scratch and removes it before any certifier child starts', (t) => {
  const item = fixture(os.tmpdir());
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const data = dataRoot(item, 'main10k');
  const result = invoke(item, baseArgs(item), runnerEnv(
    item, 'preflight-main10k', 'c'.repeat(64), data, 'created',
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disk-backed storage/u);
  assert.equal(fs.existsSync(path.join(item.resultsDir, 'sqlite-snapshot-scratch')), false);
  assert.equal(fs.existsSync(item.commandLog), false);
});

test('runner rejects an evidence root nested in a mutable candidate root', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const data = dataRoot(item, 'main10k');
  const nested = path.join(data, 'results');
  const argv = baseArgs(item);
  argv[argv.indexOf('--results-dir') + 1] = nested;
  const result = invoke(item, argv, runnerEnv(
    item, 'preflight-main10k', 'c'.repeat(64), data, 'created',
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disjoint from every mutable capacity data root/u);
  assert.equal(fs.existsSync(item.commandLog), false);
});
