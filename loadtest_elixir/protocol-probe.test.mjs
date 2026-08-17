import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeEnginePayload, decodeSocketMessages } from './protocol-codec.mjs';
import { pollingDisconnectPackets } from './protocol-probe.mjs';

test('polling probe disconnects namespaces and closes the Engine.IO session', () => {
  const packets = pollingDisconnectPackets();
  assert.deepEqual(packets.at(-1), { type: 'close' });
  assert.deepEqual(
    decodeSocketMessages(packets.slice(0, -1)).map((packet) => [packet.type, packet.namespace]),
    [
      ['disconnect', '/vault'],
      ['disconnect', '/runs'],
      ['disconnect', '/runners'],
    ],
  );
  assert.deepEqual(decodeEnginePayload('1'), [{ type: 'close' }]);
});
