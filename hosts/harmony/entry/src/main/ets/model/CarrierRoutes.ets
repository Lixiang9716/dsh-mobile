// dsh:logging-exempt (transport wiring: evidence rides the phase sink)
/**
 * CarrierRoutes — the legacy M5 wiring expressed on the Phase-B route table
 * (docs/webserver-contract.md §3.2 "migrate the existing wiring"): the static
 * fallback seat over the materialized Web Client directory and the `/ws`
 * exact upgrade. Behavior is byte-compatible with the pre-Phase-B carrier —
 * the m5.host-binding manifest is frozen and stays green unchanged.
 */
import { socket } from '@kit.NetworkKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CarrierRequest, CarrierServer, contentTypeOf } from './CarrierServer';

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
