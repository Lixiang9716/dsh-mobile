// dsh:logging-exempt (shim layer; transport face, no logging surface)
/**
 * openai-client — the composed `openai` SDK face the vendored
 * @earendil-works/pi-ai lazy api modules dynamic-import at LIVE-TRANSPORT
 * build time (`import OpenAI from "openai"` in dist/api/openai-completions.js
 * and openai-responses.js). Before the in-process loopback (node-http-loopback
 * .js, W3-K) the suite never reached a live transport, so the bare specifier
 * stayed unserved by design; the loopback made every streaming pi-ai test
 * reach `new OpenAI(...)` and die on "unmapped module specifier 'openai'".
 *
 * There is no vendored openai tarball (the heavy SDK was deliberately left
 * unfetched — npm-bridges.js round 5 note), so this is a COMPOSED face over
 * the runtime's own fetch: the loopback dispatch serves in-test servers, and
 * anything else keeps fetch's fail-loud network rejection. Only the surface
 * the pinned pi-ai 0.85.1 dist touches is implemented (measured against the
 * vendored dist):
 *   - `new OpenAI({ apiKey, baseURL, fetch, defaultHeaders, dangerouslyAllowBrowser })`
 *   - `client.chat.completions.create(params, {signal, timeout, maxRetries})`
 *   - `client.responses.create(params, {signal, timeout, maxRetries})`
 *   - the create() return is a thenable with `.withResponse()` →
 *     `{ data, response: { status, headers } }` (headersToRecord iterates
 *     `headers.entries()`, so the response headers face is the shim Headers)
 *   - `params.stream: true` → data is an async iterable of parsed SSE `data:`
 *     payloads; `[DONE]` ends the stream (the SDK's SSEDecoder contract)
 *   - non-2xx → throws with the SDK's error-field shapes pi-ai probes:
 *     `.status` (number) + `.error` (parsed body) + `.message`
 *     (utils/error-body.js extractStatus/extractBody order).
 * `timeout`/`maxRetries` are accepted and inert (the runtime keeps no
 * wall-clock seam and pi-ai passes `maxRetries: 0` expecting NO sdk retry).
 */

/** Read the SSE byte stream into parsed data payloads ('[DONE]' excluded —
 * it terminates). Line reassembly tolerates splits anywhere; multi-line
 * `data:` fields rejoin with \n (the SSE spec the SDK implements). */
async function* ssePayloads(body) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf('\n\n');
      while (at >= 0) {
        const event = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = event.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data.length === 0) {
          at = buffer.indexOf('\n\n');
          continue;
        }
        if (data === '[DONE]') return;
        yield JSON.parse(data);
        at = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** The create() return: a thenable carrying `.withResponse()` — pi-ai always
 * calls `.withResponse()` and destructures `{ data, response }`. */
function apiPromise(settled) {
  return {
    then: (onFulfilled, onRejected) => settled.then(({ data }) => data).then(onFulfilled, onRejected),
    catch: (onRejected) => settled.then(({ data }) => data).catch(onRejected),
    finally: (onFinally) => settled.then(({ data }) => data).finally(onFinally),
    withResponse: () => settled,
  };
}

/** One wire request: the loopback (or fail-loud) fetch, JSON body, the
 * SDK's header order (auth FIRST, caller defaultHeaders LAST so profile
 * headers win — the pi-ai attribution test asserts exactly that), and the
 * non-2xx → status/error/message throw. */
async function wireRequest(client, path, params, options) {
  const doFetch = client.fetchImpl();
  const headers = {
    ...(client.apiKey ? { authorization: `Bearer ${client.apiKey}` } : {}),
    'content-type': 'application/json',
    ...client.defaultHeaders,
  };
  const init = {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    ...(options?.signal ? { signal: options.signal } : {}),
  };
  const response = await doFetch(`${client.baseURL}${path}`, init);
  if (!response.ok) {
    const raw = await response.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    const bodyMessage = parsed?.error?.message;
    const error = new Error(typeof bodyMessage === 'string' && bodyMessage.length > 0
      ? bodyMessage
      : `${response.status} ${response.statusText ?? ''}`.trim());
    error.status = response.status;
    error.error = parsed;
    throw error;
  }
  const status = response.status;
  const responseHeaders = new Headers(Object.fromEntries([...response.headers.entries()].map(([k, v]) => [k, String(v)])));
  if (params?.stream === true) {
    const data = ssePayloads(response.body);
    return { data, response: { status, headers: responseHeaders, statusText: response.statusText } };
  }
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { data, response: { status, headers: responseHeaders, statusText: response.statusText } };
}

/** The path each namespace appends: the SDK builds `${baseURL}/chat/completions`
 * and `${baseURL}/responses` verbatim (the suite's mock servers assert the
 * joined paths, e.g. `/v1/responses`). */
const ENDPOINTS = {
  chat: '/chat/completions',
  responses: '/responses',
};

export class OpenAI {
  constructor(options = {}) {
    this.apiKey = options.apiKey;
    this.baseURL = String(options.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.defaultHeaders = options.defaultHeaders ?? {};
    // The injected fetch is read at CALL time (the suite may stub the global
    // per test); the loopback dispatch is the served transport.
    this.fetchImpl = () => options.fetch ?? globalThis.fetch;
    this.chat = { completions: this.#namespace(OpenAI, 'chat') };
    this.responses = this.#namespace(OpenAI, 'responses');
  }
  #namespace(_priv, kind) {
    const client = this;
    return {
      create: (params, options) => apiPromise(wireRequest(client, ENDPOINTS[kind], params, options)),
    };
  }
}

export default OpenAI;
