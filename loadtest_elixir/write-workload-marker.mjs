#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const values = { shard: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = inline ?? argv[++index];
    if (value == null || String(value).startsWith('--')) throw new Error(`--${rawKey} requires a value`);
    if (key === 'shard') values.shard.push(value);
    else if (values[key] != null) throw new Error(`--${rawKey} may only be supplied once`);
    else values[key] = value;
  }
  return values;
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function buildMarker(shardPaths, expectedShards, finishedAt = new Date().toISOString()) {
  if (!Number.isInteger(expectedShards) || expectedShards < 1) {
    throw new Error('--expected-shards must be a positive integer');
  }
  if (shardPaths.length !== expectedShards) {
    throw new Error(`received ${shardPaths.length} shard artifacts, expected exactly ${expectedShards}`);
  }

  const indexes = new Set();
  const shards = shardPaths.map((filename) => {
    const resolved = path.resolve(filename);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`shard artifact is not a regular file: ${resolved}`);
    const contents = fs.readFileSync(resolved);
    const result = JSON.parse(contents.toString('utf8'));
    const index = result.shard?.index;
    if (!Number.isInteger(index) || index < 0 || index >= expectedShards) {
      throw new Error(`shard artifact has invalid index: ${resolved}`);
    }
    if (result.shard?.count !== expectedShards) {
      throw new Error(`shard ${index} count is ${result.shard?.count}, expected ${expectedShards}`);
    }
    if (result.evaluation?.ok !== true) throw new Error(`shard ${index} did not pass`);
    if (indexes.has(index)) throw new Error(`duplicate shard ${index}`);
    indexes.add(index);
    return { index, path: resolved, sha256: sha256(contents) };
  });
  for (let index = 0; index < expectedShards; index += 1) {
    if (!indexes.has(index)) throw new Error(`missing shard ${index}`);
  }
  if (!Number.isFinite(Date.parse(finishedAt))) throw new Error('finishedAt is invalid');

  return {
    status: 'passed',
    finishedAt,
    shards: shards.sort((left, right) => left.index - right.index)
      .map(({ path: filename, sha256: digest }) => ({ path: filename, sha256: digest })),
  };
}

export function writeMarkerAtomic(output, marker) {
  const resolved = path.resolve(output);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // link(2) is an atomic create-without-replace on the same filesystem. A
    // stale marker appearing between preflight and completion fails EEXIST.
    fs.linkSync(temporary, resolved);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.output) throw new Error('--output is required');
  const expectedShards = Number(args.expectedShards ?? 4);
  const marker = buildMarker(args.shard, expectedShards);
  writeMarkerAtomic(args.output, marker);
  process.stdout.write(`${path.resolve(args.output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(`[workload-marker] fatal: ${error.stack || error}`);
    process.exitCode = 1;
  }
}
