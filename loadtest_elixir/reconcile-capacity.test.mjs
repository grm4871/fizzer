import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { evaluateReconciliation, queryDatabase } from './reconcile-capacity.mjs';

const messageIds = Array.from({ length: 3_000 }, (_unused, index) => `load-${index}`);
const runIds = Array.from({ length: 120 }, (_unused, index) => 1_898 + index);
const digest = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');

function passingObserved() {
  return {
    users: 1_007,
    vaults: 52,
    memberships: 1_015,
    fixtureChannelCount: 40,
    loadMessageCount: 3_000,
    loadMessageDistinctIds: 3_000,
    loadMessageChannels: 40,
    loadMessageIds: [...messageIds],
    loadMessageIdsSha256: digest(messageIds),
    duplicateMessageIds: 0,
    unexercisedFixtureChannels: 0,
    badMessageScope: 0,
    badMessageBodies: 0,
    loadRunCount: 120,
    completedLoadRuns: 120,
    loadRunIds: [...runIds],
    loadRunIdsSha256: digest(runIds),
    unexpectedNewRuns: 0,
    badRunPrompts: 0,
    badRunRows: 0,
    badTerminalEventCounts: 0,
    badEventSequences: 0,
    badRunEventSignatures: 0,
    openDelegatedRuns: 0,
    foreignKeyViolations: 0,
    quickCheck: 'ok',
  };
}

const expected = {
  users: 1_007,
  vaults: 52,
  memberships: 1_015,
  channels: 40,
  successfulChatWrites: 3_000,
  successfulRuns: 120,
  successfulMessageIds: [...messageIds],
  successfulMessageIdsSha256: digest(messageIds),
  requestedRunIds: [...runIds],
  requestedRunIdsSha256: digest(runIds),
};

test('accepts non-uniform per-channel writes when total, uniqueness, exercise, and scope are exact', () => {
  assert.deepEqual(evaluateReconciliation(passingObserved(), expected), { ok: true, failures: [] });
});

test('fails on aggregate, uniqueness, channel exercise, or cross-scope mismatches', () => {
  const observed = passingObserved();
  Object.assign(observed, {
    loadMessageCount: 2_999,
    loadMessageDistinctIds: 2_998,
    loadMessageChannels: 39,
    duplicateMessageIds: 1,
    unexercisedFixtureChannels: 1,
    badMessageScope: 1,
  });
  const evaluation = evaluateReconciliation(observed, expected);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /load messages are 2999, expected 3000/);
  assert.match(evaluation.failures.join('\n'), /unique load message IDs are 2998, expected 3000/);
  assert.match(evaluation.failures.join('\n'), /exercised load channels are 39, expected 40/);
  assert.match(evaluation.failures.join('\n'), /duplicate load message IDs: 1/);
  assert.match(evaluation.failures.join('\n'), /unexercised fixture channels: 1/);
  assert.match(evaluation.failures.join('\n'), /cross-scope load messages: 1/);
});

test('fails on run reconciliation or database integrity mismatches', () => {
  const observed = passingObserved();
  Object.assign(observed, {
    loadRunCount: 119,
    completedLoadRuns: 118,
    unexpectedNewRuns: 1,
    badTerminalEventCounts: 1,
    badEventSequences: 1,
    badRunEventSignatures: 1,
    openDelegatedRuns: 1,
    foreignKeyViolations: 1,
    quickCheck: '*** corrupt ***',
  });
  const evaluation = evaluateReconciliation(observed, expected);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /load runs are 119, expected 120/);
  assert.match(evaluation.failures.join('\n'), /completed load runs are 118, expected 120/);
  assert.match(evaluation.failures.join('\n'), /unexpected new runs: 1/);
  assert.match(evaluation.failures.join('\n'), /runs with non-unique terminal events: 1/);
  assert.match(evaluation.failures.join('\n'), /runs with invalid event sequences: 1/);
  assert.match(evaluation.failures.join('\n'), /runs with invalid event signatures: 1/);
  assert.match(evaluation.failures.join('\n'), /open delegated runs: 1/);
  assert.match(evaluation.failures.join('\n'), /foreign-key violations: 1/);
  assert.match(evaluation.failures.join('\n'), /SQLite quick_check/);
});

test('fails on compensated message/run identity, body, or event-signature drift', () => {
  const observed = passingObserved();
  observed.loadMessageIds[0] = 'load-compensating-row';
  observed.loadMessageIds.sort();
  observed.loadMessageIdsSha256 = digest(observed.loadMessageIds);
  observed.loadRunIds[0] = 9_999;
  observed.loadRunIds.sort((left, right) => left - right);
  observed.loadRunIdsSha256 = digest(observed.loadRunIds);
  observed.badMessageBodies = 1;
  observed.badRunEventSignatures = 1;
  const evaluation = evaluateReconciliation(observed, expected);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /message identities/);
  assert.match(evaluation.failures.join('\n'), /run identities/);
  assert.match(evaluation.failures.join('\n'), /invalid bodies/);
  assert.match(evaluation.failures.join('\n'), /invalid event signatures/);
});

