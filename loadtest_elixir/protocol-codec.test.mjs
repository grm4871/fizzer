import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeEnginePacket,
  decodeEnginePayload,
  decodeSocketMessages,
  decodeSocketPacket,
  encodeEnginePacket,
  encodeEnginePayload,
  encodeSocketPacket,
  socketMessage,
} from './protocol-codec.mjs';

test('decodes the exact Engine.IO v4 open packet shape', () => {
  assert.deepEqual(decodeEnginePacket('0{"sid":"abc","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":60000,"maxPayload":1000000}'), {
    type: 'open',
    data: { sid: 'abc', upgrades: ['websocket'], pingInterval: 25000, pingTimeout: 60000, maxPayload: 1000000 },
  });
});

test('round-trips polling payload framing and Engine.IO heartbeat/upgrade packets', () => {
  const packets = [
    { type: 'ping' },
    { type: 'pong', data: 'probe' },
    { type: 'upgrade' },
    { type: 'message', data: '0/vault,{"token":"t"}' },
  ];
  const encoded = encodeEnginePayload(packets);
  assert.equal(encoded, '2\x1e3probe\x1e5\x1e40/vault,{"token":"t"}');
  assert.deepEqual(decodeEnginePayload(encoded), packets);
});

test('round-trips every Socket.IO v5 packet form Cascade uses', () => {
  const packets = [
    { type: 'connect', namespace: '/vault', data: { token: 'secret' } },
    { type: 'connect', namespace: '/vault', data: { sid: 'socket-id' } },
    { type: 'event', namespace: '/vault', data: ['joinVault', 'vault-id'] },
    { type: 'event', namespace: '/runners', id: 17, data: ['run:cancel', { runId: 42 }] },
    { type: 'ack', namespace: '/runners', id: 17, data: [{ success: true }] },
    { type: 'disconnect', namespace: '/runs' },
    { type: 'connect_error', namespace: '/vault', data: { message: 'Invalid or expired token' } },
  ];
  for (const packet of packets) {
    assert.deepEqual(decodeSocketPacket(encodeSocketPacket(packet)), packet);
  }
  assert.equal(socketMessage(packets[2]), '42/vault,["joinVault","vault-id"]');
});

test('extracts multiplexed namespace messages from one Engine.IO payload', () => {
  const payload = [
    encodeEnginePacket({ type: 'ping' }),
    socketMessage({ type: 'connect', namespace: '/vault', data: { sid: 'v' } }),
    socketMessage({ type: 'connect', namespace: '/runs', data: { sid: 'r' } }),
    socketMessage({ type: 'event', namespace: '/runners', data: ['runner:registered', { ok: true, reclaimed: [] }] }),
  ].join('\x1e');
  assert.deepEqual(decodeSocketMessages(decodeEnginePayload(payload)).map((packet) => [packet.type, packet.namespace]), [
    ['connect', '/vault'],
    ['connect', '/runs'],
    ['event', '/runners'],
  ]);
});

test('rejects silent expansion into unimplemented binary packet framing', () => {
  assert.throws(() => decodeSocketPacket('51-/vault,["file",{"_placeholder":true,"num":0}]'), /outside the Cascade compatibility subset/);
  assert.throws(() => encodeSocketPacket({ type: 'binary_ack', namespace: '/runners', id: 1, data: [] }), /outside the Cascade compatibility subset/);
});
