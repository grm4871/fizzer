#!/usr/bin/env node

import fs from 'node:fs';
import { WebSocket } from 'ws';

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

function numberOption(args, key, fallback, minimum = 1) {
  const value = args[key] == null ? fallback : Number(args[key]);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`--${key} must be an integer >= ${minimum}`);
  return value;
}

function boolOption(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function engineUrl(target, ordinal) {
  const url = new URL('/socket.io/', target);
  url.searchParams.set('EIO', '4');
  url.searchParams.set('transport', 'websocket');
  url.searchParams.set('t', `edge-proof-${ordinal}-${Date.now()}`);
  return url;
}

function attempt(target, ordinal, timeoutMs, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(engineUrl(target, ordinal), { rejectUnauthorized });
    let settled = false;
    let opened = false;
    const timer = setTimeout(() => finish(reject, new Error(`connection ${ordinal} timed out`)), timeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    socket.on('open', () => { opened = true; });
    socket.on('message', (raw) => {
      const packet = raw.toString();
      if (opened && packet.startsWith('0{')) finish(resolve, { accepted: true, socket, packet });
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      finish(resolve, { accepted: false, status: response.statusCode });
    });
    socket.on('error', (error) => finish(reject, error));
    socket.on('close', () => {
      if (!settled) finish(reject, new Error(`connection ${ordinal} closed before Engine.IO open`));
    });
  });
}

function close(socket, timeoutMs) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close();
  });
}

export function evaluateEdgeProof({ accepted, rejectedStatus, retryAccepted, acceptedStillOpen }, limit, expectedStatus) {
  const failures = [];
  if (accepted !== limit) failures.push(`accepted ${accepted}/${limit} initial connections`);
  if (acceptedStillOpen !== limit) failures.push(`only ${acceptedStillOpen}/${limit} initial connections remained open`);
  if (rejectedStatus !== expectedStatus) failures.push(`connection ${limit + 1} returned ${rejectedStatus ?? 'no status'}, expected ${expectedStatus}`);
  if (!retryAccepted) failures.push('a replacement connection was not accepted after one slot closed');
  return { ok: failures.length === 0, failures };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = String(args.target || 'wss://127.0.0.1:38443');
  const limit = numberOption(args, 'limit', 40);
  const expectedStatus = numberOption(args, 'expectedStatus', 429, 100);
  const timeoutMs = numberOption(args, 'timeoutMs', 5_000);
  const rejectUnauthorized = !boolOption(args.insecure);
  const output = args.output ? String(args.output) : '';
  const sockets = [];
  const startedAt = new Date().toISOString();

  try {
    for (let index = 0; index < limit; index += 1) {
      const result = await attempt(target, index, timeoutMs, rejectUnauthorized);
      if (!result.accepted) throw new Error(`connection ${index + 1} was rejected with ${result.status}`);
      sockets.push(result.socket);
    }

    const overflow = await attempt(target, limit, timeoutMs, rejectUnauthorized);
    if (overflow.accepted) sockets.push(overflow.socket);
    const acceptedStillOpen = sockets.slice(0, limit).filter((socket) => socket.readyState === WebSocket.OPEN).length;

    await close(sockets[0], timeoutMs);
    const replacement = await attempt(target, limit + 1, timeoutMs, rejectUnauthorized);
    if (replacement.accepted) sockets.push(replacement.socket);

    const result = {
      target,
      startedAt,
      finishedAt: new Date().toISOString(),
      limit,
      expectedStatus,
      accepted: Math.min(sockets.length - (replacement.accepted ? 1 : 0), limit),
      acceptedStillOpen,
      rejectedStatus: overflow.accepted ? null : overflow.status,
      retryAccepted: replacement.accepted,
    };
    result.evaluation = evaluateEdgeProof(result, limit, expectedStatus);
    const rendered = `${JSON.stringify(result, null, 2)}\n`;
    if (output) fs.writeFileSync(output, rendered, { mode: 0o600 });
    process.stdout.write(rendered);
    if (!result.evaluation.ok) process.exitCode = 1;
  } finally {
    await Promise.allSettled(sockets.map((socket) => close(socket, timeoutMs)));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(`[edge-limit-proof] fatal: ${error.stack || error}`);
    process.exitCode = 1;
  });
}
