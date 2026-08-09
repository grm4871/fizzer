import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  ensureAndroidBatterySchema,
  listAndroidBatterySamples,
  parseAndroidBatterySample,
  recordAndroidBatterySample,
} from './androidBattery.js';

function database() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users (id) VALUES (1), (2)');
  ensureAndroidBatterySchema(db);
  return db;
}

const sample = {
  sessionId: 'session-1', reason: 'interval', foreground: true, capturedAt: Date.now(),
  elapsedRealtimeMs: 1000, processCpuMs: 25, uidRxBytes: 400, uidTxBytes: 200,
  powerSave: false, levelPercent: 80, chargeCounterUah: 3_200_000,
  currentNowUa: -120_000, currentAverageUa: -90_000, charging: false,
};

test('battery samples are validated, stored, and user scoped', () => {
  const db = database();
  recordAndroidBatterySample(db, 1, parseAndroidBatterySample(sample));
  recordAndroidBatterySample(db, 2, parseAndroidBatterySample({ ...sample, sessionId: 'session-2' }));
  assert.equal(listAndroidBatterySamples(db, 1).length, 1);
  assert.equal(listAndroidBatterySamples(db, null).length, 2);
  assert.equal((listAndroidBatterySamples(db, 1)[0] as { levelPercent: number }).levelPercent, 80);
});

test('battery samples reject malformed or implausible input', () => {
  assert.throws(() => parseAndroidBatterySample({ ...sample, levelPercent: 101 }), /out of range/);
  assert.throws(() => parseAndroidBatterySample({ ...sample, reason: 'spam' }), /Invalid reason/);
});
