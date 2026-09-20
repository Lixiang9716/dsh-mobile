// dsh:logging-exempt (named route: evidence rides the phase sink)
/**
 * ApiBridge — the `/api` prefix route and the `/api/remote.mux` upgrade: the
 * RPC transport of docs/webserver-contract.md §2.3/§2.4 with the Phase-B
 * bridging of §3.5. The carrier parses the frozen `client-request` envelope,
 * forwards CLAIMED endpoints onto the runtime over the bus seam, and answers
 * every UNCLAIMED endpoint with a structured unavailable envelope — fail
 * loud, logged (never a silent hang). The mux is the single multiplexed push
 * socket: `open`/`cancel` frames arrive from the page, `item`/`error`/`end`
 * frames leave toward it, all bridged over the same seam.
 *
 * Threading: handlers run on the ArkTS main thread — the ONE serial JS
 * runtime thread (ARCHITECTURE.md §6); the deliver callback re-enters the
 * runtime synchronously and only ever queues or sends back out.
 */
import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { CarrierRequest, CarrierServer } from './CarrierServer';
import { WebDist } from './WebDist';

/** Code answered for endpoints no runtime has claimed (Phase-B v0). */
const UNAVAILABLE_CODE = 'gateway/unimplemented';
/** Upstream RPC namespaces enumerated from source (§2.3). v0 answers every
 * one of them `gateway/unimplemented` until claimed. */
const NAMESPACES: string =
  '["session","settings","credentials","workspace","terminal","goals",' +
  '"skills","fileReferences","directoryPicker","archive","typert"]';

interface MuxFrame {
  type?: string;
  rpcId?: string;
  streamId?: string;
  endpoint?: string;
  payload?: Record<string, Object>;
}

export class ApiBridge {
  /** Evidence hooks — the owning drive logs them; the bridge never logs. */
  onAPICall: (endpoint: string, answered: string) => void =
    (endpoint: string, answered: string): void => {};
  onUpgradeAccepted: (path: string) => void = (path: string): void => {};
  onMuxOpen: (streamId: string, endpoint: string) => void =
    (streamId: string, endpoint: string): void => {};
  onMuxFrame: (direction: string, kind: string) => void =
    (direction: string, kind: string): void => {};
  /** One tx ERROR frame with the stream endpoint that produced it (the
   * honest services-gap leg for the official-app evidence). */
  onMuxErrorFrame: (endpoint: string) => void = (endpoint: string): void => {};

  /** Seam out: carrier → runtime deliveries (hostBusDeliver JSON). */
  deliverToRuntime: (jsonText: string) => void = (jsonText: string): void => {};
  /** Server reference for the mux tx frames. */
  private server: CarrierServer;
  private sessionToken: string;
  /** Endpoints the runtime claimed over the bus seam (v0: none). */
  private claimedEndpoints: Set<string> = new Set();
  private muxClaimed = false;
  /** Responses awaiting the runtime, by rpcId. */
  private pendingRPC: Map<string, socket.TCPSocketConnection> = new Map();

  constructor(server: CarrierServer, sessionToken: string) {
    this.server = server;
    this.sessionToken = sessionToken;
  }

  /** Binds to the server: registers the `/api` prefix route and the
   * `/api/remote.mux` exact upgrade (§2.3, §2.4). Call before `start()`. */
  install(): void {
    this.server.register('prefix', '/api', (req: CarrierRequest,
      conn: socket.TCPSocketConnection): void => {
      this.handleAPI(req, conn);
    });
    this.server.registerUpgrade('/api/remote.mux', (req: CarrierRequest): boolean => {
      if (!WebDist.isAuthedFor(req, this.sessionToken)) {
        return false; // destroy (upstream rejects at socket level)
      }
      this.onUpgradeAccepted('/api/remote.mux');
      return true;
    });
  }

  // ---- POST /api/<endpoint> (§2.3) -------------------------------------------

