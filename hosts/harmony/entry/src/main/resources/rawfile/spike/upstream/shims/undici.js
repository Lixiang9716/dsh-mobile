// dsh:logging-exempt (shim layer; transport face, no logging surface)
/**
 * undici — the Node HTTP-engine face the vendored dsh-http-proxy and
 * dsh-web-fetch-http dynamic-import ("await import(\"undici\")"). No undici
 * tarball is vendored (a native-ish heavy runtime package), but the egress
 * specs route through `installProxyFromEnvironment` → `setGlobalDispatcher`
 * and assert the in-test PROXY server (a loopback `http.createServer`) saw
 * the request — measurable in-process with no socket (the W3-K loopback
 * design line).
 *
 * The composed surface (measured against both bundles):
 *   - `Agent` ({factory}), `Pool` (origin), `ProxyAgent` ({uri}) — dispatch
 *     markers; `close()` settles (no sockets to release).
 *   - `getGlobalDispatcher` / `setGlobalDispatcher` — the module-level
 *     dispatcher the proxy installer swaps.
 *   - `fetch(input, {dispatcher})` — the engine fetch: a ProxyAgent route
 *     re-dials the PROXY (a loopback server) with the request URL in
 *     absolute-form (what a real HTTP proxy receives, and exactly what the
 *     in-test proxy records — `seen` asserts the target host appears); a
 *     direct route keeps the plain loopback dispatch. No dispatcher →
 *     unchanged fetch behavior.
 *   - `dispatchViaDispatcher` — the hook the runtime fetch calls FIRST so a
 *     `fetch(url)` with no dispatcher option still honors the installed
 *     policy (Node's built-in fetch resolves the global dispatcher).
 * https: proxying (CONNECT tunnels) keeps its real-socket shape and stays
 * unserved: a routed https: target is left to the caller's own fetch
 * behavior (the suite's proxies serve http:). DNS pinning (`connect.lookup`)
 * IS served for loopback answers (W5-S): the pinned address is the
 * connection target, and a loopback pin re-dials the in-test server.
 */

import { dispatchLoopback } from 'upstream/shims/node-http-loopback.js';

const isProxyAgent = (value) => value !== null && typeof value === 'object' && typeof value.uri === 'string';
const isAgentLike = (value) => value !== null && typeof value === 'object' && typeof value.factory === 'function';

/** Resolve one URL's route under a dispatcher:
 * `{ proxy: uri }` (re-dial the proxy), `{ direct: true }` (plain dispatch),
 * or undefined (no routing surface — caller keeps its own behavior). */
const routeFor = (dispatcher, target) => {
  if (isProxyAgent(dispatcher)) return { proxy: dispatcher.uri };
  if (isAgentLike(dispatcher)) {
    let downstream;
    try {
      downstream = dispatcher.factory(new URL(target).origin, dispatcher.options ?? {});
    } catch {
      return undefined;
    }
    if (isProxyAgent(downstream)) return { proxy: downstream.uri };
    return { direct: true };
  }
  // A plain Agent (no factory) carrying a pinning lookup is still a routable
  // direct dispatch — requestPinned's `new Agent({connect: {lookup}})` shape
  // (W5-S); viaPinnedLookup owns the answer.
  if (typeof dispatcher?.options?.connect?.lookup === 'function') return { direct: true };
  return undefined;
};

/** Dispatch through the proxy `uri` with the request line in ABSOLUTE-FORM
 * (the proxy sees the full target URL, not just its path). */
const viaProxy = (proxyUri, targetHref, init) => {
  if (!/^http:/.test(proxyUri)) return undefined; // https: needs a CONNECT tunnel — no socket seam
  return dispatchLoopback(proxyUri, init, { requestUrlOverride: targetHref });
};

/** The pinned-connection face (W5-S): an Agent constructed with
 * `connect.lookup` (dsh-web-fetch-http's requestPinned — DNS pinning, the
 * transport half of the public-network policy) resolves the target hostname
 * through the CALLER-SUPPLIED lookup before connecting. When the pinned
 * answer is a loopback address, the in-test 127.0.0.1 server IS the pinned
 * destination — dispatch the loopback with the hostname rewritten to the
 * resolved address (port/path preserved), so `fetch('http://does-not-
 * resolve.invalid:PORT/')` pinned to 127.0.0.1 serves the in-test handler
 * exactly like the real engine dials the pinned address. Non-loopback
 * answers keep the loud no-network refusal (no egress seam). Returns
 * undefined when no pinning lookup is present or the answer misses. */
