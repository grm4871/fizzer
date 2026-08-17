#!/usr/bin/env node

import fs from 'node:fs';

import { headroomEvaluation } from './monitor.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [rawKey, inline] = argument.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (inline !== undefined) result[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) result[key] = argv[++index];
    else result[key] = true;
  }
  return result;
}

function numberOption(args, key, fallback, minimum = 0) {
  const value = args[key] == null ? fallback : Number(args[key]);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`--${key} must be >= ${minimum}`);
  return value;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = String(args.input || '');
  if (!input) throw new Error('--input is required');
  const records = fs.readFileSync(input, 'utf8').trim().split(/\n/).map((line) => JSON.parse(line));
  const start = records.find((record) => record.type === 'start');
  const samples = records.filter((record) => record.type === 'sample');
  if (!start) throw new Error('monitor JSONL has no start record');

  const shape = start.expectedShape || {};
  const monitorConfig = start.monitorConfig || {};
  const expectedRuntime = shape.runtime || {
    httpAcceptors: numberOption(args, 'expectedHttpAcceptors', 4, 1),
    httpMaxConnections: numberOption(args, 'expectedHttpMaxConnections', 32_768, 1),
    httpBacklog: numberOption(args, 'expectedHttpBacklog', 65_535, 1),
    sqlitePoolSize: numberOption(args, 'expectedSqlitePoolSize', 20, 1),
    sqliteBusyTimeoutMs: numberOption(args, 'expectedSqliteBusyTimeoutMs', 5_000, 1),
  };
  const durationSeconds = numberOption(args, 'durationSeconds', monitorConfig.durationSeconds, 1);
  if (!Number.isFinite(durationSeconds)) throw new Error('--duration-seconds is required for an older monitor artifact');
  const intervalSeconds = numberOption(args, 'intervalSeconds', monitorConfig.intervalSeconds || 5, 0.5);
  const gateWindowSeconds = numberOption(args, 'gateWindowSeconds', monitorConfig.gateWindowSeconds || 1_200, 1);

  const evaluation = headroomEvaluation(
    samples,
    gateWindowSeconds,
    shape.memoryBytes || 16 * 1024 ** 3,
    shape.cpus || 8,
    shape.sessions ?? 10_000,
    shape.runners ?? 10_000,
    shape.memberships ?? 50_000,
    start.preflightFailures || [],
    expectedRuntime,
    durationSeconds,
    intervalSeconds,
  );
  const result = {
    input,
    imageId: start.imageId,
    containerId: start.containerId,
    probeSha256: start.probeSha256,
    samples: samples.length,
    evaluation,
  };
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) fs.writeFileSync(String(args.output), rendered, { mode: 0o600 });
  process.stdout.write(rendered);
  if (!evaluation.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`[evaluate-monitor] fatal: ${error.stack || error}`);
  process.exitCode = 1;
}
