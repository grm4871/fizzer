import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';

const deployDirectory = path.dirname(fileURLToPath(import.meta.url));
const restoreScript = path.join(deployDirectory, 'restore-sqlite-snapshot.sh');

function writeDatabase(filename, value) {
  const database = new Database(filename);
  database.exec('CREATE TABLE state (value TEXT NOT NULL)');
  database.prepare('INSERT INTO state(value) VALUES (?)').run(value);
  database.close();
}

function readValue(filename) {
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    return database.prepare('SELECT value FROM state').pluck().get();
  } finally {
    database.close();
  }
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-rollback-'));
  const snapshotDirectory = path.join(directory, 'snapshot');
  const dataDirectory = path.join(directory, 'data');
  fs.mkdirSync(snapshotDirectory);
  fs.mkdirSync(dataDirectory);
  const snapshot = path.join(snapshotDirectory, 'docs.db');
  const live = path.join(dataDirectory, 'docs.db');
  writeDatabase(snapshot, 'before-cutover');
  writeDatabase(live, 'candidate-mutation');
  const checksum = spawnSync('sha256sum', ['docs.db'], {
    cwd: snapshotDirectory,
    encoding: 'utf8',
  });
  assert.equal(checksum.status, 0, checksum.stderr);
  fs.writeFileSync(path.join(snapshotDirectory, 'docs.db.sha256'), checksum.stdout);
  return { directory, snapshotDirectory, snapshot, live };
}

test('verified rollback atomically restores the snapshot and removes candidate WAL state', () => {
  const files = fixture();
  try {
    fs.writeFileSync(`${files.live}-wal`, 'candidate wal');
    fs.writeFileSync(`${files.live}-shm`, 'candidate shm');

    const restored = spawnSync(
      restoreScript,
      [files.snapshotDirectory, files.live, 'regression-test'],
      { encoding: 'utf8' },
    );

    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readValue(files.live), 'before-cutover');
    assert.equal(fs.existsSync(`${files.live}-wal`), false);
    assert.equal(fs.existsSync(`${files.live}-shm`), false);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('a corrupt snapshot fails closed without replacing the live database', () => {
  const files = fixture();
  try {
    fs.appendFileSync(files.snapshot, 'tampered');

    const rejected = spawnSync(
      restoreScript,
      [files.snapshotDirectory, files.live, 'regression-test'],
      { encoding: 'utf8' },
    );

    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /failed its SHA-256 check/);
    assert.equal(readValue(files.live), 'candidate-mutation');
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rollback refuses symlinked snapshot and live database paths', () => {
  const files = fixture();
  try {
    const snapshotTarget = path.join(files.snapshotDirectory, 'snapshot-target.db');
    fs.renameSync(files.snapshot, snapshotTarget);
    fs.symlinkSync(snapshotTarget, files.snapshot);
    const linkedSnapshot = spawnSync(
      restoreScript,
      [files.snapshotDirectory, files.live, 'regression-test'],
      { encoding: 'utf8' },
    );
    assert.notEqual(linkedSnapshot.status, 0);
    assert.equal(readValue(files.live), 'candidate-mutation');

    fs.unlinkSync(files.snapshot);
    fs.renameSync(snapshotTarget, files.snapshot);
    const liveTarget = path.join(files.directory, 'live-target.db');
    fs.renameSync(files.live, liveTarget);
    fs.symlinkSync(liveTarget, files.live);
    const linkedLive = spawnSync(
      restoreScript,
      [files.snapshotDirectory, files.live, 'regression-test'],
      { encoding: 'utf8' },
    );
    assert.notEqual(linkedLive.status, 0);
    assert.match(linkedLive.stderr, /live database must be a regular file/);
    assert.equal(readValue(liveTarget), 'candidate-mutation');
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});