  private handleAPI(req: CarrierRequest, conn: socket.TCPSocketConnection): void {
    if (req.path === null) {
      this.answer(conn, 400, 'bad request');
      return;
    }
    if (req.method !== 'POST') {
      this.answer(conn, 405, '');
      return;
    }
    if (!WebDist.isAuthedFor(req, this.sessionToken)) {
      this.answer(conn, 401, '');
      return;
    }
    const endpoint = req.path.substring('/api/'.length);
    if (!ApiBridge.validEndpoint(endpoint) || !ApiBridge.validEnvelope(req.body, endpoint)) {
      this.onAPICall(endpoint, 'malformed');
      this.answer(conn, 400, 'malformed envelope');
      return;
    }
    const msg = JSON.parse(req.body) as MuxFrame;
    const rpcId = msg.rpcId ?? '';
    if (rpcId.length === 0) {
      this.onAPICall(endpoint, 'malformed');
      this.answer(conn, 400, 'malformed envelope');
      return;
    }
    if (this.claimedEndpoints.has(endpoint)) {
      this.pendingRPC.set(rpcId, conn);
      this.deliverToRuntime(ApiBridge.apiRequestJson(rpcId, endpoint, req.body));
      this.onAPICall(endpoint, 'forwarded');
      return;
    }
    this.onAPICall(endpoint, 'unavailable');
    const body = ApiBridge.unavailableEnvelope(rpcId, endpoint);
    this.server.respond(conn, 200, 'application/json',
      WebPluginsText.toBytes(body), {}, false);
  }

  /** Bus-seam settle: one claimed RPC answered with the frozen result text
   * (the already-shaped ok/error JSON object, produced by the runtime). */
  respondAPI(rpcId: string, resultJsonText: string): void {
    const conn = this.pendingRPC.get(rpcId);
    if (conn === undefined) {
      return;
    }
    this.pendingRPC.delete(rpcId);
    const envelope = '{"type":"server-response","rpcId":' +
      JSON.stringify(rpcId) + ',"result":' + resultJsonText + '}';
    this.server.respond(conn, 200, 'application/json',
      WebPluginsText.toBytes(envelope), {}, false);
  }

  /** Bus-seam claim: the runtime answers these endpoints from now on. */
  claim(endpoints: string[]): void {
    for (let i = 0; i < endpoints.length; i++) {
      this.claimedEndpoints.add(endpoints[i]);
    }
  }

  /** Bus seam: the runtime owns mux streams from now on. */
  claimMux(): void {
    this.muxClaimed = true;
  }

  // ---- WS /api/remote.mux (§2.4) ------------------------------------------------

  /** Wired to `server.onWsFrame` by the drive: mux seats only; unknown or
   * malformed frames fail the seat loudly (socket-level, per §1.6). */
  ingestFrame(text: string, path: string): void {
    if (path !== '/api/remote.mux') {
      return;
    }
    let frame: MuxFrame;
    try {
      frame = JSON.parse(text) as MuxFrame;
    } catch (e) {
      return;
    }
    if (frame.type === 'open') {
      const streamId = frame.streamId ?? '';
      const endpoint = frame.endpoint ?? '';
      if (streamId.length === 0 || endpoint.length === 0) {
        return;
      }
      this.onMuxOpen(streamId, endpoint);
      this.onMuxFrame('rx', 'open');
      this.routeMuxOpen(streamId, endpoint, frame.payload ?? {});
      return;
    }
    if (frame.type === 'cancel') {
      this.onMuxFrame('rx', 'cancel');
      if (this.muxClaimed) {
        this.deliverToRuntime(JSON.stringify({
          'type': 'mux.cancel', 'streamId': frame.streamId ?? '',
        }));
      }
    }
  }

  /** Dispatches one accepted mux open: forward to a claiming runtime, or
   * answer the structured unavailable error frame (v0 default). */
  private routeMuxOpen(streamId: string, endpoint: string,
    payload: Record<string, Object>): void {
    if (!this.muxClaimed) {
      this.onMuxErrorFrame(endpoint);
      this.muxError(streamId, UNAVAILABLE_CODE,
        'stream endpoint ' + endpoint + ' is not implemented by the Phase-B carrier',
        '{"endpoint":' + JSON.stringify(endpoint) + '}');
      return;
    }
    this.deliverToRuntime(JSON.stringify({
      'type': 'mux.open', 'streamId': streamId,
      'endpoint': endpoint, 'payload': payload,
    }));
  }

