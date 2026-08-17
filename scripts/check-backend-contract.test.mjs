import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(SCRIPT_DIR, 'check-backend-contract.mjs');
const GOLDEN = path.join(SCRIPT_DIR, 'backend-contract.v1.json');

function runChecker(args = []) {
  return spawnSync(process.execPath, [CHECKER, ...args], { cwd: path.resolve(SCRIPT_DIR, '..'), encoding: 'utf8' });
}

test('checked-in backend contract matches production Elixir sources', () => {
  const result = runChecker(['--check']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Backend contract matches:/);
});

test('checker fails closed when the golden contract drifts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-contract-'));
  const driftedManifest = path.join(tempDir, 'backend-contract.v1.json');
  try {
    const golden = fs.readFileSync(GOLDEN, 'utf8');
    fs.writeFileSync(driftedManifest, golden.replace('"manifestVersion": 1', '"manifestVersion": 999'));
    const result = runChecker(['--check', '--manifest', driftedManifest]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Backend contract drift detected/);
    assert.match(result.stderr, /First difference at manifest line/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
