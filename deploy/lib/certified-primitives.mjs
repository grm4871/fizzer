// Certified-image primitives: canonical constants, safe artifact snapshots, and shared invariants.
// Inputs are manifest/evidence values or filesystem paths; outputs are immutable records; failures throw.
// Ordering is deterministic: validation callers snapshot bytes before comparing derived evidence.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SOAK_RUNTIME_CONFIGURATION } from '../../loadtest_elixir/soak-invariants.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const REQUIRED_USERS = 10_000;
export const REQUIRED_MEMBERSHIPS = 50_000;
export const REQUIRED_SHARDS = 4;
export const REQUIRED_RAMP_SECONDS = 300;
export const REQUIRED_SOAK_SECONDS = 1_860;
export const REQUIRED_MONITOR_SECONDS = 2_250;
export const REQUIRED_GATE_SECONDS = 1_800;
export const REQUIRED_POST_WORKLOAD_SECONDS = 30;
export const MINIMUM_COVERAGE_RATIO = 0.95;
export const CERTIFIED_CPUS = 2;
export const CERTIFIED_CPUSET = '0-1';
export const CERTIFIED_MEMORY_BYTES = 3 * 1024 ** 3;
export const CERTIFIED_PIDS = 100_000;
export const CERTIFIED_NOFILE = 200_000;
export const REQUIRED_FAULTS = new Set(['runner-restart-reclaim', 'sqlite-write-lock']);
export const REQUIRED_LONG_SOAK_USERS = 5_000;
export const REQUIRED_LONG_SOAK_SECONDS = 7_200;
export const REQUIRED_LONG_SOAK_CHURN_PERCENT = 10;
export const REQUIRED_LONG_SOAK_CHURN_INTERVAL_SECONDS = 300;
export const REQUIRED_LONG_SOAK_RUN_RPS = 1;
export const PRODUCTION_SOURCE_DATABASE = {
  sha256: '3e97b52e819d6c7f02f24ce294cdc77523753a6dee4879cd0f36a7fa54fb2b78',
  bytes: 673_656_832,
  counts: {
    users: 7,
    vaults: 12,
    memberships: 15,
    notes: 325,
    messages: 4_082,
    runs: 1_897,
    runEvents: 403_514,
    delegatedRuns: 2,
    openDelegatedRuns: 2,
    maxRunId: 1_897,
  },
};
export const PRODUCTION_SOURCE_CORPUS = {
  sha256: '8795a33bce33ee47621d340ec59d25a4bb6f665fccdb18fb6eaf143c01a1a48b',
  bytes: 95_088_866,
  files: 9_325,
  vaults: {
    sha256: 'c41f69bcf4b5126fb627c9cc7ff9c69a54d287095348cec8916f04e320223f7a',
    bytes: 4_957_069,
    files: 345,
    directories: 129,
  },
  qmd: {
    sha256: '7ce9e36fa48416df6232544f5c9092ce3232c2d05f2b800c98d4ccd3f2c76af1',
    bytes: 90_131_797,
    files: 8_980,
    directories: 16,
  },
};
export const REQUIRED_FIXTURE_GROUP_SIZE = 25;
export const CAPACITY_PROFILES = {
  diagnostic1k: { users: 1_000, groups: 40, shardCount: 4, usersPerShard: 250 },
  final10k: { users: 10_000, groups: 400, shardCount: 4, usersPerShard: 2_500 },
};
export const CAPACITY_PHASES = new Set(['diagnostic', 'main10k', 'faults', 'soak5k']);
export const REQUIRED_LOAD_THRESHOLDS = {
  connectSuccess: 0.999,
  connectP99Ms: 5_000,
  httpErrorRate: 0.001,
  httpReadP99Ms: 1_000,
  httpWriteP99Ms: 1_000,
  eventP99Ms: 1_000,
  reconnectWithin10Success: 0.99,
  minimumRealtimeReceiptSuccess: 0.999,
  minimumRealtimeRunCompletionSuccess: 0.999,
  minimumWorkloadScheduledRatio: 0.99,
  minimumWorkloadAttemptedRatio: 0.99,
  minimumWorkloadCompletedRatio: 0.999,
  minimumWorkloadSucceededRatio: 0.999,
};
export const REQUIRED_ERL_AFLAGS = '+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none';
export const ORPHAN_RECLAIM_MS = SOAK_RUNTIME_CONFIGURATION.runnerOrphanReclaimMs;
export const PRODUCTION_APPLICATION_TABLES = Object.freeze([
  'agent_journal', 'agent_memory_captures', 'agent_open_threads', 'android_battery_samples',
  'chat_agent_dispatches', 'chat_agent_members', 'chat_channel_links', 'chat_channel_settings',
  'chat_messages', 'chat_mission_events', 'chat_mission_tasks', 'chat_missions',
  'chat_note_backlinks', 'chat_note_grants', 'community_note_activity', 'community_read_state',
  'content_reports', 'delegated_runs', 'direct_message_channels', 'distill_jobs', 'folders',
  'managed_agent_audit', 'managed_agent_entitlements', 'managed_agent_executions',
  'managed_usage_ledger', 'managed_usage_reservations', 'note_links', 'note_tags', 'note_versions',
  'notes', 'public_vault_join_requests', 'published_notes', 'registration_invites_used',
  'run_events', 'runs', 'scratchpad_note_stats', 'scratchpad_state', 'tags', 'user_blocks',
  'user_dm_settings', 'user_dm_vaults', 'users', 'vault_agent_exclusions', 'vault_agents',
  'vault_bans', 'vault_members', 'vault_settings', 'vaults', 'widget_feed_state',
  'work_item_dependencies', 'work_item_reviews', 'work_item_runs', 'work_items',
]);
export const PRODUCTION_APPLICATION_TABLES_SHA256 =
  '7dc78043644bbc48221038b787d1c7df0edb23c0635ba51ac56dfcec3ef145ff';
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