const viaPinnedLookup = (dispatcher, target, init) => {
  const lookup = dispatcher?.options?.connect?.lookup;
  if (typeof lookup !== 'function') return undefined;
  let url;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      lookup(url.hostname, {}, (error, address) => {
        if (error !== undefined && error !== null) return done(undefined);
        done(typeof address === 'string' ? address : undefined);
      });
    } catch {
      done(undefined);
    }
  }).then((address) => {
    // The connection phase: a pin answer the dispatch cannot serve is a
    // FAILED CONNECT, not a response-less success — real undici's fetch
    // rejects (TypeError 'fetch failed', cause ECONNREFUSED) and the
    // provider's translateAbortOrNetwork wraps that into
    // WEB_PROVIDER_ERROR. Resolving undefined here made the vendored
    // provider read `.status` of undefined (W8: 'maps a connection failure
    // to WEB_PROVIDER_ERROR').
    const connectRefused = () => {
      const error = new TypeError('fetch failed');
      error.cause = new Error(`connect ECONNREFUSED 127.0.0.1:${url.port === '' ? '80' : url.port}`);
      error.cause.code = 'ECONNREFUSED';
      error.cause.errno = -61;
      error.cause.syscall = 'connect';
      return error;
    };
    if (address === undefined) throw connectRefused();
    const loopback = address === '::1' || address === '127.0.0.1' || address.startsWith('127.');
    if (!loopback || url.protocol !== 'http:') throw connectRefused();
    // Preserve port (may be empty → default 80), path and query; the Host
    // header reports the pinned loopback, which is what the connection
    // target really is in this dispatch.
    const pinnedHref = `http://127.0.0.1${url.port === '' ? '' : `:${url.port}`}${url.pathname}${url.search}`;
    const dispatched = dispatchLoopback(pinnedHref, init);
    if (dispatched === undefined) throw connectRefused();
    return dispatched;
  });
};

/** The engine fetch: `init.dispatcher` wins, else the global dispatcher. */
export const fetch = (input, init = {}) => {
  let target;
  try {
    target = typeof input === 'string' ? input : String(input?.url ?? input);
  } catch {
    return globalThis.fetch(input, init);
  }
  const dispatcher = init?.dispatcher !== undefined ? init.dispatcher : current;
  const route = routeFor(dispatcher, target);
  if (route?.proxy !== undefined) {
    const proxied = viaProxy(route.proxy, target, init);
    if (proxied !== undefined) return proxied;
  }
  // A direct route under a pinning Agent dials the pinned answer first (the
  // loopback serves registered in-test servers; non-loopback pins and
  // unrouted fetches keep the loud refusal below).
  if (route?.direct === true) {
    const pinned = viaPinnedLookup(dispatcher, target, init);
    if (pinned !== undefined) return pinned;
  }
  // Direct routes (and unrouted fetches) keep the runtime fetch: the
  // loopback serves registered in-test servers, everything else fails loud.
  return globalThis.fetch(input, init);
};

/** The runtime fetch's first hook: honor the INSTALLED policy even when the
 * caller passed no dispatcher option (Node's fetch always resolves the
 * global dispatcher). Returns undefined when no proxy route applies. */
export const dispatchViaDispatcher = (input, init = {}) => {
  if (current === undefined || !isProxyAgent(current) && !isAgentLike(current)) return undefined;
  let target;
  try {
    target = typeof input === 'string' ? input : String(input?.url ?? input);
  } catch {
    return undefined;
  }
  const route = routeFor(current, target);
  if (route?.proxy === undefined) return undefined;
  return viaProxy(route.proxy, target, init);
};

/** Base dispatcher: `factory(origin, options)` builds the per-origin client
 * (the proxy package's policy router is exactly such a factory). */
export class Agent {
  constructor(options = {}) {
    this.options = options;
    this.factory = options.factory;
  }
  close() { return Promise.resolve(); }
}

/** A per-origin direct client (unproxied branches of the policy factory). */
export class Pool {
  constructor(origin, options = {}) {
    this.origin = String(origin);
    this.options = options;
  }
  close() { return Promise.resolve(); }
}

/** A proxied client: `uri` is the proxy the route dials. */
export class ProxyAgent {
  constructor(options = {}) {
    this.options = options;
    this.uri = String(options.uri ?? '');
  }
  close() { return Promise.resolve(); }
}

/** The installed global dispatcher (Node's default is its own Agent). */
let current = new Agent();

export const getGlobalDispatcher = () => current;
export const setGlobalDispatcher = (dispatcher) => { current = dispatcher; };

export default { Agent, Pool, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, fetch };
