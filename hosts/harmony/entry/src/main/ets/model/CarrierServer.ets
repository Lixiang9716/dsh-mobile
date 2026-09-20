// dsh:logging-exempt (carrier transport: transport facts reach the E2E log
// only as fields of canonical lines the HostPhase emits — single-logger
// discipline; hilog markers here are progress evidence, not log events)
/**
 * CarrierServer — the M5 loopback carrier (mission piece 1): a minimal
 * HTTP/1.1 static server serving the materialized Web Client directory plus
 * a minimal RFC 6455 WebSocket text-frame endpoint at /ws, both on ONE
 * loopback TCP port, implemented directly on @ohos.net.socket (no new
 * dependencies). The page knows only the HTTP+WS protocol
 * (session-projection@0); messages are shuttled by HostPhase, which stays
 * the only component that touches the JS runtime — and it does so on the
 * ArkTS main thread, the one serial runtime thread (ARCHITECTURE.md §6).
 *
 * WS accept: Sec-WebSocket-Accept = base64(sha1(key + GUID)) with the
 * hand-rolled SHA-1 of model/Sha1.ets (documented there).
 */
import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { hexToBytes, sha1Hex } from './Sha1';

const TAG: string = 'dsh.app';
const WS_GUID: string = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HEADER: number = 16 * 1024;

interface ConnState {
  client: socket.TCPSocketConnection;
  buffer: Uint8Array;
  ws: boolean;
}

function contentTypeOf(path: string): string {
  if (path.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (path.endsWith('.js')) {
    return 'application/javascript; charset=utf-8';
  }
  if (path.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  return 'application/octet-stream';
}

/** Text frame payload bytes → string (RFC 6455 opcode 0x1). */
function utf8Decode(bytes: Uint8Array): string {
  const decoder = util.TextDecoder.create('utf-8');
  return decoder.decodeToString(bytes);
}

/** Server→client text frame: FIN + opcode 0x1, unmasked (RFC 6455 §5.1). */
function wsTextFrame(text: string): ArrayBuffer {
  const payload = utf8Encode(text);
  const header: number[] = [0x81];
  const n = payload.length;
  if (n < 126) {
    header.push(n);
  } else if (n < 65536) {
    header.push(126, (n >> 8) & 0xff, n & 0xff);
  } else {
    header.push(127, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff,
      (n >>> 8) & 0xff, n & 0xff);
  }
  const frame = new Uint8Array(header.length + n);
  for (let i = 0; i < header.length; i++) {
    frame[i] = header[i];
  }
  frame.set(payload, header.length);
  return frame.buffer as ArrayBuffer;
}

function utf8Encode(text: string): Uint8Array {
  const encoder = util.TextEncoder.create('utf-8');
  return encoder.encodeInto(text);
}

/** Lines of one header block, lowercased keys stripped of their prefix. */
function headerValue(block: string, name: string): string {
  const lines = block.split('\r\n').slice(1);
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at > 0 && line.substring(0, at).trim().toLowerCase() === name) {
      return line.substring(at + 1).trim();
    }
  }
  return '';
}

export class CarrierServer {
  private webRoot: string = '';
  private wsConn: socket.TCPSocketConnection | null = null;
  private servers: socket.TCPSocketServer[] = [];
  port: number = 0;
  onWsText: (text: string) => void = (text: string): void => {};
  onStaticServed: (path: string) => void = (path: string): void => {};

  /** Bind 127.0.0.1 on the first free port from basePort (fail loud after
   * ten tries — rule 5). Registers the accept loop before resolving. */
  start(webRoot: string, basePort: number): Promise<number> {
    this.webRoot = webRoot;
    return new Promise<number>((resolve: (v: number) => void,
      reject: (e: Error) => void) => {
      const tryPort = (port: number): void => {
        if (port > basePort + 9) {
          reject(new Error('carrier: no loopback port free from ' + basePort));
          return;
        }
        const server = socket.constructTCPSocketServerInstance();
        this.servers.push(server);
        const addr: socket.NetAddress = {
          address: '127.0.0.1',
          port: port,
          family: 1
        };
        server.listen(addr, (err: BusinessError) => {
            if (err) {
              hilog.warn(0x0000, TAG, 'carrier: port %{public}d busy (%{public}s)',
                port, err.message ?? 'unknown');
              tryPort(port + 1);
              return;
            }
            server.on('connect', (client: socket.TCPSocketConnection) => {
              this.handleConnect(client);
            });
            this.port = port;
            hilog.info(0x0000, TAG, 'carrier: listening on %{public}d', port);
            resolve(port);
          });
      };
      tryPort(basePort);
    });
  }

  stop(): void {
    this.wsConn = null;
    this.servers.forEach((server: socket.TCPSocketServer): void => {
      server.off('connect');
    });
    this.servers = [];
  }

  /** Send one text message to the mounted page (dropped when it is not
   * connected — replay-before-connect is not needed: the session starts
   * only after the page hello). */
  sendText(text: string): void {
    const conn = this.wsConn;
    if (conn === null) {
      return;
    }
    conn.send({ data: wsTextFrame(text) }).catch((err: BusinessError) => {
      hilog.error(0x0000, TAG, 'carrier: ws send failed: %{public}s',
        err.message ?? 'unknown');
    });
  }

  private handleConnect(client: socket.TCPSocketConnection): void {
    const conn: ConnState = { client: client, buffer: new Uint8Array(0), ws: false };
    client.on('message', (value: socket.SocketMessageInfo): void => {
      this.ingest(conn, new Uint8Array(value.message));
    });
    client.on('close', (): void => {
      if (this.wsConn === client) {
        this.wsConn = null;
      }
    });
  }

