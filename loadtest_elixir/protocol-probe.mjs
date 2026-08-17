#!/usr/bin/env node

import {
  decodeEnginePacket,
  decodeEnginePayload,
  decodeSocketMessages,
  encodeEnginePayload,
  socketMessage,
} from './protocol-codec.mjs';
import { parseArgs } from './load.mjs';
import { pathToFileURL } from 'node:url';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function engineUrl(target, transport, sid = '') {
  const url = new URL('/socket.io/', target);
  url.searchParams.set('EIO', '4');
  url.searchParams.set('transport', transport);
  url.searchParams.set('t', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (sid) url.searchParams.set('sid', sid);
  return url;
}

async function getPolling(target, sid = '', cookie = '') {
  const response = await fetch(engineUrl(target, 'polling', sid), {
    ...(cookie ? { headers: { Cookie: cookie } } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`polling GET ${response.status}: ${text}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('text/plain')) throw new Error(`unexpected polling content-type ${contentType}`);
  return decodeEnginePayload(text);
}

async function postPolling(target, sid, packets, cookie = '') {
  const response = await fetch(engineUrl(target, 'polling', sid), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...(cookie ? { Cookie: cookie } : {}) },
    body: encodeEnginePayload(packets),
  });
  const text = await response.text();
  if (!response.ok || text !== 'ok') throw new Error(`polling POST ${response.status}: ${text}`);
}

function assertOpen(packet) {
  if (packet?.type !== 'open') throw new Error(`expected Engine.IO open, got ${packet?.type}`);
  const open = packet.data || {};
  if (typeof open.sid !== 'string' || !open.sid) throw new Error('open packet omitted sid');
  if (!Array.isArray(open.upgrades) || !open.upgrades.includes('websocket')) throw new Error('open packet omitted websocket upgrade');
  if (open.pingInterval !== 25_000) throw new Error(`pingInterval drift: ${open.pingInterval}`);
  if (open.pingTimeout !== 60_000) throw new Error(`pingTimeout drift: ${open.pingTimeout}`);
  if (open.maxPayload !== 1_000_000) throw new Error(`maxPayload drift: ${open.maxPayload}`);
  return open;
}

async function pollUntil(target, sid, predicate, timeoutMs = 10_000, cookie = '') {
  const deadline = Date.now() + timeoutMs;
  const collected = [];
  while (Date.now() < deadline) {
    const packets = await getPolling(target, sid, cookie);
    for (const packet of packets) {
      if (packet.type === 'ping') await postPolling(target, sid, [{ type: 'pong', ...(packet.data ? { data: packet.data } : {}) }], cookie);
      collected.push(packet);
    }
    const result = predicate(collected);
    if (result) return result;
  }
  throw new Error('polling probe timeout');
}

async function probePolling(target, token, vaultId, channelId) {
  const [opening] = await getPolling(target);
  const open = assertOpen(opening);
  await postPolling(target, open.sid, ['/vault', '/runs', '/runners'].map((namespace) => ({
    type: 'message',
    data: socketMessage({ type: 'connect', namespace, data: { token } }).slice(1),
  })));
  const connected = await pollUntil(target, open.sid, (enginePackets) => {
    const socketPackets = decodeSocketMessages(enginePackets);
    const acknowledgements = new Set(socketPackets.filter((packet) => packet.type === 'connect').map((packet) => packet.namespace));
    return ['/vault', '/runs', '/runners'].every((namespace) => acknowledgements.has(namespace)) ? socketPackets : null;
  });
  for (const packet of connected.filter((candidate) => candidate.type === 'connect')) {
    if (typeof packet.data?.sid !== 'string' || !packet.data.sid) throw new Error(`${packet.namespace} connect ack omitted sid`);
  }

  const events = [
    { type: 'event', namespace: '/vault', data: ['joinVault', vaultId] },
    { type: 'event', namespace: '/vault', data: ['joinChatChannel', channelId] },
    { type: 'event', namespace: '/runners', data: ['runner:register', { activeRunIds: [], runnerInstanceId: 'protocol-probe' }] },
  ].map((packet) => ({ type: 'message', data: socketMessage(packet).slice(1) }));
  await postPolling(target, open.sid, events);
  await pollUntil(target, open.sid, (enginePackets) => decodeSocketMessages(enginePackets).find((packet) => (
    packet.type === 'event' && packet.namespace === '/runners' && packet.data?.[0] === 'runner:registered'
  )));

  await postPolling(target, open.sid, pollingDisconnectPackets());
  return { transport: 'polling', namespaces: ['/vault', '/runs', '/runners'] };
}

export function pollingDisconnectPackets(namespaces = ['/vault', '/runs', '/runners']) {
  return [
    ...namespaces.map((namespace) => ({
      type: 'message', data: socketMessage({ type: 'disconnect', namespace }).slice(1),
    })),
    { type: 'close' },
  ];
}

async function probeCookieAuth(target, cookie) {
  const [opening] = await getPolling(target, '', cookie);
  const open = assertOpen(opening);
  await postPolling(target, open.sid, [{
    type: 'message',
    data: socketMessage({ type: 'connect', namespace: '/vault' }).slice(1),
  }], cookie);
  const connected = await pollUntil(target, open.sid, (enginePackets) => decodeSocketMessages(enginePackets).find((packet) => (
    packet.type === 'connect' && packet.namespace === '/vault'
  )), 10_000, cookie);
  if (typeof connected.data?.sid !== 'string' || !connected.data.sid) throw new Error('cookie-auth connect ack omitted sid');
  await postPolling(target, open.sid, [{ type: 'close' }], cookie);
  return { namespace: '/vault', accepted: true };
}

async function probeInvalidNamespaceAuth(target) {
  const [opening] = await getPolling(target);
  const open = assertOpen(opening);
  await postPolling(target, open.sid, [{
    type: 'message',
    data: socketMessage({ type: 'connect', namespace: '/vault', data: { token: 'protocol-probe-invalid' } }).slice(1),
  }]);
  const rejected = await pollUntil(target, open.sid, (enginePackets) => decodeSocketMessages(enginePackets).find((packet) => (
    packet.type === 'connect_error' && packet.namespace === '/vault'
  )));
  if (rejected.data?.message !== 'Invalid or expired token') {
    throw new Error(`namespace auth rejection drift: ${JSON.stringify(rejected.data)}`);
  }
  await postPolling(target, open.sid, [{ type: 'close' }]);
  return { namespace: '/vault', message: rejected.data.message };
}

function websocketUrl(target, sid) {
  const url = engineUrl(target, 'websocket', sid);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

function websocketQueue(ws) {
  const queue = [];
  const waiters = [];
  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
    if (waiters.length) waiters.shift()(raw);
    else queue.push(raw);
  });
  return async (timeoutMs = 10_000) => {
    if (queue.length) return queue.shift();
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket packet timeout')), timeoutMs);
      waiters.push((raw) => { clearTimeout(timeout); resolve(raw); });
    });
  };
}

async function probeUpgrade(target, token) {
  const [opening] = await getPolling(target);
  const open = assertOpen(opening);
  const ws = new WebSocket(websocketUrl(target, open.sid));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket upgrade open timeout')), 10_000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('websocket upgrade failed')); }, { once: true });
  });
  const next = websocketQueue(ws);
  ws.send('2probe');
  const probe = await next();
  if (probe !== '3probe') throw new Error(`expected 3probe, got ${probe}`);
  ws.send('5');
  for (const namespace of ['/vault', '/runs', '/runners']) {
    ws.send(socketMessage({ type: 'connect', namespace, data: { token } }));
  }
  const connected = new Set();
  const deadline = Date.now() + 10_000;
  while (connected.size < 3 && Date.now() < deadline) {
    const raw = await next(Math.max(100, deadline - Date.now()));
    const enginePacket = decodeEnginePacket(raw);
    if (enginePacket.type === 'ping') {
      ws.send(`3${enginePacket.data || ''}`);
      continue;
    }
    for (const packet of decodeSocketMessages([enginePacket])) if (packet.type === 'connect') connected.add(packet.namespace);
  }
  if (connected.size !== 3) throw new Error(`websocket namespace connect incomplete: ${[...connected].join(',')}`);
  ws.close();
  return { transport: 'polling-to-websocket', namespaces: [...connected].sort() };
}

async function probeProtocolRejection(target) {
  const url = new URL('/socket.io/', target);
  url.searchParams.set('EIO', '3');
  url.searchParams.set('transport', 'polling');
  const response = await fetch(url);
  if (response.status !== 400) throw new Error(`Engine.IO v3 must be rejected with 400, got ${response.status}`);
  const data = await response.json().catch(() => ({}));
  if (Number(data.code) !== 5) throw new Error(`Engine.IO v3 rejection code drift: ${JSON.stringify(data)}`);
  return { status: response.status, code: data.code };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = String(args.target || '').replace(/\/$/, '');
  const token = String(args.token || '');
  const cookie = String(args.cookie || '');
  const vaultId = String(args.vaultId || '');
  const channelId = String(args.channelId || '');
  const mode = String(args.mode || 'both');
  if (!target || !token || !vaultId || !channelId) throw new Error('--target, --token, --vault-id, and --channel-id are required');
  const result = {
    target,
    eio3Rejection: await probeProtocolRejection(target),
    invalidNamespaceAuth: await probeInvalidNamespaceAuth(target),
  };
  if (cookie) result.cookieAuth = await probeCookieAuth(target, cookie);
  if (mode === 'both' || mode === 'polling') result.polling = await probePolling(target, token, vaultId, channelId);
  if (mode === 'both' || mode === 'upgrade') result.upgrade = await probeUpgrade(target, token);
  await sleep(25);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[protocol-probe] fatal:', error?.stack || error);
    process.exitCode = 1;
  });
}