export function sameIntegerSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)
      || left.some((value) => !Number.isInteger(value))
      || right.some((value) => !Number.isInteger(value))) return false;
  const leftUnique = new Set(left);
  const rightUnique = new Set(right);
  return leftUnique.size === left.length
    && rightUnique.size === right.length
    && leftUnique.size === rightUnique.size
    && [...leftUnique].every((value) => rightUnique.has(value));
}

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertNoManifestSecrets(value, location = 'manifest') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoManifestSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      const segments = value.split('.');
      invariant(!(segments.length === 3
        && segments.every((segment) => /^[A-Za-z0-9_-]+$/u.test(segment))),
      `${location} contains token-like secret material`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    invariant(!/(?:^|_)(?:token|authorization|cookie|password|secret|jwt)(?:$|_)/iu.test(key),
      `${location}.${key} is a secret-bearing manifest field`);
    assertNoManifestSecrets(child, `${location}.${key}`);
  }
}

export function runtimeShapeMatches(state) {
  const nofile = state?.ulimits?.find((entry) => entry.Name === 'nofile');
  return state?.nanoCpus === CERTIFIED_CPUS * 1_000_000_000
    && state?.cpusetCpus === CERTIFIED_CPUSET
    && state?.memory === CERTIFIED_MEMORY_BYTES
    && state?.memorySwap === CERTIFIED_MEMORY_BYTES
    && state?.pidsLimit === CERTIFIED_PIDS
    && nofile?.Soft === CERTIFIED_NOFILE
    && nofile?.Hard === CERTIFIED_NOFILE;
}

