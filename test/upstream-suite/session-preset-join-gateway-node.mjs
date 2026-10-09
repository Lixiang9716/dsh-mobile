// dsh:logging-exempt (test adapter: no logging surface of its own)
/**
 * session-preset-join-gateway-node.mjs — the gateway face the session-
 * preset-join hooks serve to our upstream layer: the REAL gateway shim's
 * exports with httpFetch replaced by a real-fetch bridge (the
 * ci/parity-node-gateway.mjs contract: one httpFetch over the loopback
 * capture server, streaming body, abortable). The explicit named export
 * wins over the star, so only the C-host seam is substituted.
 */
export async function httpFetch(url, options = {}) {
  const controller = new AbortController();
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: { ...options.headers },
    body: options.body,
    signal: controller.signal,
  }).catch((error) => {
    throw Object.assign(new Error(`node httpFetch to ${url} failed: ${error?.message ?? error}`), { cause: error });
  });
  async function* body() {
    for await (const chunk of response.body) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    }
  }
  return { status: response.status, headers: response.headers, body: body(), abort: () => controller.abort() };
}

export * from '../../runtime/dsh/gateway.js';
