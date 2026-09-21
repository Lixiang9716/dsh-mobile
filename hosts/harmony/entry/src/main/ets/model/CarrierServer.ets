// dsh:logging-exempt (carrier transport: transport facts reach the E2E log
// only as fields of canonical lines the phase drives emit — single-logger
// discipline; hilog markers here are progress evidence, not log events)
/**
 * CarrierServer — the loopback carrier implementing the `ctx.webServer`
 * contract subset (docs/webserver-contract.md §1, §3) on @ohos.net.socket:
 * a route table with exact + prefix named routes, one fallback seat,
 * exact-path-only upgrade dispatch with per-path WS seats, and request-body
 * reading for the /api RPC bridge. Transport only: the wire is reduced to
 * callbacks and send; this class never touches JS or the runtime.
 *
 * Matching is fixed (§1.2): exact table → longest prefix → fallback; an
 * unmatched upgrade socket is destroyed (§1.3); a missing fallback answers
 * bare 404 (§1.4). One HTTP request per connection (Connection: close).
 *
 * WS accept: Sec-WebSocket-Accept = base64(sha1(key + GUID)) with the
 * hand-rolled SHA-1 of model/Sha1.ets (documented there).
 */
import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { hexToBytes, sha1Hex } from './Sha1';

const TAG: string = 'dsh.app';
const WS_GUID: string = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HEADER: number = 16 * 1024;

/** Session cookie name (the auth-lite posture of contract §3.4). */
export const COOKIE_NAME: string = 'dsh.session';
/** Body cap for page RPC (§3.5); upstream allows 300 MiB for uploads,
 * which the mobile carrier does not serve. */
export const MAX_BODY_BYTES: number = 256 * 1024;

/** One parsed HTTP request handed to route handlers — transport facts only. */
export interface CarrierRequest {
  method: string;
  /** Percent-decoded pathname (query stripped, one decode); null on bad
   * escapes — a null path dispatches to the 400 leg, never a crash. */
  path: string | null;
  /** Raw (still-encoded) request path, query stripped. */
  rawPath: string;
  /** Raw query string (no leading `?`), null when absent. */
  query: string | null;
  /** Header names lowercased; the first value of each name wins. */
  headers: Record<string, string>;
  /** Body bytes (utf8-decoded; the /api envelopes are JSON text). */
  body: string;
  declaredLength: number;
}

export type HttpHandler = (req: CarrierRequest,
  conn: socket.TCPSocketConnection) => void;
export type UpgradeHandler = (req: CarrierRequest) => boolean;

interface ConnState {
  client: socket.TCPSocketConnection;
  buffer: Uint8Array;
  /** The WS seat path once upgraded; null while the connection speaks HTTP. */
  seat: string | null;
}

