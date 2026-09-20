// dsh:logging-exempt (capability primitive: its facts ride the gateway log)
/**
 * HttpFetch — the httpFetch v2 primitive (contract/primitives.md §4) over
 * @ohos.net.http requestInStream. The call settles
 * `{status, headers, bodyId: "body:<callId>"}` when response HEADERS arrive;
 * the body then streams as gateway events — `http.body` chunks (≤16 KB
 * base64) and a final `http.end` — never a blocking whole-result (D8).
 * Failures after the settle ride `http.error` with a GatewayError code
 * (cancelled / timeout / network); failures before headers settle the call
 * itself. Abort (`httpFetch.abort`, control-plane via __dshGatewayAbort)
 * destroys the in-flight request → stream error code `cancelled`.
 *
 * This is the platform twin of hosts/ios Gateway/HTTPPrimitive.swift (the
 * W-SESS reference implementation) — same settle shape, same chunking, same
 * error codes, so the gateway.js AsyncIterable shim sees one contract.
 */
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';

const CHUNK_LIMIT = 16 * 1024;
const BODY_PREFIX = 'body:';
const CONNECT_TIMEOUT_MS = 15000;
const READ_TIMEOUT_MS = 30000;

interface FetchArgs {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyB64?: string;
}

interface AbortArgs {
  callId?: string | number;
}

interface Inflight {
  request: http.HttpRequest;
  headersJson: string | null;
  status: number;
  settled: boolean;
  aborted: boolean;
  /** Body/end events that arrived before the headers settled: the platform
   * resolves the requestInStream promise only at dataEnd (observed: the full
   * body streams first, the status lands last), so emitting them straight
   * away would hand the shim body chunks for a stream it does not know yet.
   * Queued here and flushed in order right after the settle. */
  pending: string[];
}

export class HttpFetch {
  /** Seam out (HostPhase wires these): settle a gateway call, emit a
   * gateway event into the runtime. */
  settle: (callId: number, ok: boolean, payloadJson: string) => void =
    (callId: number, ok: boolean, payloadJson: string): void => {};
  emit: (eventJson: string) => void = (eventJson: string): void => {};

  private inflight: Map<number, Inflight> = new Map();

  /** The descriptors this implementation serves (6 available / 3 unavailable
   * with fsRead/fsWrite/fsScope/notify/presentApproval — the official-phase
   * v2 posture; the frozen m5 phase keeps its 5/4 descriptor). */
  fetch(callId: number, argsJson: string): void {
    let args: FetchArgs;
    try {
      args = JSON.parse(argsJson) as FetchArgs;
    } catch (e) {
      this.settle(callId, false,
        HttpFetch.errorJson('invalid', 'malformed httpFetch args'));
      return;
    }
    if (args.url === undefined || args.url === null || args.url === '') {
      this.settle(callId, false,
        HttpFetch.errorJson('invalid', 'malformed url'));
      return;
    }
    const request = http.createHttp();
    const state: Inflight = {
      request: request, headersJson: null, status: 0,
      settled: false, aborted: false, pending: [],
    };
    this.inflight.set(callId, state);
    request.on('headersReceive', (value: Object): void => {
      state.headersJson = JSON.stringify(value ?? {});
      this.trySettleHeaders(callId, state);
    });
    request.on('dataReceive', (chunk: ArrayBuffer): void => {
      this.emitChunks(callId, new Uint8Array(chunk));
    });
    request.on('dataEnd', (): void => {
      this.emitForCall(callId,
        JSON.stringify({ 'event': 'http.end', 'callId': callId }));
      this.forget(callId, request);
    });
    const options: http.HttpRequestOptions = {
      method: HttpFetch.methodOf(args.method ?? 'GET'),
      header: HttpFetch.headersObject(args.headers),
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: READ_TIMEOUT_MS,
    };
    if (args.bodyB64 !== undefined && args.bodyB64 !== null) {
      options.extraData = HttpFetch.decodeB64(args.bodyB64).buffer as object as ArrayBuffer;
    }
    request.requestInStream(args.url, options)
      .then((status: number): void => {
        state.status = status;
        this.trySettleHeaders(callId, state);
      })
      .catch((err: Error): void => {
        const code = HttpFetch.errorCode(err, state.aborted);
        if (state.settled) {
          this.emit(JSON.stringify({
            'event': 'http.error', 'callId': callId,
            'code': code, 'message': err.message ?? 'http body failed',
          }));
        } else {
          state.settled = true;
          this.settle(callId, false, HttpFetch.errorJson(code, err.message));
        }
        this.forget(callId, request);
      });
  }

