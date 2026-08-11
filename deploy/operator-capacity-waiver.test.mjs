import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.join(import.meta.dirname, 'operator-capacity-waiver.mjs');
const revision = 'a'.repeat(40);
const imageId = `sha256:${'b'.repeat(64)}`;
const base = {
  schemaVersion: 1,
  type: 'cascade-operator-capacity-waiver',
  revision,
  imageId,
  authorizedBy: 'asdfasdf',
  authorizationMessageId: 'msg-1786474795198-adfk59',
  authorizedAt: '2026-08-11T19:00:00Z',
  acceptedEvidence: {
    certifiedUsers: 1000,
    demonstratedConcurrentUsers: 10000,
    strictFinal10kGatePassed: false,
  },
  scope: 'One production cutover of this exact revision and image; all data, protocol, authenticated smoke, runtime-shape, snapshot, rollback, and live-edge checks remain mandatory.',
};

function writeWaiver(directory, value) {
  const file = path.join(directory, 'waiver.json');
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(bytes).digest('hex')}  waiver.json\n`);
  return file;
}

function run(file, ...args) {
  return spawnSync(process.execPath, [script, ...args, '--waiver', file], { encoding: 'utf8' });
}

test('accepts only the exact operator-authorized capacity exception', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-waiver-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = writeWaiver(directory, base);
  const result = run(file, 'verify', '--expected-revision', revision);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), imageId);
});

test('rejects revision drift, authorization drift, and checksum drift', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-waiver-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let file = writeWaiver(directory, base);
  assert.notEqual(run(file, 'verify', '--expected-revision', 'c'.repeat(40)).status, 0);

  file = writeWaiver(directory, { ...base, authorizationMessageId: 'msg-wrong' });
  assert.notEqual(run(file, 'verify').status, 0);

  file = writeWaiver(directory, base);
  fs.appendFileSync(file, ' ');
  assert.notEqual(run(file, 'verify').status, 0);
});
