// dsh:logging-exempt (shim layer; no logging surface in the hot path)
/**
 * shims/boot-tail-url-mutators.js — the WHATWG hash SETTER the DshURL shim
 * stops short of (W8, 2026-09-29).
 *
 * DshURL (shims/url.js) models `hash` as a getter over the `fragment`
 * field, and `pathname`/`search` as plain instance fields — so component
 * MUTATION through the WHATWG setter face (`url.hash = ''`) throws
 * `TypeError: no setter for property` (ESM strict mode) on the getter-only
 * accessor. The vendored client-connection's authenticatedUrl() composes
 * the clean application root exactly that way — pathname/search/hash
 * assignments then a searchParams.set — and the gateway host suite's HTTP
 * dispatch arm dies on the hash assignment (url.js is outside this
 * worker's file lease, so the face completes here, on the SAME prototype
 * the web-fetch-forms URLSearchParams view already extends).
 *
 * WHATWG semantics: '' clears the fragment; any other value stores '#' +
 * value-without-leading-'#' — the internal fragment field already carries
 * the leading '#', which the existing hash getter serializes unchanged.
 * An existing setter (a later url.js face) is never shadowed.
 *
 * Mounting: buffer.js and node-child-process.js (both in-lease) import this
 * module, which puts it on the leg boot's import chain — and its install
 * runs DEFERRED (microtask), because buffer.js is evaluated by
 * web-shims.js's own top-of-file imports, BEFORE web-shims's body pins
 * globalThis.URL (the URL stanza sits a dozen lines below the Buffer one).
 * An eager install would run once, see no URL, and the module's
 * single-evaluation cache would make it a permanent no-op (measured W8:
 * the first gateway.host rerun still threw 'no setter'). The microtask
 * drains after the whole import graph — the URL pin included — and long
 * before any vendored code executes.
 */
const installHashSetter = () => {
  const proto = globalThis.URL?.prototype;
  if (proto === undefined || proto === null) return false;
  const existing = Object.getOwnPropertyDescriptor(proto, 'hash');
  if (existing === undefined) return false;
  if (existing.set !== undefined) return true;
  Object.defineProperty(proto, 'hash', {
    get: existing.get,
    set(value) {
      const text = String(value);
      this.fragment = text === '' ? '' : `#${text.replace(/^#/, '')}`;
    },
    configurable: true,
    enumerable: existing.enumerable === true,
  });
  return true;
};

queueMicrotask(() => { installHashSetter(); });
