#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const AUTHORIZATION = Object.freeze({
  authorizedBy: 'asdfasdf',
  authorizationMessageId: 'msg-1786474795198-adfk59',
  certifiedUsers: 1_000,
  demonstratedConcurrentUsers: 10_000,
  scope: 'One production cutover of this exact revision and image; all data, protocol, authenticated smoke, runtime-shape, snapshot, rollback, and live-edge checks remain mandatory.',
});

function fail(message) {
  throw new Error(message);
}

function readWaiver(file) {
  const resolved = path.resolve(file || '');
  if (!file || !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    fail('operator capacity waiver must be a regular file');
  }
  const checksumFile = `${resolved}.sha256`;
  if (!fs.statSync(checksumFile, { throwIfNoEntry: false })?.isFile()) {
    fail('operator capacity waiver checksum is missing');
  }
  const expectedChecksum = fs.readFileSync(checksumFile, 'utf8').trim().split(/\s+/u)[0];
  if (!/^[0-9a-f]{64}$/u.test(expectedChecksum)) fail('operator capacity waiver checksum is invalid');

  const bytes = fs.readFileSync(resolved);
  const actualChecksum = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualChecksum !== expectedChecksum) fail('operator capacity waiver checksum mismatch');

  let waiver;
  try {
    waiver = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('operator capacity waiver is not valid JSON');
  }
  return waiver;
}

async function verify(file, expectedRevision = '') {
  const waiver = await readWaiver(file);
  if (waiver?.schemaVersion !== 1 || waiver?.type !== 'cascade-operator-capacity-waiver') {
    fail('operator capacity waiver schema is invalid');
  }
  if (!/^[0-9a-f]{40}$/u.test(waiver.revision || '')) fail('operator capacity waiver revision is invalid');
  if (expectedRevision && waiver.revision !== expectedRevision) fail('operator capacity waiver revision does not match checkout');
  if (!/^sha256:[0-9a-f]{64}$/u.test(waiver.imageId || '')) fail('operator capacity waiver image ID is invalid');
  if (waiver.authorizedBy !== AUTHORIZATION.authorizedBy ||
      waiver.authorizationMessageId !== AUTHORIZATION.authorizationMessageId ||
      waiver.acceptedEvidence?.certifiedUsers !== AUTHORIZATION.certifiedUsers ||
      waiver.acceptedEvidence?.demonstratedConcurrentUsers !== AUTHORIZATION.demonstratedConcurrentUsers ||
      waiver.acceptedEvidence?.strictFinal10kGatePassed !== false ||
      waiver.scope !== AUTHORIZATION.scope) {
    fail('operator capacity waiver does not match the explicit authorization');
  }
  if (!Number.isFinite(Date.parse(waiver.authorizedAt))) fail('operator capacity waiver authorization time is invalid');
  return waiver;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? '' : String(argv[index + 1] || '');
}

const [command, ...argv] = process.argv.slice(2);
if (command !== 'verify' && command !== 'field') {
  fail('usage: operator-capacity-waiver.mjs <verify|field> --waiver <path> [--expected-revision <sha>] [--name <field>]');
}
const waiver = await verify(option(argv, '--waiver'), option(argv, '--expected-revision'));
if (command === 'verify') {
  process.stdout.write(`${waiver.imageId}\n`);
} else {
  const name = option(argv, '--name');
  const value = name === 'revision' ? waiver.revision
    : name === 'image.id' ? waiver.imageId
      : name === 'image.tag' ? `cascade:certified-${waiver.revision}`
        : fail(`unsupported operator capacity waiver field: ${name}`);
  process.stdout.write(`${value}\n`);
}
