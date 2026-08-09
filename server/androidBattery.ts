import type Database from 'better-sqlite3';

type Db = Database.Database;
type BatteryReason = 'launch' | 'interval' | 'background' | 'resume';

export type AndroidBatterySampleInput = {
  sessionId: string; reason: BatteryReason; foreground: boolean; capturedAt: number;
  elapsedRealtimeMs: number; processCpuMs: number; uidRxBytes: number; uidTxBytes: number;
  powerSave: boolean; thermalStatus?: number; levelPercent?: number; chargeCounterUah?: number;
  currentNowUa?: number; currentAverageUa?: number; charging?: boolean;
};

export function ensureAndroidBatterySchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS android_battery_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('launch', 'interval', 'background', 'resume')),
      foreground INTEGER NOT NULL, captured_at INTEGER NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      elapsed_realtime_ms INTEGER NOT NULL, process_cpu_ms INTEGER NOT NULL,
      uid_rx_bytes INTEGER NOT NULL, uid_tx_bytes INTEGER NOT NULL,
      power_save INTEGER NOT NULL, thermal_status INTEGER, level_percent INTEGER,
      charge_counter_uah INTEGER, current_now_ua INTEGER, current_average_ua INTEGER,
      charging INTEGER
    );
    CREATE INDEX IF NOT EXISTS android_battery_samples_user_time_idx
      ON android_battery_samples(user_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS android_battery_samples_session_idx
      ON android_battery_samples(session_id, captured_at ASC);
  `);
}

function finiteInteger(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  const integer = Math.round(value);
  if (integer < min || integer > max) throw new Error(`${name} is out of range`);
  return integer;
}

function optionalInteger(value: unknown, name: string, min: number, max: number) {
  return value == null ? undefined : finiteInteger(value, name, min, max);
}

export function parseAndroidBatterySample(body: Record<string, unknown>): AndroidBatterySampleInput {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId || sessionId.length > 80) throw new Error('Invalid sessionId');
  const reason = String(body.reason);
  if (!['launch', 'interval', 'background', 'resume'].includes(reason)) throw new Error('Invalid reason');
  return {
    sessionId, reason: reason as BatteryReason, foreground: body.foreground === true,
    capturedAt: finiteInteger(body.capturedAt, 'capturedAt', 1, Number.MAX_SAFE_INTEGER),
    elapsedRealtimeMs: finiteInteger(body.elapsedRealtimeMs, 'elapsedRealtimeMs', 0, Number.MAX_SAFE_INTEGER),
    processCpuMs: finiteInteger(body.processCpuMs, 'processCpuMs', 0, Number.MAX_SAFE_INTEGER),
    uidRxBytes: finiteInteger(body.uidRxBytes, 'uidRxBytes', -1, Number.MAX_SAFE_INTEGER),
    uidTxBytes: finiteInteger(body.uidTxBytes, 'uidTxBytes', -1, Number.MAX_SAFE_INTEGER),
    powerSave: body.powerSave === true,
    thermalStatus: optionalInteger(body.thermalStatus, 'thermalStatus', 0, 10),
    levelPercent: optionalInteger(body.levelPercent, 'levelPercent', 0, 100),
    chargeCounterUah: optionalInteger(body.chargeCounterUah, 'chargeCounterUah', -100_000_000, 100_000_000),
    currentNowUa: optionalInteger(body.currentNowUa, 'currentNowUa', -100_000_000, 100_000_000),
    currentAverageUa: optionalInteger(body.currentAverageUa, 'currentAverageUa', -100_000_000, 100_000_000),
    charging: typeof body.charging === 'boolean' ? body.charging : undefined,
  };
}

export function recordAndroidBatterySample(db: Db, userId: number, sample: AndroidBatterySampleInput): void {
  db.prepare(`INSERT INTO android_battery_samples (
    user_id, session_id, reason, foreground, captured_at, elapsed_realtime_ms, process_cpu_ms,
    uid_rx_bytes, uid_tx_bytes, power_save, thermal_status, level_percent, charge_counter_uah,
    current_now_ua, current_average_ua, charging
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, sample.sessionId, sample.reason, sample.foreground ? 1 : 0, sample.capturedAt,
      sample.elapsedRealtimeMs, sample.processCpuMs, sample.uidRxBytes, sample.uidTxBytes,
      sample.powerSave ? 1 : 0, sample.thermalStatus ?? null, sample.levelPercent ?? null,
      sample.chargeCounterUah ?? null, sample.currentNowUa ?? null, sample.currentAverageUa ?? null,
      sample.charging == null ? null : sample.charging ? 1 : 0);
  db.prepare("DELETE FROM android_battery_samples WHERE received_at < datetime('now', '-30 days')").run();
}

export function listAndroidBatterySamples(db: Db, userId: number | null, days = 7) {
  const boundedDays = Math.max(1, Math.min(30, Math.floor(days) || 7));
  const whereUser = userId == null ? '' : 'AND user_id = ?';
  return db.prepare(`SELECT id, user_id AS userId, session_id AS sessionId, reason, foreground,
    captured_at AS capturedAt, received_at AS receivedAt, elapsed_realtime_ms AS elapsedRealtimeMs,
    process_cpu_ms AS processCpuMs, uid_rx_bytes AS uidRxBytes, uid_tx_bytes AS uidTxBytes,
    power_save AS powerSave, thermal_status AS thermalStatus, level_percent AS levelPercent,
    charge_counter_uah AS chargeCounterUah, current_now_ua AS currentNowUa,
    current_average_ua AS currentAverageUa, charging
    FROM android_battery_samples WHERE received_at >= datetime('now', ?) ${whereUser}
    ORDER BY captured_at DESC LIMIT 5000`)
    .all(`-${boundedDays} days`, ...(userId == null ? [] : [userId]));
}
