import fs from 'node:fs';
import process from 'node:process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, output, preflightPath, freezePath, assertArtifactAbsent, readPassingArtifact, appendJournal, spawnTracked, waitPassed, writeExclusiveJson } from './certification-state.mjs';
import { profiles, loadThresholdArgs, sha256, stableJson, tools, root, certifiedImage, invariant } from './certification-inputs.mjs';

/**
 * Certification phase seam: preflight, workload, reconciliation, freeze, and fault/soak drivers.
 * Failure mode: each phase requires fresh artifacts and passing child evidence before advancing.
 */

export async function runPreflight(context, phaseName, profileName) {
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

export function parseSha256sum(raw, label) {
  const match = raw.trim().match(/^([a-f0-9]{64})\s+/u);
  invariant(match, `${label} did not return one SHA-256 digest`);
  return match[1];
}

export async function writeRuntimeProof(context) {
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

export function loadArgs(context, profile, shardIndex, filename) {
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

export function monitorArgs(context, profile, marker, monitor) {
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

export async function waitForMonitorStart(handle, filename, context, timeoutMs = 60_000) {
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

export function validateLoadResult(filename, profile, index, sourceIp, fixtureSha256, loadDriverSha256) {
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

export function validateMonitorFinish(filename) {
  const records = fs.readFileSync(filename, 'utf8').split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line));
  const finish = records.findLast((record) => record.type === 'finish');
  invariant(finish?.evaluation?.ok === true, 'capacity monitor did not pass');
}

export async function runShardedProfile(context, profile) {
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

export async function runReconciliationAndFreeze(context) {
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

export async function runFreeze(context, phaseName) {
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

export async function runFaults(context) {
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

export async function runSoak(context) {
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
