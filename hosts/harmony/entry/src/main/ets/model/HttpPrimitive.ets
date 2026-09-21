// dsh:logging-exempt (hilog here is drive/progress evidence only; canonical
// E2E lines route through the HostPhase phase sink — ONE writer)
/**
 * HttpPrimitive — the httpFetch capability primitive (contract/primitives.md
 * §4) over @ohos.net.http requestInStream. Platform sibling of
 * hosts/android/app/src/main/java/com/dshmobile/spike/HttpPrimitive.kt.
 *
 * The gateway call settles `{status, headers, bodyId: <callId>}` when the
 * response HEADERS arrive; the body then streams onto the runtime queue as
 * bridge events — `http.body` chunks (capped at CHUNK_LIMIT raw bytes,
 * base64) and a final `http.end` — one event sequence, never a blocking
 * whole-result (D8). Failures after the settle ride `http.error` with a
 * GatewayError code (cancelled / network); failures before headers settle
 * the call itself. abort() destroys the in-flight request for real: the
 * abort dispatch carries the numeric bodyId (== the gateway call id, the
 * bridge's abort seam parses it back out of the body id), so a generic
 * streaming consumer can cancel a download mid-body.
 *
 * Threading: every @ohos.net.http callback lands on the ArkTS main thread —
 * the ONE serial JS runtime thread (ARCHITECTURE.md §6); chunk events
 * re-enter JS through the HostPhase sink exactly like the carrier WS frames
 * do, never from a second thread.
 */
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'dsh.app';

/** Largest raw body chunk per http.body event: the hostEvent bridge buffer
 * is 8 KB and each chunk travels base64 (4/3 growth), so stay well under. */
const CHUNK_LIMIT: number = 4 * 1024;

interface FetchArgs {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyB64?: string;
}

/** (callId, payloadJson, ok) — HostPhase.settleCall's shape. */
export type SettleFn = (callId: number, payloadJson: string, ok: boolean) => void;

/** One bridge event line into the runtime queue (HostPhase.deliverEvent). */
export type DeliverFn = (eventJson: string) => void;

function methodOf(name: string | undefined): http.RequestMethod {
  switch (name) {
    case 'POST':
      return http.RequestMethod.POST;
    case 'PUT':
      return http.RequestMethod.PUT;
    case 'DELETE':
      return http.RequestMethod.DELETE;
    case 'HEAD':
      return http.RequestMethod.HEAD;
    case 'OPTIONS':
      return http.RequestMethod.OPTIONS;
    case 'PATCH':
      return http.RequestMethod.PATCH;
    default:
      return http.RequestMethod.GET;
  }
}

function errJson(code: string, message: string): string {
  return '{"code":"' + code + '","primitive":"httpFetch","message":"' +
    message + '"}';
}

export class HttpPrimitive {
  private clients: Map<number, http.HttpRequest> = new Map();
  private aborted: Set<number> = new Set();
  /** Body events that arrived before the settle rode out (loopback bodies
   * can beat the requestInStream promise). Flushed in order right after the
   * settle, so the JS side always sees settle → chunks → end. */
  private queued: Map<number, string[]> = new Map();
  private settled: Set<number> = new Set();

