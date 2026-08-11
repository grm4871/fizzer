#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseArgs } from './load.mjs';

const reconciliationDriverPath = fileURLToPath(import.meta.url);
const reconciliationDriverBytes = fs.readFileSync(reconciliationDriverPath);
const reconciliationDriverSha256 = createHash('sha256').update(reconciliationDriverBytes).digest('hex');

function integerOption(args, key, minimum = 0) {
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`--${key} must be an integer >= ${minimum}`);
  }
  return value;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readShardArtifacts(files, expectedCount) {
  if (files.length !== expectedCount) {
    throw new Error(`received ${files.length} shard artifacts, expected ${expectedCount}`);
  }
  const seen = new Set();
  return files.map((file) => {
    const resolved = path.resolve(file);
    const result = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const index = result?.shard?.index;
    if (!Number.isInteger(index) || result?.shard?.count !== expectedCount || seen.has(index)) {
      throw new Error(`invalid or duplicate shard identity in ${resolved}`);
    }
    if (result?.evaluation?.ok !== true) throw new Error(`shard ${index} did not pass its load evaluation`);
    for (const kind of ['chat', 'run']) {
      if (!Number.isInteger(result?.metrics?.workload?.[kind]?.succeeded)) {
        throw new Error(`shard ${index} has no exact successful ${kind} count`);
      }
    }
    seen.add(index);
    return {
      index,
      path: resolved,
      sha256: sha256File(resolved),
      successfulChatWrites: result.metrics.workload.chat.succeeded,
      successfulRuns: result.metrics.workload.run.succeeded,
    };
  }).sort((left, right) => left.index - right.index);
}

