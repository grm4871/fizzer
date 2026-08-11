import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildMarker, writeMarkerAtomic } from './write-workload-marker.mjs';

function fixture(root, index, count = 2, ok = true, label = '') {
  const filename = path.join(root, `shard-${index}${label}.json`);
  fs.writeFileSync(filename, JSON.stringify({ shard: { index, count }, evaluation: { ok } }));
  return filename;
}

test('builds a sorted marker bound to every passing shard artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-marker-'));
  const second = fixture(root, 1);
  const first = fixture(root, 0);
  const marker = buildMarker([second, first], 2, '2026-08-11T02:00:00.000Z');
  assert.equal(marker.status, 'passed');
  assert.deepEqual(marker.shards.map((shard) => shard.path), [first, second]);
  assert.equal(
    marker.shards[0].sha256,
    createHash('sha256').update(fs.readFileSync(first)).digest('hex'),
  );
});

test('fails closed for missing, duplicate, inconsistent, or failed shards', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-marker-'));
  const zero = fixture(root, 0);
  const duplicate = fixture(root, 0, 2, true, '-duplicate');
  const wrongCount = fixture(root, 1, 3, true, '-wrong-count');
  const failed = fixture(root, 1, 2, false, '-failed');
  assert.throws(() => buildMarker([zero], 2), /expected exactly 2/);
  assert.throws(() => buildMarker([zero, duplicate], 2), /duplicate shard 0/);
  assert.throws(() => buildMarker([zero, wrongCount], 2), /count is 3/);
  assert.throws(() => buildMarker([zero, failed], 2), /did not pass/);
});

test('atomically creates but never replaces a marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-marker-'));
  const output = path.join(root, 'finished.json');
  const marker = { status: 'passed', finishedAt: '2026-08-11T02:00:00.000Z', shards: [] };
  writeMarkerAtomic(output, marker);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), marker);
  assert.throws(() => writeMarkerAtomic(output, marker), { code: 'EEXIST' });
  assert.equal(fs.readdirSync(root).some((name) => name.includes('.tmp-')), false);
});
