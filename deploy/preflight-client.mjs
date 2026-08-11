#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { Manager } from 'socket.io-client';

const origin = String(process.argv[2] || '').replace(/\/$/, '');
if (!origin) throw new Error('candidate origin is required');

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text}`);
  return { body, response };
}

function waitFor(socket, event, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`${event} timeout`));
    }, timeoutMs);
    const onEvent = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

function runProtocolProbe({ token, cookie, vaultId, channelId }) {
  return new Promise((resolve, reject) => {
    const probe = process.env.CASCADE_PROTOCOL_PROBE || '/app/loadtest_elixir/protocol-probe.mjs';
    const child = spawn('node', [
      probe,
      '--target', origin,
      '--token', token,
      '--cookie', cookie,
      '--vault-id', vaultId,
      '--channel-id', channelId,
    ], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`protocol probe failed (${signal || code})`));
    });
  });
}

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const registration = await request('/api/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    username: `preflight_${suffix}`.slice(0, 30),
    password: `Preflight-${suffix}-only!`,
    displayName: 'Cutover preflight',
  }),
});
const token = String(registration.body.token || '');
const cookie = String(registration.response.headers.get('set-cookie') || '').split(';', 1)[0];
if (!token || !cookie) throw new Error('registration omitted bearer token or session cookie');
const auth = { Authorization: `Bearer ${token}` };

const { body: vaultBody } = await request('/api/vaults', {
  method: 'POST', headers: auth, body: JSON.stringify({ name: 'Cutover preflight' }),
});
const vaultId = String(vaultBody.vault?.id || '');
const { body: notesBody } = await request(`/api/vaults/${encodeURIComponent(vaultId)}/notes`, { headers: auth });
const channelId = String(notesBody.notes?.find((note) => note.content_preview === 'cascade://chat-channel')?.id
  || notesBody.notes?.find((note) => note.title === 'General')?.id || '');
if (!vaultId || !channelId) throw new Error('fixture vault omitted its General channel');

await runProtocolProbe({ token, cookie, vaultId, channelId });

const manager = new Manager(origin, {
  transports: ['websocket'], reconnection: false, timeout: 10_000, autoConnect: false,
});
const runner = manager.socket('/runners', { auth: { token } });
const connected = waitFor(runner, 'connect');
const registered = waitFor(runner, 'runner:registered');
let delegatedResolve;
let delegatedReject;
const delegated = new Promise((resolve, reject) => {
  delegatedResolve = resolve;
  delegatedReject = reject;
  setTimeout(() => reject(new Error('run:delegate timeout')), 15_000).unref();
});
let cancelResolve;
const canceled = new Promise((resolve, reject) => {
  cancelResolve = resolve;
  setTimeout(() => reject(new Error('run:cancel ACK timeout')), 15_000).unref();
});

runner.on('run:delegate', (payload) => delegatedResolve(payload));
runner.on('run:cancel', (payload, acknowledge) => {
  if (typeof acknowledge !== 'function') {
    delegatedReject(new Error('run:cancel omitted Socket.IO acknowledgement id'));
    return;
  }
  acknowledge({ success: true });
  cancelResolve(payload);
});
runner.connect();
await connected;
runner.emit('runner:register', { activeRunIds: [], runnerInstanceId: `preflight-${suffix}` });
await registered;

const { body: runBody } = await request(`/api/vaults/${encodeURIComponent(vaultId)}/runs`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ prompt: 'Cutover ACK preflight', agent: 'grok', note_id: channelId }),
});
const runId = Number(runBody.run?.id);
const delegatedPayload = await delegated;
if (!Number.isInteger(runId) || Number(delegatedPayload?.runId) !== runId) {
  throw new Error('runner delegation did not match the persisted run');
}

await request(`/api/runs/${runId}/cancel`, {
  method: 'POST', headers: auth, body: JSON.stringify({}),
});
const cancelPayload = await canceled;
if (Number(cancelPayload?.runId) !== runId) throw new Error('run:cancel ACK targeted the wrong run');

manager.disconnect();
console.log(JSON.stringify({ ok: true, namespaces: 3, runnerRegistration: true, cancelAck: true }));
