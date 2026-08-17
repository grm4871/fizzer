const ENGINE_TYPES = Object.freeze({
  0: 'open',
  1: 'close',
  2: 'ping',
  3: 'pong',
  4: 'message',
  5: 'upgrade',
  6: 'noop',
});

const ENGINE_CODES = Object.freeze(Object.fromEntries(Object.entries(ENGINE_TYPES).map(([code, type]) => [type, code])));
const SOCKET_TYPES = Object.freeze({
  0: 'connect',
  1: 'disconnect',
  2: 'event',
  3: 'ack',
  4: 'connect_error',
  5: 'binary_event',
  6: 'binary_ack',
});
const SOCKET_CODES = Object.freeze(Object.fromEntries(Object.entries(SOCKET_TYPES).map(([code, type]) => [type, code])));
export const ENGINE_PAYLOAD_SEPARATOR = '\x1e';

export function decodeEnginePacket(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('empty Engine.IO packet');
  const type = ENGINE_TYPES[raw[0]];
  if (!type) throw new Error(`unknown Engine.IO packet type ${raw[0]}`);
  const data = raw.slice(1);
  return {
    type,
    ...(data ? { data: type === 'open' ? JSON.parse(data) : data } : {}),
  };
}

export function encodeEnginePacket(packet) {
  const code = ENGINE_CODES[packet?.type];
  if (code == null) throw new Error(`unsupported Engine.IO packet type ${packet?.type}`);
  const data = packet.data == null ? '' : typeof packet.data === 'string' ? packet.data : JSON.stringify(packet.data);
  return `${code}${data}`;
}

export function decodeEnginePayload(raw) {
  if (typeof raw !== 'string') throw new Error('Engine.IO polling payload must be text');
  return raw.split(ENGINE_PAYLOAD_SEPARATOR).filter(Boolean).map(decodeEnginePacket);
}

export function encodeEnginePayload(packets) {
  return packets.map(encodeEnginePacket).join(ENGINE_PAYLOAD_SEPARATOR);
}

export function decodeSocketPacket(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('empty Socket.IO packet');
  let offset = 0;
  const type = SOCKET_TYPES[raw[offset++]];
  if (!type) throw new Error(`unknown Socket.IO packet type ${raw[0]}`);
  if (type === 'binary_event' || type === 'binary_ack') {
    throw new Error('binary Socket.IO packets are outside the Cascade compatibility subset');
  }

  let namespace = '/';
  if (raw[offset] === '/') {
    const comma = raw.indexOf(',', offset);
    if (comma < 0) {
      namespace = raw.slice(offset);
      offset = raw.length;
    } else {
      namespace = raw.slice(offset, comma);
      offset = comma + 1;
    }
  }

  let idText = '';
  while (offset < raw.length && /[0-9]/.test(raw[offset])) idText += raw[offset++];
  const dataText = raw.slice(offset);
  return {
    type,
    namespace,
    ...(idText ? { id: Number(idText) } : {}),
    ...(dataText ? { data: JSON.parse(dataText) } : {}),
  };
}

export function encodeSocketPacket(packet) {
  const code = SOCKET_CODES[packet?.type];
  if (code == null) throw new Error(`unsupported Socket.IO packet type ${packet?.type}`);
  if (packet.type === 'binary_event' || packet.type === 'binary_ack') {
    throw new Error('binary Socket.IO packets are outside the Cascade compatibility subset');
  }
  const namespace = packet.namespace && packet.namespace !== '/' ? `${packet.namespace},` : '';
  const id = packet.id == null ? '' : String(packet.id);
  const data = packet.data == null ? '' : JSON.stringify(packet.data);
  return `${code}${namespace}${id}${data}`;
}

export function socketMessage(packet) {
  return encodeEnginePacket({ type: 'message', data: encodeSocketPacket(packet) });
}

export function decodeSocketMessages(enginePackets) {
  return enginePackets
    .filter((packet) => packet.type === 'message')
    .map((packet) => decodeSocketPacket(packet.data));
}