export function contentTypeOf(path: string): string {
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

function utf8Encode(text: string): Uint8Array {
  if (text.length === 0) {
    return new Uint8Array(0); // encodeInto('') returns undefined on this SDK
  }
  const encoder = util.TextEncoder.create('utf-8');
  return encoder.encodeInto(text);
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

function reasonOf(status: number): string {
  if (status === 200) {
    return 'OK';
  }
  if (status === 204) {
    return 'No Content';
  }
  if (status === 303) {
    return 'See Other';
  }
  if (status === 400) {
    return 'Bad Request';
  }
  if (status === 401) {
    return 'Unauthorized';
  }
  if (status === 403) {
    return 'Forbidden';
  }
  if (status === 404) {
    return 'Not Found';
  }
  if (status === 405) {
    return 'Method Not Allowed';
  }
  if (status === 413) {
    return 'Payload Too Large';
  }
  return 'Error';
}

export class CarrierServer {
  private servers: socket.TCPSocketServer[] = [];
  private conns: ConnState[] = [];
  /** Named routes: exact table, prefix table, upgrade table, fallback slot
   * (§1.2–§1.4). Duplicate registration is a fatal config error — the drive
   * fails loud (§3.2). */
  private exactRoutes: Map<string, HttpHandler> = new Map();
  private prefixRoutes: Map<string, HttpHandler> = new Map();
  private upgradeRoutes: Map<string, UpgradeHandler> = new Map();
  private fallbackHandler: HttpHandler | null = null;
  port: number = 0;
  onWsText: (text: string) => void = (text: string): void => {};
  /** Path-aware seam: (text, seat path) for every WS text frame. */
  onWsFrame: (text: string, path: string) => void =
    (text: string, path: string): void => {};
  onStaticServed: (path: string) => void = (path: string): void => {};
  /** Fired once the 101 is on the wire — the mux.upgraded evidence point. */
  onSeatOpen: (path: string) => void = (path: string): void => {};

  /** Bind 127.0.0.1 on the first free port from basePort (fail loud after
   * ten tries — rule 5). Registers the accept loop before resolving. */
  start(basePort: number): Promise<number> {
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

  /** Registers one named HTTP route (§1.2). Duplicate (kind, path) throws. */
  register(kind: string, path: string, handler: HttpHandler): void {
    const table = kind === 'exact' ? this.exactRoutes : this.prefixRoutes;
    if (table.has(path)) {
      throw new Error(`carrier: duplicate ${kind} route ${path}`);
    }
    table.set(path, handler);
  }

  /** Registers the fallback seat (§1.4). One owner only. */
  registerFallback(handler: HttpHandler): void {
    if (this.fallbackHandler !== null) {
      throw new Error('carrier: two fallbacks cannot compose');
    }
    this.fallbackHandler = handler;
  }

  /** Registers one exact-path upgrade route (§1.3); duplicates throw. */
  registerUpgrade(path: string, handler: UpgradeHandler): void {
    if (this.upgradeRoutes.has(path)) {
      throw new Error(`carrier: duplicate upgrade route ${path}`);
    }
    this.upgradeRoutes.set(path, handler);
  }

  stop(): void {
    this.conns.forEach((conn: ConnState): void => {
      this.closeQuietly(conn);
    });
    this.conns = [];
    this.servers.forEach((server: socket.TCPSocketServer): void => {
      server.off('connect');
    });
    this.servers = [];
  }

  /** Send one WS text frame to every seat on `path` (no-op while closed). */
  sendToPath(path: string, text: string): void {
    this.conns.forEach((conn: ConnState): void => {
      if (conn.seat === path) {
        conn.client.send({ data: wsTextFrame(text) })
          .catch((err: BusinessError): void => {
            hilog.error(0x0000, TAG, 'carrier: ws send failed: %{public}s',
              err.message ?? 'unknown');
          });
      }
    });
  }

  /** Legacy M2 seam: send to the `/ws` page. */
  sendText(text: string): void {
    this.sendToPath('/ws', text);
  }

  /** One complete response then close (handlers own the lifecycle;
   * `Connection: close` stays the carrier posture). With `bodyless` (HEAD)
   * the headers keep the real length but no body follows. */
  respond(conn: socket.TCPSocketConnection, status: number, type: string,
    body: ArrayBuffer, extra: Record<string, string>, bodyless: boolean): void {
    const headBytes = utf8Encode('HTTP/1.1 ' + status + ' ' + reasonOf(status) +
      '\r\nContent-Type: ' + type +
      '\r\nContent-Length: ' + body.byteLength +
      '\r\n' + CarrierServer.headerBlock(extra) +
      'Connection: close\r\n\r\n');
    if (bodyless) {
      this.send(conn, headBytes.buffer as ArrayBuffer);
      return;
    }
    const out = new Uint8Array(headBytes.length + body.byteLength);
    out.set(headBytes);
    out.set(new Uint8Array(body), headBytes.length);
    this.send(conn, out.buffer as ArrayBuffer);
  }

  respondText(conn: socket.TCPSocketConnection, status: number, type: string,
    text: string): void {
    this.respond(conn, status, type, utf8Encode(text).buffer as ArrayBuffer,
      {}, false);
  }

  private static headerBlock(extra: Record<string, string>): string {
    let out = '';
    const keys: string[] = Object.keys(extra);
    for (let i = 0; i < keys.length; i++) {
      out += keys[i] + ': ' + extra[keys[i]] + '\r\n';
    }
    return out;
  }

  private send(conn: socket.TCPSocketConnection, data: ArrayBuffer): void {
    // Bounded sequential writes: a single multi-hundred-KB send() truncates
    // on the platform (the peer saw ~16 KB of a 604 KB body and stalled) —
    // chain the pieces and close only after the last one lands.
    const bytes = new Uint8Array(data);
    const sendAt = (at: number): void => {
      if (at >= bytes.length) {
        conn.close();
        return;
      }
      const end = Math.min(at + CarrierServer.SEND_CHUNK_BYTES, bytes.length);
      conn.send({ data: bytes.slice(at, end).buffer as ArrayBuffer })
        .then((): void => sendAt(end))
        .catch((err: BusinessError): void => {
          hilog.error(0x0000, TAG, 'carrier: send failed: %{public}s',
            err.message ?? 'unknown');
        });
    };
    sendAt(0);
  }

  private static readonly SEND_CHUNK_BYTES: number = 64 * 1024;

  /** Tear a connection down from inside a socket callback. `close()` is
   * documented to throw, and every call site here is a protocol dead end
   * (oversized header, unmatched upgrade, missing WS key, close frame) whose
   * only job is to drop the socket — a throw would escape into the socket
   * event handler and take the carrier's fault handling with it, so the
   * failure is logged and swallowed: the connection is going away either way. */
  private closeQuietly(conn: ConnState): void {
    try {
      conn.client.close();
    } catch (e) {
      const be = e as BusinessError;
      hilog.warn(0x0000, TAG, 'carrier: close failed code=%{public}d: %{public}s',
        be.code ?? -1, be.message ?? 'unknown');
    }
  }

  private handleConnect(client: socket.TCPSocketConnection): void {
    const conn: ConnState = { client: client, buffer: new Uint8Array(0), seat: null };
    this.conns.push(conn);
    client.on('message', (value: socket.SocketMessageInfo): void => {
      this.ingest(conn, new Uint8Array(value.message));
    });
    client.on('close', (): void => {
      this.conns = this.conns.filter((c: ConnState): boolean => c.client !== client);
    });
  }

  private ingest(conn: ConnState, chunk: Uint8Array): void {
    const merged = new Uint8Array(conn.buffer.length + chunk.length);
    merged.set(conn.buffer);
    merged.set(chunk, conn.buffer.length);
    conn.buffer = merged;
    if (conn.seat !== null) {
      this.parseWsFrames(conn);
    } else {
      this.parseHttp(conn);
    }
  }

  /** One HTTP request per connection (Connection: close), except upgrades
   * which flip the connection into frame mode. Reassembles head + a
   * Content-Length body up to MAX_BODY_BYTES (§3.5). */
  private parseHttp(conn: ConnState): void {
    const text = utf8Decode(conn.buffer);
    const end = text.indexOf('\r\n\r\n');
    if (end < 0) {
      if (conn.buffer.length > MAX_HEADER) {
        this.closeQuietly(conn);
      }
      return;
    }
    const head = text.substring(0, end);
    const request = CarrierServer.parseRequest(head, text.substring(end + 4));
    if (request === null) {
      this.respondText(conn.client, 400, 'text/plain', 'bad request');
      return;
    }
    if (text.length - (end + 4) < request.declaredLength) {
      return; // body still arriving; keep buffering
    }
    if (request.declaredLength > MAX_BODY_BYTES) {
      this.respondText(conn.client, 413, 'text/plain', 'body too large');
      return;
    }
    conn.buffer = new Uint8Array(0);
    if (request.headers['sec-websocket-key'] !== undefined) {
      this.runUpgrade(conn, request);
      return;
    }
    this.dispatch(conn, request);
  }

  private static parseRequest(head: string, bodyText: string): CarrierRequest | null {
    const lines = head.split('\r\n');
    if (lines.length === 0) {
      return null;
    }
    const parts = lines[0].split(' ');
    if (parts.length < 2) {
      return null;
    }
    const target = parts[1];
    const qAt = target.indexOf('?');
    const rawPath = qAt >= 0 ? target.substring(0, qAt) : target;
    const query = qAt >= 0 ? target.substring(qAt + 1) : null;
    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const at = lines[i].indexOf(':');
      if (at > 0) {
        headers[lines[i].substring(0, at).trim().toLowerCase()] =
          lines[i].substring(at + 1).trim();
      }
    }
    let path: string | null = null;
    try {
      path = decodeURIComponent(rawPath);
    } catch (e) {
      path = null; // bad escapes dispatch to the 400 leg (§3.2)
    }
    const declared = Number(headers['content-length'] ?? '0');
    return {
      method: parts[0],
      path: path,
      rawPath: rawPath,
      query: query,
      headers: headers,
      body: bodyText.substring(0, Number.isNaN(declared) ? 0 : declared),
      declaredLength: Number.isNaN(declared) ? 0 : declared,
    };
  }

  /** Dispatch (§3.2): exact → longest prefix → fallback → bare 404. */
  private dispatch(conn: ConnState, request: CarrierRequest): void {
    if (request.path === null) {
      this.respondText(conn.client, 400, 'text/plain', 'bad request path');
      return;
    }
    const exact = this.exactRoutes.get(request.path);
    if (exact !== undefined) {
      exact(request, conn.client);
      return;
    }
    const prefix = CarrierServer.longestPrefix(this.prefixRoutes, request.path);
    if (prefix !== null) {
      prefix(request, conn.client);
      return;
    }
    if (this.fallbackHandler !== null) {
      this.fallbackHandler(request, conn.client);
      return;
    }
    this.respondText(conn.client, 404, 'text/plain', 'not found');
  }

  private static longestPrefix(table: Map<string, HttpHandler>,
    path: string): HttpHandler | null {
    let best: string | null = null;
    table.forEach((handler: HttpHandler, key: string): void => {
      if ((path === key || path.startsWith(key + '/')) &&
        (best === null || key.length > best.length)) {
        best = key;
      }
    });
    if (best === null) {
      return null;
    }
    const handler = table.get(best);
    return handler === undefined ? null : handler;
  }

  /** Upgrades match by exact pathname only; an unmatched target destroys the
   * socket — never a fall-through to static (§1.3, §3.3). */
  private runUpgrade(conn: ConnState, request: CarrierRequest): void {
    const handler = this.upgradeRoutes.get(request.rawPath);
    if (handler === undefined || request.path === null) {
      this.closeQuietly(conn);
      return;
    }
    if (!handler(request)) {
      this.closeQuietly(conn);
      return;
    }
    this.acceptUpgrade(conn, request.rawPath,
      request.headers['sec-websocket-key'] ?? '');
  }

  private acceptUpgrade(conn: ConnState, path: string, key: string): void {
    if (key.length === 0) {
      hilog.error(0x0000, TAG, 'carrier: ws upgrade without a key');
      this.closeQuietly(conn);
      return;
    }
    const digest = hexToBytes(sha1Hex(utf8Encode(key + WS_GUID)));
    const accept = new util.Base64Helper().encodeToStringSync(digest);
    const response = 'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n';
    conn.client.send({ data: utf8Encode(response).buffer as ArrayBuffer })
      .then((): void => {
        conn.seat = path;
        conn.buffer = new Uint8Array(0);
        hilog.info(0x0000, TAG, 'carrier: ws established %{public}s', path);
        this.onSeatOpen(path);
      })
      .catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'carrier: ws handshake send failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  /** RFC 6455 server-side frame reader: client frames are masked; text
   * frames reach the phase drive via the path-aware seam, ping is ponged,
   * close drops the seat. */
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
      const seat = conn.seat ?? '';
      if (opcode === 0x1) {
        const text = utf8Decode(payload);
        this.onWsFrame(text, seat);
        if (seat === '/ws') {
          this.onWsText(text);
        }
      } else if (opcode === 0x8) {
        this.closeQuietly(conn);
        return;
      } else if (opcode === 0x9) {
        this.sendRawFrame(conn, 0x0a, payload);
      }
    }
  }

  private sendRawFrame(conn: ConnState, opcode: number, payload: Uint8Array): void {
    const frame = new Uint8Array(2 + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = payload.length;
    frame.set(payload, 2);
    conn.client.send({ data: frame.buffer as ArrayBuffer })
      .catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'carrier: frame send failed: %{public}s',
          err.message ?? 'unknown');
      });
  }
}
