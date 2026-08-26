// Logical database evidence: compare approved rows, FTS, migration identity, and phase deltas.
// Inputs are source/candidate DBs plus phase labels; outputs are deterministic row evidence; failures throw.
// Ordering validates schema and row identity before workload-specific counts.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as p from './certified-primitives.mjs';
import * as source from './certified-source-evidence.mjs';
import { commonFts5ShadowTables, databaseSnapshot, validatePinnedElixirSchema, verifyFtsIntegrity } from '../../scripts/check-elixir-data-compat.mjs';

const { stableJson, invariant, digestRegularFile, PRODUCTION_APPLICATION_TABLES,
  PRODUCTION_APPLICATION_TABLES_SHA256, CAPACITY_PROFILES } = p;
const { sqliteJson } = source;

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

export function expectedFixtureDatabaseBaseline(sourceSnapshot, fixture) {
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

export function validateLogicalTableEvidence(sourceRows, expectedTableNames = null) {
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
