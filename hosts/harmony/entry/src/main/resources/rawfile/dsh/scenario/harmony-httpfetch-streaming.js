// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * harmony-httpfetch-streaming.js — the on-device proof of the harmony httpFetch v2
 * streaming bridge (decision D9 W-HARMONY; scenario harmony.httpfetch-streaming).
 *
 * The platform gap this closes: harmony declared httpFetch honestly
 * `unavailable` through the M5 binding descriptor while iOS/Android stream
 * real bodies (hosts/ios Gateway/HTTPPrimitive.swift is the reference). The
 * ArkTS capability layer now serves httpFetch over @ohos.net.http
 * requestInStream — headers settle the call, the body streams as
 * http.body/http.end events keyed by bodyId, abort answers `cancelled`.
 *
 * The proof fetches the LIVE carrier's own loopback origin (the official
 * dist entry chunk — real bytes, many chunks, no external network), plus
 * the control-plane abort and the connection-refused legs:
 *
 *   host → runtime : {"event":"host.info","port":<carrier port>}
 *   runtime → log  : descriptor.declared / http.headers /
 *                    http.body.streamed / http.aborted / http.refused
 *
 * Asserts are demand-loud: any mismatch fails the scenario verdict.
 */
import { createLogger } from 'logger.js';
import { GatewayError, httpFetch, onEvent } from 'gateway.js';

const SCENARIO = 'harmony.httpfetch-streaming';
const log = createLogger('b1.http');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });

const fail = (reason) => {
  const error = reason instanceof Error ? reason : null;
  const message = error ? error.message : String(reason);
  log.debug('scenario failed', { reason: message });
  emit('scenario.failed', { reason: message });
  globalThis.__dshComplete(false, message);
};

const demand = (ok, why) => {
  if (!ok) throw new Error(`demand failed: ${why}`);
};

/** The vendored official dist's entry chunk (pinned by MANIFEST.sha256 —
 * the deterministic first fetch the b1 manifests pin as asset.served). */
const ENTRY_CHUNK = '/assets/index-8VXBH-f-.js';

const drainBody = async (res) => {
  let chunks = 0;
  let bytes = 0;
  for await (const chunk of res.body) {
    chunks += 1;
    bytes += chunk.length;
  }
  return { chunks, bytes };
};

/** Leg 1: headers settle, then the body streams in chunks. */
const proveStreaming = async (url) => {
  const res = await httpFetch(url);
  demand(res.status === 200, `streaming status ${res.status}`);
  emit('http.headers', { status: res.status, bodyStream: true });
  const streamed = await drainBody(res);
  demand(streamed.bytes > 0, 'streaming body was empty');
  demand(streamed.chunks > 1, `expected multiple streamed chunks, got ${streamed.chunks}`);
  emit('http.body.streamed', {
    chunks: streamed.chunks,
    bytes: streamed.bytes,
    streaming: true,
  });
};

/** Leg 2: cancel right after the headers; the body stream rejects with the
 * GatewayError `cancelled` code. */
const proveAbort = async (url) => {
  const aborted = await httpFetch(url);
  aborted.abort();
  try {
    await drainBody(aborted);
    demand(false, 'aborted body drained without error');
  } catch (e) {
    demand(e instanceof GatewayError, `abort rejection type ${typeof e}`);
    demand(e.code === 'cancelled', `abort code ${e.code}`);
    emit('http.aborted', { code: e.code, cancelled: e.code === 'cancelled' });
  }
};

/** Leg 3: a closed loopback port rejects before headers with a structured
 * GatewayError (never a hang). */
const proveRefused = async () => {
  try {
    await httpFetch('http://127.0.0.1:1/nope');
    demand(false, 'connection to a closed port succeeded');
  } catch (e) {
    demand(e instanceof GatewayError, `refused rejection type ${typeof e}`);
    emit('http.refused', { code: e.code });
  }
};

const main = async (port) => {
  log.debug('main begin', { port });
  const descriptor = JSON.parse(globalThis.__dshGatewayDescriptor());
  demand(descriptor.available.length === 6, 'expected 6 available primitives');
  demand(descriptor.unavailable.length === 3, 'expected 3 unavailable primitives');
  demand(descriptor.unavailable.includes('httpFetch') === false,
    'httpFetch must be available under the v2 descriptor');
  emit('descriptor.declared', {
    available: descriptor.available.length,
    unavailable: descriptor.unavailable.length,
  });

  const url = `http://127.0.0.1:${port}${ENTRY_CHUNK}`;
  await proveStreaming(url);
  await proveAbort(url);
  await proveRefused();

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'pass');
};

let started = false;
onEvent((ev) => {
  if (ev.event === 'host.info' && !started) {
    started = true;
    main(ev.port).catch(fail);
  }
});