  private ingest(conn: ConnState, chunk: Uint8Array): void {
    const merged = new Uint8Array(conn.buffer.length + chunk.length);
    merged.set(conn.buffer);
    merged.set(chunk, conn.buffer.length);
    conn.buffer = merged;
    if (conn.ws) {
      this.parseWsFrames(conn);
    } else {
      this.parseHttp(conn);
    }
  }

  /** One HTTP request per connection (Connection: close), except the /ws
   * upgrade which flips the connection into frame mode. */
  private parseHttp(conn: ConnState): void {
    const text = utf8Decode(conn.buffer);
    const end = text.indexOf('\r\n\r\n');
    if (end < 0) {
      if (conn.buffer.length > MAX_HEADER) {
        conn.client.close();
      }
      return;
    }
    const head = text.substring(0, end);
    const requestLine = head.split('\r\n')[0];
    const parts = requestLine.split(' ');
    const path = parts.length >= 2 ? parts[1] : '';
    if (path === '/ws' &&
      headerValue(head, 'upgrade').toLowerCase() === 'websocket') {
      this.upgrade(conn, headerValue(head, 'sec-websocket-key'));
      return;
    }
    this.serveStatic(conn, path);
  }

  private upgrade(conn: ConnState, key: string): void {
    if (key.length === 0) {
      hilog.error(0x0000, TAG, 'carrier: ws upgrade without a key');
      conn.client.close();
      return;
    }
    const digest = hexToBytes(sha1Hex(utf8Encode(key + WS_GUID)));
    const accept = new util.Base64Helper().encodeToStringSync(digest);
    const response = 'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n';
    conn.client.send({ data: utf8Encode(response).buffer as ArrayBuffer })
      .then((): void => {
        conn.ws = true;
        conn.buffer = new Uint8Array(0);
        this.wsConn = conn.client;
        hilog.info(0x0000, TAG, 'carrier: ws established');
      })
      .catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'carrier: ws handshake send failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  private serveStatic(conn: ConnState, rawPath: string): void {
    if (rawPath.indexOf('..') >= 0) {
      this.respond(conn, 404, 'text/plain', 'invalid path');
      return;
    }
    const path = rawPath === '/' ? '/index.html' : rawPath;
    const full = this.webRoot + path;
    let body: ArrayBuffer;
    try {
      const stat = fs.statSync(full);
      const file = fs.openSync(full, fs.OpenMode.READ_ONLY);
      body = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, body);
      fs.closeSync(file.fd);
    } catch (e) {
      hilog.error(0x0000, TAG, 'carrier: 404 %{public}s', path);
      this.respond(conn, 404, 'text/plain', 'not found');
      return;
    }
    this.respondBytes(conn, 200, contentTypeOf(path), body);
    this.onStaticServed(path);
  }

  private respond(conn: ConnState, status: number, type: string, text: string): void {
    this.respondBytes(conn, status, type, utf8Encode(text).buffer as ArrayBuffer);
  }

  private respondBytes(conn: ConnState, status: number, type: string,
    body: ArrayBuffer): void {
    const reason = status === 200 ? 'OK' : 'Not Found';
    const head = 'HTTP/1.1 ' + status + ' ' + reason +
      '\r\nContent-Type: ' + type +
      '\r\nContent-Length: ' + body.byteLength +
      '\r\nConnection: close\r\n\r\n';
    const headBytes = utf8Encode(head);
    const out = new Uint8Array(headBytes.length + body.byteLength);
    out.set(headBytes);
    out.set(new Uint8Array(body), headBytes.length);
    conn.client.send({ data: out.buffer as ArrayBuffer })
      .then((): void => {
        conn.client.close();
      })
      .catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'carrier: static send failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  /** RFC 6455 server-side frame reader: client frames are masked; text
   * frames reach HostPhase via onWsText, ping is ponged, close drops. */
  private parseWsFrames(conn: ConnState): void {
    for (;;) {
      const buf = conn.buffer;
      if (buf.length < 2) {
        return;
      }
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) {
          return;
        }
        len = (buf[2] << 8) | buf[3];
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) {
          return;
        }
        len = 0;
        for (let i = 4; i < 10; i++) {
          len = len * 256 + buf[2 + i];
        }
        at = 10;
      }
      const maskAt = at;
      if ((buf[1] & 0x80) !== 0) {
        at += 4;
      }
      if (buf.length < at + len) {
        return;
      }
      const payload = buf.slice(at, at + len);
      if ((buf[1] & 0x80) !== 0) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i] ^ buf[maskAt + (i % 4)];
        }
      }
      conn.buffer = buf.slice(at + len);
      if (opcode === 0x1) {
        this.onWsText(utf8Decode(payload));
      } else if (opcode === 0x8) {
        conn.client.close();
        if (this.wsConn === conn.client) {
          this.wsConn = null;
        }
        return;
      } else if (opcode === 0x9) {
        this.sendRawFrame(0x0a, payload);
      }
    }
  }

  private sendRawFrame(opcode: number, payload: Uint8Array): void {
    const conn = this.wsConn;
    if (conn === null) {
      return;
    }
    const frame = new Uint8Array(2 + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = payload.length;
    frame.set(payload, 2);
    conn.send({ data: frame.buffer as ArrayBuffer })
      .catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'carrier: frame send failed: %{public}s',
          err.message ?? 'unknown');
      });
  }
}