function exactDatabase(filename) {
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE vaults(id TEXT PRIMARY KEY);
    CREATE TABLE vault_members(vault_id TEXT,user_id INTEGER);
    CREATE TABLE notes(id TEXT PRIMARY KEY,vault_id TEXT,content TEXT);
    CREATE TABLE chat_messages(id TEXT PRIMARY KEY,vault_id TEXT,channel_id TEXT,body TEXT);
    CREATE TABLE runs(
      id INTEGER PRIMARY KEY,vault_id TEXT,note_id TEXT,prompt TEXT,agent TEXT,status TEXT,
      summary TEXT,session_id TEXT
    );
    CREATE TABLE run_events(
      id INTEGER PRIMARY KEY,run_id INTEGER,seq INTEGER,type TEXT,payload_json TEXT
    );
    CREATE TABLE delegated_runs(run_id INTEGER,status TEXT);
    INSERT INTO users VALUES(1,'cap_user');
    INSERT INTO vaults VALUES('vault-1');
    INSERT INTO vault_members VALUES('vault-1',1);
    INSERT INTO notes VALUES('channel-1','vault-1','cascade://chat-channel');
    INSERT INTO chat_messages VALUES('load-0','vault-1','channel-1','capacity load-0');
    INSERT INTO runs VALUES(
      1898,'vault-1',NULL,'capacity proof\n\n[Context: test]','grok','completed',
      'capacity run 1898','load-session-1898'
    );
  `);
  const events = [
    [1, 1, 'status', { status: 'queued' }],
    [2, 2, 'status', { status: 'running' }],
    [3, 3, 'text', {
      message: { content: [{ type: 'text', text: 'capacity event 1898' }] },
      chatVisible: true,
    }],
    [4, 4, 'status', {
      status: 'completed', summary: 'capacity run 1898', sessionId: 'load-session-1898',
    }],
  ];
  const insert = db.prepare('INSERT INTO run_events VALUES(?,?,?,?,?)');
  for (const [id, seq, type, payload] of events) insert.run(id, 1898, seq, type, JSON.stringify(payload));
  db.close();
}

test('actual reconciliation SQL rejects prompt, body, event, and compensated identity drift', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-reconcile-sql-'));
  const expectedOne = {
    users: 1,
    vaults: 1,
    memberships: 1,
    channels: 1,
    successfulChatWrites: 1,
    successfulRuns: 1,
    successfulMessageIds: ['load-0'],
    successfulMessageIdsSha256: digest(['load-0']),
    requestedRunIds: [1_898],
    requestedRunIdsSha256: digest([1_898]),
  };
  try {
    const passing = path.join(directory, 'passing.db');
    exactDatabase(passing);
    assert.deepEqual(evaluateReconciliation(
      queryDatabase(passing, 'cap', 1_897), expectedOne,
    ), { ok: true, failures: [] });
    const mutations = [
      ["UPDATE runs SET prompt='capacity proof suffix'", /enriched prompts|persisted rows/],
      ["UPDATE chat_messages SET body='wrong'", /invalid bodies/],
      ["UPDATE run_events SET type='text' WHERE seq=2", /invalid event signatures/],
      ["UPDATE run_events SET payload_json='{\"status\":\"running\",\"extra\":1}' WHERE seq=2", /invalid event signatures/],
      ["UPDATE run_events SET payload_json='{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"wrong\"}]},\"chatVisible\":true}' WHERE seq=3", /invalid event signatures/],
      ["UPDATE run_events SET payload_json='{\"status\":\"completed\",\"summary\":\"capacity run 1898\",\"sessionId\":\"wrong\"}' WHERE seq=4", /invalid event signatures/],
      ["UPDATE chat_messages SET id='load-compensating'", /message identities/],
      ["UPDATE runs SET id=1899,summary='capacity run 1899',session_id='load-session-1899'; UPDATE run_events SET run_id=1899", /run identities/],
    ];
    for (let index = 0; index < mutations.length; index += 1) {
      const filename = path.join(directory, `mutation-${index}.db`);
      exactDatabase(filename);
      const db = new Database(filename);
      db.exec(mutations[index][0]);
      db.close();
      const evaluation = evaluateReconciliation(queryDatabase(filename, 'cap', 1_897), expectedOne);
      assert.equal(evaluation.ok, false);
      assert.match(evaluation.failures.join('\n'), mutations[index][1]);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
