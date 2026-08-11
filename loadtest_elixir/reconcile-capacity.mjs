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

function digestIdentity(values) {
  return createHash('sha256').update(stableJson(values)).digest('hex');
}

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
    const messageIds = result.workloadIdentity?.successfulMessageIds;
    const runIds = result.workloadIdentity?.requestedRunIds;
    if (!Array.isArray(messageIds) || !Array.isArray(runIds)
      || messageIds.length !== result.metrics.workload.chat.succeeded
      || runIds.length !== result.metrics.workload.run.succeeded
      || result.workloadIdentity.successfulMessageIdsCount !== messageIds.length
      || result.workloadIdentity.requestedRunIdsCount !== runIds.length
      || new Set(messageIds).size !== messageIds.length || new Set(runIds).size !== runIds.length
      || stableJson(messageIds) !== stableJson([...messageIds].sort())
      || stableJson(runIds) !== stableJson([...runIds].sort((left, right) => left - right))
      || result.workloadIdentity.successfulMessageIdsSha256 !== digestIdentity(messageIds)
      || result.workloadIdentity.requestedRunIdsSha256 !== digestIdentity(runIds)) {
      throw new Error(`shard ${index} has invalid successful message/run identity evidence`);
    }
    seen.add(index);
    return {
      index,
      path: resolved,
      sha256: sha256File(resolved),
      successfulChatWrites: result.metrics.workload.chat.succeeded,
      successfulRuns: result.metrics.workload.run.succeeded,
      successfulMessageIds: messageIds,
      successfulMessageIdsCount: messageIds.length,
      successfulMessageIdsSha256: result.workloadIdentity.successfulMessageIdsSha256,
      requestedRunIds: runIds,
      requestedRunIdsCount: runIds.length,
      requestedRunIdsSha256: result.workloadIdentity.requestedRunIdsSha256,
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
  WHERE id > ${baselineMaxRunId}
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
  (SELECT json_group_array(id) FROM (
    SELECT id FROM chat_messages WHERE id GLOB 'load-*' ORDER BY id
  )) AS loadMessageIdsJson,
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
  (SELECT count(*) FROM chat_messages
    WHERE id GLOB 'load-*' AND body != ('capacity ' || id)
  ) AS badMessageBodies,
  (SELECT count(*) FROM scoped_runs) AS loadRunCount,
  (SELECT count(*) FROM scoped_runs WHERE status = 'completed') AS completedLoadRuns,
  (SELECT json_group_array(id) FROM (SELECT id FROM scoped_runs ORDER BY id)) AS loadRunIdsJson,
  (SELECT count(*) FROM run_events e JOIN scoped_runs r ON r.id=e.run_id) AS loadRunEventCount,
  0 AS unexpectedNewRuns,
  (SELECT count(*) FROM runs
    WHERE id > ${baselineMaxRunId}
      AND prompt NOT LIKE 'capacity proof' || char(10) || char(10) || '[Context: %'
  ) AS badRunPrompts,
  (SELECT count(*) FROM runs r
    LEFT JOIN fixture_vaults fv ON fv.vault_id=r.vault_id
    WHERE r.id > ${baselineMaxRunId}
      AND (r.agent IS NOT 'grok' OR r.note_id IS NOT NULL OR fv.vault_id IS NULL
        OR r.status IS NOT 'completed' OR r.summary IS NOT ('capacity run ' || r.id)
        OR r.session_id IS NOT ('load-session-' || r.id)
        OR r.prompt NOT LIKE 'capacity proof' || char(10) || char(10) || '[Context: %')
  ) AS badRunRows,
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
  (SELECT count(*) FROM scoped_runs r
    WHERE NOT EXISTS (
      SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.seq=1 AND e.type='status'
        AND json_type(e.payload_json,'$')='object'
        AND (SELECT count(*) FROM json_each(e.payload_json))=1
        AND json_extract(e.payload_json,'$.status')='queued'
    ) OR NOT EXISTS (
      SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.seq=2 AND e.type='status'
        AND json_type(e.payload_json,'$')='object'
        AND (SELECT count(*) FROM json_each(e.payload_json))=1
        AND json_extract(e.payload_json,'$.status')='running'
    ) OR NOT EXISTS (
      SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.seq=3 AND e.type='text'
        AND json_type(e.payload_json,'$')='object'
        AND (SELECT count(*) FROM json_each(e.payload_json))=2
        AND json_extract(e.payload_json,'$.chatVisible')=1
        AND json_type(e.payload_json,'$.message')='object'
        AND (SELECT count(*) FROM json_each(json_extract(e.payload_json,'$.message')))=1
        AND json_type(e.payload_json,'$.message.content')='array'
        AND json_array_length(e.payload_json,'$.message.content')=1
        AND json_type(e.payload_json,'$.message.content[0]')='object'
        AND (SELECT count(*) FROM json_each(json_extract(e.payload_json,'$.message.content[0]')))=2
        AND json_extract(e.payload_json,'$.message.content[0].type')='text'
        AND json_extract(e.payload_json,'$.message.content[0].text')='capacity event ' || r.id
    ) OR NOT EXISTS (
      SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.seq=4 AND e.type='status'
        AND json_type(e.payload_json,'$')='object'
        AND (SELECT count(*) FROM json_each(e.payload_json))=3
        AND json_extract(e.payload_json,'$.status')='completed'
        AND json_extract(e.payload_json,'$.summary')='capacity run ' || r.id
        AND json_extract(e.payload_json,'$.sessionId')='load-session-' || r.id
    )
  ) AS badRunEventSignatures,
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
  const row = rows[0];
  for (const [jsonKey, outputKey] of [
    ['loadMessageIdsJson', 'loadMessageIds'],
    ['loadRunIdsJson', 'loadRunIds'],
  ]) {
    try { row[outputKey] = JSON.parse(row[jsonKey] || '[]'); } catch {
      throw new Error(`reconciliation query returned invalid ${jsonKey}`);
    }
    delete row[jsonKey];
  }
  row.loadMessageIdsSha256 = digestIdentity(row.loadMessageIds);
  row.loadRunIdsSha256 = digestIdentity(row.loadRunIds);
  return row;
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
  if (stableJson(observed?.loadMessageIds) !== stableJson(expected?.successfulMessageIds)
      || observed?.loadMessageIdsSha256 !== expected?.successfulMessageIdsSha256) {
    failures.push('persisted load message identities differ from successful shard writes');
  }
  if (stableJson(observed?.loadRunIds) !== stableJson(expected?.requestedRunIds)
      || observed?.loadRunIdsSha256 !== expected?.requestedRunIdsSha256) {
    failures.push('persisted load run identities differ from requested shard runs');
  }
  for (const [key, label] of [
    ['duplicateMessageIds', 'duplicate load message IDs'],
    ['unexercisedFixtureChannels', 'unexercised fixture channels'],
    ['badMessageScope', 'cross-scope load messages'],
    ['badMessageBodies', 'load messages with invalid bodies'],
    ['unexpectedNewRuns', 'unexpected new runs'],
    ['badRunPrompts', 'load runs with invalid enriched prompts'],
    ['badRunRows', 'load runs with invalid persisted rows'],
    ['badTerminalEventCounts', 'runs with non-unique terminal events'],
    ['badEventSequences', 'runs with invalid event sequences'],
    ['badRunEventSignatures', 'runs with invalid event signatures'],
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
    successfulMessageIds: shards.flatMap((shard) => shard.successfulMessageIds).sort(),
    requestedRunIds: shards.flatMap((shard) => shard.requestedRunIds).sort((left, right) => left - right),
  };
  expected.successfulMessageIdsSha256 = digestIdentity(expected.successfulMessageIds);
  expected.requestedRunIdsSha256 = digestIdentity(expected.requestedRunIds);
  expected.shardWorkloadIdentities = shards.map((shard) => ({
    shard: shard.index,
    successfulMessageIdsCount: shard.successfulMessageIdsCount,
    successfulMessageIdsSha256: shard.successfulMessageIdsSha256,
    requestedRunIdsCount: shard.requestedRunIdsCount,
    requestedRunIdsSha256: shard.requestedRunIdsSha256,
  }));
  if (new Set(expected.successfulMessageIds).size !== expected.successfulChatWrites
      || expected.successfulMessageIds.length !== expected.successfulChatWrites
      || new Set(expected.requestedRunIds).size !== expected.successfulRuns
      || expected.requestedRunIds.length !== expected.successfulRuns) {
    throw new Error('shard workload identities overlap or differ from successful counts');
  }
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
