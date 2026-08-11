#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { parseArgs, readFixtures } from './load.mjs';

function numberOption(args, key, fallback, minimum = 1) {
  const value = args[key] == null ? fallback : Number(args[key]);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`--${key} must be >= ${minimum}`);
  return value;
}

function assertIsolatedDatabase(filename) {
  const resolved = fs.realpathSync(filename);
  const forbidden = ['/data', '/var/lib/cascade'];
  if (forbidden.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    throw new Error(`refusing production database path ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) throw new Error('--db-path must be a regular SQLite file');
  return resolved;
}

function containerIdentity(container) {
  const [inspection] = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }));
  const [image] = JSON.parse(execFileSync('docker', ['image', 'inspect', inspection.Image], { encoding: 'utf8' }));
  return {
    containerId: inspection.Id,
    containerStartedAt: inspection.State.StartedAt,
    imageId: inspection.Image,
    revision: image.Config?.Labels?.['org.opencontainers.image.revision'] || '',
  };
}

async function jsonRequest(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body, durationMs: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function bearer(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export function evaluateSqliteLock(observations, maximumFailureMs = 7_000, maximumRecoveryMs = 1_000) {
  const failures = [];
  if (![429, 503].includes(observations.boundedFailureStatus)) {
    failures.push(`locked write returned ${observations.boundedFailureStatus}, expected 429 or 503`);
  }
  if (observations.boundedFailureMs > maximumFailureMs) {
    failures.push(`locked write took ${observations.boundedFailureMs}ms, expected <=${maximumFailureMs}ms`);
  }
  if (!observations.failedWriteAbsent) failures.push('locked write became a phantom success');
  if (observations.recoveryStatus !== 201) failures.push(`recovery write returned ${observations.recoveryStatus}`);
  if (observations.recoveryMs > maximumRecoveryMs) {
    failures.push(`recovery write took ${observations.recoveryMs}ms, expected <=${maximumRecoveryMs}ms`);
  }
  if (!observations.recoveryWritePersisted) failures.push('recovery write was not persisted');
  return { ok: failures.length === 0, failures };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const target = String(args.target || '').replace(/\/$/u, '');
  const fixturesFile = String(args.fixtures || '');
  const container = String(args.container || '');
  const output = path.resolve(String(args.output || ''));
  if (!target || !fixturesFile || !container || !args.dbPath || !args.output) {
    throw new Error('--target, --fixtures, --container, --db-path, and --output are required');
  }
  if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
  const dbPath = assertIsolatedDatabase(String(args.dbPath));
  const timeoutMs = numberOption(args, 'timeoutMs', 8_000);
  const maximumFailureMs = numberOption(args, 'maximumFailureMs', 7_000);
  const maximumRecoveryMs = numberOption(args, 'maximumRecoveryMs', 1_000);
  const [fixture] = readFixtures(fixturesFile, { users: 1 });
  const identity = containerIdentity(container);
  const startedAt = new Date().toISOString();
  const nonce = `${Date.now()}-${process.pid}`;
  const blockedId = `fault-lock-blocked-${nonce}`;
  const recoveryId = `fault-lock-recovery-${nonce}`;
  const messagesUrl = `${target}/api/vaults/${encodeURIComponent(fixture.vaultId)}/channels/${encodeURIComponent(fixture.channelId)}/messages`;
  const lock = new Database(dbPath, { fileMustExist: true, timeout: 0 });
  let blocked;

  try {
    lock.pragma('journal_mode = WAL');
    lock.exec('BEGIN IMMEDIATE');
    blocked = await jsonRequest(messagesUrl, {
      method: 'POST',
      headers: bearer(fixture.token),
      body: JSON.stringify({
        id: blockedId,
        channelId: fixture.channelId,
        body: 'must not commit while the dependency is locked',
        createdAt: new Date().toISOString(),
      }),
    }, timeoutMs);
  } finally {
    try { lock.exec('ROLLBACK'); } catch { /* already released */ }
    lock.close();
  }

  const recovery = await jsonRequest(messagesUrl, {
    method: 'POST',
    headers: bearer(fixture.token),
    body: JSON.stringify({
      id: recoveryId,
      channelId: fixture.channelId,
      body: 'dependency recovered',
      createdAt: new Date().toISOString(),
    }),
  }, timeoutMs);
  const read = await jsonRequest(`${messagesUrl}?detail=list&limit=120`, {
    headers: bearer(fixture.token),
  }, timeoutMs);
  const ids = new Set(Array.isArray(read.body?.messages) ? read.body.messages.map((message) => message.id) : []);
  const observations = {
    blockedId,
    recoveryId,
    vaultId: fixture.vaultId,
    channelId: fixture.channelId,
    boundedFailureStatus: blocked.status,
    boundedFailureMs: Math.round(blocked.durationMs * 10) / 10,
    failedWriteAbsent: !ids.has(blockedId),
    recoveryStatus: recovery.status,
    recoveryMs: Math.round(recovery.durationMs * 10) / 10,
    recoveryWritePersisted: ids.has(recoveryId),
  };
  const evaluation = evaluateSqliteLock(observations, maximumFailureMs, maximumRecoveryMs);

  const result = {
    schemaVersion: 1,
    type: 'cascade-fault-recovery',
    fault: 'sqlite-write-lock',
    target,
    ...identity,
    fixtureSha256: createHash('sha256').update(fs.readFileSync(fixturesFile)).digest('hex'),
    startedAt,
    finishedAt: new Date().toISOString(),
    observations,
    evaluation,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.evaluation.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[sqlite-lock-recovery] fatal: ${error.stack || error}`);
    process.exitCode = 1;
  });
}
