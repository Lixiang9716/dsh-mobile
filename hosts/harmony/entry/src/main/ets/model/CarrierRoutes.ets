// dsh:logging-exempt (transport wiring: evidence rides the phase sink)
/**
 * CarrierRoutes — the legacy M5 wiring expressed on the Phase-B route table
 * (docs/webserver-contract.md §3.2 "migrate the existing wiring"): the static
 * fallback seat over the materialized Web Client directory and the `/ws`
 * exact upgrade. Behavior is byte-compatible with the pre-Phase-B carrier —
 * the harmony.capability-binding manifest is frozen and stays green unchanged.
 */
import { socket } from '@kit.NetworkKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CarrierRequest, CarrierServer, HttpHandler, contentTypeOf } from './CarrierServer';

const TAG: string = 'dsh.app';

/** Installs the legacy routes: GET-only static serving from `webRoot` on the
 * fallback seat (path-escape reject, 404 miss) plus the always-accept `/ws`
 * upgrade. Call before `start()`; duplicate registration throws (one server
 * per phase). */
export function installLegacyRoutes(server: CarrierServer, webRoot: string): void {
  server.registerUpgrade('/ws', (req: CarrierRequest): boolean => true);
  server.registerFallback((req: CarrierRequest,
    conn: socket.TCPSocketConnection): void => {
    serveStatic(server, webRoot, req, conn);
  });
}

function serveStatic(server: CarrierServer, webRoot: string,
  req: CarrierRequest, conn: socket.TCPSocketConnection): void {
  const rawPath = req.rawPath;
  if (rawPath.indexOf('..') >= 0) {
    server.respondText(conn, 404, 'text/plain', 'invalid path');
    return;
  }
  const path = rawPath === '/' ? '/index.html' : rawPath;
  const full = webRoot + path;
  let body: ArrayBuffer;
  try {
    const stat = fs.statSync(full);
    const file = fs.openSync(full, fs.OpenMode.READ_ONLY);
    body = new ArrayBuffer(stat.size);
    fs.readSync(file.fd, body);
    fs.closeSync(file.fd);
  } catch (e) {
    hilog.error(0x0000, TAG, 'carrier: 404 %{public}s', path);
    server.respondText(conn, 404, 'text/plain', 'not found');
    return;
  }
  server.respond(conn, 200, contentTypeOf(path), body, {}, false);
  server.onStaticServed(path);
}

/** The httpFetch E2E targets (mirroring the Android carrier's /gateway-e2e
 * routes): HTTP/1.1 chunked streams of deterministic ASCII — /bytes is two
 * 32-byte chunks (64 bytes total), /slow six 16-byte chunks paced 300 ms
 * apart so an abort lands mid-body. The pacing sleeps are real chunk physics
 * (rules.md rule 8), awaited on the main event loop. */
export function installE2EStreams(server: CarrierServer): void {
  server.register('exact', '/gateway-e2e/bytes', streamE2E(false));
  server.register('exact', '/gateway-e2e/slow', streamE2E(true));
}

function streamE2E(paced: boolean): HttpHandler {
  const chunkLen = paced ? 16 : 32;
  const count = paced ? 6 : 2;
  const intervalMs = paced ? 300 : 60;
  return (req: CarrierRequest, conn: socket.TCPSocketConnection): void => {
    const pause = (ms: number): Promise<void> => new Promise<void>(
      (resolve: (v: void) => void): void => {
        setTimeout(resolve, ms);
      });
    const sendRaw = (bytes: Uint8Array): Promise<void> => new Promise<void>(
      (resolve: (v: void) => void, reject: (e: Error) => void): void => {
        conn.send({ data: bytes.buffer as ArrayBuffer })
          .then((): void => resolve())
          .catch((err: BusinessError): void => reject(new Error(err.message)));
      });
    const run = async (): Promise<void> => {
      const unit = utf8Encode('0123456789abcdef');
      const chunk = new Uint8Array(chunkLen);
      for (let i = 0; i < chunkLen; i++) {
        chunk[i] = unit[i % 16];
      }
      await sendRaw(utf8Encode('HTTP/1.1 200 OK\r\n' +
        'Content-Type: application/octet-stream\r\n' +
        'Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n'));
      for (let i = 0; i < count; i++) {
        if (i > 0) {
          await pause(intervalMs);
        }
        const sizeHex = chunkLen.toString(16);
        const frame = new Uint8Array(sizeHex.length + 2 + chunkLen + 2);
        frame.set(utf8Encode(sizeHex), 0);
        frame.set(utf8Encode('\r\n'), sizeHex.length);
        frame.set(chunk, sizeHex.length + 2);
        frame.set(utf8Encode('\r\n'), sizeHex.length + 2 + chunkLen);
        await sendRaw(frame);
      }
      await sendRaw(utf8Encode('0\r\n\r\n'));
    };
    run().catch((e: Error): void => {
      hilog.warn(0x0000, TAG, 'carrier: e2e stream aborted: %{public}s',
        e.message ?? 'unknown');
    }).then((): void => {
      conn.close();
    });
  };
}

function utf8Encode(text: string): Uint8Array {
  const encoder = util.TextEncoder.create('utf-8');
  return encoder.encodeInto(text);
}
