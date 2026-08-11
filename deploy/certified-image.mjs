#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  SOAK_PROFILE,
  SOAK_RUNTIME_CONFIGURATION,
  databaseReconciliation as reconcileLongSoakDatabase,
  evaluateSoakEvidence as evaluateLongSoakEvidence,
  parseSoakJournal,
  recomputeSoakJournal,
} from '../loadtest_elixir/soak-invariants.mjs';
import { analyzeServerLogs } from '../loadtest_elixir/monitor.mjs';
import { loadConfiguration } from '../loadtest_elixir/load.mjs';
import {
  evaluateReconciliation,
  queryDatabase as queryReconciliationDatabase,
} from '../loadtest_elixir/reconcile-capacity.mjs';
import {
  commonFts5ShadowTables,
  databaseSnapshot,
  validatePinnedElixirSchema,
  verifyFtsIntegrity,
} from '../scripts/check-elixir-data-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REQUIRED_USERS = 10_000;
const REQUIRED_MEMBERSHIPS = 50_000;
const REQUIRED_SHARDS = 4;
const REQUIRED_RAMP_SECONDS = 300;
const REQUIRED_SOAK_SECONDS = 1_860;
const REQUIRED_MONITOR_SECONDS = 2_250;
const REQUIRED_GATE_SECONDS = 1_800;
const REQUIRED_POST_WORKLOAD_SECONDS = 30;
const MINIMUM_COVERAGE_RATIO = 0.95;
const CERTIFIED_CPUS = 2;
const CERTIFIED_CPUSET = '0-1';
const CERTIFIED_MEMORY_BYTES = 3 * 1024 ** 3;
const CERTIFIED_PIDS = 100_000;
const CERTIFIED_NOFILE = 200_000;
const REQUIRED_FAULTS = new Set(['runner-restart-reclaim', 'sqlite-write-lock']);
const REQUIRED_LONG_SOAK_USERS = 5_000;
const REQUIRED_LONG_SOAK_SECONDS = 7_200;
const REQUIRED_LONG_SOAK_CHURN_PERCENT = 10;
const REQUIRED_LONG_SOAK_CHURN_INTERVAL_SECONDS = 300;
const REQUIRED_LONG_SOAK_RUN_RPS = 1;
const PRODUCTION_SOURCE_DATABASE = {
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
const PRODUCTION_SOURCE_CORPUS = {
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
const REQUIRED_FIXTURE_GROUP_SIZE = 25;
const CAPACITY_PROFILES = {
  diagnostic1k: { users: 1_000, groups: 40, shardCount: 4, usersPerShard: 250 },
  final10k: { users: 10_000, groups: 400, shardCount: 4, usersPerShard: 2_500 },
};
const CAPACITY_PHASES = new Set(['diagnostic', 'main10k', 'faults', 'soak5k']);
const REQUIRED_LOAD_THRESHOLDS = {
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
const REQUIRED_ERL_AFLAGS = '+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none';
const ORPHAN_RECLAIM_MS = SOAK_RUNTIME_CONFIGURATION.runnerOrphanReclaimMs;
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
const PRODUCTION_APPLICATION_TABLES_SHA256 =
  '7dc78043644bbc48221038b787d1c7df0edb23c0635ba51ac56dfcec3ef145ff';

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

function sameIntegerSet(left, right) {
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

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoManifestSecrets(value, location = 'manifest') {
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

function runtimeShapeMatches(state) {
  const nofile = state?.ulimits?.find((entry) => entry.Name === 'nofile');
  return state?.nanoCpus === CERTIFIED_CPUS * 1_000_000_000
    && state?.cpusetCpus === CERTIFIED_CPUSET
    && state?.memory === CERTIFIED_MEMORY_BYTES
    && state?.memorySwap === CERTIFIED_MEMORY_BYTES
    && state?.pidsLimit === CERTIFIED_PIDS
    && nofile?.Soft === CERTIFIED_NOFILE
    && nofile?.Hard === CERTIFIED_NOFILE;
}

function validateRealtimeEvidence(expected, presencePlan, observed, expectedSessions, expectedRunners) {
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

function parseArgs(argv) {
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

function artifactSnapshot(filename, label = 'release artifact') {
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

function commandOutput(command, args, options = {}) {
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

function digestRegularFile(filename, label) {
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

function directoryTreeRecords(directory, label) {
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

function directoryTreeEvidence(directory, label) {
  const records = directoryTreeRecords(directory, label);
  const files = records.filter((record) => record.type === 'file');
  return {
    sha256: createHash('sha256').update(`${records.map(stableJson).join('\n')}\n`).digest('hex'),
    bytes: files.reduce((sum, record) => sum + record.bytes, 0),
    files: files.length,
    directories: records.length - files.length,
  };
}

export function validateProductionSourceSummary(summary) {
  const database = summary?.database;
  const counts = database?.counts;
  const corpus = summary?.corpus;
  invariant(summary?.schemaVersion === 1 && summary?.type === 'cascade-production-source-snapshot',
    'production source snapshot schema is invalid');
  invariant(database?.sha256 === PRODUCTION_SOURCE_DATABASE.sha256
    && database?.bytes === PRODUCTION_SOURCE_DATABASE.bytes,
  'production source database differs from the approved immutable snapshot');
  invariant(stableJson(counts) === stableJson(PRODUCTION_SOURCE_DATABASE.counts),
    'production source database baseline differs from the approved snapshot');
  invariant(database.quickCheck === 'ok' && database.foreignKeyViolations === 0,
    'production source database failed SQLite integrity checks');
  invariant(corpus?.sha256 === PRODUCTION_SOURCE_CORPUS.sha256
    && corpus?.bytes === PRODUCTION_SOURCE_CORPUS.bytes
    && corpus?.files === PRODUCTION_SOURCE_CORPUS.files,
  'production source corpus differs from the approved immutable snapshot');
  for (const name of ['vaults', 'qmd']) {
    invariant(stableJson(corpus?.[name]) === stableJson(PRODUCTION_SOURCE_CORPUS[name]),
      `production source ${name} corpus differs from the approved immutable snapshot`);
  }
  invariant(corpus.bytes === corpus.vaults.bytes + corpus.qmd.bytes
    && corpus.files === corpus.vaults.files + corpus.qmd.files
    && corpus.sha256 === createHash('sha256').update(stableJson({
      qmd: corpus.qmd,
      vaults: corpus.vaults,
    })).digest('hex'),
  'production source corpus aggregate differs from its vault/QMD evidence');
  return summary;
}

export function collectProductionSourceEvidence(databaseFilename, corpusRoot) {
  const database = digestRegularFile(databaseFilename, 'production source database');
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${database.path}${suffix}`),
      `production source database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const databaseUri = `${pathToFileURL(database.path).href}?immutable=1`;
  const sql = `
SELECT
  (SELECT count(*) FROM users) AS users,
  (SELECT count(*) FROM vaults) AS vaults,
  (SELECT count(*) FROM vault_members) AS memberships,
  (SELECT count(*) FROM notes) AS notes,
  (SELECT count(*) FROM chat_messages) AS messages,
  (SELECT count(*) FROM runs) AS runs,
  (SELECT count(*) FROM run_events) AS runEvents,
  (SELECT count(*) FROM delegated_runs) AS delegatedRuns,
  (SELECT count(*) FROM delegated_runs d JOIN runs r ON r.id=d.run_id
    WHERE r.status IN ('queued','running')) AS openDelegatedRuns,
  (SELECT max(id) FROM runs) AS maxRunId,
  (SELECT count(*) FROM pragma_foreign_key_check) AS foreignKeyViolations,
  (SELECT group_concat(quick_check, ',') FROM pragma_quick_check) AS quickCheck;
`;
  const rows = JSON.parse(commandOutput('sqlite3', ['-readonly', '-json', databaseUri, sql]));
  invariant(rows.length === 1, `production source database query returned ${rows.length} rows`);
  const databaseAfterQuery = digestRegularFile(database.path, 'production source database');
  invariant(database.sha256 === databaseAfterQuery.sha256 && database.bytes === databaseAfterQuery.bytes,
    'production source database changed while provenance was collected');
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${database.path}${suffix}`),
      `production source database query created a ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const { foreignKeyViolations, quickCheck, ...counts } = rows[0];
  const vaultCorpusRoot = path.join(path.resolve(corpusRoot), 'vaults');
  const expectedVaultRoots = ['1', '3', '4', '5', '6', '7', 'My Vault'].sort();
  const actualVaultRoots = fs.readdirSync(vaultCorpusRoot, { withFileTypes: true })
    .map((entry) => entry.name).sort();
  invariant(stableJson(actualVaultRoots) === stableJson(expectedVaultRoots),
    'production source corpus must contain only the seven approved production vault roots');
  const vaults = directoryTreeEvidence(vaultCorpusRoot, 'production vault corpus');
  const qmd = directoryTreeEvidence(path.join(path.resolve(corpusRoot), 'qmd'), 'production QMD corpus');
  return validateProductionSourceSummary({
    schemaVersion: 1,
    type: 'cascade-production-source-snapshot',
    database: { sha256: database.sha256, bytes: database.bytes, counts, quickCheck, foreignKeyViolations },
    corpus: {
      sha256: createHash('sha256').update(stableJson({ qmd, vaults })).digest('hex'),
      bytes: vaults.bytes + qmd.bytes,
      files: vaults.files + qmd.files,
      vaults,
      qmd,
    },
  });
}

function sqliteJson(database, sql) {
  const uri = `${pathToFileURL(path.resolve(database)).href}?immutable=1`;
  const output = commandOutput('sqlite3', ['-readonly', '-json', uri, sql], { maxBuffer: 64 * 1024 * 1024 });
  return output ? JSON.parse(output) : [];
}

function capacityFixtureIdentities(artifact) {
  return artifact.text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    const fixture = JSON.parse(line);
    const claims = JSON.parse(Buffer.from(fixture.token.split('.')[1], 'base64url').toString('utf8'));
    return {
      sourceIndex: index,
      userId: claims.id,
      username: claims.username,
      vaultId: fixture.vaultId,
      channelId: fixture.channelId,
      ownedChatChannels: fixture.ownedChatChannels,
    };
  });
}

export function validateFixtureDatabaseIdentity(database, fixtureArtifact) {
  const fixtures = capacityFixtureIdentities(fixtureArtifact);
  const users = new Map(sqliteJson(database,
    'SELECT id,username,password_hash,auth_version FROM users;')
    .map((row) => [row.id, row]));
  const memberships = new Map(sqliteJson(database, 'SELECT vault_id,user_id,role FROM vault_members;')
    .map((row) => [`${row.vault_id}\u0000${row.user_id}`, row]));
  const vaults = new Map(sqliteJson(database, 'SELECT id,created_by FROM vaults;')
    .map((row) => [row.id, row]));
  const channels = new Map(sqliteJson(database,
    "SELECT id,vault_id,created_by,content FROM notes WHERE content='cascade://chat-channel';")
    .map((row) => [row.id, row]));
  const activities = new Map(sqliteJson(database,
    'SELECT note_id,actor_user_id,count(*) AS activityCount FROM community_note_activity GROUP BY note_id,actor_user_id;')
    .map((row) => [`${row.note_id}\u0000${row.actor_user_id}`, row.activityCount]));
  const ownerByGroup = new Map();
  for (const fixture of fixtures) {
    if (fixture.ownedChatChannels === 1) ownerByGroup.set(fixture.vaultId, fixture.userId);
  }
  let userMismatches = 0;
  let membershipMismatches = 0;
  let vaultMismatches = 0;
  let channelMismatches = 0;
  let activityMismatches = 0;
  for (const fixture of fixtures) {
    const user = users.get(fixture.userId);
    if (user?.username !== fixture.username
      || user?.password_hash !== '!capacity-fixture-no-password-login!'
      || user?.auth_version !== 0) userMismatches += 1;
    const membership = memberships.get(`${fixture.vaultId}\u0000${fixture.userId}`);
    const expectedRole = fixture.ownedChatChannels === 1 ? 'owner' : 'editor';
    if (membership?.role !== expectedRole) membershipMismatches += 1;
  }
  for (const [vaultId, ownerId] of ownerByGroup) {
    const vault = vaults.get(vaultId);
    if (vault?.created_by !== ownerId) vaultMismatches += 1;
    const fixture = fixtures.find((entry) => entry.vaultId === vaultId);
    const channel = channels.get(fixture?.channelId);
    if (channel?.vault_id !== vaultId || channel?.created_by !== ownerId
        || channel?.content !== 'cascade://chat-channel') channelMismatches += 1;
    if (activities.get(`${fixture?.channelId}\u0000${ownerId}`) !== 1) activityMismatches += 1;
  }
  const evidence = {
    users: fixtures.length,
    groups: ownerByGroup.size,
    userMismatches,
    membershipMismatches,
    vaultMismatches,
    channelMismatches,
    activityMismatches,
    identitySha256: createHash('sha256').update(stableJson(fixtures)).digest('hex'),
  };
  invariant(evidence.users === fixtures.length
    && evidence.groups === fixtures.length / REQUIRED_FIXTURE_GROUP_SIZE
    && userMismatches === 0 && membershipMismatches === 0
    && vaultMismatches === 0 && channelMismatches === 0 && activityMismatches === 0,
  'capacity fixture identities do not exactly match users, memberships, vault owners, and channels');
  return evidence;
}

function inspectContainerDataMount(containerReference) {
  const [inspection] = JSON.parse(commandOutput('docker', ['inspect', containerReference]));
  invariant(inspection?.Id, `capacity container ${containerReference} is unavailable`);
  const environment = Object.fromEntries((inspection.Config?.Env || []).map((entry) => {
    const separator = entry.indexOf('=');
    return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const containerDatabase = environment.DOCS_DB_PATH;
  invariant(typeof containerDatabase === 'string' && path.posix.isAbsolute(containerDatabase),
    'capacity container has no absolute DOCS_DB_PATH');
  const mounts = (inspection.Mounts || []).filter((mount) => (
    mount.Type === 'bind'
    && (containerDatabase === mount.Destination
      || containerDatabase.startsWith(`${mount.Destination.replace(/\/$/u, '')}/`))
  ));
  invariant(mounts.length === 1 && mounts[0].RW === true,
    'capacity container database is not on one writable bind mount');
  const mount = mounts[0];
  const relativeDatabase = path.posix.relative(mount.Destination, containerDatabase);
  invariant(relativeDatabase && !relativeDatabase.startsWith('../') && !path.posix.isAbsolute(relativeDatabase),
    'capacity container database escapes its data mount');
  const mountSource = fs.realpathSync(mount.Source);
  const hostPath = (containerPath, label) => {
    invariant(typeof containerPath === 'string'
      && (containerPath === mount.Destination
        || containerPath.startsWith(`${mount.Destination.replace(/\/$/u, '')}/`)),
    `${label} is outside the capacity data mount`);
    const relative = path.posix.relative(mount.Destination, containerPath);
    const resolved = path.resolve(mountSource, relative);
    invariant(resolved === mountSource || resolved.startsWith(`${mountSource}${path.sep}`),
      `${label} host path escapes its mount`);
    return resolved;
  };
  const database = hostPath(containerDatabase, 'capacity database');
  invariant(database.startsWith(`${mountSource}${path.sep}`), 'capacity database host path escapes its mount');
  return {
    inspection,
    database,
    mountDestination: mount.Destination,
    mountSourceSha256: createHash('sha256').update(mountSource).digest('hex'),
    relativeDatabase,
    vaultsDirectory: hostPath(environment.CASCADE_VAULTS_BASE_DIR, 'capacity vault corpus'),
    qmdDirectory: hostPath(environment.CASCADE_QMD_DIR, 'capacity QMD corpus'),
    vaultsContainerDirectory: environment.CASCADE_VAULTS_BASE_DIR,
    qmdContainerDirectory: environment.CASCADE_QMD_DIR,
  };
}

function containerRuntimeEvidence(inspection) {
  const environment = Object.fromEntries((inspection.Config?.Env || []).map((entry) => {
    const separator = entry.indexOf('=');
    return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const host = inspection.HostConfig || {};
  const nofile = (host.Ulimits || []).find((entry) => entry.Name === 'nofile');
  const envelope = {
    nanoCpus: host.NanoCpus,
    cpusetCpus: host.CpusetCpus,
    memory: host.Memory,
    memorySwap: host.MemorySwap,
    pidsLimit: host.PidsLimit,
    nofileSoft: nofile?.Soft,
    nofileHard: nofile?.Hard,
  };
  const configuration = {
    httpAcceptors: Number(environment.CASCADE_HTTP_ACCEPTORS),
    httpMaxConnections: Number(environment.CASCADE_HTTP_MAX_CONNECTIONS),
    httpBacklog: Number(environment.CASCADE_HTTP_BACKLOG),
    networkMode: /^(?:1|true)$/iu.test(environment.CASCADE_NETWORK_MODE || ''),
    trustProxyHops: Number(environment.CASCADE_TRUST_PROXY_HOPS),
    qmdWorkerEnabled: /^(?:1|true)$/iu.test(environment.CASCADE_QMD_WORKER_ENABLED || ''),
    realtimeHibernateAfterMs: Number(environment.CASCADE_REALTIME_HIBERNATE_AFTER_MS),
    runnerOrphanReclaimMs: Number(environment.CASCADE_RUNNER_ORPHAN_RECLAIM_MS),
    sqlitePoolSize: Number(environment.CASCADE_SQLITE_POOL_SIZE),
    sqliteBusyTimeoutMs: Number(environment.CASCADE_SQLITE_BUSY_TIMEOUT_MS),
  };
  invariant(envelope.nanoCpus === CERTIFIED_CPUS * 1_000_000_000
    && envelope.cpusetCpus === CERTIFIED_CPUSET
    && envelope.memory === CERTIFIED_MEMORY_BYTES
    && envelope.memorySwap === CERTIFIED_MEMORY_BYTES
    && envelope.pidsLimit === CERTIFIED_PIDS
    && envelope.nofileSoft === CERTIFIED_NOFILE && envelope.nofileHard === CERTIFIED_NOFILE,
  'capacity phase runtime envelope differs from the certified shape');
  invariant(stableJson(configuration) === stableJson(SOAK_RUNTIME_CONFIGURATION),
    'capacity phase runtime configuration differs from the certified contract');
  invariant(environment.ERL_AFLAGS === REQUIRED_ERL_AFLAGS,
    'capacity phase BEAM scheduler flags differ from the certified contract');
  return { envelope, configuration, erlAflags: environment.ERL_AFLAGS };
}

function relativeFixtureVaultRoots(database, fixtureArtifact, containerMount) {
  const fixtureUserIds = new Set(capacityFixtureIdentities(fixtureArtifact).map((fixture) => fixture.userId));
  const rows = sqliteJson(database, 'SELECT id,root_path,created_by FROM vaults;')
    .filter((row) => fixtureUserIds.has(row.created_by));
  invariant(rows.length === fixtureUserIds.size / REQUIRED_FIXTURE_GROUP_SIZE,
    'fixture vault roots do not match the exact fixture owner cohort');
  const roots = rows.map((row) => {
    const root = String(row.root_path || '');
    let relative;
    if (path.isAbsolute(root) && (root === containerMount.vaultsDirectory
        || root.startsWith(`${containerMount.vaultsDirectory}${path.sep}`))) {
      relative = path.relative(containerMount.vaultsDirectory, root);
    } else if (root === containerMount.vaultsContainerDirectory
        || root.startsWith(`${containerMount.vaultsContainerDirectory.replace(/\/$/u, '')}/`)) {
      relative = path.posix.relative(containerMount.vaultsContainerDirectory, root);
    }
    invariant(relative && !relative.startsWith('../') && !path.isAbsolute(relative),
      `fixture vault ${row.id} root is outside the candidate vault corpus`);
    const normalized = relative.split(path.sep).join('/');
    const [topLevel] = normalized.split('/');
    invariant(topLevel && normalized.startsWith(`${topLevel}/`),
      `fixture vault ${row.id} does not have an isolated top-level root`);
    return topLevel;
  });
  const approvedRoots = new Set(['1', '3', '4', '5', '6', '7', 'My Vault']);
  invariant(new Set(roots).size === rows.length
    && roots.every((root) => !approvedRoots.has(root)),
  'fixture vault roots must be unique top-level paths disjoint from production roots');
  return roots;
}

export function compareCorpusTree(
  sourceDirectory,
  candidateDirectory,
  label,
  allowedExtraRoots,
) {
  const sourceRecords = directoryTreeRecords(sourceDirectory, `${label} approved source`);
  const candidateRecords = directoryTreeRecords(candidateDirectory, `${label} candidate`);
  const candidateByPath = new Map(candidateRecords.map((record) => [record.path, record]));
  let missingOrChanged = 0;
  for (const record of sourceRecords) {
    const candidate = candidateByPath.get(record.path);
    if (stableJson(candidate) === stableJson(record)) continue;
    missingOrChanged += 1;
  }
  const sourcePaths = new Set(sourceRecords.map((record) => record.path));
  const extras = candidateRecords.filter((record) => !sourcePaths.has(record.path));
  const roots = [...allowedExtraRoots].map((root) => root.replace(/\/$/u, ''));
  const unexpectedExtras = extras.filter((record) => !roots.some(
    (root) => record.path === `${root}/` || record.path.startsWith(`${root}/`),
  ));
  invariant(missingOrChanged === 0,
    `${label} candidate mutated or omitted ${missingOrChanged} approved production records`);
  invariant(unexpectedExtras.length === 0,
    `${label} candidate contains ${unexpectedExtras.length} extras not attributable to fixture vaults`);
  return {
    approvedRecords: sourceRecords.length,
    approvedSha256: createHash('sha256')
      .update(`${sourceRecords.map(stableJson).join('\n')}\n`).digest('hex'),
    missingOrChanged,
    extraRecords: extras.length,
    unexpectedExtras: unexpectedExtras.length,
    extrasSha256: createHash('sha256').update(`${extras.map(stableJson).join('\n')}\n`).digest('hex'),
    derivedIndexChanges: 0,
    derivedIndexChangesSha256: createHash('sha256').update('\n').digest('hex'),
  };
}

function validateCandidateCorpus(
  sourceCorpusRoot,
  containerMount,
  database,
  fixtureArtifact,
  { postRun: _postRun = false } = {},
) {
  const fixtureVaultRoots = relativeFixtureVaultRoots(database, fixtureArtifact, containerMount);
  const fixtureVaultIds = new Set(capacityFixtureIdentities(fixtureArtifact).map((fixture) => fixture.vaultId));
  const fixtureQmdRoots = [...fixtureVaultIds].map((vaultId) => Buffer.from(vaultId).toString('base64url'));
  const approvedQmdRoots = new Set(fs.readdirSync(path.join(path.resolve(sourceCorpusRoot), 'qmd')));
  invariant(new Set(fixtureQmdRoots).size === fixtureQmdRoots.length
    && fixtureQmdRoots.every((root) => !approvedQmdRoots.has(root)),
  'fixture QMD roots must be unique and disjoint from production roots');
  return {
    vaults: compareCorpusTree(
      path.join(path.resolve(sourceCorpusRoot), 'vaults'),
      containerMount.vaultsDirectory,
      'vault corpus',
      fixtureVaultRoots,
    ),
    qmd: compareCorpusTree(
      path.join(path.resolve(sourceCorpusRoot), 'qmd'),
      containerMount.qmdDirectory,
      'QMD corpus',
      fixtureQmdRoots,
    ),
  };
}

function databaseBaseline(database) {
  const sql = `
SELECT
  (SELECT count(*) FROM users) AS users,
  (SELECT count(*) FROM vaults) AS vaults,
  (SELECT count(*) FROM vault_members) AS memberships,
  (SELECT count(*) FROM notes) AS notes,
  (SELECT count(*) FROM chat_messages) AS messages,
  (SELECT count(*) FROM runs) AS runs,
  (SELECT count(*) FROM run_events) AS runEvents,
  (SELECT count(*) FROM delegated_runs) AS delegatedRuns,
  (SELECT max(id) FROM runs) AS maxRunId,
  (SELECT count(*) FROM pragma_foreign_key_check) AS foreignKeyViolations,
  (SELECT group_concat(quick_check, ',') FROM pragma_quick_check) AS quickCheck;
`;
  const rows = sqliteJson(database, sql);
  invariant(rows.length === 1, `capacity database baseline query returned ${rows.length} rows`);
  return rows[0];
}

function expectedFixtureDatabaseBaseline(sourceSnapshot, fixture) {
  return {
    users: sourceSnapshot.database.counts.users + fixture.users,
    vaults: sourceSnapshot.database.counts.vaults + fixture.groups,
    memberships: sourceSnapshot.database.counts.memberships + fixture.users,
    notes: sourceSnapshot.database.counts.notes + fixture.groups,
    messages: sourceSnapshot.database.counts.messages,
    runs: sourceSnapshot.database.counts.runs,
    runEvents: sourceSnapshot.database.counts.runEvents,
    delegatedRuns: sourceSnapshot.database.counts.delegatedRuns,
    maxRunId: sourceSnapshot.database.counts.maxRunId,
    quickCheck: 'ok',
    foreignKeyViolations: 0,
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function applicationColumns(snapshot, derivedFtsTables) {
  const tables = new Map();
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    if (table.rows.virtual || derivedFtsTables.has(tableName)
        || tableName === 'cascade_elixir_schema_migrations') continue;
    tables.set(tableName, {
      columns: table.columns.map((column) => column.name),
      includesRowid: table.rows.includesRowid,
    });
  }
  return tables;
}

export function validateFtsIntegrity(database, snapshot = databaseSnapshot(database)) {
  verifyFtsIntegrity(database, snapshot);
  const [coverage] = sqliteJson(database, `
SELECT
  (SELECT count(*) FROM notes) AS notes,
  (SELECT count(*) FROM notes_fts) AS notesFts,
  (SELECT count(*) FROM chat_messages) AS messages,
  (SELECT count(*) FROM chat_messages_fts) AS messagesFts;
`);
  invariant(coverage?.notes === coverage?.notesFts
    && coverage?.messages === coverage?.messagesFts,
  'candidate FTS virtual tables do not semantically cover notes and chat messages');
  const schema = ['chat_messages_fts', 'notes_fts'].map((table) => snapshot.schema[`table:${table}`]);
  invariant(schema.every(Boolean), 'candidate FTS virtual table schema is missing');
  return {
    ...coverage,
    integrityCheck: 'rank=1 passed on disposable snapshot',
    schemaSha256: createHash('sha256').update(stableJson(schema)).digest('hex'),
  };
}

function semanticJsonEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  try {
    return stableJson(JSON.parse(left)) === stableJson(JSON.parse(right));
  } catch {
    return false;
  }
}

function validateApprovedChatTransforms(sourceDatabase, candidateDatabase) {
  const sourceUri = `${pathToFileURL(path.resolve(sourceDatabase)).href}?immutable=1`.replaceAll("'", "''");
  const candidateUri = `${pathToFileURL(path.resolve(candidateDatabase)).href}?immutable=1`;
  const rows = JSON.parse(commandOutput('sqlite3', ['-readonly', '-json', candidateUri, `
ATTACH DATABASE '${sourceUri}' AS approved;
SELECT s.rowid AS sourceRowid,s.id,s.run_id AS sourceRunId,
  s.mission_json AS sourceMissionJson,s.mission_task_id AS sourceMissionTaskId,
  c.rowid AS candidateRowid,c.run_id AS candidateRunId,
  c.mission_json AS candidateMissionJson,c.mission_task_id AS candidateMissionTaskId,
  (SELECT t.id FROM main.chat_mission_tasks t
   WHERE t.run_id=s.run_id ORDER BY t.rowid LIMIT 1) AS expectedBackfill
FROM approved.chat_messages s
LEFT JOIN main.chat_messages c ON c.id=s.id
ORDER BY s.rowid;
`], { maxBuffer: 64 * 1024 * 1024 }) || '[]');
  let missionJsonSemanticReencodes = 0;
  let missionTaskBackfills = 0;
  for (const row of rows) {
    invariant(row.candidateRowid === row.sourceRowid && row.candidateRunId === row.sourceRunId,
      `approved chat message ${row.id} identity or rowid changed`);
    invariant(semanticJsonEqual(row.sourceMissionJson, row.candidateMissionJson),
      `approved chat message ${row.id} mission JSON changed semantically`);
    if (row.sourceMissionJson !== row.candidateMissionJson) missionJsonSemanticReencodes += 1;
    const expectedTask = row.sourceMissionTaskId
      ?? (row.sourceRunId == null ? null : row.expectedBackfill ?? null);
    invariant(row.candidateMissionTaskId === expectedTask,
      `approved chat message ${row.id} mission task link differs from the deterministic backfill`);
    if (row.sourceMissionTaskId !== row.candidateMissionTaskId) missionTaskBackfills += 1;
  }
  return {
    rows: rows.length,
    missionJsonSemanticReencodes,
    missionTaskBackfills,
    sha256: createHash('sha256').update(stableJson(rows.map((row) => ({
      rowid: row.sourceRowid,
      id: row.id,
      missionJsonEquivalent: semanticJsonEqual(row.sourceMissionJson, row.candidateMissionJson),
      expectedMissionTaskId: row.sourceMissionTaskId
        ?? (row.sourceRunId == null ? null : row.expectedBackfill ?? null),
      candidateMissionTaskId: row.candidateMissionTaskId,
    })))).digest('hex'),
  };
}

export function compareProductionRows(
  sourceDatabase,
  candidateDatabase,
  { profileName = 'final10k', phase = 'preflight', allowOrphanReclaim = false } = {},
) {
  const profile = CAPACITY_PROFILES[profileName];
  invariant(profile, `unsupported logical row-comparison profile ${profileName}`);
  const sourceSnapshot = databaseSnapshot(sourceDatabase);
  const candidateSnapshot = databaseSnapshot(candidateDatabase);
  const schemaFailures = validatePinnedElixirSchema(sourceSnapshot, candidateSnapshot);
  invariant(schemaFailures.length === 0,
    `candidate schema differs from the pinned Elixir transform: ${schemaFailures.join('; ')}`);
  const derivedFtsTables = commonFts5ShadowTables(sourceSnapshot, candidateSnapshot);
  const sourceTables = applicationColumns(sourceSnapshot, derivedFtsTables);
  const candidateTables = applicationColumns(candidateSnapshot, derivedFtsTables);
  const sourceTableNames = [...sourceTables.keys()].sort();
  invariant(sourceTableNames.every((table) => candidateTables.has(table)),
    'candidate database is missing approved application tables');
  invariant([...candidateTables.keys()].every((table) => sourceTables.has(table)),
    'candidate database contains an unexpected application table');
  const comparisons = sourceTableNames.map((table) => {
    const candidateColumns = new Set(candidateTables.get(table).columns);
    const sourceTable = sourceTables.get(table);
    const columns = sourceTable.columns.filter((column) => (
      table !== 'chat_messages' || !['mission_json', 'mission_task_id'].includes(column)
    ));
    invariant(columns.every((column) => candidateColumns.has(column)),
      `candidate table ${table} is missing approved semantic columns`);
    const selected = [
      ...(sourceTable.includesRowid ? ['rowid'] : []),
      ...columns.map(quoteIdentifier),
    ].join(',');
    const quotedTable = quoteIdentifier(table);
    return `SELECT '${table.replaceAll("'", "''")}' AS tableName,
      (SELECT count(*) FROM (
        SELECT ${selected} FROM approved.${quotedTable}
        EXCEPT SELECT ${selected} FROM main.${quotedTable}
      )) AS missingRows,
      (SELECT count(*) FROM (
        SELECT ${selected} FROM main.${quotedTable}
        EXCEPT SELECT ${selected} FROM approved.${quotedTable}
      )) AS extraRows`;
  });
  const sourceUri = `${pathToFileURL(path.resolve(sourceDatabase)).href}?immutable=1`.replaceAll("'", "''");
  const candidateUri = `${pathToFileURL(path.resolve(candidateDatabase)).href}?immutable=1`;
  const sql = `ATTACH DATABASE '${sourceUri}' AS approved;\n${comparisons.join('\nUNION ALL\n')};`;
  const result = commandOutput('sqlite3', ['-readonly', '-json', candidateUri, sql], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows = result ? JSON.parse(result) : [];
  invariant(rows.length === sourceTableNames.length,
    'logical production row comparison returned incomplete table evidence');
  const expectedFixtureExtras = {
    users: profile.users,
    vaults: profile.groups,
    vault_members: profile.users,
    notes: profile.groups,
    community_note_activity: profile.groups,
  };
  for (const row of rows) {
    const allowedMissing = allowOrphanReclaim && ['runs', 'delegated_runs'].includes(row.tableName) ? 2 : 0;
    invariant(row.missingRows === allowedMissing,
      `candidate table ${row.tableName} changes or omits ${row.missingRows} approved rows`);
    if (phase === 'preflight') {
      invariant(row.extraRows === (expectedFixtureExtras[row.tableName] || 0),
        `candidate table ${row.tableName} has ${row.extraRows} rows outside the exact fixture delta`);
    }
  }
  const migrations = sqliteJson(candidateDatabase,
    'SELECT version,name,checksum FROM cascade_elixir_schema_migrations ORDER BY version;');
  invariant(stableJson(migrations) === stableJson([{
    version: 1,
    name: 'core_node_schema_compatibility',
    checksum: 'b844b7f41e5377d5ce8ff5dd3c3cc0951cab766773f5bf0816aaec45864d338a',
  }]), 'candidate Elixir schema migration identity is not exact');
  const fts = validateFtsIntegrity(candidateDatabase, candidateSnapshot);
  const chatTransforms = validateApprovedChatTransforms(sourceDatabase, candidateDatabase);
  invariant(chatTransforms.missionJsonSemanticReencodes === 0,
    'candidate rewrote approved mission JSON bytes');
  return {
    sourceSha256: digestRegularFile(sourceDatabase, 'production row-comparison source').sha256,
    phase,
    profile: profileName,
    tables: rows.length,
    tableNames: sourceTableNames,
    tableNamesSha256: createHash('sha256').update(stableJson(sourceTableNames)).digest('hex'),
    tableDeltas: rows,
    missingRows: rows.reduce((sum, row) => sum + row.missingRows, 0),
    extraRows: rows.reduce((sum, row) => sum + row.extraRows, 0),
    tableEvidenceSha256: createHash('sha256').update(stableJson(rows)).digest('hex'),
    schemaMigrationSha256: createHash('sha256').update(stableJson(migrations)).digest('hex'),
    schemaEvidenceSha256: createHash('sha256')
      .update(stableJson(candidateSnapshot.schema)).digest('hex'),
    schemaValidation: 'pinned Elixir transform passed',
    chatTransforms,
    fts,
    forbiddenChanges: 0,
  };
}

function validateLogicalTableEvidence(sourceRows, expectedTableNames = null) {
  const deltas = sourceRows?.tableDeltas;
  invariant(Array.isArray(deltas) && deltas.length > 0
    && sourceRows.tables === deltas.length,
  'logical production row evidence has an incomplete table set');
  const names = deltas.map((row) => row.tableName);
  const sortedNames = [...names].sort();
  invariant(names.every((name) => typeof name === 'string' && name !== '')
    && new Set(names).size === names.length
    && stableJson(names) === stableJson(sortedNames)
    && stableJson(sourceRows.tableNames) === stableJson(names)
    && stableJson(names) === stableJson(PRODUCTION_APPLICATION_TABLES)
    && sourceRows.tableNamesSha256 === createHash('sha256').update(stableJson(names)).digest('hex'),
  'logical production row evidence has duplicate, missing, or reordered tables');
  invariant(sourceRows.tableNamesSha256 === PRODUCTION_APPLICATION_TABLES_SHA256,
    'logical production row evidence table set differs from the approved production database');
  invariant(sourceRows.tableEvidenceSha256
    === createHash('sha256').update(stableJson(deltas)).digest('hex'),
  'logical production row evidence digest differs from its table deltas');
  invariant(deltas.every((row) => Number.isInteger(row.missingRows)
    && row.missingRows >= 0 && Number.isInteger(row.extraRows) && row.extraRows >= 0),
  'logical production row evidence contains invalid table counts');
  if (expectedTableNames) {
    invariant(stableJson(names) === stableJson(expectedTableNames),
      'phase freeze logical table set differs from its approved preflight');
  }
  return names;
}

export function validateBaselineOrphanState(database, reclaimed) {
  const rows = sqliteJson(database, `
SELECT r.id,r.status,r.summary,
  EXISTS(SELECT 1 FROM delegated_runs d WHERE d.run_id=r.id) AS delegated,
  (SELECT owner_user_id FROM delegated_runs d WHERE d.run_id=r.id) AS ownerUserId,
  (SELECT max(seq) FROM run_events e WHERE e.run_id=r.id) AS maxSeq,
  (SELECT type FROM run_events e WHERE e.run_id=r.id ORDER BY seq DESC LIMIT 1) AS lastType,
  (SELECT payload_json FROM run_events e WHERE e.run_id=r.id ORDER BY seq DESC LIMIT 1) AS lastPayload
FROM runs r WHERE r.id IN (1896,1897) ORDER BY r.id;
`);
  invariant(rows.length === 2, 'approved baseline delegated runs are missing');
  const expectedSummary = 'Desktop agent runner did not reclaim this run after server restart.';
  const expectedSeq = new Map([[1896, reclaimed ? 1914 : 1913], [1897, reclaimed ? 28 : 27]]);
  const expectedOwner = new Map([[1896, 1], [1897, 4]]);
  for (const row of rows) {
    invariant(row.maxSeq === expectedSeq.get(row.id),
      `baseline delegated run ${row.id} event sequence differs from the duration contract`);
    if (reclaimed) {
      let payload;
      try { payload = JSON.parse(row.lastPayload); } catch { payload = null; }
      invariant(row.status === 'failed' && row.summary === expectedSummary && row.delegated === 0
        && row.ownerUserId == null && row.lastType === 'status'
        && stableJson(payload) === stableJson({ status: 'failed', summary: expectedSummary }),
      `baseline delegated run ${row.id} was not reclaimed with the exact terminal event`);
    } else {
      invariant(row.status === 'queued' && row.summary == null && row.delegated === 1
        && row.ownerUserId === expectedOwner.get(row.id),
        `baseline delegated run ${row.id} changed before the 600-second reclaim boundary`);
    }
  }
  return {
    state: reclaimed ? 'reclaimed' : 'preserved',
    runs: 2,
    sha256: createHash('sha256').update(stableJson(rows)).digest('hex'),
  };
}

export function phaseWorkloadEvidence(database, phase) {
  const predicates = {
    main10k: { run: "prompt LIKE 'capacity proof%'", message: "id GLOB 'load-*'" },
    faults: {
      run: "prompt = 'runner restart recovery proof'",
      message: "id GLOB 'fault-lock-*'",
    },
    soak5k: { run: "prompt = 'two-hour soak invariant proof'", message: '0' },
    diagnostic: { run: "prompt LIKE 'capacity proof%'", message: "id GLOB 'load-*'" },
  }[phase];
  invariant(predicates, `unsupported phase workload evidence ${phase}`);
  const [row] = sqliteJson(database, `
WITH phase_runs AS (SELECT id,status FROM runs WHERE id > 1897 AND ${predicates.run})
SELECT
  (SELECT count(*) FROM phase_runs) AS runs,
  (SELECT count(*) FROM phase_runs WHERE status='completed') AS completedRuns,
  (SELECT count(*) FROM run_events e JOIN phase_runs r ON r.id=e.run_id) AS runEvents,
  (SELECT count(*) FROM (
    SELECT e.run_id FROM run_events e JOIN phase_runs r ON r.id=e.run_id
    GROUP BY e.run_id HAVING min(e.seq)!=1 OR max(e.seq)!=count(*) OR count(DISTINCT e.seq)!=count(*)
  )) AS badRunEventSequences,
  (SELECT count(*) FROM chat_messages WHERE ${predicates.message}) AS messages,
  (SELECT count(DISTINCT id) FROM chat_messages WHERE ${predicates.message}) AS distinctMessages;
`);
  invariant(row && row.badRunEventSequences === 0 && row.messages === row.distinctMessages,
    `phase ${phase} workload database evidence is duplicated or unordered`);
  const workloadRuns = sqliteJson(database, `
SELECT r.id,r.status,r.summary,
  (SELECT count(*) FROM run_events e WHERE e.run_id=r.id) AS eventCount,
  (SELECT count(*) FROM run_events e WHERE e.run_id=r.id
    AND e.type='status' AND json_extract(e.payload_json,'$.status')='completed') AS completedTerminalEvents,
  (SELECT type FROM run_events e WHERE e.run_id=r.id ORDER BY e.seq DESC LIMIT 1) AS lastType,
  (SELECT payload_json FROM run_events e WHERE e.run_id=r.id ORDER BY e.seq DESC LIMIT 1) AS lastPayload
FROM runs r WHERE r.id > 1897 AND ${predicates.run} ORDER BY r.id;
`);
  const workloadMessages = sqliteJson(database, `
SELECT id,vault_id AS vaultId,channel_id AS channelId,body
FROM chat_messages WHERE ${predicates.message} ORDER BY rowid;
`);
  const workloadRunEvents = sqliteJson(database, `
SELECT e.run_id AS runId,e.seq,e.type,e.payload_json AS payloadJson
FROM run_events e JOIN runs r ON r.id=e.run_id
WHERE r.id > 1897 AND ${predicates.run}
ORDER BY e.run_id,e.seq;
`);
  return {
    ...row,
    workloadRuns,
    workloadRunEvents,
    workloadMessages,
    workloadIdentitySha256: createHash('sha256')
      .update(stableJson({ workloadMessages, workloadRunEvents, workloadRuns })).digest('hex'),
  };
}

export function validateFixturePreflight(
  result,
  artifact,
  sourceSnapshot,
  fixture,
  containerMount,
  imageId,
  monitorStartedAt = null,
  expectedProfile = 'final10k',
  expectedPhase = 'main10k',
) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'fixture preflight checksum is invalid');
  invariant(result?.schemaVersion === 1 && result?.type === 'cascade-capacity-fixture-preflight',
    'fixture preflight schema is invalid');
  invariant(result.profile === expectedProfile && CAPACITY_PROFILES[expectedProfile],
    'fixture preflight profile differs from the requested capacity profile');
  invariant(result.phase === expectedPhase && CAPACITY_PHASES.has(expectedPhase),
    'fixture preflight phase differs from the requested capacity phase');
  invariant(result.imageId === imageId
    && result.containerId === containerMount.inspection.Id,
  'fixture preflight image or container differs from capacity evidence');
  invariant(result.containerStartedAt === '0001-01-01T00:00:00Z',
    'fixture preflight container had already been started');
  invariant(stableJson(result.runtime) === stableJson(containerRuntimeEvidence(containerMount.inspection)),
    'fixture preflight runtime shape differs from current container inspect');
  invariant(result.mountDestination === containerMount.mountDestination
    && result.mountSourceSha256 === containerMount.mountSourceSha256
    && result.relativeDatabase === containerMount.relativeDatabase,
  'fixture preflight data mount differs from the owned capacity container');
  invariant(result.sourceDatabaseSha256 === sourceSnapshot.database.sha256
    && result.sourceCorpusSha256 === sourceSnapshot.corpus.sha256
    && result.fixtureSha256 === fixture.sha256,
  'fixture preflight source or fixture identity differs from certification inputs');
  invariant(DIGEST_PATTERN.test(result.databaseSha256 || '')
    && Number.isInteger(result.databaseBytes) && result.databaseBytes > sourceSnapshot.database.bytes
    && /^[0-9]+$/u.test(result.databaseDevice || '') && /^[0-9]+$/u.test(result.databaseInode || ''),
  'fixture preflight database identity is missing or invalid');
  invariant(stableJson(result.baseline) === stableJson(expectedFixtureDatabaseBaseline(sourceSnapshot, fixture)),
    'fixture preflight database counts differ from the production-derived fixture contract');
  invariant(result.identity?.users === fixture.users
    && result.identity?.groups === fixture.groups
    && result.identity?.userMismatches === 0
    && result.identity?.membershipMismatches === 0
    && result.identity?.vaultMismatches === 0
    && result.identity?.channelMismatches === 0
    && result.identity?.activityMismatches === 0
    && DIGEST_PATTERN.test(result.identity?.identitySha256 || ''),
  'fixture preflight identity-to-database joins are incomplete or failed');
  invariant(result.sourceRows?.sourceSha256 === sourceSnapshot.database.sha256
    && result.sourceRows?.forbiddenChanges === 0
    && result.sourceRows?.missingRows === 0
    && Number.isInteger(result.sourceRows?.extraRows)
    && DIGEST_PATTERN.test(result.sourceRows?.tableEvidenceSha256 || '')
    && DIGEST_PATTERN.test(result.sourceRows?.schemaMigrationSha256 || '')
    && DIGEST_PATTERN.test(result.sourceRows?.schemaEvidenceSha256 || '')
    && result.sourceRows?.schemaValidation === 'pinned Elixir transform passed'
    && Number.isInteger(result.sourceRows?.chatTransforms?.rows)
    && DIGEST_PATTERN.test(result.sourceRows?.chatTransforms?.sha256 || '')
    && result.sourceRows?.fts?.integrityCheck === 'rank=1 passed on disposable snapshot',
  'fixture preflight does not prove exact preservation of approved production rows');
  validateLogicalTableEvidence(result.sourceRows);
  const createdAt = Date.parse(result.createdAt);
  invariant(Number.isFinite(createdAt)
    && (monitorStartedAt == null || createdAt <= Date.parse(monitorStartedAt)),
  'fixture preflight timestamp is invalid or later than monitor start');
  invariant(result.walPresent === false && result.shmPresent === false,
    'fixture preflight database was not closed and checkpointed');
  invariant(result.snapshotScratch?.policy
    === 'private owned disk-backed scratch with at least 2 GiB free'
    && /^[0-9]+$/u.test(result.snapshotScratch?.device || '')
    && result.snapshotScratch?.availableBytes >= 2 * 1024 ** 3,
  'fixture preflight did not use the required disk-backed snapshot scratch');
  invariant(['vaults', 'qmd'].every((name) => (
    Number.isInteger(result.candidateCorpus?.[name]?.approvedRecords)
    && result.candidateCorpus[name].approvedRecords > 0
    && DIGEST_PATTERN.test(result.candidateCorpus[name].approvedSha256 || '')
    && result.candidateCorpus[name].missingOrChanged === 0
    && result.candidateCorpus[name].unexpectedExtras === 0
    && result.candidateCorpus[name].derivedIndexChanges === 0
    && DIGEST_PATTERN.test(result.candidateCorpus[name].extrasSha256 || '')
    && DIGEST_PATTERN.test(result.candidateCorpus[name].derivedIndexChangesSha256 || '')
  )), 'fixture preflight candidate corpus evidence is incomplete or failed');
  return {
    sha256: artifact.sha256,
    profile: result.profile,
    phase: result.phase,
    imageId,
    containerId: result.containerId,
    containerStartedAt: result.containerStartedAt,
    runtime: result.runtime,
    mountDestination: result.mountDestination,
    mountSourceSha256: result.mountSourceSha256,
    relativeDatabase: result.relativeDatabase,
    sourceDatabaseSha256: result.sourceDatabaseSha256,
    sourceCorpusSha256: result.sourceCorpusSha256,
    fixtureSha256: result.fixtureSha256,
    databaseSha256: result.databaseSha256,
    databaseBytes: result.databaseBytes,
    databaseDevice: result.databaseDevice,
    databaseInode: result.databaseInode,
    baseline: result.baseline,
    identity: result.identity,
    sourceRows: result.sourceRows,
    candidateCorpus: result.candidateCorpus,
    snapshotScratch: result.snapshotScratch,
    createdAt: result.createdAt,
  };
}

function writeExclusiveJson(filename, value) {
  const output = path.resolve(filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  return output;
}

function preflight(options) {
  invariant(options.container, '--container is required');
  invariant(options.sourceDatabase, '--source-database is required');
  invariant(options.sourceCorpusRoot, '--source-corpus-root is required');
  invariant(options.fixture, '--fixture is required');
  invariant(options.output, '--output is required');
  const snapshotScratch = configureSnapshotScratch(options.scratchDirectory);
  invariant(CAPACITY_PROFILES[options.profile],
    '--profile must be diagnostic1k or final10k');
  invariant(CAPACITY_PHASES.has(options.phase),
    '--phase must be diagnostic, main10k, faults, or soak5k');
  invariant((options.phase === 'diagnostic') === (options.profile === 'diagnostic1k'),
    'diagnostic phase requires diagnostic1k and release phases require final10k');
  const mount = inspectContainerDataMount(options.container);
  invariant(mount.inspection.State?.Running === false
    && mount.inspection.RestartCount === 0 && mount.inspection.State?.OOMKilled === false,
  'fixture preflight requires a never-started/stopped healthy capacity container');
  invariant(mount.inspection.State?.StartedAt === '0001-01-01T00:00:00Z',
    'fixture preflight refuses a previously started container');
  const runtime = containerRuntimeEvidence(mount.inspection);
  const sourceSnapshot = collectProductionSourceEvidence(options.sourceDatabase, options.sourceCorpusRoot);
  const fixtureArtifact = artifactSnapshot(options.fixture, 'capacity fixture evidence');
  const fixture = validateCapacityFixtureArtifact(fixtureArtifact, options.profile);
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${mount.database}${suffix}`),
      `fixture preflight database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const database = digestRegularFile(mount.database, 'fixture preflight database');
  const baseline = databaseBaseline(mount.database);
  const identity = validateFixtureDatabaseIdentity(mount.database, fixtureArtifact);
  const sourceRows = compareProductionRows(options.sourceDatabase, mount.database, {
    profileName: options.profile,
    phase: 'preflight',
  });
  const candidateCorpus = validateCandidateCorpus(
    options.sourceCorpusRoot,
    mount,
    mount.database,
    fixtureArtifact,
  );
  invariant(stableJson(baseline) === stableJson(expectedFixtureDatabaseBaseline(sourceSnapshot, fixture)),
    'fixture preflight database is not an exact production-derived fixture');
  const evidence = {
    schemaVersion: 1,
    type: 'cascade-capacity-fixture-preflight',
    profile: options.profile,
    phase: options.phase,
    imageId: mount.inspection.Image,
    containerId: mount.inspection.Id,
    containerStartedAt: mount.inspection.State.StartedAt,
    runtime,
    mountDestination: mount.mountDestination,
    mountSourceSha256: mount.mountSourceSha256,
    relativeDatabase: mount.relativeDatabase,
    sourceDatabaseSha256: sourceSnapshot.database.sha256,
    sourceCorpusSha256: sourceSnapshot.corpus.sha256,
    fixtureSha256: fixture.sha256,
    databaseSha256: database.sha256,
    databaseBytes: database.bytes,
    databaseDevice: database.device,
    databaseInode: database.inode,
    baseline,
    identity,
    sourceRows,
    candidateCorpus,
    snapshotScratch,
    walPresent: false,
    shmPresent: false,
    createdAt: new Date().toISOString(),
  };
  const output = writeExclusiveJson(options.output, evidence);
  process.stdout.write(`${output}\n`);
}

export function validateFreezeEvidence(result, artifact, preflightEvidence, imageId) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'phase freeze checksum is invalid');
  invariant(result?.schemaVersion === 1 && result?.type === 'cascade-capacity-phase-freeze',
    'phase freeze schema is invalid');
  invariant(result.phase === preflightEvidence.phase && result.profile === preflightEvidence.profile
    && result.imageId === imageId && result.containerId === preflightEvidence.containerId,
  'phase freeze identity differs from its preflight');
  invariant(result.mountSourceSha256 === preflightEvidence.mountSourceSha256
    && result.databaseDevice === preflightEvidence.databaseDevice
    && result.databaseInode === preflightEvidence.databaseInode,
  'phase freeze data root or database inode differs from its preflight');
  invariant(stableJson(result.runtime) === stableJson(preflightEvidence.runtime),
    'phase freeze runtime shape differs from preflight');
  invariant(DIGEST_PATTERN.test(result.databaseSha256 || '')
    && Number.isInteger(result.databaseBytes) && result.databaseBytes >= preflightEvidence.databaseBytes
    && Number.isFinite(Date.parse(result.frozenAt)),
  'phase freeze database identity or timestamp is invalid');
  invariant(result.walPresent === false && result.shmPresent === false,
    'phase freeze database was not checkpointed and closed');
  invariant(result.containerState?.running === false
    && result.containerState?.restartCount === 0 && result.containerState?.oomKilled === false,
  'phase freeze container was not cleanly stopped');
  const containerStartedAt = Date.parse(result.containerStartedAt);
  const frozenAt = Date.parse(result.frozenAt);
  invariant(Number.isFinite(containerStartedAt) && Number.isFinite(frozenAt)
    && frozenAt >= containerStartedAt,
  'phase freeze container lifetime is missing or invalid');
  invariant(result.snapshotScratch?.policy
    === 'private owned disk-backed scratch with at least 2 GiB free'
    && /^[0-9]+$/u.test(result.snapshotScratch?.device || '')
    && result.snapshotScratch?.availableBytes >= 2 * 1024 ** 3,
  'phase freeze did not use the required disk-backed snapshot scratch');
  invariant(['vaults', 'qmd'].every((name) => (
    result.candidateCorpus?.[name]?.approvedRecords
      === preflightEvidence.candidateCorpus?.[name]?.approvedRecords
    && result.candidateCorpus?.[name]?.approvedSha256
      === preflightEvidence.candidateCorpus?.[name]?.approvedSha256
    && result.candidateCorpus?.[name]?.missingOrChanged === 0
    && result.candidateCorpus[name].unexpectedExtras === 0
    && result.candidateCorpus[name].derivedIndexChanges === 0
    && DIGEST_PATTERN.test(result.candidateCorpus[name].extrasSha256 || '')
    && DIGEST_PATTERN.test(result.candidateCorpus[name].derivedIndexChangesSha256 || '')
  )), 'phase freeze candidate corpus evidence is incomplete or failed');
  invariant(result.sourceRows?.sourceSha256 === PRODUCTION_SOURCE_DATABASE.sha256
    && result.sourceRows?.forbiddenChanges === 0
    && DIGEST_PATTERN.test(result.sourceRows?.tableEvidenceSha256 || '')
    && DIGEST_PATTERN.test(result.sourceRows?.schemaEvidenceSha256 || '')
    && result.sourceRows?.schemaValidation === 'pinned Elixir transform passed'
    && result.sourceRows?.fts?.integrityCheck === 'rank=1 passed on disposable snapshot',
  'phase freeze does not preserve approved production rows');
  validateLogicalTableEvidence(
    result.sourceRows,
    preflightEvidence.sourceRows.tableNames,
  );
  invariant(stableJson(result.identity) === stableJson(preflightEvidence.identity),
    'phase freeze fixture identity joins differ from preflight');
  const expectedOrphanState = frozenAt - containerStartedAt >= ORPHAN_RECLAIM_MS
    ? 'reclaimed' : 'preserved';
  invariant(result.orphanState?.state === expectedOrphanState,
  'phase freeze baseline orphan state differs from its duration contract');
  return {
    sha256: artifact.sha256,
    phase: result.phase,
    profile: result.profile,
    imageId,
    containerId: result.containerId,
    mountSourceSha256: result.mountSourceSha256,
    databaseSha256: result.databaseSha256,
    databaseBytes: result.databaseBytes,
    databaseDevice: result.databaseDevice,
    databaseInode: result.databaseInode,
    baseline: result.baseline,
    runtime: result.runtime,
    candidateCorpus: result.candidateCorpus,
    sourceRows: result.sourceRows,
    identity: result.identity,
    orphanState: result.orphanState,
    phaseWorkload: result.phaseWorkload,
    snapshotScratch: result.snapshotScratch,
    containerStartedAt: result.containerStartedAt,
    frozenAt: result.frozenAt,
  };
}

export function validatePhaseTableDeltas(freezeEvidence, fixture, workload) {
  validateLogicalTableEvidence(freezeEvidence.sourceRows);
  const deltas = new Map(freezeEvidence.sourceRows.tableDeltas
    .map((row) => [row.tableName, row]));
  invariant(deltas.size > 0, `phase ${freezeEvidence.phase} has no logical table deltas`);
  const expectedExtras = {
    users: fixture.users,
    vaults: fixture.groups,
    vault_members: fixture.users,
    notes: fixture.groups,
    community_note_activity: fixture.groups,
  };
  const orphanReclaimed = freezeEvidence.orphanState?.state === 'reclaimed';
  if (freezeEvidence.phase === 'main10k') {
    expectedExtras.chat_messages = workload.successfulChatWrites;
    expectedExtras.runs = workload.successfulRuns;
    expectedExtras.run_events = workload.successfulRuns * 4;
  } else if (freezeEvidence.phase === 'faults') {
    expectedExtras.chat_messages = 1;
    expectedExtras.runs = 1;
    expectedExtras.run_events = workload.runEvents;
  } else if (freezeEvidence.phase === 'soak5k') {
    expectedExtras.runs = workload.runCount;
    expectedExtras.run_events = workload.persistedEventCount;
  }
  if (orphanReclaimed) {
    expectedExtras.runs = (expectedExtras.runs || 0) + 2;
    expectedExtras.run_events = (expectedExtras.run_events || 0) + 2;
  }
  for (const [table, row] of deltas) {
    const expectedMissing = orphanReclaimed && ['runs', 'delegated_runs'].includes(table) ? 2 : 0;
    invariant(row.missingRows === expectedMissing,
      `phase ${freezeEvidence.phase} table ${table} changes ${row.missingRows} approved rows`);
    invariant(row.extraRows === (expectedExtras[table] || 0),
      `phase ${freezeEvidence.phase} table ${table} has ${row.extraRows} unexpected rows`);
  }
  return true;
}

function validateFrozenPhaseAgainstMount(
  sourceDatabase,
  sourceCorpusRoot,
  fixtureArtifact,
  preflightEvidence,
  freezeEvidence,
  mount,
) {
  invariant(mount.inspection.Id === freezeEvidence.containerId
    && mount.inspection.Image === freezeEvidence.imageId
    && mount.inspection.State?.Running === false
    && mount.inspection.RestartCount === 0
    && mount.inspection.State?.OOMKilled === false
    && mount.inspection.State?.StartedAt === freezeEvidence.containerStartedAt,
  `phase ${freezeEvidence.phase} frozen container identity or state drifted`);
  invariant(stableJson(containerRuntimeEvidence(mount.inspection)) === stableJson(freezeEvidence.runtime),
    `phase ${freezeEvidence.phase} frozen runtime shape drifted`);
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${mount.database}${suffix}`),
      `phase ${freezeEvidence.phase} frozen database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const database = digestRegularFile(mount.database, `${freezeEvidence.phase} frozen database`);
  invariant(database.sha256 === freezeEvidence.databaseSha256
    && database.bytes === freezeEvidence.databaseBytes
    && database.device === freezeEvidence.databaseDevice
    && database.inode === freezeEvidence.databaseInode,
  `phase ${freezeEvidence.phase} frozen database identity drifted`);
  const expected = {
    baseline: databaseBaseline(mount.database),
    identity: validateFixtureDatabaseIdentity(mount.database, fixtureArtifact),
    candidateCorpus: validateCandidateCorpus(
      sourceCorpusRoot, mount, mount.database, fixtureArtifact, { postRun: true },
    ),
    sourceRows: compareProductionRows(sourceDatabase, mount.database, {
      profileName: preflightEvidence.profile,
      phase: 'post-run',
      allowOrphanReclaim: freezeEvidence.orphanState.state === 'reclaimed',
    }),
    orphanState: validateBaselineOrphanState(
      mount.database, freezeEvidence.orphanState.state === 'reclaimed',
    ),
    phaseWorkload: phaseWorkloadEvidence(mount.database, freezeEvidence.phase),
  };
  for (const [name, value] of Object.entries(expected)) {
    invariant(stableJson(value) === stableJson(freezeEvidence[name]),
      `phase ${freezeEvidence.phase} frozen ${name} differs from independent database/corpus evidence`);
  }
  return true;
}

function freeze(options) {
  invariant(options.container, '--container is required');
  invariant(options.sourceDatabase, '--source-database is required');
  invariant(options.sourceCorpusRoot, '--source-corpus-root is required');
  invariant(options.fixture, '--fixture is required');
  invariant(options.preflight, '--preflight is required');
  invariant(options.output, '--output is required');
  const snapshotScratch = configureSnapshotScratch(options.scratchDirectory);
  const preflightArtifact = artifactSnapshot(options.preflight, 'phase preflight evidence');
  const preflightResult = JSON.parse(preflightArtifact.text);
  const mount = inspectContainerDataMount(options.container);
  invariant(mount.inspection.State?.Running === false
    && mount.inspection.RestartCount === 0 && mount.inspection.State?.OOMKilled === false,
  'phase freeze requires the exact stopped healthy capacity container');
  const sourceSnapshot = collectProductionSourceEvidence(options.sourceDatabase, options.sourceCorpusRoot);
  const fixtureArtifact = artifactSnapshot(options.fixture, 'capacity fixture evidence');
  const fixture = validateCapacityFixtureArtifact(fixtureArtifact, preflightResult.profile);
  const preflightEvidence = validateFixturePreflight(
    preflightResult,
    preflightArtifact,
    sourceSnapshot,
    fixture,
    mount,
    mount.inspection.Image,
    null,
    preflightResult.profile,
    preflightResult.phase,
  );
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${mount.database}${suffix}`),
      `phase freeze database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const database = digestRegularFile(mount.database, 'phase freeze database');
  invariant(database.device === preflightEvidence.databaseDevice
    && database.inode === preflightEvidence.databaseInode,
  'phase freeze database inode differs from preflight');
  const frozenAt = new Date().toISOString();
  const containerStartedAt = mount.inspection.State?.StartedAt;
  const startedAtMs = Date.parse(containerStartedAt);
  const frozenAtMs = Date.parse(frozenAt);
  invariant(Number.isFinite(startedAtMs) && Number.isFinite(frozenAtMs)
    && frozenAtMs >= startedAtMs,
  'phase freeze cannot bind the owned container lifetime');
  const longRunning = frozenAtMs - startedAtMs >= ORPHAN_RECLAIM_MS;
  const evidence = {
    schemaVersion: 1,
    type: 'cascade-capacity-phase-freeze',
    phase: preflightEvidence.phase,
    profile: preflightEvidence.profile,
    imageId: mount.inspection.Image,
    containerId: mount.inspection.Id,
    mountSourceSha256: mount.mountSourceSha256,
    databaseSha256: database.sha256,
    databaseBytes: database.bytes,
    databaseDevice: database.device,
    databaseInode: database.inode,
    runtime: containerRuntimeEvidence(mount.inspection),
    baseline: databaseBaseline(mount.database),
    identity: validateFixtureDatabaseIdentity(mount.database, fixtureArtifact),
    candidateCorpus: validateCandidateCorpus(
      options.sourceCorpusRoot,
      mount,
      mount.database,
      fixtureArtifact,
      { postRun: true },
    ),
    sourceRows: compareProductionRows(
      options.sourceDatabase,
      mount.database,
      {
        profileName: preflightEvidence.profile,
        phase: 'post-run',
        allowOrphanReclaim: longRunning,
      },
    ),
    orphanState: validateBaselineOrphanState(mount.database, longRunning),
    phaseWorkload: phaseWorkloadEvidence(mount.database, preflightEvidence.phase),
    snapshotScratch,
    containerState: {
      running: mount.inspection.State.Running,
      restartCount: mount.inspection.RestartCount,
      oomKilled: mount.inspection.State.OOMKilled,
    },
    containerStartedAt,
    walPresent: false,
    shmPresent: false,
    frozenAt,
  };
  const output = writeExclusiveJson(options.output, evidence);
  process.stdout.write(`${output}\n`);
}

export function validateMonitorEvidence(records, imageId) {
  const start = records.find((record) => record.type === 'start');
  const finish = [...records].reverse().find((record) => record.type === 'finish');
  const samples = records.filter((record) => record.type === 'sample');
  invariant(start && finish, 'capacity monitor evidence must contain start and finish records');
  invariant(typeof start.containerId === 'string' && start.containerId !== '',
    'capacity monitor start evidence has no immutable container ID');
  invariant(samples.length > 0, 'capacity monitor evidence contains no identity-bound samples');
  const monitorStartedAt = Date.parse(start.observedAt);
  const monitorFinishedAt = Date.parse(finish.observedAt);
  invariant(Number.isFinite(monitorStartedAt) && Number.isFinite(monitorFinishedAt)
    && monitorFinishedAt > monitorStartedAt, 'capacity monitor timestamps are invalid');
  invariant(start.imageId === imageId, `capacity monitor exercised ${start.imageId}, expected ${imageId}`);
  invariant(start.expectedShape?.imageId === imageId, 'capacity monitor immutable-image expectation is missing or different');
  invariant(start.expectedShape?.cpus === CERTIFIED_CPUS
    && start.expectedShape?.memoryBytes === CERTIFIED_MEMORY_BYTES,
  'capacity monitor expected a different CPU or memory envelope');
  invariant(runtimeShapeMatches(start.hostConfig),
    'capacity monitor start evidence differs from the certified runtime envelope');
  const containerStartedAt = samples[0]?.containerState?.startedAt;
  invariant(typeof containerStartedAt === 'string' && containerStartedAt !== '',
    'capacity monitor sample evidence has no container start identity');
  const serverLogStart = start.serverLogEvidence;
  const serverLogs = finish.serverLogs;
  const serverLogBaselineAt = Date.parse(serverLogStart?.baselineCursor);
  const serverLogFinishAt = Date.parse(serverLogs?.finishCursor);
  invariant(Number.isFinite(serverLogBaselineAt)
    && serverLogStart.baselineCursor === containerStartedAt
    && serverLogStart.monitorStartedAt === start.observedAt,
  'server-log baseline is not bound to the monitored container and start time');
  invariant(serverLogStart.policy === 'zero fatal/error lines from container start through monitor finish',
    'server-log zero-error policy is missing or different');
  invariant(typeof serverLogStart.output === 'string' && serverLogStart.output !== ''
    && serverLogs?.output === serverLogStart.output,
  'server-log artifact path is missing or changed');
  invariant(serverLogs?.baselineCursor === serverLogStart.baselineCursor
    && Number.isFinite(serverLogFinishAt)
    && serverLogFinishAt >= Date.parse(samples.at(-1)?.observedAt)
    && serverLogFinishAt <= monitorFinishedAt,
  'server-log capture interval is missing, stale, or outside the monitor interval');
  invariant(serverLogs?.readError === null, `server-log capture failed: ${serverLogs?.readError || 'missing evidence'}`);
  invariant(DIGEST_PATTERN.test(serverLogs?.sha256 || ''), 'server-log artifact checksum is invalid');
  invariant(Number.isInteger(serverLogs?.totalBytes) && serverLogs.totalBytes >= 0
    && Number.isInteger(serverLogs?.totalLines) && serverLogs.totalLines >= 0,
  'server-log artifact size or line count is invalid');
  invariant(serverLogs?.matchedErrorLines === 0
    && Array.isArray(serverLogs.matches) && serverLogs.matches.length === 0
    && serverLogs.matchesTruncated === false,
  'server-log evidence contains fatal/error lines or incomplete match evidence');
  for (const sample of samples) {
    invariant(sample.containerState?.containerId === start.containerId
      && sample.containerState?.imageId === imageId
      && sample.containerState?.startedAt === containerStartedAt,
    `capacity monitor container/image identity drifted at ${sample.observedAt || 'an unknown sample'}`);
    invariant(runtimeShapeMatches(sample.containerState),
      `capacity monitor runtime envelope drifted at ${sample.observedAt || 'an unknown sample'}`);
  }
  invariant(start.expectedShape?.sessions >= REQUIRED_USERS, 'capacity monitor did not require 10,000 sessions');
  invariant(start.expectedShape?.runners >= REQUIRED_USERS, 'capacity monitor did not require 10,000 runners');
  invariant(start.expectedShape?.memberships >= REQUIRED_MEMBERSHIPS,
    'capacity monitor did not require 50,000 namespace/room memberships');
  invariant(stableJson(start.expectedShape?.runtime) === stableJson(SOAK_RUNTIME_CONFIGURATION),
    'capacity monitor did not bind the exact production runtime configuration');
  invariant(start.monitorConfig?.durationSeconds >= REQUIRED_MONITOR_SECONDS,
    'capacity monitor duration is shorter than 2,250 seconds');
  invariant(start.monitorConfig?.gateWindowSeconds >= REQUIRED_GATE_SECONDS,
    'capacity headroom window is shorter than 30 minutes');
  invariant(typeof start.monitorConfig?.workloadFinishedMarker === 'string'
    && start.monitorConfig.workloadFinishedMarker !== '', 'capacity monitor did not require a workload-finished marker');
  invariant(start.monitorConfig?.minimumWorkloadSeconds >= REQUIRED_RAMP_SECONDS + REQUIRED_SOAK_SECONDS,
    'capacity monitor allowed the workload marker before the 300-second ramp and 1,860-second soak');
  invariant(start.monitorConfig?.minimumPostWorkloadSeconds >= REQUIRED_POST_WORKLOAD_SECONDS,
    'capacity monitor post-workload observation is shorter than 30 seconds');
  const expectedLoad = start.monitorConfig?.expectedLoad;
  invariant(typeof expectedLoad?.target === 'string' && expectedLoad.target !== '',
    'capacity monitor did not bind the staging target');
  invariant(expectedLoad?.shardCount === REQUIRED_SHARDS,
    'capacity monitor did not bind exactly four load shards');
  invariant(expectedLoad?.rampSeconds === REQUIRED_RAMP_SECONDS
    && expectedLoad?.soakSeconds === REQUIRED_SOAK_SECONDS
    && expectedLoad?.pollingPercent === 5
    && expectedLoad?.reconnectPercent === 10
    && expectedLoad?.reconnectAtSeconds === 600
    && stableJson(expectedLoad?.rates) === stableJson({ chatRps: 6.25, readRps: 12.5, runRps: 0.25 }),
  'capacity monitor did not bind the exact 10,000-user workload configuration');
  invariant(Array.isArray(expectedLoad?.sourceIps) && expectedLoad.sourceIps.length === REQUIRED_SHARDS
    && new Set(expectedLoad.sourceIps).size === REQUIRED_SHARDS,
  'capacity monitor did not bind four distinct load-generator source IPs');
  invariant((monitorFinishedAt - monitorStartedAt) / 1_000
    >= REQUIRED_MONITOR_SECONDS - Math.max((start.monitorConfig?.intervalSeconds || 0) * 2, 2),
  'capacity monitor finish evidence is shorter than its 2,250-second contract');
  invariant(Array.isArray(start.preflightFailures) && start.preflightFailures.length === 0,
    `capacity monitor preflight failed: ${(start.preflightFailures || []).join('; ')}`);
  invariant(finish.evaluation?.ok === true,
    `capacity monitor failed: ${(finish.evaluation?.failures || ['missing evaluation']).join('; ')}`);

  const gateStartSeconds = finish.evaluation?.gateStartSeconds;
  const gateEndSeconds = finish.evaluation?.gateEndSeconds;
  invariant(Number.isFinite(gateStartSeconds) && Number.isFinite(gateEndSeconds)
    && gateEndSeconds - gateStartSeconds >= REQUIRED_GATE_SECONDS,
  'capacity finish evidence does not contain a literal 30-minute gate window');
  invariant(gateEndSeconds <= (monitorFinishedAt - monitorStartedAt) / 1_000,
    'capacity gate ends after the monitor finished');
  const observed = finish.evaluation?.observed;
  invariant(observed?.sessionCoverage >= MINIMUM_COVERAGE_RATIO
    && observed?.sessionsEnd >= REQUIRED_USERS,
  'capacity finish evidence does not prove 10,000-session coverage');
  invariant(observed?.runnerCoverage >= MINIMUM_COVERAGE_RATIO
    && observed?.runnersEnd >= REQUIRED_USERS,
  'capacity finish evidence does not prove 10,000-runner coverage');
  invariant(observed?.membershipCoverage >= MINIMUM_COVERAGE_RATIO
    && observed?.membershipsEnd >= REQUIRED_MEMBERSHIPS,
  'capacity finish evidence does not prove 50,000-membership coverage');

  const workload = finish.workload;
  invariant(workload && Array.isArray(workload.shards), 'capacity finish evidence has no workload marker');
  const workloadGateStartAt = Date.parse(workload.gateStartAt);
  const workloadGateEndAt = Date.parse(workload.gateEndAt);
  invariant(Number.isFinite(workloadGateStartAt) && Number.isFinite(workloadGateEndAt)
    && workloadGateEndAt - workloadGateStartAt >= REQUIRED_GATE_SECONDS * 1_000,
  'workload marker does not identify a literal 30-minute concurrent gate');
  invariant(Math.abs(workloadGateStartAt - (monitorStartedAt + gateStartSeconds * 1_000)) <= 1_000
    && Math.abs(workloadGateEndAt - (monitorStartedAt + gateEndSeconds * 1_000)) <= 1_000
    && Math.abs(workload.gateEndSeconds - gateEndSeconds) <= 1,
  'capacity evaluation gate is not bound to the workload marker gate');
  const workloadFinishedAt = Date.parse(workload.finishedAt);
  const expectedElapsedSeconds = (workloadFinishedAt - monitorStartedAt) / 1_000;
  invariant(Number.isFinite(workloadFinishedAt) && workloadFinishedAt > monitorStartedAt
    && workloadFinishedAt <= monitorFinishedAt, 'workload-finished marker timestamp is stale or invalid');
  invariant(Number.isFinite(workload.elapsedSeconds)
    && Math.abs(workload.elapsedSeconds - expectedElapsedSeconds) <= 1,
  'workload-finished marker elapsed time does not match its timestamp');
  invariant(workload.elapsedSeconds >= start.monitorConfig.minimumWorkloadSeconds,
    'workload-finished marker arrived before the required workload duration');
  invariant(workload.postWorkloadSeconds >= start.monitorConfig.minimumPostWorkloadSeconds
    && workload.postWorkloadSamples > 0,
  'capacity monitor did not observe the required fresh post-workload interval');
  invariant((monitorFinishedAt - workloadFinishedAt) / 1_000 >= start.monitorConfig.minimumPostWorkloadSeconds,
    'capacity finish timestamp does not prove the required post-workload interval');
  invariant(workload.users === REQUIRED_USERS, 'workload-finished marker does not cover exactly 10,000 users');
  invariant(workload.shards.length === REQUIRED_SHARDS, 'workload-finished marker does not cover four shards');
  const workloadShardIndexes = new Set();
  const workloadSourceIps = new Set();
  const workloadReconnectOwnerUserIds = [];
  for (const shard of workload.shards) {
    invariant(Number.isInteger(shard.index) && shard.index >= 0 && shard.index < REQUIRED_SHARDS,
      'workload-finished marker contains an invalid shard index');
    invariant(!workloadShardIndexes.has(shard.index), `workload-finished marker duplicates shard ${shard.index}`);
    workloadShardIndexes.add(shard.index);
    invariant(shard.users === REQUIRED_USERS / REQUIRED_SHARDS,
      `workload-finished marker shard ${shard.index} does not cover 2,500 users`);
    invariant(DIGEST_PATTERN.test(shard.sha256 || ''),
      `workload-finished marker shard ${shard.index} has an invalid checksum`);
    invariant(shard.markerSha256 === shard.sha256,
      `workload-finished marker shard ${shard.index} checksum is not bound to the artifact`);
    invariant(typeof shard.path === 'string' && shard.path !== '',
      `workload-finished marker shard ${shard.index} has no artifact path`);
    invariant(typeof shard.sourceIp === 'string' && shard.sourceIp !== ''
      && !workloadSourceIps.has(shard.sourceIp),
    `workload-finished marker shard ${shard.index} has a missing or duplicate source IP`);
    workloadSourceIps.add(shard.sourceIp);
    invariant(Date.parse(shard.soakStartedAt) <= workloadGateStartAt
      && Date.parse(shard.workloadFinishedAt) >= workloadGateEndAt
      && Date.parse(shard.finishedAt) <= workloadFinishedAt,
    `workload-finished marker shard ${shard.index} does not span the full concurrent gate`);
    invariant(Number.isInteger(shard.initialOwnedChatChannels)
      && shard.initialOwnedChatChannels === start.expectedShape.realtime.groupCount / REQUIRED_SHARDS
      && Number.isInteger(shard.forcedReconnectOwnedChatChannels)
      && shard.forcedReconnectOwnedChatChannels
        === Math.round(start.expectedShape.realtime.groupCount * 0.1) / REQUIRED_SHARDS
      && shard.forcedReconnectStrategy === 'owner-stratified-v1'
      && Array.isArray(shard.forcedReconnectOwnerUserIds)
      && shard.forcedReconnectOwnerUserIds.length === shard.forcedReconnectOwnedChatChannels
      && new Set(shard.forcedReconnectOwnerUserIds).size === shard.forcedReconnectOwnedChatChannels
      && shard.forcedReconnectOwnerUserIds.every(Number.isInteger),
    `workload-finished marker shard ${shard.index} has an invalid presence-owner plan`);
    workloadReconnectOwnerUserIds.push(...shard.forcedReconnectOwnerUserIds);
  }
  validateRealtimeEvidence(
    start.expectedShape.realtime,
    workload.presencePlan,
    observed,
    start.expectedShape.sessions,
    start.expectedShape.runners,
  );
  invariant(workload.shards.reduce((sum, shard) => sum + shard.initialOwnedChatChannels, 0)
      === workload.presencePlan.initialOwnedChatChannels
    && workload.shards.reduce((sum, shard) => sum + shard.forcedReconnectOwnedChatChannels, 0)
      === workload.presencePlan.forcedReconnectOwnedChatChannels,
  'workload-finished marker aggregate presence-owner plan differs from its shards');
  invariant(sameIntegerSet(
    workloadReconnectOwnerUserIds,
    workload.presencePlan.forcedReconnectOwnerUserIds,
  ), 'workload-finished marker reconnect-owner IDs differ from its shards');
  invariant(finish.containerState?.running === true, 'capacity container was not running at certification finish');
  invariant(finish.containerState?.containerId === start.containerId
    && finish.containerState?.imageId === imageId
    && finish.containerState?.startedAt === containerStartedAt,
  'capacity finish container/image identity differs from the monitored image');
  invariant(runtimeShapeMatches(finish.containerState),
    'capacity finish runtime envelope differs from the certified shape');
  invariant(finish.containerState?.oomKilled === false, 'capacity container was OOM-killed');
  invariant(finish.containerState?.restartCount === 0, 'capacity container restarted during certification');
  return { start, finish };
}

export function validateServerLogArtifact(start, finish) {
  const serverLogArtifact = artifactSnapshot(finish.serverLogs.output, 'server-log evidence');
  invariant(serverLogArtifact.path === path.resolve(start.serverLogEvidence.output),
    'server-log artifact path differs from the monitor contract');
  invariant(serverLogArtifact.sha256 === finish.serverLogs.sha256,
    'server-log artifact checksum differs from monitor evidence');
  invariant(Buffer.byteLength(serverLogArtifact.text) === finish.serverLogs.totalBytes,
    'server-log artifact byte count differs from monitor evidence');
  invariant(serverLogArtifact.text.split(/\r?\n/u).filter(Boolean).length === finish.serverLogs.totalLines,
    'server-log artifact line count differs from monitor evidence');
  return serverLogArtifact;
}

export function validateLoadEvidence(results, monitorStart, monitorFinish, artifacts) {
  invariant(results.length > 0, 'at least one load-generator result is required');
  const shardCount = results[0].shard?.count;
  invariant(shardCount === REQUIRED_SHARDS, 'capacity certification requires exactly four load shards');
  invariant(results.length === shardCount, `received ${results.length} load results for ${shardCount} shards`);
  invariant(Array.isArray(artifacts) && artifacts.length === results.length,
    'every load result must be bound to its artifact checksum');
  const shardIndexes = new Set();
  const target = results[0].target;
  invariant(typeof target === 'string' && target !== '', 'load target is missing');
  const expectedLoad = monitorStart.monitorConfig.expectedLoad;
  invariant(target === expectedLoad.target, 'load target differs from the monitor contract');
  const commonConfiguration = JSON.stringify({
    rampSeconds: results[0].rampSeconds,
    soakSeconds: results[0].soakSeconds,
    pollingPercent: results[0].pollingPercent,
    reconnectPercent: results[0].reconnectPercent,
    reconnectAtSeconds: results[0].reconnectAtSeconds,
    rates: results[0].rates,
    thresholds: results[0].thresholds,
  });
  const monitorStartedAt = Date.parse(monitorStart.observedAt);
  const gateStartAt = monitorStartedAt + monitorFinish.evaluation.gateStartSeconds * 1_000;
  const gateEndAt = monitorStartedAt + monitorFinish.evaluation.gateEndSeconds * 1_000;
  invariant(Number.isFinite(gateStartAt) && Number.isFinite(gateEndAt)
    && gateEndAt - gateStartAt >= REQUIRED_GATE_SECONDS * 1_000,
  'monitor gate interval is invalid');
  const markerShards = new Map(monitorFinish.workload.shards.map((shard) => [shard.index, shard]));
  const sourceIps = new Set();
  let users = 0;

  for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
    const result = results[resultIndex];
    const artifact = artifacts[resultIndex];
    invariant(result.evaluation?.ok === true,
      `load shard ${result.shard?.index ?? '?'} failed: ${(result.evaluation?.failures || ['missing evaluation']).join('; ')}`);
    invariant(result.shard?.count === shardCount, 'load results disagree on shard count');
    invariant(result.target === target, 'load results target different staging endpoints');
    invariant(JSON.stringify({
      rampSeconds: result.rampSeconds,
      soakSeconds: result.soakSeconds,
      pollingPercent: result.pollingPercent,
      reconnectPercent: result.reconnectPercent,
      reconnectAtSeconds: result.reconnectAtSeconds,
      rates: result.rates,
      thresholds: result.thresholds,
    }) === commonConfiguration, 'load shards used inconsistent workload configurations');
    invariant(result.rampSeconds === expectedLoad.rampSeconds
      && result.soakSeconds === expectedLoad.soakSeconds
      && result.pollingPercent === expectedLoad.pollingPercent
      && result.reconnectPercent === expectedLoad.reconnectPercent
      && result.reconnectAtSeconds === expectedLoad.reconnectAtSeconds
      && JSON.stringify(result.rates) === JSON.stringify(expectedLoad.rates),
    `load shard ${result.shard?.index ?? '?'} differs from the monitor workload contract`);
    invariant(stableJson(result.thresholds) === stableJson(REQUIRED_LOAD_THRESHOLDS),
      `load shard ${result.shard?.index ?? '?'} thresholds differ from the release contract`);
    invariant(Number.isInteger(result.shard?.index), 'load shard index is missing');
    invariant(!shardIndexes.has(result.shard.index), `duplicate load shard ${result.shard.index}`);
    shardIndexes.add(result.shard.index);
    invariant(result.requestedUsers === REQUIRED_USERS / REQUIRED_SHARDS,
      `load shard ${result.shard.index} does not cover exactly 2,500 users`);
    invariant(result.rampSeconds >= REQUIRED_RAMP_SECONDS,
      `load shard ${result.shard.index} ramped for less than 300 seconds`);
    invariant(result.soakSeconds >= REQUIRED_SOAK_SECONDS,
      `load shard ${result.shard.index} soaked for less than 1,860 seconds`);
    invariant(expectedLoad.sourceIps.includes(result.sourceIp),
      `load shard ${result.shard.index} source IP differs from the monitor contract`);
    invariant(!sourceIps.has(result.sourceIp), `duplicate load-generator source IP ${result.sourceIp}`);
    sourceIps.add(result.sourceIp);
    invariant(result.metrics?.connected === result.requestedUsers && result.metrics?.connectFailures === 0,
      `load shard ${result.shard.index} did not connect every requested user`);
    const messageIds = result.workloadIdentity?.successfulMessageIds;
    const runIds = result.workloadIdentity?.requestedRunIds;
    invariant(Array.isArray(messageIds) && Array.isArray(runIds)
      && messageIds.length === result.metrics?.workload?.chat?.succeeded
      && runIds.length === result.metrics?.workload?.run?.succeeded
      && result.workloadIdentity.successfulMessageIdsCount === messageIds.length
      && result.workloadIdentity.requestedRunIdsCount === runIds.length
      && new Set(messageIds).size === messageIds.length && new Set(runIds).size === runIds.length
      && stableJson(messageIds) === stableJson([...messageIds].sort())
      && stableJson(runIds) === stableJson([...runIds].sort((left, right) => left - right))
      && result.workloadIdentity.successfulMessageIdsSha256
        === createHash('sha256').update(stableJson(messageIds)).digest('hex')
      && result.workloadIdentity.requestedRunIdsSha256
        === createHash('sha256').update(stableJson(runIds)).digest('hex'),
    `load shard ${result.shard.index} has invalid successful message/run identity evidence`);
    const selectedCount = (percent) => Math.floor(result.requestedUsers / 100) * percent
      + Math.min(result.requestedUsers % 100, percent);
    invariant(result.metrics?.pollingOnly === selectedCount(result.pollingPercent),
      `load shard ${result.shard.index} did not exercise the configured polling split`);
    invariant(result.metrics?.forcedReconnectsExpected === selectedCount(result.reconnectPercent),
      `load shard ${result.shard.index} did not force the exact 10% reconnect storm`);
    invariant(result.metrics?.forcedReconnectsRecovered === result.metrics?.forcedReconnectsExpected,
      `load shard ${result.shard.index} did not recover every forced reconnect`);
    invariant(result.metrics?.forcedReconnectsWithin20s === result.metrics?.forcedReconnectsExpected,
      `load shard ${result.shard.index} exceeded the 20-second reconnect deadline`);
    const withinTen = result.metrics?.forcedReconnectsWithin10s / result.metrics?.forcedReconnectsExpected;
    invariant(withinTen >= 0.99, `load shard ${result.shard.index} recovered fewer than 99% within 10 seconds`);
    const soakStartedAt = Date.parse(result.soakStartedAt);
    const rampCompletedAt = Date.parse(result.rampCompletedAt);
    const workloadFinishedAt = Date.parse(result.workloadFinishedAt);
    const loadFinishedAt = Date.parse(result.finishedAt);
    invariant(Number.isFinite(soakStartedAt) && Number.isFinite(rampCompletedAt)
      && Number.isFinite(workloadFinishedAt) && Number.isFinite(loadFinishedAt),
    `load shard ${result.shard.index} has invalid interval timestamps`);
    const loadStartedAt = Date.parse(result.metrics?.startedAt);
    invariant(Number.isFinite(loadStartedAt) && loadStartedAt >= monitorStartedAt
      && rampCompletedAt >= loadStartedAt && soakStartedAt >= rampCompletedAt
      && workloadFinishedAt >= soakStartedAt && loadFinishedAt >= workloadFinishedAt,
    `load shard ${result.shard.index} has stale or out-of-order interval timestamps`);
    invariant(soakStartedAt <= gateStartAt && rampCompletedAt <= gateStartAt,
      `load shard ${result.shard.index} was not ready before the monitor gate started`);
    invariant(workloadFinishedAt >= gateEndAt && loadFinishedAt >= gateEndAt,
      `load shard ${result.shard.index} ended before the monitor gate finished`);
    invariant(workloadFinishedAt - soakStartedAt >= result.soakSeconds * 1_000,
      `load shard ${result.shard.index} ended before its declared soak elapsed`);
    invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''),
      `load shard ${result.shard.index} artifact checksum is invalid`);
    const markerShard = markerShards.get(result.shard.index);
    invariant(markerShard?.sha256 === artifact.sha256,
      `load shard ${result.shard.index} checksum differs from the workload marker`);
    invariant(markerShard?.users === result.requestedUsers,
      `load shard ${result.shard.index} user count differs from the workload marker`);
    invariant(markerShard?.successfulMessageIdsCount === messageIds.length
      && markerShard?.successfulMessageIdsSha256
        === result.workloadIdentity.successfulMessageIdsSha256
      && markerShard?.requestedRunIdsCount === runIds.length
      && markerShard?.requestedRunIdsSha256 === result.workloadIdentity.requestedRunIdsSha256,
    `load shard ${result.shard.index} workload identity differs from the workload marker`);
    invariant(markerShard?.sourceIp === result.sourceIp
      && markerShard?.soakStartedAt === result.soakStartedAt
      && markerShard?.workloadFinishedAt === result.workloadFinishedAt
      && markerShard?.finishedAt === result.finishedAt,
    `load shard ${result.shard.index} interval differs from the workload marker`);
    invariant(Number.isInteger(result.presencePlan?.initialOwnedChatChannels)
      && Number.isInteger(result.presencePlan?.forcedReconnectOwnedChatChannels)
      && result.presencePlan.initialOwnedChatChannels === markerShard?.initialOwnedChatChannels
      && result.presencePlan.forcedReconnectOwnedChatChannels
        === markerShard?.forcedReconnectOwnedChatChannels
      && result.selectionPlan?.forcedReconnectStrategy === 'owner-stratified-v1'
      && result.presencePlan.strategy === result.selectionPlan.forcedReconnectStrategy
      && markerShard?.forcedReconnectStrategy === result.selectionPlan.forcedReconnectStrategy
      && stableJson(result.selectionPlan.forcedReconnectOwnerUserIds)
        === stableJson(result.presencePlan.forcedReconnectOwnerUserIds)
      && stableJson(result.presencePlan.forcedReconnectOwnerUserIds)
        === stableJson(markerShard?.forcedReconnectOwnerUserIds),
    `load shard ${result.shard.index} presence-owner plan differs from the workload marker`);
    invariant(typeof artifact?.path === 'string' && artifact.path !== ''
      && path.resolve(markerShard.path || '') === path.resolve(artifact.path),
      `load shard ${result.shard.index} path differs from the workload marker`);
    invariant(loadFinishedAt <= Date.parse(monitorFinish.workload.finishedAt),
      `load shard ${result.shard.index} finished after the workload marker`);
    users += result.requestedUsers;
  }

  invariant(users === REQUIRED_USERS, `load evidence covers ${users} users, expected exactly 10,000`);
  invariant(monitorFinish.workload.users === users, 'workload marker user count differs from load evidence');
  for (let index = 0; index < shardCount; index += 1) {
    invariant(shardIndexes.has(index), `load shard ${index} is missing`);
  }
  return {
    shardCount,
    users,
    gateStartAt: new Date(gateStartAt).toISOString(),
    gateEndAt: new Date(gateEndAt).toISOString(),
  };
}

export function validateCapacityFixtureSummary(summary, profileName = 'final10k') {
  const profile = CAPACITY_PROFILES[profileName];
  invariant(profile, `unsupported capacity fixture profile ${profileName}`);
  invariant(DIGEST_PATTERN.test(summary?.sha256 || '')
    && DIGEST_PATTERN.test(summary?.identitySha256 || '')
    && DIGEST_PATTERN.test(summary?.groupShapeSha256 || '')
    && Number.isInteger(summary?.bytes) && summary.bytes > 0,
  'capacity fixture summary is missing or unbound');
  invariant(summary.lines === profile.users && summary.users === profile.users
    && summary.groups === profile.groups
    && summary.groupSize === REQUIRED_FIXTURE_GROUP_SIZE
    && summary.runners === profile.users
    && summary.ownedChatChannels === profile.groups,
    `capacity fixture summary differs from the exact ${profile.users.toLocaleString('en-US')}-user/${profile.groups}-group shape`);
  return summary;
}

export function validateCapacityFixtureArtifact(artifact, profileName = 'final10k') {
  const profile = CAPACITY_PROFILES[profileName];
  invariant(profile, `unsupported capacity fixture profile ${profileName}`);
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'capacity fixture checksum is invalid');
  const fixtures = artifact.text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let fixture;
    try { fixture = JSON.parse(line); } catch (error) {
      throw new Error(`capacity fixture line ${index + 1} is invalid JSON: ${error.message}`);
    }
    invariant(typeof fixture.token === 'string' && fixture.token
      && typeof fixture.vaultId === 'string' && fixture.vaultId
      && typeof fixture.channelId === 'string' && fixture.channelId
      && Number.isInteger(fixture.ownedChatChannels) && fixture.ownedChatChannels >= 0
      && fixture.runner === true,
    `capacity fixture line ${index + 1} is incomplete`);
    let claims;
    try {
      const parts = fixture.token.split('.');
      invariant(parts.length === 3, 'not a JWT');
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new Error(`capacity fixture line ${index + 1} has no JWT identity`);
    }
    invariant(Number.isInteger(claims?.id)
      && typeof claims?.username === 'string' && claims.username,
    `capacity fixture line ${index + 1} has no valid user identity`);
    return {
      sourceIndex: index,
      token: fixture.token,
      authenticatedUserId: claims.id,
      username: claims.username,
      vaultId: fixture.vaultId,
      channelId: fixture.channelId,
      ownedChatChannels: fixture.ownedChatChannels,
      runner: fixture.runner,
    };
  });
  invariant(fixtures.length === profile.users,
    `capacity fixture contains ${fixtures.length} users, expected exactly ${profile.users}`);
  invariant(new Set(fixtures.map((fixture) => fixture.token)).size === profile.users
    && new Set(fixtures.map((fixture) => fixture.authenticatedUserId)).size === profile.users
    && new Set(fixtures.map((fixture) => fixture.username)).size === profile.users,
  'capacity fixture reuses a token, authenticated user, or username');
  const groups = new Map();
  for (const fixture of fixtures) {
    const key = `${fixture.vaultId}\u0000${fixture.channelId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fixture);
  }
  invariant(groups.size === profile.groups,
    `capacity fixture does not contain exactly ${profile.groups} vault/channel groups`);
  const groupShape = [...groups.entries()].map(([key, group]) => {
    const [vaultId, channelId] = key.split('\u0000');
    const owners = group.reduce((sum, fixture) => sum + fixture.ownedChatChannels, 0);
    invariant(group.length === REQUIRED_FIXTURE_GROUP_SIZE && owners === 1,
      `capacity fixture group ${key} must contain 25 users and exactly one owner`);
    return { vaultId, channelId, users: group.length, owners };
  }).sort((left, right) => `${left.vaultId}\u0000${left.channelId}`
    .localeCompare(`${right.vaultId}\u0000${right.channelId}`));
  const identities = fixtures.map(({ token: _token, ...fixture }) => fixture);
  return validateCapacityFixtureSummary({
    sha256: artifact.sha256,
    bytes: Buffer.byteLength(artifact.text),
    lines: fixtures.length,
    users: fixtures.length,
    groups: groups.size,
    groupSize: REQUIRED_FIXTURE_GROUP_SIZE,
    runners: fixtures.filter((fixture) => fixture.runner).length,
    ownedChatChannels: groupShape.reduce((sum, group) => sum + group.owners, 0),
    identitySha256: createHash('sha256').update(stableJson(identities)).digest('hex'),
    groupShapeSha256: createHash('sha256').update(stableJson(groupShape)).digest('hex'),
  }, profileName);
}

export function validateLoadProvenance(results, driverArtifact, fixtureEvidence) {
  invariant(driverArtifact?.path === path.join(root, 'loadtest_elixir', 'load.mjs'),
    'capacity load driver is not the checked-out authoritative load.mjs');
  invariant(DIGEST_PATTERN.test(driverArtifact?.sha256 || '')
    && Number.isInteger(driverArtifact?.bytes) && driverArtifact.bytes > 0,
  'capacity load driver artifact is missing or unbound');
  invariant(DIGEST_PATTERN.test(fixtureEvidence?.sha256 || ''),
    'capacity fixture evidence is missing or unbound');
  const configurations = [];
  for (const result of results) {
    const shard = result.shard?.index;
    const provenance = result.provenance;
    const configurationSha256 = createHash('sha256')
      .update(stableJson(loadConfiguration(result)))
      .digest('hex');
    invariant(provenance?.schemaVersion === 1
      && provenance.loadDriverSha256 === driverArtifact.sha256
      && provenance.loadDriverBytes === driverArtifact.bytes,
    `load shard ${shard ?? '?'} did not execute the certified load-driver bytes`);
    invariant(provenance.fixtureSha256 === fixtureEvidence.sha256
      && provenance.fixtureBytes === fixtureEvidence.bytes,
    `load shard ${shard ?? '?'} did not execute the certified fixture bytes`);
    invariant(provenance.configurationSha256 === configurationSha256,
      `load shard ${shard ?? '?'} configuration digest is stale or invalid`);
    configurations.push({ shard, sha256: configurationSha256 });
  }
  configurations.sort((left, right) => left.shard - right.shard);
  return {
    sha256: driverArtifact.sha256,
    bytes: driverArtifact.bytes,
    configurations,
    configurationsSha256: createHash('sha256').update(stableJson(configurations)).digest('hex'),
  };
}

function validateRuntimeProof(
  result,
  artifact,
  mainPreflight,
  imageId,
  revision,
  loadDriverArtifact,
  reconciliationDriverArtifact,
) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'owned runtime proof checksum is invalid');
  invariant(result?.schemaVersion === 1 && result?.type === 'cascade-owned-runtime-proof'
    && result.phase === 'main10k' && result.profile === 'final10k',
  'owned runtime proof schema or phase is invalid');
  invariant(result.imageId === imageId && result.containerId === mainPreflight.containerId
    && result.revision === revision,
  'owned runtime proof image/container/revision differs from main preflight');
  invariant(result.swapReady === true && Number.isFinite(Date.parse(result.executedAt)),
    'owned runtime proof did not pass the embedded route swap gate');
  invariant(result.embedded?.loadDriverSha256 === loadDriverArtifact.sha256
    && result.embedded?.reconciliationDriverSha256 === reconciliationDriverArtifact.sha256,
  'owned runtime proof host/commit/embedded driver checksums differ');
  return {
    sha256: artifact.sha256,
    phase: result.phase,
    profile: result.profile,
    imageId,
    containerId: result.containerId,
    revision,
    executedAt: result.executedAt,
    swapReady: true,
    embedded: result.embedded,
  };
}

export function validateReconciliationEvidence(
  result,
  artifact,
  sourceSnapshot,
  fixtureEvidence,
  fixtureArtifact,
  loadResults,
  loadArtifacts,
  containerMount,
  preflightEvidence,
  monitorFinishedAt,
  reconciliationDriverArtifact,
  embeddedReconciliationDriverSha256,
) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'capacity reconciliation checksum is invalid');
  invariant(result?.schemaVersion === 1 && result?.type === 'cascade-capacity-reconciliation',
    'capacity reconciliation schema is invalid');
  invariant(result.evaluation?.ok === true
    && Array.isArray(result.evaluation?.failures) && result.evaluation.failures.length === 0,
  `capacity reconciliation failed: ${(result.evaluation?.failures || ['missing evaluation']).join('; ')}`);
  const reconciliationFinishedAt = Date.parse(result.finishedAt);
  const latestLoadFinishedAt = Math.max(...loadResults.map((load) => Date.parse(load.finishedAt)));
  invariant(Number.isFinite(reconciliationFinishedAt)
    && reconciliationFinishedAt >= latestLoadFinishedAt
    && reconciliationFinishedAt >= Date.parse(monitorFinishedAt),
  'capacity reconciliation is stale or predates load/monitor completion');
  invariant(reconciliationDriverArtifact?.path === path.join(root, 'loadtest_elixir', 'reconcile-capacity.mjs')
    && result.provenance?.driverSha256 === reconciliationDriverArtifact.sha256
    && result.provenance?.driverBytes === reconciliationDriverArtifact.bytes
    && embeddedReconciliationDriverSha256 === reconciliationDriverArtifact.sha256,
  'capacity reconciliation did not execute host/commit/embedded authoritative driver bytes');
  invariant(containerMount.inspection.State?.Running === false
    && containerMount.inspection.RestartCount === 0
    && containerMount.inspection.State?.OOMKilled === false,
  'capacity reconciliation did not run against a cleanly stopped candidate');
  invariant(fs.realpathSync(result.database || '') === fs.realpathSync(containerMount.database),
    'capacity reconciliation database is not the candidate mounted fixture database');
  const postDatabase = digestRegularFile(result.database || '', 'reconciled capacity database');
  invariant(postDatabase.sha256 === result.databaseSha256,
    'capacity reconciliation database checksum differs from the reconciled bytes');
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${postDatabase.path}${suffix}`),
      `reconciled capacity database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  invariant(postDatabase.device === preflightEvidence.databaseDevice
    && postDatabase.inode === preflightEvidence.databaseInode,
  'capacity reconciliation database inode differs from the preflight fixture');
  invariant(result.baselineMaxRunId === sourceSnapshot.database.counts.maxRunId,
    'capacity reconciliation run baseline differs from the production source snapshot');
  invariant(/^[a-z][a-z0-9_-]{2,30}$/u.test(result.fixturePrefix || ''),
    'capacity reconciliation fixture prefix is invalid');
  const expected = {
    users: sourceSnapshot.database.counts.users + fixtureEvidence.users,
    vaults: sourceSnapshot.database.counts.vaults + fixtureEvidence.groups,
    memberships: sourceSnapshot.database.counts.memberships + fixtureEvidence.users,
    channels: fixtureEvidence.groups,
    successfulChatWrites: loadResults.reduce(
      (sum, load) => sum + (load.metrics?.workload?.chat?.succeeded || 0), 0,
    ),
    successfulRuns: loadResults.reduce(
      (sum, load) => sum + (load.metrics?.workload?.run?.succeeded || 0), 0,
    ),
    successfulMessageIds: loadResults
      .flatMap((load) => load.workloadIdentity?.successfulMessageIds || []).sort(),
    requestedRunIds: loadResults
      .flatMap((load) => load.workloadIdentity?.requestedRunIds || [])
      .sort((left, right) => left - right),
  };
  expected.successfulMessageIdsSha256 = createHash('sha256')
    .update(stableJson(expected.successfulMessageIds)).digest('hex');
  expected.requestedRunIdsSha256 = createHash('sha256')
    .update(stableJson(expected.requestedRunIds)).digest('hex');
  expected.shardWorkloadIdentities = loadResults
    .map((load) => ({
      shard: load.shard.index,
      successfulMessageIdsCount: load.workloadIdentity.successfulMessageIdsCount,
      successfulMessageIdsSha256: load.workloadIdentity.successfulMessageIdsSha256,
      requestedRunIdsCount: load.workloadIdentity.requestedRunIdsCount,
      requestedRunIdsSha256: load.workloadIdentity.requestedRunIdsSha256,
    }))
    .sort((left, right) => left.shard - right.shard);
  invariant(stableJson(result.expected) === stableJson(expected),
    'capacity reconciliation expected counts differ from source, fixture, or load evidence');
  invariant(Array.isArray(result.shards) && result.shards.length === REQUIRED_SHARDS,
    'capacity reconciliation does not bind all four load shards');
  const shardEvidence = new Map(result.shards.map((shard) => [shard.index, shard]));
  for (let index = 0; index < loadResults.length; index += 1) {
    const load = loadResults[index];
    const shard = shardEvidence.get(load.shard.index);
    invariant(shard?.sha256 === loadArtifacts[index]?.sha256
      && shard?.successfulChatWrites === load.metrics?.workload?.chat?.succeeded
      && shard?.successfulRuns === load.metrics?.workload?.run?.succeeded
      && shard?.successfulMessageIdsCount === load.workloadIdentity?.successfulMessageIdsCount
      && shard?.successfulMessageIdsSha256 === load.workloadIdentity?.successfulMessageIdsSha256
      && stableJson(shard?.successfulMessageIds)
        === stableJson(load.workloadIdentity?.successfulMessageIds)
      && shard?.requestedRunIdsCount === load.workloadIdentity?.requestedRunIdsCount
      && shard?.requestedRunIdsSha256 === load.workloadIdentity?.requestedRunIdsSha256
      && stableJson(shard?.requestedRunIds) === stableJson(load.workloadIdentity?.requestedRunIds),
    `capacity reconciliation shard ${load.shard.index} differs from load evidence`);
  }
  const recomputedObserved = queryReconciliationDatabase(
    postDatabase.path,
    result.fixturePrefix,
    result.baselineMaxRunId,
  );
  invariant(stableJson(recomputedObserved) === stableJson(result.observed),
    'capacity reconciliation claimed observations differ from an independent database query');
  const recomputedEvaluation = evaluateReconciliation(recomputedObserved, expected);
  invariant(stableJson(recomputedEvaluation) === stableJson(result.evaluation)
    && recomputedEvaluation.ok,
  'capacity reconciliation evaluation differs from independently recomputed evidence');
  const observed = recomputedObserved;
  invariant(observed.users === expected.users
    && observed.vaults === expected.vaults
    && observed.memberships === expected.memberships
    && observed.fixtureChannelCount === expected.channels
    && observed.loadMessageCount === expected.successfulChatWrites
    && observed.loadMessageDistinctIds === expected.successfulChatWrites
    && observed.loadMessageChannels === expected.channels
    && observed.loadRunCount === expected.successfulRuns
    && observed.completedLoadRuns === expected.successfulRuns,
  'capacity reconciliation observed counts do not match the bound workload');
  invariant(['duplicateMessageIds', 'unexercisedFixtureChannels', 'badMessageScope',
    'badMessageBodies', 'unexpectedNewRuns', 'badRunPrompts', 'badRunRows',
    'badTerminalEventCounts', 'badEventSequences',
    'badRunEventSignatures', 'openDelegatedRuns',
    'foreignKeyViolations'].every((key) => observed[key] === 0)
    && observed.quickCheck === 'ok',
  'capacity reconciliation integrity or scope checks failed');
  const expectedLoadRunEvents = expected.successfulRuns * 4;
  invariant(observed.totalNotes === sourceSnapshot.database.counts.notes + fixtureEvidence.groups
    && observed.totalMessages === sourceSnapshot.database.counts.messages + expected.successfulChatWrites
    && observed.totalRuns === sourceSnapshot.database.counts.runs + expected.successfulRuns
    && observed.loadRunEventCount === expectedLoadRunEvents
    && observed.totalRunEvents === sourceSnapshot.database.counts.runEvents
      + expectedLoadRunEvents + sourceSnapshot.database.counts.openDelegatedRuns
    && observed.totalDelegatedRuns === 0,
  'capacity reconciliation does not preserve exact production totals and workload deltas');
  const fixtureIdentity = validateFixtureDatabaseIdentity(postDatabase.path, fixtureArtifact);
  invariant(fixtureIdentity.userMismatches === 0, 'capacity fixture identities changed after the run');
  const { successfulMessageIds: _successfulMessageIds, requestedRunIds: _requestedRunIds,
    ...expectedSummary } = expected;
  const { loadMessageIds: _loadMessageIds, loadRunIds: _loadRunIds, ...observedSummary } = observed;
  return {
    sha256: artifact.sha256,
    databaseSha256: postDatabase.sha256,
    driverSha256: reconciliationDriverArtifact.sha256,
    fixturePrefixSha256: createHash('sha256').update(result.fixturePrefix || '').digest('hex'),
    baselineMaxRunId: result.baselineMaxRunId,
    expected: expectedSummary,
    observed: observedSummary,
    fixtureIdentity,
    finishedAt: result.finishedAt,
    evaluation: 'passed',
  };
}

export function validateFaultEvidence(results, artifacts, imageId, revision, target, fixtureSha256) {
  invariant(DIGEST_PATTERN.test(fixtureSha256 || ''),
    'fault certification requires the exact fixture checksum');
  invariant(results.length === REQUIRED_FAULTS.size,
    `capacity certification requires exactly ${REQUIRED_FAULTS.size} fault-recovery artifacts`);
  invariant(artifacts.length === results.length, 'every fault result must have an artifact checksum');
  const observed = new Set();

  return results.map((result, index) => {
    const artifact = artifacts[index];
    invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'fault-recovery artifact checksum is invalid');
    invariant(result.schemaVersion === 1 && result.type === 'cascade-fault-recovery',
      'fault-recovery artifact schema is invalid');
    invariant(REQUIRED_FAULTS.has(result.fault), `unsupported fault-recovery proof ${result.fault || 'missing'}`);
    invariant(!observed.has(result.fault), `duplicate fault-recovery proof ${result.fault}`);
    observed.add(result.fault);
    invariant(result.imageId === imageId, `fault proof ${result.fault} exercised a different image`);
    invariant(result.revision === revision, `fault proof ${result.fault} exercised a different revision`);
    invariant(result.target === target, `fault proof ${result.fault} exercised a different target`);
    invariant(result.fixtureSha256 === fixtureSha256,
      `fault proof ${result.fault} used a different authenticated fixture cohort`);
    invariant(typeof result.containerId === 'string' && result.containerId !== '',
      `fault proof ${result.fault} has no container identity`);
    invariant(Number.isFinite(Date.parse(result.startedAt))
      && Number.isFinite(Date.parse(result.finishedAt))
      && Date.parse(result.finishedAt) >= Date.parse(result.startedAt),
    `fault proof ${result.fault} timestamps are invalid`);
    invariant(result.evaluation?.ok === true
      && Array.isArray(result.evaluation.failures)
      && result.evaluation.failures.length === 0,
    `fault proof ${result.fault} failed`);

    const observations = result.observations || {};
    if (result.fault === 'runner-restart-reclaim') {
      invariant(Number.isInteger(observations.runId)
        && observations.runId > PRODUCTION_SOURCE_DATABASE.counts.maxRunId,
      'runner restart proof has no exact post-baseline run identity');
      invariant(observations.sameContainer === true && observations.sameImage === true
        && observations.containerRestarted === true,
      'runner restart proof did not restart the same image/container');
      invariant(observations.restartMs <= 120_000 && observations.reclaimedActiveRun === true,
        'runner restart proof exceeded 120 seconds or did not reclaim the active run');
      invariant(observations.delegations === 1 && observations.completedTerminalEvents === 1
        && observations.finalStatus === 'completed',
      'runner restart proof contains duplicate delegation/terminal state or no completion');
    } else if (result.fault === 'sqlite-write-lock') {
      invariant(typeof observations.blockedId === 'string' && observations.blockedId.startsWith('fault-lock-blocked-')
        && typeof observations.recoveryId === 'string' && observations.recoveryId.startsWith('fault-lock-recovery-')
        && observations.blockedId !== observations.recoveryId
        && typeof observations.vaultId === 'string' && observations.vaultId
        && typeof observations.channelId === 'string' && observations.channelId,
      'SQLite lock proof has no exact blocked/recovery message scope');
      invariant([429, 503].includes(observations.boundedFailureStatus)
        && observations.boundedFailureMs <= 7_000,
      'SQLite lock proof did not shed the blocked write within seven seconds');
      invariant(observations.failedWriteAbsent === true
        && observations.recoveryStatus === 201
        && observations.recoveryMs <= 1_000
        && observations.recoveryWritePersisted === true,
      'SQLite lock proof has a phantom failure or did not recover within one second');
    }

    return {
      fault: result.fault,
      sha256: artifact.sha256,
      fixtureSha256: result.fixtureSha256,
      containerId: result.containerId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      evaluation: 'passed',
      observations,
    };
  });
}

export function validateFaultPersistence(phaseWorkload, faults) {
  invariant(phaseWorkload?.runs === 1
    && phaseWorkload?.completedRuns === 1
    && phaseWorkload?.messages === 1,
  'phase B freeze workload differs from the two exact fault proofs');
  const runnerFault = faults.find((fault) => fault.fault === 'runner-restart-reclaim');
  const sqliteFault = faults.find((fault) => fault.fault === 'sqlite-write-lock');
  invariant(runnerFault && sqliteFault, 'phase B is missing a required fault proof');
  const [persistedFaultRun] = phaseWorkload.workloadRuns || [];
  const persistedFaultEvents = phaseWorkload.workloadRunEvents || [];
  const [persistedRecoveryMessage] = phaseWorkload.workloadMessages || [];
  let persistedTerminalPayload;
  try { persistedTerminalPayload = JSON.parse(persistedFaultRun?.lastPayload || 'null'); } catch {
    persistedTerminalPayload = null;
  }
  invariant(persistedFaultRun?.id === runnerFault.observations.runId
    && persistedFaultRun?.status === 'completed'
    && persistedFaultRun?.summary === 'restart recovery passed'
    && persistedFaultRun?.eventCount === 3
    && persistedFaultRun?.completedTerminalEvents === 1
    && persistedFaultRun?.lastType === 'status'
    && persistedTerminalPayload?.status === 'completed'
    && persistedTerminalPayload?.summary === 'restart recovery passed'
    && persistedTerminalPayload?.sessionId === `fault-session-${runnerFault.observations.runId}`,
  'phase B database does not contain the exact runner-restart run/event signature');
  const expectedFaultEvents = [
    { seq: 1, type: 'status', payload: { status: 'queued' } },
    { seq: 2, type: 'status', payload: { status: 'running' } },
    {
      seq: 3,
      type: 'status',
      payload: {
        status: 'completed',
        summary: 'restart recovery passed',
        sessionId: `fault-session-${runnerFault.observations.runId}`,
      },
    },
  ];
  invariant(persistedFaultEvents.length === expectedFaultEvents.length
    && persistedFaultEvents.every((event, index) => {
      let payload;
      try { payload = JSON.parse(event.payloadJson); } catch { payload = null; }
      const expected = expectedFaultEvents[index];
      return event.runId === runnerFault.observations.runId
        && event.seq === expected.seq && event.type === expected.type
        && stableJson(payload) === stableJson(expected.payload);
    }),
  'phase B runner restart events differ from the exact queued/running/completed sequence');
  invariant(persistedRecoveryMessage?.id === sqliteFault.observations.recoveryId
    && persistedRecoveryMessage?.vaultId === sqliteFault.observations.vaultId
    && persistedRecoveryMessage?.channelId === sqliteFault.observations.channelId
    && persistedRecoveryMessage?.body === 'dependency recovered'
    && !(phaseWorkload.workloadMessages || []).some(
      (message) => message.id === sqliteFault.observations.blockedId,
    ),
  'phase B database does not contain only the exact scoped SQLite recovery message');
  return true;
}

export function validatePhaseChronology(preflights, freezes, reconciliation, faults, soak) {
  const mainFrozenAt = Date.parse(freezes.main10k?.frozenAt);
  const faultPreflightAt = Date.parse(preflights.faults?.createdAt);
  const soakPreflightAt = Date.parse(preflights.soak5k?.createdAt);
  invariant(Number.isFinite(mainFrozenAt)
    && Number.isFinite(faultPreflightAt) && Number.isFinite(soakPreflightAt),
  'phase lifecycle timestamps are missing or invalid');
  invariant(Date.parse(reconciliation.finishedAt) <= mainFrozenAt,
    'phase A freeze predates its authoritative reconciliation');
  invariant(faults.every((result) => Date.parse(result.finishedAt) <= Date.parse(freezes.faults.frozenAt))
    && Date.parse(soak.finishedAt) <= Date.parse(freezes.soak5k.frozenAt),
  'phase B/C freeze predates its workload evidence');
  invariant(faults.every((result) => Date.parse(result.startedAt) >= mainFrozenAt)
    && Date.parse(soak.startedAt) >= mainFrozenAt,
  'phase B/C started before phase A was reconciled and frozen');
  invariant(faultPreflightAt >= mainFrozenAt && soakPreflightAt >= mainFrozenAt,
    'phase B/C preflight was created before phase A was reconciled and frozen');
  invariant(faults.every((result) => faultPreflightAt <= Date.parse(result.startedAt))
    && soakPreflightAt <= Date.parse(soak.startedAt),
  'phase B/C workload started before its never-started preflight was captured');
  return true;
}

function selectedFixtureEvidence(artifact) {
  const fixtures = artifact.text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let fixture;
    try { fixture = JSON.parse(line); } catch (error) {
      throw new Error(`two-hour soak fixture line ${index + 1} is invalid JSON: ${error.message}`);
    }
    invariant(typeof fixture.token === 'string' && fixture.token
      && typeof fixture.vaultId === 'string' && fixture.vaultId
      && typeof fixture.channelId === 'string' && fixture.channelId
      && Number.isInteger(fixture.ownedChatChannels) && fixture.ownedChatChannels >= 0
      && fixture.runner === true,
    `two-hour soak fixture line ${index + 1} is incomplete`);
    let claims;
    try { claims = JSON.parse(Buffer.from(fixture.token.split('.')[1], 'base64url').toString('utf8')); } catch {
      throw new Error(`two-hour soak fixture line ${index + 1} has no JWT identity`);
    }
    invariant(Number.isInteger(claims?.id)
      && typeof claims?.username === 'string' && claims.username,
    `two-hour soak fixture line ${index + 1} has no valid user identity`);
    return { ...fixture, authenticatedUserId: claims.id, sourceIndex: index };
  });
  const tokenSet = new Set(fixtures.map((fixture) => fixture.token));
  const userSet = new Set(fixtures.map((fixture) => fixture.authenticatedUserId));
  invariant(tokenSet.size === fixtures.length && userSet.size === fixtures.length,
    'two-hour soak fixture artifact reuses a token or authenticated user');
  const groups = new Map();
  for (const fixture of fixtures) {
    const key = `${fixture.vaultId}\u0000${fixture.channelId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fixture);
  }
  for (const [key, group] of groups) {
    const owners = group.reduce((total, fixture) => total + fixture.ownedChatChannels, 0);
    invariant(owners === 1,
      `two-hour soak fixture vault/channel group ${key} owns ${owners} chat channels, expected exactly 1`);
  }
  const selected = [];
  for (const group of groups.values()) {
    if (selected.length >= REQUIRED_LONG_SOAK_USERS) break;
    invariant(selected.length + group.length <= REQUIRED_LONG_SOAK_USERS,
      'two-hour soak fixture selection splits a vault/channel group');
    selected.push(...group);
  }
  invariant(selected.length === REQUIRED_LONG_SOAK_USERS,
    'two-hour soak fixture artifact does not select exactly 5,000 users');
  const selectedGroups = new Map();
  for (const fixture of selected) {
    const key = `${fixture.vaultId}\u0000${fixture.channelId}`;
    const group = selectedGroups.get(key) || { users: 0, owners: 0 };
    group.users += 1;
    group.owners += fixture.ownedChatChannels;
    selectedGroups.set(key, group);
  }
  const groupIdentities = [...selectedGroups.entries()].map(([key, group]) => {
    const [vaultId, channelId] = key.split('\u0000');
    return { vaultId, channelId, users: group.users, owners: group.owners };
  }).sort((left, right) => `${left.vaultId}\u0000${left.channelId}`.localeCompare(`${right.vaultId}\u0000${right.channelId}`));
  invariant(groupIdentities.length === REQUIRED_LONG_SOAK_USERS / 25
    && groupIdentities.every((group) => group.users === 25 && group.owners === 1),
  'two-hour soak fixture artifact must contain exactly 200 complete 25-user groups');
  const selectedIdentity = selected.map((fixture) => ({
    authenticatedUserId: fixture.authenticatedUserId,
    sourceIndex: fixture.sourceIndex,
    vaultId: fixture.vaultId,
    channelId: fixture.channelId,
    ownedChatChannels: fixture.ownedChatChannels,
    runner: fixture.runner,
  }));
  const churnCohortDigests = Array.from({ length: 10 }, (_unused, cohort) => createHash('sha256')
    .update(stableJson(selected.filter((_fixture, ordinal) => ordinal % 10 === cohort).map((fixture) => ({
      authenticatedUserId: fixture.authenticatedUserId,
      sourceIndex: fixture.sourceIndex,
    }))))
    .digest('hex'));
  return {
    sha256: artifact.sha256,
    bytes: Buffer.byteLength(artifact.text),
    lines: fixtures.length,
    users: selected.length,
    groups: groupIdentities.length,
    groupSize: 25,
    groupIdentities,
    selectedIdentitySha256: createHash('sha256').update(stableJson(selectedIdentity)).digest('hex'),
    churnCohortDigests,
  };
}

function validateSoakServerLogArtifact(result, artifact) {
  invariant(artifact.sha256 === result.serverLogs?.sha256,
    'two-hour soak server-log artifact checksum differs from the evaluated bytes');
  invariant(Buffer.byteLength(artifact.text) === result.serverLogs?.totalBytes
    && artifact.text.split(/\r?\n/u).filter(Boolean).length === result.serverLogs?.totalLines,
  'two-hour soak server-log artifact size differs from the evaluated bytes');
  const recomputed = analyzeServerLogs(artifact.text);
  invariant(recomputed.matchedErrorLines === 0
    && recomputed.matches.length === 0
    && recomputed.matchesTruncated === false
    && stableJson({
      totalBytes: result.serverLogs.totalBytes,
      totalLines: result.serverLogs.totalLines,
      matchedErrorLines: result.serverLogs.matchedErrorLines,
      matches: result.serverLogs.matches,
      matchesTruncated: result.serverLogs.matchesTruncated,
    }) === stableJson(recomputed),
  'two-hour soak server-log artifact contains errors or differs from recomputed analysis');
}

export function validateSoakEvidence(
  result,
  artifact,
  journalArtifact,
  fixtureArtifact,
  serverLogArtifact,
  imageId,
  revision,
  target,
) {
  invariant(DIGEST_PATTERN.test(artifact?.sha256 || ''), 'two-hour soak artifact checksum is invalid');
  invariant(result.schemaVersion === 1 && result.type === 'cascade-elixir-two-hour-soak-invariants',
    'two-hour soak artifact schema is invalid');
  invariant(result.expectedImage === imageId, 'two-hour soak exercised a different image');
  invariant(result.expectedRevision === revision, 'two-hour soak exercised a different revision');
  invariant(result.target === target, 'two-hour soak exercised a different target');
  invariant(result.evaluation?.ok === true
    && Array.isArray(result.evaluation.failures)
    && result.evaluation.failures.length === 0
    && Array.isArray(result.preflightFailures)
    && result.preflightFailures.length === 0,
  `two-hour soak evaluation failed: ${[
    ...(result.preflightFailures || []),
    ...(result.evaluation?.failures || []),
  ].join('; ') || 'missing passing evaluation'}`);

  const profile = result.profile || {};
  invariant(Object.entries(SOAK_PROFILE).every(([key, expected]) => profile[key] === expected),
  'two-hour soak workload profile differs from the release contract');
  invariant(result.observed?.soakSeconds >= REQUIRED_LONG_SOAK_SECONDS - 2
    && Math.abs((Date.parse(result.soakFinishedAt) - Date.parse(result.soakStartedAt)) / 1_000
      - result.observed.soakSeconds) <= 0.001,
  'two-hour soak observed duration is incomplete');
  const rampStartedAt = Date.parse(result.workload?.rampStartedAt);
  const rampCompletedAt = Date.parse(result.workload?.rampCompletedAt);
  invariant(Number.isFinite(rampStartedAt) && Number.isFinite(rampCompletedAt)
    && rampCompletedAt <= Date.parse(result.soakStartedAt)
    && rampCompletedAt - rampStartedAt >= SOAK_PROFILE.rampSeconds * 1_000
    && rampCompletedAt - rampStartedAt <= (SOAK_PROFILE.rampSeconds + 10) * 1_000,
  'two-hour soak did not observe the exact bounded 300-second connection ramp');

  const initial = result.identity?.initial;
  const final = result.identity?.final;
  invariant(initial?.container?.imageId === imageId && final?.container?.imageId === imageId,
    'two-hour soak container image identity drifted');
  invariant(typeof initial?.container?.id === 'string' && initial.container.id !== ''
    && initial.container.id === final?.container?.id
    && initial.container.startedAt === final?.container?.startedAt,
  'two-hour soak container/start identity drifted');
  invariant(initial?.image?.revision === revision && final?.image?.revision === revision,
    'two-hour soak image revision drifted');
  invariant(initial?.container?.restartCount === 0
    && final?.container?.running === true && final?.container?.oomKilled === false
    && final?.container?.restartCount === 0,
  'two-hour soak container restarted, stopped, or was OOM-killed');
  invariant(JSON.stringify(result.identity?.runtimeInitial) === JSON.stringify(result.identity?.runtimeFinal),
    'two-hour soak Elixir/OTP/application runtime identity drifted');

  const workload = result.workload || {};
  invariant(workload.initialConnected === REQUIRED_LONG_SOAK_USERS
    && workload.initialConnectionFailures === 0,
  'two-hour soak did not connect exactly 5,000 authenticated runner users');
  const expectedCycles = Math.floor(
    (profile.soakSeconds - 20) / profile.churnIntervalSeconds,
  );
  invariant(Array.isArray(workload.churnCycles) && workload.churnCycles.length >= expectedCycles,
    'two-hour soak did not execute every periodic churn cycle');
  for (const cycle of workload.churnCycles) {
    const expectedSelected = Math.round(profile.users * profile.churnPercent / 100);
    invariant(cycle.selected === expectedSelected
      && cycle.recovered === expectedSelected
      && cycle.within20 === expectedSelected
      && cycle.within10 / Math.max(expectedSelected, 1) >= 0.99
      && Array.isArray(cycle.failures) && cycle.failures.length === 0,
    `two-hour soak churn cycle ${cycle.index ?? '?'} did not recover cleanly`);
  }
  const runs = workload.runs || {};
  const minimumRuns = Math.floor(profile.runRps * profile.soakSeconds * 0.99);
  invariant(runs.scheduled >= minimumRuns
    && runs.created === runs.scheduled
    && runs.delegated === runs.created
    && runs.completed === runs.created
    && runs.duplicates === 0
    && runs.orderingViolations === 0
    && runs.requestErrors / Math.max(runs.scheduled, 1) <= 0.001,
  'two-hour soak run-event workload is incomplete, duplicated, unordered, or over its error budget');
  const runIds = workload.runIds || {};
  const normalizedSet = (values) => [...(values || [])].map(Number).sort((left, right) => left - right);
  const requested = normalizedSet(runIds.requested);
  invariant(requested.length === runs.created
    && [runIds.delegated, runIds.terminal, runIds.liveComplete, result.postDb?.runIds]
      .every((values) => stableJson(normalizedSet(values)) === stableJson(requested)),
  'two-hour soak requested/delegated/live/terminal/persisted run-ID sets differ');
  invariant(result.postDb?.runs === runs.created
    && result.postDb?.completed === runs.created
    && result.postDb?.eventsReconciled === runs.created
    && Array.isArray(result.postDb?.failures) && result.postDb.failures.length === 0
    && DIGEST_PATTERN.test(result.postDb?.eventDigest || ''),
  'two-hour soak post-DB reconciliation is incomplete');
  invariant(result.database?.baseline && result.database?.final
    && Array.isArray(result.database?.failures) && result.database.failures.length === 0,
  'two-hour soak SQLite count/integrity reconciliation is incomplete');
  const recomputedDatabase = reconcileLongSoakDatabase(
    result.database.baseline,
    result.database.final,
    runs.created,
    result.postDb.totalEvents,
  );
  invariant(stableJson(result.database) === stableJson(recomputedDatabase)
    && recomputedDatabase.failures.length === 0,
  'two-hour soak SQLite orphan transition or workload reconciliation differs from recomputed evidence');

  invariant(Number.isInteger(result.recovery?.consecutivePassing)
    && result.recovery.consecutivePassing >= profile.recoveryConsecutiveSamples
    && result.recovery?.final,
  'two-hour soak resources did not return to baseline');
  invariant(DIGEST_PATTERN.test(result.journal?.sha256 || '')
    && result.journal.sha256 === journalArtifact?.sha256,
  'two-hour soak runtime journal checksum is missing or different');
  invariant(Number.isInteger(result.journal?.bytes)
    && result.journal.bytes === Buffer.byteLength(journalArtifact.text)
    && Number.isInteger(result.journal?.samples)
    && result.journal.samples === journalArtifact.text.split(/\r?\n/u).filter(Boolean).length
    && result.journal.samples >= 10,
  'two-hour soak runtime journal size or sample count is invalid');
  const recomputedJournal = recomputeSoakJournal(result, parseSoakJournal(journalArtifact.text));
  const declaredJournalValidation = {
    records: recomputedJournal.records,
    phases: recomputedJournal.phases,
    headroom: recomputedJournal.headroom,
    failures: recomputedJournal.failures,
  };
  invariant(stableJson(result.baseline) === stableJson(recomputedJournal.baseline)
    && stableJson(result.workload.runtimeCoverage) === stableJson(recomputedJournal.runtimeCoverage)
    && stableJson(result.recovery) === stableJson(recomputedJournal.recovery)
    && stableJson(result.journal.validation) === stableJson(declaredJournalValidation),
  'two-hour soak aggregates differ from recomputed runtime journal evidence');
  const recomputedResult = structuredClone(result);
  recomputedResult.baseline = recomputedJournal.baseline;
  recomputedResult.workload.runtimeCoverage = recomputedJournal.runtimeCoverage;
  recomputedResult.recovery = recomputedJournal.recovery;
  recomputedResult.journal.validation = declaredJournalValidation;
  const recomputedEvaluation = evaluateLongSoakEvidence(recomputedResult);
  invariant(recomputedEvaluation.ok && recomputedEvaluation.failures.length === 0
    && stableJson(result.evaluation) === stableJson(recomputedEvaluation),
  'two-hour soak evaluation does not match independently recomputed evidence');

  const recomputedFixtures = selectedFixtureEvidence(fixtureArtifact);
  invariant(stableJson({ ...result.fixtures, path: undefined })
    === stableJson({ ...recomputedFixtures, path: undefined }),
  'two-hour soak fixture artifact identity differs from the evaluated fixture evidence');
  validateSoakServerLogArtifact(result, serverLogArtifact);

  return {
    sha256: artifact.sha256,
    imageId,
    revision,
    target,
    journal: {
      sha256: journalArtifact.sha256,
      bytes: result.journal.bytes,
      samples: result.journal.samples,
    },
    fixtures: {
      sha256: fixtureArtifact.sha256,
      bytes: recomputedFixtures.bytes,
      users: recomputedFixtures.users,
      groups: recomputedFixtures.groups,
      selectedIdentitySha256: recomputedFixtures.selectedIdentitySha256,
    },
    serverLogs: {
      policy: result.serverLogs.policy,
      baselineCursor: result.serverLogs.baselineCursor,
      finishCursor: result.serverLogs.finishCursor,
      readError: result.serverLogs.readError,
      sha256: serverLogArtifact.sha256,
      totalBytes: result.serverLogs.totalBytes,
      totalLines: result.serverLogs.totalLines,
      matchedErrorLines: result.serverLogs.matchedErrorLines,
      matchesTruncated: result.serverLogs.matchesTruncated,
    },
    users: profile.users,
    rampSeconds: profile.rampSeconds,
    rampStartedAt: result.workload.rampStartedAt,
    rampCompletedAt: result.workload.rampCompletedAt,
    soakSeconds: profile.soakSeconds,
    sampleIntervalSeconds: profile.sampleIntervalSeconds,
    recoveryConsecutiveSamples: profile.recoveryConsecutiveSamples,
    churnPercent: profile.churnPercent,
    churnIntervalSeconds: profile.churnIntervalSeconds,
    runRps: profile.runRps,
    containerId: initial.container.id,
    containerStartedAt: initial.container.startedAt,
    startedAt: result.startedAt,
    soakStartedAt: result.soakStartedAt,
    finishedAt: result.finishedAt,
    postDbEventDigest: result.postDb.eventDigest,
    liveEventDigest: result.workload.liveEventDigest,
    runCount: runs.created,
    persistedEventCount: result.postDb.totalEvents,
    probeUninstalled: result.probe.owned === true
      && result.probe.uninstallError === null
      && result.probe.postUninstall?.error === 'capacity probe is not installed',
    teardown: result.teardown,
    database: result.database,
    journalHeadroom: recomputedJournal.headroom.observed,
    evaluation: 'passed',
  };
}

export function validateManifest(manifest) {
  assertNoManifestSecrets(manifest);
  invariant(manifest.schemaVersion === 2, 'unsupported certification manifest version');
  invariant(manifest.status === 'certified', 'image manifest is not certified');
  invariant(SHA_PATTERN.test(manifest.revision || ''), 'manifest revision is invalid');
  invariant(IMAGE_ID_PATTERN.test(manifest.image?.id || ''), 'manifest image ID is invalid');
  invariant(manifest.image?.tag === `cascade:certified-${manifest.revision}`, 'manifest image tag is not canonical');
  const certification = manifest.certification;
  const monitor = certification?.monitor;
  invariant(certification?.totalUsers === REQUIRED_USERS, 'manifest does not certify exactly 10,000 users');
  invariant(certification?.shardCount === REQUIRED_SHARDS, 'manifest does not certify exactly four shards');
  invariant(typeof certification?.target === 'string' && certification.target !== '',
    'manifest does not identify the staging target');
  const provenance = certification?.provenance;
  const sourceSnapshot = validateProductionSourceSummary(provenance?.sourceSnapshot);
  const fixture = validateCapacityFixtureSummary(provenance?.fixture);
  const loadDriver = provenance?.loadDriver;
  invariant(DIGEST_PATTERN.test(loadDriver?.sha256 || '')
    && Number.isInteger(loadDriver?.bytes) && loadDriver.bytes > 0
    && DIGEST_PATTERN.test(loadDriver?.configurationsSha256 || '')
    && Array.isArray(loadDriver?.configurations) && loadDriver.configurations.length === REQUIRED_SHARDS,
  'manifest load-driver provenance is missing or unbound');
  const runtimeProof = provenance?.runtimeProof;
  invariant(runtimeProof?.phase === 'main10k' && runtimeProof?.profile === 'final10k'
    && runtimeProof?.imageId === manifest.image.id && runtimeProof?.revision === manifest.revision
    && runtimeProof?.swapReady === true && DIGEST_PATTERN.test(runtimeProof?.sha256 || '')
    && runtimeProof?.embedded?.loadDriverSha256 === loadDriver.sha256
    && DIGEST_PATTERN.test(runtimeProof?.embedded?.reconciliationDriverSha256 || ''),
  'manifest owned runtime proof is missing, failed, or unbound');
  const preflights = provenance?.preflights;
  const freezes = provenance?.freezes;
  const phases = ['main10k', 'faults', 'soak5k'];
  invariant(phases.every((phase) => (
    preflights?.[phase]?.phase === phase
    && preflights[phase].profile === 'final10k'
    && preflights[phase].imageId === manifest.image.id
    && preflights[phase].sourceDatabaseSha256 === sourceSnapshot.database.sha256
    && preflights[phase].sourceCorpusSha256 === sourceSnapshot.corpus.sha256
    && preflights[phase].fixtureSha256 === fixture.sha256
    && DIGEST_PATTERN.test(preflights[phase].sha256 || '')
    && DIGEST_PATTERN.test(preflights[phase].databaseSha256 || '')
    && freezes?.[phase]?.phase === phase
    && freezes[phase].profile === 'final10k'
    && freezes[phase].imageId === manifest.image.id
    && freezes[phase].containerId === preflights[phase].containerId
    && freezes[phase].mountSourceSha256 === preflights[phase].mountSourceSha256
    && freezes[phase].databaseDevice === preflights[phase].databaseDevice
    && freezes[phase].databaseInode === preflights[phase].databaseInode
    && DIGEST_PATTERN.test(freezes[phase].sha256 || '')
    && DIGEST_PATTERN.test(freezes[phase].databaseSha256 || '')
  )), 'manifest A/B/C preflight or freeze provenance is incomplete or inconsistent');
  invariant(new Set(phases.map((phase) => preflights[phase].containerId)).size === phases.length
    && new Set(phases.map((phase) => preflights[phase].mountSourceSha256)).size === phases.length
    && new Set(phases.map(
      (phase) => `${preflights[phase].databaseDevice}:${preflights[phase].databaseInode}`,
    )).size === phases.length,
  'manifest A/B/C containers, data roots, or database inodes are reused');
  invariant(runtimeProof.containerId === preflights.main10k.containerId,
    'manifest runtime proof does not belong to phase A');
  const reconciliation = provenance?.reconciliation;
  invariant(reconciliation?.evaluation === 'passed'
    && DIGEST_PATTERN.test(reconciliation?.sha256 || '')
    && DIGEST_PATTERN.test(reconciliation?.databaseSha256 || '')
    && DIGEST_PATTERN.test(reconciliation?.fixturePrefixSha256 || '')
    && reconciliation?.driverSha256 === runtimeProof.embedded.reconciliationDriverSha256
    && reconciliation?.baselineMaxRunId === sourceSnapshot.database.counts.maxRunId
    && reconciliation?.expected?.successfulMessageIdsSha256
      === reconciliation?.observed?.loadMessageIdsSha256
    && reconciliation?.expected?.requestedRunIdsSha256
      === reconciliation?.observed?.loadRunIdsSha256
    && DIGEST_PATTERN.test(reconciliation?.expected?.successfulMessageIdsSha256 || '')
    && DIGEST_PATTERN.test(reconciliation?.expected?.requestedRunIdsSha256 || '')
    && Number.isFinite(Date.parse(reconciliation?.finishedAt)),
  'manifest capacity reconciliation provenance is missing, failed, or unbound');
  invariant(monitor?.evaluation === 'passed', 'manifest monitor gate did not pass');
  invariant(DIGEST_PATTERN.test(monitor?.sha256 || ''), 'manifest monitor checksum is invalid');
  invariant(monitor?.imageId === manifest.image.id, 'manifest monitor image differs from the certified image');
  invariant(typeof monitor?.containerId === 'string' && monitor.containerId !== '',
    'manifest monitor container identity is missing');
  invariant(typeof monitor?.containerStartedAt === 'string' && Number.isFinite(Date.parse(monitor.containerStartedAt)),
    'manifest monitor container start identity is missing');
  const serverLogs = monitor?.serverLogs;
  invariant(serverLogs?.policy === 'zero fatal/error lines from container start through monitor finish',
    'manifest server-log policy is missing or different');
  invariant(serverLogs?.baselineCursor === monitor.containerStartedAt
    && Number.isFinite(Date.parse(serverLogs?.finishCursor)),
  'manifest server-log capture identity is missing or different');
  invariant(serverLogs?.readError === null
    && DIGEST_PATTERN.test(serverLogs?.sha256 || '')
    && Number.isInteger(serverLogs?.totalBytes) && serverLogs.totalBytes >= 0
    && Number.isInteger(serverLogs?.totalLines) && serverLogs.totalLines >= 0
    && serverLogs?.matchedErrorLines === 0
    && serverLogs?.matchesTruncated === false,
  'manifest server-log evidence is incomplete or contains errors');
  invariant(monitor?.runtimeEnvelope?.cpus === CERTIFIED_CPUS
    && monitor?.runtimeEnvelope?.cpuset === CERTIFIED_CPUSET
    && monitor?.runtimeEnvelope?.memoryBytes === CERTIFIED_MEMORY_BYTES
    && monitor?.runtimeEnvelope?.memorySwapBytes === CERTIFIED_MEMORY_BYTES
    && monitor?.runtimeEnvelope?.pidsLimit === CERTIFIED_PIDS
    && monitor?.runtimeEnvelope?.nofileSoft === CERTIFIED_NOFILE
    && monitor?.runtimeEnvelope?.nofileHard === CERTIFIED_NOFILE,
  'manifest runtime envelope differs from the certified shape');
  invariant(stableJson(monitor?.runtimeConfiguration) === stableJson(SOAK_RUNTIME_CONFIGURATION),
    'manifest runtime configuration differs from the certified release contract');
  invariant(monitor?.sessions >= REQUIRED_USERS && monitor?.runners >= REQUIRED_USERS
    && monitor?.memberships >= REQUIRED_MEMBERSHIPS,
  'manifest monitor shape does not include 10,000 sessions/runners and 50,000 memberships');
  invariant(monitor?.durationSeconds >= REQUIRED_MONITOR_SECONDS
    && monitor?.gateWindowSeconds >= REQUIRED_GATE_SECONDS,
  'manifest monitor duration or gate window is below the release contract');
  invariant(monitor?.coverage?.sessions >= MINIMUM_COVERAGE_RATIO
    && monitor?.coverage?.runners >= MINIMUM_COVERAGE_RATIO
    && monitor?.coverage?.memberships >= MINIMUM_COVERAGE_RATIO,
  'manifest monitor coverage is below the release contract');
  invariant(monitor?.coverage?.sessionsEnd >= REQUIRED_USERS
    && monitor?.coverage?.runnersEnd >= REQUIRED_USERS
    && monitor?.coverage?.membershipsEnd >= REQUIRED_MEMBERSHIPS,
  'manifest monitor end-state coverage is below the release contract');
  const gateStartAt = Date.parse(monitor?.gateStartAt);
  const gateEndAt = Date.parse(monitor?.gateEndAt);
  invariant(Number.isFinite(gateStartAt) && Number.isFinite(gateEndAt)
    && gateEndAt - gateStartAt >= REQUIRED_GATE_SECONDS * 1_000,
  'manifest does not contain a literal 30-minute concurrent gate');
  invariant(Date.parse(serverLogs.finishCursor) >= gateEndAt,
    'manifest server-log capture does not span the certified interval');
  invariant(monitor?.workload?.users === REQUIRED_USERS
    && monitor?.workload?.shardCount === REQUIRED_SHARDS
    && monitor?.workload?.elapsedSeconds >= REQUIRED_RAMP_SECONDS + REQUIRED_SOAK_SECONDS
    && monitor?.workload?.postWorkloadSeconds >= REQUIRED_POST_WORKLOAD_SECONDS
    && Date.parse(monitor?.workload?.finishedAt) >= gateEndAt,
  'manifest workload marker does not satisfy the release contract');
  validateRealtimeEvidence(
    monitor?.realtime?.expected,
    monitor?.realtime?.presencePlan,
    monitor?.realtime?.observed,
    monitor?.sessions,
    monitor?.runners,
  );
  const manifestPresenceShards = monitor?.workload?.shards || [];
  const manifestReconnectOwnerIds = manifestPresenceShards.flatMap(
    (shard) => shard.forcedReconnectOwnerUserIds || [],
  );
  invariant(manifestPresenceShards.length === REQUIRED_SHARDS
    && manifestPresenceShards.every((shard) => (
      shard.initialOwnedChatChannels === 100
      && shard.forcedReconnectOwnedChatChannels === 10
      && shard.forcedReconnectStrategy === 'owner-stratified-v1'
      && Array.isArray(shard.forcedReconnectOwnerUserIds)
      && shard.forcedReconnectOwnerUserIds.length === 10
      && new Set(shard.forcedReconnectOwnerUserIds).size === 10
      && shard.forcedReconnectOwnerUserIds.every(Number.isInteger)
    ))
    && sameIntegerSet(
      manifestReconnectOwnerIds,
      monitor.realtime.presencePlan.forcedReconnectOwnerUserIds,
    ),
  'manifest workload reconnect-owner strategy, counts, or IDs differ from the certified plan');
  invariant(certification?.loads?.length === certification?.shardCount,
    'manifest load-shard evidence is incomplete');
  invariant(certification?.loads?.every((entry) => entry.evaluation === 'passed'),
    'manifest contains a failed load shard');
  const shards = new Set(certification.loads.map((entry) => entry.shard));
  invariant(shards.size === certification.shardCount,
    'manifest load-shard identities are incomplete');
  const sourceIps = new Set(certification.loads.map((entry) => entry.sourceIp));
  invariant(sourceIps.size === REQUIRED_SHARDS && !sourceIps.has(undefined),
    'manifest load-generator source IPs are incomplete');
  const workloadDigests = new Map((monitor.workload.shards || []).map((entry) => [entry.shard, entry.sha256]));
  const workloadShards = new Map((monitor.workload.shards || []).map((entry) => [entry.shard, entry]));
  invariant(workloadDigests.size === REQUIRED_SHARDS,
    'manifest workload marker shard checksums are incomplete');
  const firstLoad = certification.loads[0];
  const commonConfiguration = JSON.stringify({
    rampSeconds: firstLoad.rampSeconds,
    soakSeconds: firstLoad.soakSeconds,
    pollingPercent: firstLoad.pollingPercent,
    reconnectPercent: firstLoad.reconnectPercent,
    reconnectAtSeconds: firstLoad.reconnectAtSeconds,
    rates: firstLoad.rates,
  });
  for (const entry of certification.loads) {
    invariant(entry.users === REQUIRED_USERS / REQUIRED_SHARDS,
      `manifest load shard ${entry.shard} does not cover 2,500 users`);
    invariant(DIGEST_PATTERN.test(entry.sha256 || '') && workloadDigests.get(entry.shard) === entry.sha256,
      `manifest load shard ${entry.shard} is not bound to the workload marker checksum`);
    invariant(entry.rampSeconds === REQUIRED_RAMP_SECONDS
      && entry.soakSeconds === REQUIRED_SOAK_SECONDS
      && entry.pollingPercent === 5
      && entry.reconnectPercent === 10
      && entry.reconnectAtSeconds === 600
      && stableJson(entry.rates) === stableJson({ chatRps: 6.25, readRps: 12.5, runRps: 0.25 }),
    `manifest load shard ${entry.shard} does not match the workload plan`);
    const markerShard = workloadShards.get(entry.shard);
    invariant(entry.selectionPlan?.forcedReconnectStrategy === 'owner-stratified-v1'
      && entry.presencePlan?.strategy === entry.selectionPlan.forcedReconnectStrategy
      && entry.presencePlan?.initialOwnedChatChannels === 100
      && entry.presencePlan?.forcedReconnectOwnedChatChannels === 10
      && stableJson(entry.selectionPlan?.forcedReconnectOwnerUserIds)
        === stableJson(entry.presencePlan?.forcedReconnectOwnerUserIds)
      && stableJson(entry.presencePlan?.forcedReconnectOwnerUserIds)
        === stableJson(markerShard?.forcedReconnectOwnerUserIds),
    `manifest load shard ${entry.shard} reconnect-owner evidence differs from the workload marker`);
    invariant(JSON.stringify({
      rampSeconds: entry.rampSeconds,
      soakSeconds: entry.soakSeconds,
      pollingPercent: entry.pollingPercent,
      reconnectPercent: entry.reconnectPercent,
      reconnectAtSeconds: entry.reconnectAtSeconds,
      rates: entry.rates,
    }) === commonConfiguration, `manifest load shard ${entry.shard} has an inconsistent workload configuration`);
    const configurationSha256 = createHash('sha256')
      .update(stableJson(loadConfiguration(entry)))
      .digest('hex');
    invariant(entry.configurationSha256 === configurationSha256,
      `manifest load shard ${entry.shard} configuration checksum is invalid`);
    invariant(Number.isInteger(entry.successfulChatWrites) && entry.successfulChatWrites > 0
      && Number.isInteger(entry.successfulRuns) && entry.successfulRuns > 0,
    `manifest load shard ${entry.shard} has no exact successful workload counts`);
    invariant(entry.workloadIdentity?.successfulMessageIdsCount === entry.successfulChatWrites
      && entry.workloadIdentity?.requestedRunIdsCount === entry.successfulRuns
      && DIGEST_PATTERN.test(entry.workloadIdentity?.successfulMessageIdsSha256 || '')
      && DIGEST_PATTERN.test(entry.workloadIdentity?.requestedRunIdsSha256 || '')
      && markerShard?.successfulMessageIdsCount === entry.successfulChatWrites
      && markerShard?.successfulMessageIdsSha256
        === entry.workloadIdentity.successfulMessageIdsSha256
      && markerShard?.requestedRunIdsCount === entry.successfulRuns
      && markerShard?.requestedRunIdsSha256 === entry.workloadIdentity.requestedRunIdsSha256,
    `manifest load shard ${entry.shard} workload identities differ from its artifact marker`);
    invariant(Date.parse(entry.soakStartedAt) <= gateStartAt
      && Date.parse(entry.rampCompletedAt) <= gateStartAt
      && Date.parse(entry.workloadFinishedAt) >= gateEndAt
      && Date.parse(entry.finishedAt) >= gateEndAt,
    `manifest load shard ${entry.shard} does not span the full concurrent gate`);
  }
  invariant(certification.loads.reduce((total, entry) => total + entry.users, 0)
    === certification.totalUsers, 'manifest load user total is inconsistent');
  const configurationEvidence = certification.loads
    .map((entry) => ({ shard: entry.shard, sha256: entry.configurationSha256 }))
    .sort((left, right) => left.shard - right.shard);
  invariant(stableJson(loadDriver.configurations) === stableJson(configurationEvidence)
    && loadDriver.configurationsSha256 === createHash('sha256')
      .update(stableJson(configurationEvidence)).digest('hex'),
  'manifest load-driver configuration evidence differs from its shards');
  const expectedReconciliation = {
    users: sourceSnapshot.database.counts.users + fixture.users,
    vaults: sourceSnapshot.database.counts.vaults + fixture.groups,
    memberships: sourceSnapshot.database.counts.memberships + fixture.users,
    channels: fixture.groups,
    successfulChatWrites: certification.loads.reduce(
      (sum, entry) => sum + entry.successfulChatWrites, 0,
    ),
    successfulRuns: certification.loads.reduce((sum, entry) => sum + entry.successfulRuns, 0),
    successfulMessageIdsSha256: reconciliation.expected.successfulMessageIdsSha256,
    requestedRunIdsSha256: reconciliation.expected.requestedRunIdsSha256,
    shardWorkloadIdentities: certification.loads
      .map((entry) => ({ shard: entry.shard, ...entry.workloadIdentity }))
      .sort((left, right) => left.shard - right.shard),
  };
  invariant(stableJson(reconciliation.expected) === stableJson(expectedReconciliation),
    'manifest reconciliation expectations differ from source, fixture, or load evidence');
  const reconciledObserved = reconciliation.observed || {};
  invariant(reconciledObserved.users === expectedReconciliation.users
    && reconciledObserved.vaults === expectedReconciliation.vaults
    && reconciledObserved.memberships === expectedReconciliation.memberships
    && reconciledObserved.fixtureChannelCount === expectedReconciliation.channels
    && reconciledObserved.loadMessageCount === expectedReconciliation.successfulChatWrites
    && reconciledObserved.loadMessageDistinctIds === expectedReconciliation.successfulChatWrites
    && reconciledObserved.loadMessageChannels === expectedReconciliation.channels
    && reconciledObserved.loadRunCount === expectedReconciliation.successfulRuns
    && reconciledObserved.completedLoadRuns === expectedReconciliation.successfulRuns
    && ['duplicateMessageIds', 'unexercisedFixtureChannels', 'badMessageScope',
      'badMessageBodies', 'unexpectedNewRuns', 'badRunPrompts', 'badRunRows',
      'badTerminalEventCounts', 'badEventSequences',
      'badRunEventSignatures', 'openDelegatedRuns',
      'foreignKeyViolations'].every((key) => reconciledObserved[key] === 0)
    && reconciledObserved.quickCheck === 'ok',
  'manifest reconciliation counts, scope, or integrity evidence is invalid');
  const faults = certification?.faults;
  invariant(Array.isArray(faults) && faults.length === REQUIRED_FAULTS.size,
    'manifest fault-recovery evidence is incomplete');
  invariant(new Set(faults.map((entry) => entry.fault)).size === REQUIRED_FAULTS.size
    && faults.every((entry) => REQUIRED_FAULTS.has(entry.fault)),
  'manifest fault-recovery identities are incomplete');
  invariant(faults.every((entry) => entry.evaluation === 'passed'
    && DIGEST_PATTERN.test(entry.sha256 || '')
    && entry.fixtureSha256 === fixture.sha256
    && entry.containerId === preflights.faults.containerId),
  'manifest contains failed or unbound fault-recovery evidence');
  const soak = certification?.soak;
  invariant(soak?.evaluation === 'passed'
    && DIGEST_PATTERN.test(soak?.sha256 || '')
    && DIGEST_PATTERN.test(soak?.journal?.sha256 || '')
    && DIGEST_PATTERN.test(soak?.fixtures?.sha256 || '')
    && DIGEST_PATTERN.test(soak?.fixtures?.selectedIdentitySha256 || '')
    && DIGEST_PATTERN.test(soak?.serverLogs?.sha256 || '')
    && DIGEST_PATTERN.test(soak?.postDbEventDigest || '')
    && DIGEST_PATTERN.test(soak?.liveEventDigest || ''),
  'manifest two-hour soak evidence is missing, failed, or unbound');
  invariant(soak?.imageId === manifest.image.id
    && soak?.revision === manifest.revision
    && soak?.target === certification.target
    && soak?.containerId === preflights.soak5k.containerId,
  'manifest two-hour soak image, revision, or target differs from the release certificate');
  validatePhaseChronology(preflights, freezes, reconciliation, faults, soak);
  invariant(soak?.users === REQUIRED_LONG_SOAK_USERS
    && soak?.rampSeconds === SOAK_PROFILE.rampSeconds
    && soak?.soakSeconds === REQUIRED_LONG_SOAK_SECONDS
    && soak?.sampleIntervalSeconds === SOAK_PROFILE.sampleIntervalSeconds
    && soak?.recoveryConsecutiveSamples === SOAK_PROFILE.recoveryConsecutiveSamples
    && soak?.churnPercent === REQUIRED_LONG_SOAK_CHURN_PERCENT
    && soak?.churnIntervalSeconds === REQUIRED_LONG_SOAK_CHURN_INTERVAL_SECONDS
    && soak?.runRps === REQUIRED_LONG_SOAK_RUN_RPS,
  'manifest two-hour soak workload differs from the release contract');
  invariant(Number.isFinite(Date.parse(soak?.rampStartedAt))
    && Number.isFinite(Date.parse(soak?.rampCompletedAt))
    && Number.isFinite(Date.parse(soak?.soakStartedAt))
    && Date.parse(soak.rampCompletedAt) <= Date.parse(soak.soakStartedAt)
    && Date.parse(soak.rampCompletedAt) - Date.parse(soak.rampStartedAt)
      >= SOAK_PROFILE.rampSeconds * 1_000
    && Date.parse(soak.rampCompletedAt) - Date.parse(soak.rampStartedAt)
      <= (SOAK_PROFILE.rampSeconds + 10) * 1_000,
  'manifest two-hour soak does not bind the observed 300-second ramp');
  invariant(soak?.fixtures?.users === REQUIRED_LONG_SOAK_USERS
    && soak?.fixtures?.groups === REQUIRED_LONG_SOAK_USERS / 25
    && soak?.fixtures?.sha256 === fixture.sha256
    && Number.isInteger(soak?.fixtures?.bytes) && soak.fixtures.bytes > 0,
  'manifest two-hour soak fixture evidence is incomplete');
  invariant(soak?.serverLogs?.policy === 'zero fatal/error lines from container start through soak finish'
    && soak?.serverLogs?.baselineCursor === soak?.containerStartedAt
    && Number.isFinite(Date.parse(soak?.serverLogs?.finishCursor))
    && soak?.serverLogs?.readError === null
    && soak?.serverLogs?.matchedErrorLines === 0
    && soak?.serverLogs?.matchesTruncated === false
    && Number.isInteger(soak?.serverLogs?.totalBytes)
    && Number.isInteger(soak?.serverLogs?.totalLines),
  'manifest two-hour soak server-log evidence is incomplete');
  invariant(Date.parse(soak.serverLogs.finishCursor) >= Date.parse(soak.finishedAt),
    'manifest two-hour soak server-log capture does not span the certified interval');
  invariant(soak?.database?.baseline && soak?.database?.final
    && Array.isArray(soak?.database?.failures) && soak.database.failures.length === 0
    && soak.database.final.foreignKeyViolations === 0
    && soak.database.final.quickCheck === 'ok',
  'manifest two-hour soak SQLite reconciliation is incomplete');
  const manifestSoakDatabase = reconcileLongSoakDatabase(
    soak.database.baseline,
    soak.database.final,
    soak.runCount,
    soak.persistedEventCount,
  );
  invariant(stableJson(soak.database) === stableJson(manifestSoakDatabase)
    && manifestSoakDatabase.failures.length === 0,
  'manifest two-hour soak SQLite counts or approved orphan transition do not reconcile');
  invariant(freezes.main10k.phaseWorkload?.runs === expectedReconciliation.successfulRuns
    && freezes.main10k.phaseWorkload?.completedRuns === expectedReconciliation.successfulRuns
    && freezes.main10k.phaseWorkload?.runEvents === expectedReconciliation.successfulRuns * 4
    && freezes.main10k.phaseWorkload?.messages === expectedReconciliation.successfulChatWrites,
  'manifest phase A workload differs from reconciliation evidence');
  validateFaultPersistence(freezes.faults.phaseWorkload, faults);
  invariant(freezes.soak5k.phaseWorkload?.runs === soak.runCount
    && freezes.soak5k.phaseWorkload?.completedRuns === soak.runCount
    && freezes.soak5k.phaseWorkload?.runEvents === soak.persistedEventCount
    && freezes.soak5k.phaseWorkload?.messages === 0,
  'manifest phase C workload differs from soak evidence');
  validatePhaseTableDeltas(freezes.main10k, fixture, expectedReconciliation);
  validatePhaseTableDeltas(freezes.faults, fixture, freezes.faults.phaseWorkload);
  validatePhaseTableDeltas(freezes.soak5k, fixture, soak);
  const soakHeadroom = soak?.journalHeadroom;
  invariant(soakHeadroom
    && [
      soakHeadroom.cpuMaxPct,
      soakHeadroom.memoryMaxPct,
      soakHeadroom.schedulerMaxPct,
      soakHeadroom.poolSaturationRatio,
      soakHeadroom.dbQueueP99Us,
      soakHeadroom.dbQueryP99Us,
      soakHeadroom.dbWriteLockWaitP99Us,
      soakHeadroom.dbWriteLockHoldP99Us,
      soakHeadroom.mailboxMax,
      soakHeadroom.walMaxBytes,
      soakHeadroom.walGrowthBytes,
      soakHeadroom.sessionCoverage,
      soakHeadroom.runnerCoverage,
      soakHeadroom.membershipCoverage,
    ].every(Number.isFinite)
    && soakHeadroom.cpuMaxPct <= 70
    && soakHeadroom.memoryMaxPct <= 70
    && soakHeadroom.schedulerMaxPct <= 80
    && soakHeadroom.poolSaturationRatio <= 0.05
    && soakHeadroom.dbQueueP99Us <= 50_000
    && soakHeadroom.dbQueryP99Us <= 100_000
    && soakHeadroom.dbWriteLockWaitP99Us <= 100_000
    && soakHeadroom.dbWriteLockHoldP99Us <= 100_000
    && soakHeadroom.dbErrors === 0
    && soakHeadroom.dbBusyOrLockedErrors === 0
    && soakHeadroom.dbWriteLockOwnerDeaths === 0
    && soakHeadroom.probeErrors === 0
    && soakHeadroom.mailboxMax <= 500
    && soakHeadroom.walMaxBytes <= 128 * 1024 ** 2
    && soakHeadroom.walGrowthBytes <= 64 * 1024 ** 2
    && soakHeadroom.restarts === 0
    && soakHeadroom.oomKilled === false
    && soakHeadroom.rpcErrors === 0
    && soakHeadroom.sessionCoverage >= 0.95
    && soakHeadroom.runnerCoverage >= 0.95
    && soakHeadroom.membershipCoverage >= 0.95,
  'manifest two-hour soak headroom evidence is missing or outside the release gate');
  invariant(soak?.probeUninstalled === true,
    'manifest two-hour soak capacity probe was not cleanly uninstalled');
  invariant(soak?.teardown?.runnerDisconnectFlushes === 1
    && soak.teardown.runnerDisconnectFlushOwners >= Math.floor(REQUIRED_LONG_SOAK_USERS * 0.99)
    && soak.teardown.runnerDisconnectFlushOwners <= REQUIRED_LONG_SOAK_USERS
    && soak.teardown.runnerDelegatedSnapshotReads === 1
    && soak.teardown.runnerDelegatedOwnerReads === 0
    && soak.teardown.presenceDispatcher?.completed === soak.teardown.presenceDispatcher?.dispatched
    && soak.teardown.presenceDispatcher?.completed === soak.teardown.presenceDispatcher?.refreshed
    && soak.teardown.presenceDispatcher?.failed === 0
    && soak.teardown.presenceDispatcher?.noop === 0
    && soak.teardown.presenceDispatcher?.startFailed === 0
    && soak.teardown.presenceDispatcher?.taskFailed === 0
    && soak.teardown.presenceDispatcher?.active === 0
    && soak.teardown.presenceDispatcher?.pending === 0
    && soak.teardown.presenceDispatcher?.queued === 0,
  'manifest two-hour soak teardown batching or dispatcher drain is invalid');
  invariant(typeof soak?.containerId === 'string' && soak.containerId !== ''
    && Number.isFinite(Date.parse(soak?.containerStartedAt))
    && Number.isFinite(Date.parse(soak?.startedAt))
    && Number.isFinite(Date.parse(soak?.finishedAt))
    && Date.parse(soak.finishedAt) > Date.parse(soak.startedAt),
  'manifest two-hour soak identity or timestamps are invalid');
  invariant(faults.every((entry) => Date.parse(entry.startedAt) >= Date.parse(freezes.main10k.frozenAt)
    && Date.parse(entry.finishedAt) <= Date.parse(freezes.faults.frozenAt))
    && Date.parse(soak.startedAt) >= Date.parse(freezes.main10k.frozenAt)
    && Date.parse(soak.finishedAt) <= Date.parse(freezes.soak5k.frozenAt),
  'manifest phase B/C workload timestamps are outside their owned lifecycle');
  invariant(Number.isInteger(soak?.journal?.bytes) && soak.journal.bytes >= 0
    && Number.isInteger(soak?.journal?.samples) && soak.journal.samples >= 10,
  'manifest two-hour soak journal metadata is invalid');
  return manifest;
}

function inspectImage(image) {
  const [inspection] = JSON.parse(commandOutput('docker', ['image', 'inspect', image]));
  invariant(inspection, `image ${image} is unavailable`);
  return inspection;
}

function runtimeImageId(inspection) {
  const id = inspection.Descriptor?.annotations?.['config.digest'] || inspection.Id;
  invariant(/^sha256:[0-9a-f]{64}$/u.test(id || ''), 'image has no canonical runtime config ID');
  return id;
}

function verifyImage(manifest) {
  const inspection = inspectImage(manifest.image.tag);
  const localImageId = runtimeImageId(inspection);
  invariant(localImageId === manifest.image.id,
    `local image ${manifest.image.tag} is ${localImageId}, expected ${manifest.image.id}`);
  invariant(inspection.Config?.Labels?.['org.opencontainers.image.revision'] === manifest.revision,
    'image revision label does not match the certification manifest');
  invariant(inspection.Config?.Labels?.['io.cascade.backend'] === 'elixir', 'image is not labeled as the Elixir backend');
}

function verifyChecksum(manifestPath, actual = null) {
  const sidecar = artifactSnapshot(`${manifestPath}.sha256`, 'manifest checksum sidecar');
  const expected = sidecar.text.trim().split(/\s+/u)[0];
  invariant(/^[0-9a-f]{64}$/.test(expected), 'manifest checksum sidecar is invalid');
  invariant((actual || artifactSnapshot(manifestPath, 'certification manifest').sha256) === expected,
    'certification manifest checksum does not match');
}

function requireExactCheckout(revision, clean) {
  invariant(commandOutput('git', ['rev-parse', 'HEAD']) === revision, 'manifest revision is not the checked-out commit');
  if (clean) invariant(commandOutput('git', ['status', '--porcelain', '--untracked-files=all']) === '',
    'certification requires a clean checkout');
}

function certify(options) {
  invariant(options.image, '--image is required');
  invariant(options.monitor, '--monitor is required');
  invariant(options.sourceDatabase, '--source-database is required');
  invariant(options.sourceCorpusRoot, '--source-corpus-root is required');
  invariant(options.fixture, '--fixture is required');
  invariant(options.loadDriver, '--load-driver is required');
  invariant(options.reconciliationDriver, '--reconciliation-driver is required');
  invariant(options.reconciliation, '--reconciliation is required');
  invariant(options.fixturePreflight, '--fixture-preflight is required for phase A');
  invariant(options.faultPreflight, '--fault-preflight is required for phase B');
  invariant(options.soakPreflight, '--soak-preflight is required for phase C');
  invariant(options.runtimeProof, '--runtime-proof is required');
  invariant(options.mainFreeze, '--main-freeze is required');
  invariant(options.faultFreeze, '--fault-freeze is required');
  invariant(options.soakFreeze, '--soak-freeze is required');
  configureSnapshotScratch(options.scratchDirectory);
  invariant(options.loadResults.length > 0, '--load-result is required for every shard');
  invariant(options.faultResults.length === REQUIRED_FAULTS.size,
    '--fault-result is required for runner restart and SQLite lock recovery');
  invariant(options.soakResult, '--soak-result is required for the 5,000-user two-hour soak');
  const inspection = inspectImage(options.image);
  const imageId = runtimeImageId(inspection);
  const revision = inspection.Config?.Labels?.['org.opencontainers.image.revision'];
  invariant(SHA_PATTERN.test(revision || ''), 'image has no full Git revision label');
  invariant(options.image === `cascade:certified-${revision}`, 'certification requires the canonical revision tag');
  requireExactCheckout(revision, true);

  const monitorArtifact = artifactSnapshot(options.monitor, 'capacity monitor evidence');
  const monitorRecords = monitorArtifact.text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const { start, finish } = validateMonitorEvidence(monitorRecords, imageId);
  validateServerLogArtifact(start, finish);
  const loadArtifacts = options.loadResults.map((filename) => artifactSnapshot(filename, 'load-shard evidence'));
  const loadResults = loadArtifacts.map((artifact) => JSON.parse(artifact.text));
  const load = validateLoadEvidence(loadResults, start, finish, loadArtifacts);
  const sourceSnapshot = collectProductionSourceEvidence(options.sourceDatabase, options.sourceCorpusRoot);
  const fixtureArtifact = artifactSnapshot(options.fixture, 'capacity fixture evidence');
  const fixture = validateCapacityFixtureArtifact(fixtureArtifact);
  const loadDriverArtifact = digestRegularFile(options.loadDriver, 'capacity load-driver evidence');
  const reconciliationDriverArtifact = digestRegularFile(
    options.reconciliationDriver,
    'capacity reconciliation-driver evidence',
  );
  const preflightInputs = [
    ['main10k', options.fixturePreflight, start.observedAt],
    ['faults', options.faultPreflight, null],
    ['soak5k', options.soakPreflight, null],
  ];
  const preflights = Object.fromEntries(preflightInputs.map(([phase, filename, monitorStartedAt]) => {
    const artifact = artifactSnapshot(filename, `${phase} fixture preflight evidence`);
    const result = JSON.parse(artifact.text);
    const mount = inspectContainerDataMount(result.containerId || '');
    const evidence = validateFixturePreflight(
      result,
      artifact,
      sourceSnapshot,
      fixture,
      mount,
      imageId,
      monitorStartedAt,
      'final10k',
      phase,
    );
    return [phase, { artifact, result, mount, evidence }];
  }));
  const distinctPreflightValues = (selector, label) => {
    const values = Object.values(preflights).map((entry) => selector(entry.evidence));
    invariant(new Set(values).size === values.length, `capacity phase ${label} values are not pairwise distinct`);
  };
  distinctPreflightValues((entry) => entry.containerId, 'container');
  distinctPreflightValues((entry) => entry.mountSourceSha256, 'data-root');
  distinctPreflightValues((entry) => `${entry.databaseDevice}:${entry.databaseInode}`, 'database inode');
  invariant(preflights.main10k.evidence.containerId === start.containerId,
    'main monitor container differs from phase A preflight');
  const runtimeProofArtifact = artifactSnapshot(options.runtimeProof, 'owned runtime proof');
  const runtimeProof = validateRuntimeProof(
    JSON.parse(runtimeProofArtifact.text),
    runtimeProofArtifact,
    preflights.main10k.evidence,
    imageId,
    revision,
    loadDriverArtifact,
    reconciliationDriverArtifact,
  );
  invariant(Date.parse(runtimeProof.executedAt) >= Date.parse(preflights.main10k.evidence.createdAt)
    && Date.parse(runtimeProof.executedAt) <= Date.parse(start.observedAt),
  'owned runtime proof is stale or later than monitor start');
  const loadDriver = validateLoadProvenance(loadResults, loadDriverArtifact, fixture);
  const reconciliationArtifact = artifactSnapshot(options.reconciliation, 'capacity reconciliation evidence');
  const reconciliationResult = JSON.parse(reconciliationArtifact.text);
  const reconciliation = validateReconciliationEvidence(
    reconciliationResult,
    reconciliationArtifact,
    sourceSnapshot,
    fixture,
    fixtureArtifact,
    loadResults,
    loadArtifacts,
    preflights.main10k.mount,
    preflights.main10k.evidence,
    finish.observedAt,
    reconciliationDriverArtifact,
    runtimeProof.embedded.reconciliationDriverSha256,
  );
  const faultArtifacts = options.faultResults.map((filename) => artifactSnapshot(filename, 'fault-recovery evidence'));
  const faultResults = faultArtifacts.map((artifact) => JSON.parse(artifact.text));
  const faults = validateFaultEvidence(
    faultResults,
    faultArtifacts,
    imageId,
    revision,
    start.monitorConfig.expectedLoad.target,
    fixtureArtifact.sha256,
  );
  invariant(faultResults.every((result) => result.containerId === preflights.faults.evidence.containerId),
    'fault evidence did not run in the owned phase B container');
  const soakArtifact = artifactSnapshot(options.soakResult, 'two-hour soak evidence');
  const soakResult = JSON.parse(soakArtifact.text);
  const soakJournalArtifact = artifactSnapshot(
    soakResult.journal?.path || '',
    'two-hour soak runtime journal',
  );
  const soakFixtureArtifact = artifactSnapshot(
    soakResult.fixtures?.path || '',
    'two-hour soak fixture artifact',
  );
  const soakServerLogArtifact = artifactSnapshot(
    soakResult.serverLogs?.output || '',
    'two-hour soak server-log artifact',
  );
  const soak = validateSoakEvidence(
    soakResult,
    soakArtifact,
    soakJournalArtifact,
    soakFixtureArtifact,
    soakServerLogArtifact,
    imageId,
    revision,
    start.monitorConfig.expectedLoad.target,
  );
  invariant(soak.containerId === preflights.soak5k.evidence.containerId,
    'two-hour soak did not run in the owned phase C container');
  invariant(soak.fixtures.sha256 === fixtureArtifact.sha256,
    'two-hour soak used a different authenticated fixture cohort');
  const freezeInputs = [
    ['main10k', options.mainFreeze],
    ['faults', options.faultFreeze],
    ['soak5k', options.soakFreeze],
  ];
  const freezes = Object.fromEntries(freezeInputs.map(([phase, filename]) => {
    const artifact = artifactSnapshot(filename, `${phase} freeze evidence`);
    const evidence = validateFreezeEvidence(
      JSON.parse(artifact.text), artifact, preflights[phase].evidence, imageId,
    );
    return [phase, evidence];
  }));
  for (const phase of ['main10k', 'faults', 'soak5k']) {
    validateFrozenPhaseAgainstMount(
      options.sourceDatabase,
      options.sourceCorpusRoot,
      fixtureArtifact,
      preflights[phase].evidence,
      freezes[phase],
      preflights[phase].mount,
    );
  }
  validatePhaseChronology(
    Object.fromEntries(Object.entries(preflights).map(([phase, entry]) => [phase, entry.evidence])),
    freezes,
    reconciliation,
    faultResults,
    soak,
  );
  invariant(freezes.main10k.phaseWorkload?.runs === reconciliation.expected.successfulRuns
    && freezes.main10k.phaseWorkload?.completedRuns === reconciliation.expected.successfulRuns
    && freezes.main10k.phaseWorkload?.runEvents === reconciliation.expected.successfulRuns * 4
    && freezes.main10k.phaseWorkload?.messages === reconciliation.expected.successfulChatWrites,
  'phase A freeze workload differs from reconciliation evidence');
  validateFaultPersistence(freezes.faults.phaseWorkload, faults);
  invariant(freezes.soak5k.phaseWorkload?.runs === soak.runCount
    && freezes.soak5k.phaseWorkload?.completedRuns === soak.runCount
    && freezes.soak5k.phaseWorkload?.runEvents === soak.persistedEventCount
    && freezes.soak5k.phaseWorkload?.messages === 0,
  'phase C freeze workload differs from two-hour soak evidence');
  validatePhaseTableDeltas(freezes.main10k, fixture, reconciliation.expected);
  validatePhaseTableDeltas(freezes.faults, fixture, freezes.faults.phaseWorkload);
  validatePhaseTableDeltas(freezes.soak5k, fixture, soak);
  const output = path.resolve(options.output || path.join(root, '.cascade-release', `${revision}.json`));
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const manifest = validateManifest({
    schemaVersion: 2,
    status: 'certified',
    revision,
    image: { id: imageId, tag: options.image },
    certification: {
      certifiedAt: new Date().toISOString(),
      totalUsers: load.users,
      shardCount: load.shardCount,
      target: start.monitorConfig.expectedLoad.target,
      provenance: {
        sourceSnapshot,
        fixture,
        loadDriver,
        runtimeProof,
        preflights: Object.fromEntries(Object.entries(preflights).map(
          ([phase, entry]) => [phase, entry.evidence],
        )),
        freezes,
        reconciliation,
      },
      monitor: {
        sha256: monitorArtifact.sha256,
        imageId: start.imageId,
        containerId: start.containerId,
        containerStartedAt: finish.containerState.startedAt,
        serverLogs: {
          policy: start.serverLogEvidence.policy,
          baselineCursor: finish.serverLogs.baselineCursor,
          finishCursor: finish.serverLogs.finishCursor,
          readError: finish.serverLogs.readError,
          sha256: finish.serverLogs.sha256,
          totalBytes: finish.serverLogs.totalBytes,
          totalLines: finish.serverLogs.totalLines,
          matchedErrorLines: finish.serverLogs.matchedErrorLines,
          matchesTruncated: finish.serverLogs.matchesTruncated,
        },
        runtimeEnvelope: {
          cpus: start.expectedShape.cpus,
          cpuset: start.hostConfig.cpusetCpus,
          memoryBytes: start.hostConfig.memory,
          memorySwapBytes: start.hostConfig.memorySwap,
          pidsLimit: start.hostConfig.pidsLimit,
          nofileSoft: start.hostConfig.ulimits.find((entry) => entry.Name === 'nofile').Soft,
          nofileHard: start.hostConfig.ulimits.find((entry) => entry.Name === 'nofile').Hard,
        },
        runtimeConfiguration: start.expectedShape.runtime,
        sessions: start.expectedShape.sessions,
        runners: start.expectedShape.runners,
        memberships: start.expectedShape.memberships,
        durationSeconds: start.monitorConfig.durationSeconds,
        gateWindowSeconds: start.monitorConfig.gateWindowSeconds,
        gateStartAt: load.gateStartAt,
        gateEndAt: load.gateEndAt,
        coverage: {
          sessions: finish.evaluation.observed.sessionCoverage,
          runners: finish.evaluation.observed.runnerCoverage,
          memberships: finish.evaluation.observed.membershipCoverage,
          sessionsEnd: finish.evaluation.observed.sessionsEnd,
          runnersEnd: finish.evaluation.observed.runnersEnd,
          membershipsEnd: finish.evaluation.observed.membershipsEnd,
        },
        realtime: validateRealtimeEvidence(
          start.expectedShape.realtime,
          finish.workload.presencePlan,
          finish.evaluation.observed,
          start.expectedShape.sessions,
          start.expectedShape.runners,
        ),
        workload: {
          finishedAt: finish.workload.finishedAt,
          elapsedSeconds: finish.workload.elapsedSeconds,
          postWorkloadSeconds: finish.workload.postWorkloadSeconds,
          users: finish.workload.users,
          shardCount: finish.workload.shards.length,
          presencePlan: finish.workload.presencePlan,
          shards: finish.workload.shards.map((shard) => ({
            shard: shard.index,
            sha256: shard.sha256,
            initialOwnedChatChannels: shard.initialOwnedChatChannels,
            forcedReconnectOwnedChatChannels: shard.forcedReconnectOwnedChatChannels,
            forcedReconnectStrategy: shard.forcedReconnectStrategy,
            forcedReconnectOwnerUserIds: shard.forcedReconnectOwnerUserIds,
            successfulMessageIdsCount: shard.successfulMessageIdsCount,
            successfulMessageIdsSha256: shard.successfulMessageIdsSha256,
            requestedRunIdsCount: shard.requestedRunIdsCount,
            requestedRunIdsSha256: shard.requestedRunIdsSha256,
          })),
        },
        evaluation: finish.evaluation.ok ? 'passed' : 'failed',
      },
      loads: options.loadResults.map((filename, index) => ({
        shard: loadResults[index].shard.index,
        sha256: loadArtifacts[index].sha256,
        users: loadResults[index].requestedUsers,
        sourceIp: loadResults[index].sourceIp,
        rampSeconds: loadResults[index].rampSeconds,
        soakSeconds: loadResults[index].soakSeconds,
        pollingPercent: loadResults[index].pollingPercent,
        reconnectPercent: loadResults[index].reconnectPercent,
        reconnectAtSeconds: loadResults[index].reconnectAtSeconds,
        selectionPlan: {
          forcedReconnectStrategy: loadResults[index].selectionPlan.forcedReconnectStrategy,
          forcedReconnectOwnerUserIds: loadResults[index].selectionPlan.forcedReconnectOwnerUserIds,
        },
        presencePlan: loadResults[index].presencePlan,
        rates: loadResults[index].rates,
        thresholds: loadResults[index].thresholds,
        successfulChatWrites: loadResults[index].metrics.workload.chat.succeeded,
        successfulRuns: loadResults[index].metrics.workload.run.succeeded,
        workloadIdentity: {
          successfulMessageIdsCount: loadResults[index].workloadIdentity.successfulMessageIdsCount,
          successfulMessageIdsSha256: loadResults[index].workloadIdentity.successfulMessageIdsSha256,
          requestedRunIdsCount: loadResults[index].workloadIdentity.requestedRunIdsCount,
          requestedRunIdsSha256: loadResults[index].workloadIdentity.requestedRunIdsSha256,
        },
        rampCompletedAt: loadResults[index].rampCompletedAt,
        soakStartedAt: loadResults[index].soakStartedAt,
        workloadFinishedAt: loadResults[index].workloadFinishedAt,
        finishedAt: loadResults[index].finishedAt,
        configurationSha256: loadResults[index].provenance.configurationSha256,
        evaluation: loadResults[index].evaluation.ok ? 'passed' : 'failed',
      })),
      faults,
      soak,
    },
  });

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, manifestBytes, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, output);
  fs.chmodSync(output, 0o600);
  const checksumTemporary = `${output}.sha256.tmp-${process.pid}`;
  fs.writeFileSync(checksumTemporary, `${manifestDigest}  ${path.basename(output)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(checksumTemporary, `${output}.sha256`);
  fs.chmodSync(`${output}.sha256`, 0o600);
  process.stdout.write(`${output}\n`);
}

function verify(options) {
  invariant(options.manifest, '--manifest is required');
  const manifestPath = path.resolve(options.manifest);
  const artifact = artifactSnapshot(manifestPath, 'certification manifest');
  const manifest = validateManifest(JSON.parse(artifact.text));
  verifyChecksum(manifestPath, artifact.sha256);
  requireExactCheckout(manifest.revision, false);
  verifyImage(manifest);
  process.stdout.write(`${manifest.image.id}\n`);
}

function field(options) {
  invariant(options.manifest && options.name, '--manifest and --name are required');
  const manifestPath = path.resolve(options.manifest);
  const artifact = artifactSnapshot(manifestPath, 'certification manifest');
  const manifest = validateManifest(JSON.parse(artifact.text));
  verifyChecksum(manifestPath, artifact.sha256);
  const fields = {
    revision: manifest.revision,
    'image.id': manifest.image.id,
    'image.tag': manifest.image.tag,
  };
  invariant(Object.hasOwn(fields, options.name), `unsupported manifest field ${options.name}`);
  process.stdout.write(`${fields[options.name]}\n`);
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'preflight') preflight(options);
  else if (command === 'freeze') freeze(options);
  else if (command === 'certify') certify(options);
  else if (command === 'verify') verify(options);
  else if (command === 'field') field(options);
  else throw new Error('usage: certified-image.mjs <preflight|freeze|certify|verify|field> [options]');
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  try {
    main();
  } catch (error) {
    console.error(`[certified-image] ${error.message}`);
    process.exitCode = 1;
  }
}