export function validateRealtimeEvidence(expected, presencePlan, observed, expectedSessions, expectedRunners) {
  const expectedAuthFull = expectedSessions + Math.round(expectedSessions * 0.1);
  const expectedGroups = Math.ceil(expectedSessions / 25);
  const expectedReconnectOwnerChannels = Math.round(expectedGroups * 0.1);
  const expectedSuccessfulChatWrites = Math.max(1, Math.floor(6.25 * REQUIRED_SOAK_SECONDS))
    * REQUIRED_SHARDS;
  invariant(expected?.enabled === true
    && expected.authFull === expectedAuthFull
    && expected.groupCount === expectedGroups
    && expected.successfulChatWrites === expectedSuccessfulChatWrites,
  'capacity monitor realtime expectations differ from the exact release workload');
  invariant(Number.isInteger(presencePlan?.initialOwnedChatChannels)
    && presencePlan.initialOwnedChatChannels === expectedGroups
    && Number.isInteger(presencePlan?.forcedReconnectOwnedChatChannels)
    && presencePlan.forcedReconnectOwnedChatChannels === expectedReconnectOwnerChannels
    && presencePlan.strategy === 'owner-stratified-v1'
    && Array.isArray(presencePlan.forcedReconnectOwnerUserIds)
    && presencePlan.forcedReconnectOwnerUserIds.length === expectedReconnectOwnerChannels
    && new Set(presencePlan.forcedReconnectOwnerUserIds).size === expectedReconnectOwnerChannels
    && presencePlan.forcedReconnectOwnerUserIds.every(Number.isInteger),
  'capacity workload presence-owner plan is missing or invalid');

  const directSnapshots = presencePlan.initialOwnedChatChannels
    + presencePlan.forcedReconnectOwnedChatChannels;
  const dispatcher = observed?.presenceDispatcher;
  const integerFields = [
    'realtimeAuthFull', 'realtimeAuthCacheHits', 'realtimeAuthConflicts', 'realtimeAuthUnknown',
    'presenceUserChannelReads', 'presenceChannelSourceReads', 'presenceParticipantSnapshotReads',
    'presenceSnapshotInitial', 'presenceSnapshotDirect', 'presenceSnapshotDispatcher',
    'presenceSnapshotOther', 'chatListRouteReads', 'chatListRouteMessage', 'chatListRouteDirect',
    'chatListRouteDispatcher', 'chatListRouteOther', 'runnerDelegatedSnapshotReads',
    'runnerDelegatedOwnerReads', 'runnerDisconnectFlushes', 'runnerDisconnectFlushOwners',
  ];
  const dispatcherFields = [
    'requested', 'dispatched', 'completed', 'failed', 'noop', 'active', 'pending', 'queued',
    'refreshed', 'startFailed', 'taskFailed',
  ];
  invariant(integerFields.every((key) => Number.isInteger(observed?.[key]) && observed[key] >= 0)
    && dispatcherFields.every((key) => Number.isInteger(dispatcher?.[key]) && dispatcher[key] >= 0),
  'capacity realtime accounting contains missing or non-integer counters');
  invariant(observed.realtimeAuthFull === expectedAuthFull
    && observed.realtimeAuthCacheHits === expectedAuthFull * 2
    && observed.realtimeAuthConflicts === 0
    && observed.realtimeAuthUnknown === 0,
  'capacity realtime authentication accounting is not exact');
  invariant(observed.presenceUserChannelReads >= Math.floor(expectedSessions * 0.99)
    && observed.presenceUserChannelReads <= expectedSessions
    && observed.presenceChannelSourceReads <= expectedGroups * 3,
  'capacity presence query accounting exceeds the release budget');
  invariant(observed.runnerDelegatedSnapshotReads >= 1
    && observed.runnerDelegatedSnapshotReads <= 2
    && observed.runnerDelegatedOwnerReads === 0
    && observed.runnerDisconnectFlushes === 1
    && observed.runnerDisconnectFlushOwners >= Math.floor(expectedRunners * 0.99)
    && observed.runnerDisconnectFlushOwners <= expectedRunners,
  'capacity runner batching accounting differs from the release contract');
  invariant(dispatcher.requested >= expectedSessions
    && dispatcher.dispatched <= expectedGroups * 6
    && dispatcher.dispatched === dispatcher.completed
    && dispatcher.completed === dispatcher.refreshed
    && dispatcher.failed === 0
    && dispatcher.noop === 0
    && dispatcher.active === 0
    && dispatcher.pending === 0
    && dispatcher.queued === 0
    && dispatcher.startFailed === 0
    && dispatcher.taskFailed === 0,
  'capacity presence dispatcher accounting is incomplete, failed, or not drained');
  invariant(observed.presenceSnapshotInitial === expectedAuthFull
    && observed.presenceSnapshotDirect === directSnapshots
    && observed.presenceSnapshotDispatcher === dispatcher.refreshed
    && observed.presenceSnapshotOther === 0
    && observed.presenceParticipantSnapshotReads === observed.presenceSnapshotInitial
      + observed.presenceSnapshotDirect + observed.presenceSnapshotDispatcher,
  'capacity presence snapshot reason accounting is not exact');
  invariant(observed.chatListRouteMessage === expectedSuccessfulChatWrites
    && observed.chatListRouteDirect === observed.presenceSnapshotDirect
    && observed.chatListRouteDispatcher === dispatcher.refreshed
    && observed.chatListRouteOther === 0
    && observed.chatListRouteReads === observed.chatListRouteMessage
      + observed.chatListRouteDirect + observed.chatListRouteDispatcher,
  'capacity chat list-route reason accounting is not exact');

  return {
    expected: { ...expected },
    presencePlan: { ...presencePlan },
    observed: Object.fromEntries([
      ...integerFields.map((key) => [key, observed[key]]),
      ['presenceDispatcher', Object.fromEntries(dispatcherFields.map((key) => [key, dispatcher[key]]))],
    ]),
  };
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { faultResults: [], loadResults: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    invariant(key.startsWith('--') && value, `${key || 'argument'} requires a value`);
    index += 1;
    const name = key.slice(2);
    if (name === 'load-result') options.loadResults.push(path.resolve(value));
    else if (name === 'fault-result') options.faultResults.push(path.resolve(value));
    else if (name === 'soak-result') options.soakResult = path.resolve(value);
    else options[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }
  return { command, options };
}

export function artifactSnapshot(filename, label = 'release artifact') {
  const resolved = path.resolve(filename);
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} could not be opened without following symlinks: ${error.message}`);
  }
  let bytes;
  try {
    const metadata = fs.fstatSync(descriptor);
    invariant(metadata.isFile(), `${label} must be a regular file, not a symlink`);
    bytes = fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    path: resolved,
    text: bytes.toString('utf8'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  invariant(result.status === 0, `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export function configureSnapshotScratch(directory) {
  invariant(directory, '--scratch-directory is required');
  const resolved = fs.realpathSync(path.resolve(directory));
  const metadata = fs.lstatSync(resolved);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(),
    'SQLite snapshot scratch must be a real directory');
  invariant((metadata.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || metadata.uid === process.getuid()),
  'SQLite snapshot scratch must be private and owned by the certifier user');
  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  const filesystem = fs.statfsSync(resolved);
  const filesystemType = BigInt.asUintN(64, BigInt(filesystem.type));
  invariant(filesystemType !== 0x01021994n && filesystemType !== 0x858458f6n,
    'SQLite snapshot scratch must be on disk-backed storage, not tmpfs or ramfs');
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  invariant(availableBytes >= 2 * 1024 ** 3,
    'SQLite snapshot scratch requires at least 2 GiB free');
  process.env.CASCADE_SQLITE_SNAPSHOT_TMPDIR = resolved;
  return {
    device: metadata.dev.toString(),
    availableBytes,
    policy: 'private owned disk-backed scratch with at least 2 GiB free',
  };
}