  /** Runtime → page: one stream item (value is an already-encoded JSON TEXT;
   * splicing the text keeps the frame lossless without re-parsing). */
  muxItem(streamId: string, valueJsonText: string): void {
    this.sendMux('{"type":"item","streamId":' + JSON.stringify(streamId) +
      ',"value":' + valueJsonText + '}');
    this.onMuxFrame('tx', 'item');
  }

  /** Runtime → page: one terminal stream error (§2.4 carrier-safe failure). */
  muxError(streamId: string, code: string, message: string,
    detailsJsonText: string): void {
    this.sendMux('{"type":"error","streamId":' + JSON.stringify(streamId) +
      ',"error":{"code":' + JSON.stringify(code) + ',"message":' +
      JSON.stringify(message) + ',"details":' + detailsJsonText + '}}');
    this.onMuxFrame('tx', 'error');
  }

  /** Runtime → page: stream completion. */
  muxEnd(streamId: string): void {
    this.sendMux('{"type":"end","streamId":' + JSON.stringify(streamId) + '}');
    this.onMuxFrame('tx', 'end');
  }

  private sendMux(frame: string): void {
    this.server.sendToPath('/api/remote.mux', frame);
  }

  private answer(conn: socket.TCPSocketConnection, status: number,
    text: string): void {
    this.server.respond(conn, status, 'text/plain',
      WebPluginsText.toBytes(text), {}, false);
  }

  // ---- envelope helpers -------------------------------------------------------

  private static apiRequestJson(rpcId: string, endpoint: string,
    rawEnvelope: string): string {
    // Forward the page's own payload object verbatim: reparse the envelope
    // and rebuild only the transport fields around it.
    const msg = JSON.parse(rawEnvelope) as Record<string, Object>;
    const delivery: Record<string, Object> = {
      'type': 'api.request',
      'rpcId': rpcId,
      'endpoint': endpoint,
      'payload': msg['payload'],
    };
    return JSON.stringify(delivery);
  }

  /** The structured unavailable envelope for one unclaimed endpoint (200:
   * the envelope is the response, the error rides inside). */
  static unavailableEnvelope(rpcId: string, endpoint: string): string {
    return '{"type":"server-response","rpcId":' + JSON.stringify(rpcId) +
      ',"result":{"ok":false,"error":{"code":"' + UNAVAILABLE_CODE +
      '","message":' +
      JSON.stringify('endpoint ' + endpoint +
        ' is not implemented by the Phase-B carrier') +
      ',"details":{"endpoint":' + JSON.stringify(endpoint) +
      ',"namespaces":' + NAMESPACES + '}}}';
  }

  /** Endpoint segment pattern (upstream `ENDPOINT_SEGMENT_PATTERN`, applied
   * per '/' segment: the official client calls namespaced endpoints like
   * `settings/describe`; empty, ".", and ".." segments are invalid). */
  static validEndpoint(endpoint: string): boolean {
    if (endpoint.length === 0) {
      return false;
    }
    const segments = endpoint.split('/');
    for (let i = 0; i < segments.length; i++) {
      const piece = segments[i];
      if (piece.length === 0 || piece === '.' || piece === '..') {
        return false;
      }
      if (!/^[A-Za-z0-9_.$-]+$/.test(piece)) {
        return false;
      }
    }
    return true;
  }

  /** Validates the frozen client-request envelope (§2.3): type, non-empty
   * rpcId, method equal to the posted endpoint, any payload. */
  static validEnvelope(body: string, endpoint: string): boolean {
    let msg: MuxFrame;
    try {
      msg = JSON.parse(body) as MuxFrame;
    } catch (e) {
      return false;
    }
    return msg.type === 'client-request' &&
      msg.rpcId !== undefined && (msg.rpcId as string).length > 0 &&
      (msg as Record<string, Object>)['method'] === endpoint &&
      (msg as Record<string, Object>)['payload'] !== undefined;
  }
}

/** Text→bytes helper shared with the bridge (WebPlugins owns the encoder). */
class WebPluginsText {
  static toBytes(text: string): ArrayBuffer {
    if (text.length === 0) {
      return new ArrayBuffer(0); // encodeInto('') returns undefined on this SDK
    }
    const encoder = util.TextEncoder.create('utf-8');
    const bytes = encoder.encodeInto(text);
    return bytes.buffer.slice(bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