  /** One httpFetch dispatch: open, settle at headers, stream the body. */
  fetch(callId: number, argsText: string, settle: SettleFn,
    deliver: DeliverFn): void {
    hilog.info(0x0000, TAG, 'httpFetch: open call %{public}d', callId);
    let args: FetchArgs = {};
    let parsed = true;
    try {
      args = JSON.parse(argsText) as FetchArgs;
    } catch (e) {
      parsed = false;
    }
    if (!parsed || args.url === undefined || args.url.length === 0) {
      settle(callId, errJson('invalid', 'missing or malformed url'), false);
      return;
    }
    const client = http.createHttp();
    this.clients.set(callId, client);
    const headers: Record<string, string> = {};
    client.on('headersReceive', (value: Object): void => {
      const plain = JSON.parse(JSON.stringify(value)) as Record<string, string>;
      const keys: string[] = Object.keys(plain);
      for (let i = 0; i < keys.length; i++) {
        headers[keys[i]] = plain[keys[i]];
      }
    });
    client.on('dataReceive', (chunk: ArrayBuffer): void => {
      this.deliverChunk(callId, new Uint8Array(chunk), deliver);
    });
    client.on('dataEnd', (): void => {
      hilog.info(0x0000, TAG, 'httpFetch: body end call %{public}d', callId);
      this.deliverOrQueue(callId, '{"event":"http.end","callId":' + callId + '}',
        deliver);
    });
    const options: http.HttpRequestOptions = {
      method: methodOf(args.method),
      header: args.headers,
      connectTimeout: 10000,
      readTimeout: 15000,
    };
    if (args.bodyB64 !== undefined && args.bodyB64.length > 0) {
      options.extraData = this.decode(args.bodyB64).buffer as object as ArrayBuffer;
    }
    client.requestInStream(args.url, options).then((code: number): void => {
      hilog.info(0x0000, TAG, 'httpFetch: headers call %{public}d status %{public}d',
        callId, code);
      settle(callId, '{"status":' + code + ',"headers":' +
        JSON.stringify(headers) + ',"bodyId":' + callId + '}', true);
      this.flushQueued(callId, deliver);
      this.cleanup(callId);
    }).catch((err: BusinessError): void => {
      const cancelled = this.aborted.delete(callId);
      hilog.error(0x0000, TAG, 'httpFetch: failed call %{public}d: %{public}s',
        callId, err.message ?? 'unknown');
      if (!this.settled.has(callId)) {
        settle(callId, errJson(cancelled ? 'cancelled' : 'network',
          err.message ?? 'request failed'), false);
      }
      this.cleanup(callId);
    });
  }

  /** httpFetch.abort dispatch: destroy the in-flight request. Idempotent —
   * an unknown or finished body id has nothing to cancel. */
  abort(targetCallId: number): void {
    hilog.info(0x0000, TAG, 'httpFetch: abort call %{public}d', targetCallId);
    this.aborted.add(targetCallId);
    const client = this.clients.get(targetCallId);
    if (client !== undefined) {
      client.destroy();
      this.clients.delete(targetCallId);
    }
  }

  private deliverChunk(callId: number, chunk: Uint8Array, deliver: DeliverFn): void {
    if (this.aborted.has(callId)) {
      return; // post-abort residue: the consumer is already cancelled
    }
    for (let at = 0; at < chunk.length; at += CHUNK_LIMIT) {
      const end = Math.min(at + CHUNK_LIMIT, chunk.length);
      const slice = chunk.slice(at, end);
      const b64 = new util.Base64Helper().encodeToStringSync(slice);
      this.deliverOrQueue(callId,
        '{"event":"http.body","callId":' + callId + ',"chunkB64":"' + b64 + '"}',
        deliver);
    }
  }

  /** Before the settle rides, queue; after, deliver straight to the queue
   * door (the JS runtime re-drives synchronously per event). */
  private deliverOrQueue(callId: number, eventJson: string, deliver: DeliverFn): void {
    if (this.settled.has(callId)) {
      deliver(eventJson);
      return;
    }
    const lines = this.queued.get(callId);
    if (lines === undefined) {
      this.queued.set(callId, [eventJson]);
    } else {
      lines.push(eventJson);
    }
  }

  /** Settle-side flush: deliver everything the body raced ahead of. */
  private flushQueued(callId: number, deliver: DeliverFn): void {
    this.settled.add(callId);
    const lines = this.queued.get(callId);
    this.queued.delete(callId);
    if (lines === undefined) {
      return;
    }
    for (let i = 0; i < lines.length; i++) {
      deliver(lines[i]);
    }
  }

  private decode(b64: string): Uint8Array {
    const decoder = new util.Base64Helper();
    return decoder.decodeSync(b64);
  }

  private cleanup(callId: number): void {
    this.queued.delete(callId);
    this.settled.delete(callId);
    const client = this.clients.get(callId);
    if (client !== undefined) {
      client.destroy();
      this.clients.delete(callId);
    }
  }
}