export function queryDatabase(database, prefix, baselineMaxRunId) {
  const sql = `
WITH fixture_vaults AS (
  SELECT DISTINCT vm.vault_id
  FROM vault_members vm
  JOIN users u ON u.id = vm.user_id
  WHERE u.username GLOB '${prefix}_*'
), fixture_channels AS (
  SELECT DISTINCT n.id, n.vault_id
  FROM notes n
  JOIN fixture_vaults fv ON fv.vault_id = n.vault_id
  WHERE n.content = 'cascade://chat-channel'
), scoped_runs AS (
  SELECT id, status
  FROM runs
  WHERE id > ${baselineMaxRunId} AND prompt LIKE 'capacity proof%'
)
SELECT
  (SELECT count(*) FROM users) AS users,
  (SELECT count(*) FROM vaults) AS vaults,
  (SELECT count(*) FROM vault_members) AS memberships,
  (SELECT count(*) FROM notes) AS totalNotes,
  (SELECT count(*) FROM chat_messages) AS totalMessages,
  (SELECT count(*) FROM runs) AS totalRuns,
  (SELECT count(*) FROM run_events) AS totalRunEvents,
  (SELECT count(*) FROM delegated_runs) AS totalDelegatedRuns,
  (SELECT count(*) FROM fixture_channels) AS fixtureChannelCount,
  (SELECT count(*) FROM chat_messages WHERE id GLOB 'load-*') AS loadMessageCount,
  (SELECT count(DISTINCT id) FROM chat_messages WHERE id GLOB 'load-*') AS loadMessageDistinctIds,
  (SELECT count(DISTINCT channel_id) FROM chat_messages WHERE id GLOB 'load-*') AS loadMessageChannels,
  (SELECT count(*) FROM (
    SELECT id FROM chat_messages WHERE id GLOB 'load-*' GROUP BY id HAVING count(*) != 1
  )) AS duplicateMessageIds,
  (SELECT count(*) FROM fixture_channels fc WHERE NOT EXISTS (
    SELECT 1 FROM chat_messages m
    WHERE m.id GLOB 'load-*' AND m.channel_id = fc.id AND m.vault_id = fc.vault_id
  )) AS unexercisedFixtureChannels,
  (SELECT count(*) FROM chat_messages m
    LEFT JOIN fixture_channels fc ON fc.id = m.channel_id AND fc.vault_id = m.vault_id
    WHERE m.id GLOB 'load-*' AND fc.id IS NULL
  ) AS badMessageScope,
  (SELECT count(*) FROM scoped_runs) AS loadRunCount,
  (SELECT count(*) FROM scoped_runs WHERE status = 'completed') AS completedLoadRuns,
  (SELECT count(*) FROM run_events e JOIN scoped_runs r ON r.id=e.run_id) AS loadRunEventCount,
  (SELECT count(*) FROM runs WHERE id > ${baselineMaxRunId} AND prompt NOT LIKE 'capacity proof%') AS unexpectedNewRuns,
  (SELECT count(*) FROM (
    SELECT r.id
    FROM scoped_runs r
    LEFT JOIN run_events e ON e.run_id = r.id
      AND e.type = 'status'
      AND json_extract(e.payload_json, '$.status') IN ('completed', 'failed', 'canceled')
    GROUP BY r.id
    HAVING count(e.id) != 1
  )) AS badTerminalEventCounts,
  (SELECT count(*) FROM (
    SELECT e.run_id
    FROM run_events e
    JOIN scoped_runs r ON r.id = e.run_id
    GROUP BY e.run_id
    HAVING min(e.seq) != 1 OR max(e.seq) != count(*) OR count(DISTINCT e.seq) != count(*)
  )) AS badEventSequences,
  (SELECT count(*) FROM delegated_runs d
    JOIN scoped_runs r ON r.id = d.run_id
    WHERE r.status IN ('queued', 'running')
  ) AS openDelegatedRuns,
  (SELECT count(*) FROM pragma_foreign_key_check) AS foreignKeyViolations,
  (SELECT group_concat(quick_check, ',') FROM pragma_quick_check) AS quickCheck;
`;
  const databaseUri = `${pathToFileURL(database).href}?immutable=1`;
  const raw = execFileSync('sqlite3', ['-readonly', '-json', databaseUri, sql], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = JSON.parse(raw);
  if (rows.length !== 1) throw new Error(`reconciliation query returned ${rows.length} rows`);
  return rows[0];
}

export function evaluateReconciliation(observed, expected) {
  const failures = [];
  const exact = [
    ['users', expected.users, 'users'],
    ['vaults', expected.vaults, 'vaults'],
    ['memberships', expected.memberships, 'memberships'],
    ['fixtureChannelCount', expected.channels, 'fixture channels'],
    ['loadMessageCount', expected.successfulChatWrites, 'load messages'],
    ['loadMessageDistinctIds', expected.successfulChatWrites, 'unique load message IDs'],
    ['loadMessageChannels', expected.channels, 'exercised load channels'],
    ['loadRunCount', expected.successfulRuns, 'load runs'],
    ['completedLoadRuns', expected.successfulRuns, 'completed load runs'],
  ];
  for (const [key, wanted, label] of exact) {
    if (observed?.[key] !== wanted) failures.push(`${label} are ${observed?.[key] ?? 'missing'}, expected ${wanted}`);
  }
  for (const [key, label] of [
    ['duplicateMessageIds', 'duplicate load message IDs'],
    ['unexercisedFixtureChannels', 'unexercised fixture channels'],
    ['badMessageScope', 'cross-scope load messages'],
    ['unexpectedNewRuns', 'unexpected new runs'],
    ['badTerminalEventCounts', 'runs with non-unique terminal events'],
    ['badEventSequences', 'runs with invalid event sequences'],
    ['openDelegatedRuns', 'open delegated runs'],
    ['foreignKeyViolations', 'foreign-key violations'],
  ]) {
    if (observed?.[key] !== 0) failures.push(`${label}: ${observed?.[key] ?? 'missing'}`);
  }
  if (observed?.quickCheck !== 'ok') failures.push(`SQLite quick_check is ${observed?.quickCheck ?? 'missing'}, expected ok`);
  return { ok: failures.length === 0, failures };
}

export function reconcile(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const database = path.resolve(String(args.database || ''));
  const output = path.resolve(String(args.output || ''));
  const prefix = String(args.fixturePrefix || '');
  if (!fs.statSync(database).isFile()) throw new Error(`database is not a regular file: ${database}`);
  if (!output || output === path.resolve('.')) throw new Error('--output is required');
  if (!/^[a-z][a-z0-9_-]{2,30}$/u.test(prefix)) throw new Error('--fixture-prefix is invalid');
  const expectedShardCount = integerOption(args, 'expectedShards', 1);
  const shardFiles = String(args.shards || '').split(',').map((value) => value.trim()).filter(Boolean);
  const shards = readShardArtifacts(shardFiles, expectedShardCount);
  const expected = {
    users: integerOption(args, 'expectedUsers', 1),
    vaults: integerOption(args, 'expectedVaults', 1),
    memberships: integerOption(args, 'expectedMemberships', 1),
    channels: integerOption(args, 'expectedChannels', 1),
    successfulChatWrites: shards.reduce((sum, shard) => sum + shard.successfulChatWrites, 0),
    successfulRuns: shards.reduce((sum, shard) => sum + shard.successfulRuns, 0),
  };
  const baselineMaxRunId = integerOption(args, 'baselineMaxRunId', 0);
  const observed = queryDatabase(database, prefix, baselineMaxRunId);
  const evaluation = evaluateReconciliation(observed, expected);
  const evidence = {
    schemaVersion: 1,
    type: 'cascade-capacity-reconciliation',
    provenance: {
      driverSha256: reconciliationDriverSha256,
      driverBytes: reconciliationDriverBytes.byteLength,
    },
    database,
    databaseSha256: sha256File(database),
    fixturePrefix: prefix,
    baselineMaxRunId,
    shards,
    expected,
    observed,
    evaluation,
    finishedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (!evaluation.ok) process.exitCode = 1;
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reconcile();
}
