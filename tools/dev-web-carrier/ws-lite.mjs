// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * ws-lite.mjs — the server half of RFC 6455, the Node port of the mobile
 * carriers' hand-rolled upgrade (CarrierServer.kt / CarrierServer.swift):
 * handshake (Sec-WebSocket-Accept = SHA1(key + magic)), masked-frame
 * parsing (126/127 lengths), text send, ping→pong, close echo. Transport
 * only — the mux protocol rides above it.
 */
import { createHash } from 'node:crypto';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Complete one upgrade on the socket; returns a connection object or
 * null when the handshake is not a legal websocket upgrade. */
export const acceptUpgrade = (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  const upgrade = (request.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket' || key === undefined) return null;
  const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + '\r\n',
  );
  return connect(socket);
};

/** One server→client frame (unmasked, with length framing). */
const writeFrame = (socket, opcode, payload) => {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([head, payload]));
};

/** Parse one client frame off the head of `buffer` (masked, 126/127
 * length forms). Returns { opcode, payload, rest } or null when the
 * buffer holds less than one whole frame. */
const readFrame = (buffer) => {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(16 * 1024 * 1024)) throw new Error('ws-lite: frame too large');
    length = Number(big);
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buffer.length < offset + maskLen + length) return null;
  let payload = buffer.subarray(offset + maskLen, offset + maskLen + length);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    const unmasked = Buffer.alloc(length);
    for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
    payload = unmasked;
  }
  return { opcode, payload, rest: buffer.subarray(offset + maskLen + length) };
};

/** One live WS connection over an upgraded socket. */
export const connect = (socket) => {
  let buffer = Buffer.alloc(0);
  let closed = false;
  const listeners = { text: [], close: [] };

  const emitClose = () => {
    if (closed) return;
    closed = true;
    for (const fn of listeners.close) fn();
  };

  const handleFrame = (opcode, payload) => {
    if (opcode === 0x8) { // close: echo, then done
      writeFrame(socket, 0x8, payload.subarray(0, 2));
      socket.end();
      emitClose();
      return;
    }
    if (opcode === 0x9) return writeFrame(socket, 0xA, payload); // ping → pong
    if (opcode === 0xA) return; // unsolicited pong: ignore
    if (opcode === 0x1) {
      const text = payload.toString('utf8');
      for (const fn of listeners.text) fn(text);
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let frame = readFrame(buffer);
    while (frame !== null) {
      buffer = frame.rest;
      handleFrame(frame.opcode, frame.payload);
      frame = readFrame(buffer);
    }
  });
  socket.on('error', emitClose);
  socket.on('close', emitClose);

  return {
    sendText: (text) => { if (!closed) writeFrame(socket, 0x1, Buffer.from(text, 'utf8')); },
    close: () => { writeFrame(socket, 0x8, Buffer.alloc(0)); socket.end(); emitClose(); },
    onText: (fn) => listeners.text.push(fn),
    onClose: (fn) => listeners.close.push(fn),
    get closed() { return closed; },
  };
};