export function digestRegularFile(filename, label) {
  const resolved = path.resolve(filename);
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} could not be opened without following symlinks: ${error.message}`);
  }
  try {
    const metadata = fs.fstatSync(descriptor);
    invariant(metadata.isFile(), `${label} must be a regular file, not a symlink`);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
      bytes += read;
    }
    return {
      path: resolved,
      sha256: digest.digest('hex'),
      bytes,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function directoryTreeRecords(directory, label) {
  const resolved = path.resolve(directory);
  let rootMetadata;
  try { rootMetadata = fs.lstatSync(resolved); } catch (error) {
    throw new Error(`${label} is unavailable: ${error.message}`);
  }
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(),
    `${label} must be a real directory, not a symlink`);
  const records = [];
  const visit = (current, relative = '') => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      const metadata = fs.lstatSync(child);
      invariant(!metadata.isSymbolicLink(), `${label} contains symbolic link ${childRelative}`);
      if (metadata.isDirectory()) {
        records.push({ path: `${childRelative}/`, type: 'directory' });
        visit(child, childRelative);
      } else {
        invariant(metadata.isFile(), `${label} contains non-regular entry ${childRelative}`);
        const artifact = digestRegularFile(child, `${label} file ${childRelative}`);
        records.push({ path: childRelative, type: 'file', bytes: artifact.bytes, sha256: artifact.sha256 });
      }
    }
  };
  visit(resolved);
  return records;
}

export function directoryTreeEvidence(directory, label) {
  const records = directoryTreeRecords(directory, label);
  const files = records.filter((record) => record.type === 'file');
  return {
    sha256: createHash('sha256').update(`${records.map(stableJson).join('\n')}\n`).digest('hex'),
    bytes: files.reduce((sum, record) => sum + record.bytes, 0),
    files: files.length,
    directories: records.length - files.length,
  };
}