  /** Control-plane abort of the frozen bridge: cancels the in-flight task;
   * idempotent. The target callId arrives as the number `callId`; shims may
   * also pass the response's bodyId string ("body:<callId>"), accepted
   * tolerantly (the iOS primitive's contract). */
  abort(argsJson: string): void {
    let args: AbortArgs;
    try {
      args = JSON.parse(argsJson) as AbortArgs;
    } catch (e) {
      return;
    }
    let target = -1;
    if (typeof args.callId === 'number') {
      target = args.callId;
    } else if (typeof args.callId === 'string' &&
      args.callId.startsWith(BODY_PREFIX)) {
      target = Number(args.callId.substring(BODY_PREFIX.length));
    }
    if (Number.isNaN(target)) {
      return;
    }
    const state = this.inflight.get(target);
    if (state === undefined) {
      return;
    }
    state.aborted = true;
    state.settled = true;
    // The shim closes its stream locally on abort; suppress any later
    // wire events for this call (the stream is already cancelled).
    this.emitForCall(target, JSON.stringify({
      'event': 'http.error', 'callId': target,
      'code': 'cancelled', 'message': 'aborted by the caller',
    }));
    state.request.destroy();
    this.inflight.delete(target);
  }

  /** Settles the moment BOTH headers and status are known (their arrival
   * order is not specified by the platform API). */
  private trySettleHeaders(callId: number, state: Inflight): void {
    if (state.settled || state.headersJson === null || state.status === 0) {
      return;
    }
    state.settled = true;
    const payload = '{"status":' + state.status + ',"headers":' +
      state.headersJson + ',"bodyId":' + JSON.stringify(BODY_PREFIX + callId) + '}';
    this.settle(callId, true, payload);
    // The shim registered the body stream on this settle: replay whatever
    // arrived early, in arrival order (chunks, then http.end).
    const queued = state.pending.splice(0);
    for (let i = 0; i < queued.length; i++) {
      this.emit(queued[i]);
    }
  }

  /** Emits one call-scoped event, or parks it while the call is still
   * unsettled (see Inflight.pending). */
  private emitForCall(callId: number, eventJson: string): void {
    const state = this.inflight.get(callId);
    if (state !== undefined && !state.settled) {
      state.pending.push(eventJson);
      return;
    }
    this.emit(eventJson);
  }

  /** Splits one platform chunk into ≤16 KB `http.body` events (the same
   * chunking contract the iOS primitive pins). */
  private emitChunks(callId: number, bytes: Uint8Array): void {
    const base64 = new util.Base64Helper();
    for (let offset = 0; offset < bytes.length; offset += CHUNK_LIMIT) {
      const end = Math.min(offset + CHUNK_LIMIT, bytes.length);
      const piece = bytes.subarray(offset, end);
      const chunkB64 = base64.encodeToStringSync(piece);
      this.emitForCall(callId, JSON.stringify({
        'event': 'http.body', 'callId': callId, 'chunkB64': chunkB64,
      }));
    }
  }

  private forget(callId: number, request: http.HttpRequest): void {
    request.destroy();
    this.inflight.delete(callId);
  }

  static decodeB64(text: string): Uint8Array {
    const base64 = new util.Base64Helper();
    return base64.decodeSync(text);
  }

  static errorJson(code: string, message?: string): string {
    return '{"code":' + JSON.stringify(code) + ',"primitive":"httpFetch"' +
      ',"message":' + JSON.stringify(message ?? 'http fetch failed') + '}';
  }

  static headersObject(headers: Record<string, string> | undefined): Object {
    const out: Record<string, string> = {};
    if (headers !== undefined) {
      const keys: string[] = Object.keys(headers);
      for (let i = 0; i < keys.length; i++) {
        out[keys[i]] = headers[keys[i]];
      }
    }
    return out;
  }

  static methodOf(name: string): http.RequestMethod {
    if (name === 'POST') {
      return http.RequestMethod.POST;
    }
    if (name === 'PUT') {
      return http.RequestMethod.PUT;
    }
    if (name === 'DELETE') {
      return http.RequestMethod.DELETE;
    }
    if (name === 'HEAD') {
      return http.RequestMethod.HEAD;
    }
    if (name === 'OPTIONS') {
      return http.RequestMethod.OPTIONS;
    }
    if (name === 'TRACE') {
      return http.RequestMethod.TRACE;
    }
    if (name === 'CONNECT') {
      return http.RequestMethod.CONNECT;
    }
    return http.RequestMethod.GET;
  }

  /** GatewayError codes over the wire: cancelled / timeout / network
   * (BusinessError 2300028 is the platform's timeout; an abort surfaces as
   * whatever rejection destroy() produces — the aborted flag decides). */
  static errorCode(err: Error, aborted: boolean): string {
    if (aborted) {
      return 'cancelled';
    }
    const business = err as BusinessError;
    if (business.code === 2300028) {
      return 'timeout';
    }
    const text = err.message ?? '';
    if (text.includes('timeout')) {
      return 'timeout';
    }
    return 'network';
  }
}
