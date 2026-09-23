// dsh:logging-exempt (node-side test vehicle: its stderr is diagnostics only)
/**
 * parity-node-gateway — the NODE httpFetch bridge for the parity reference
 * leg. The reference imports the REAL gateway transport adapter
 * (upstream/llm-transport.js) so both legs execute the SAME wire/SSE/translate
 * code; this module is the only Node-side substitution, standing where the
 * quickjs gateway primitive stands: one httpFetch over the loopback mock,
 * streaming body, abortable.
 *
 * Shape contract (what llm-transport consumes):
 *   httpFetch(url, { method, headers, body: Uint8Array })
 *     -> { status, headers?, body: AsyncIterable<Uint8Array>, abort() }
 */
export async function httpFetch(url, options = {}) {
  const controller = new AbortController();
  const headers = { ...options.headers };
  // Node's undici lowercases its own header names; keep ours as given (the
  // mock server reads them case-insensitively — same as the gateway).
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body instanceof Uint8Array ? options.body : options.body,
    signal: controller.signal,
    // Node fetch forbids some headers in browsers-only worlds; none used here.
  }).catch((error) => {
    throw Object.assign(new Error(`node httpFetch to ${url} failed: ${error?.message ?? error}`), { cause: error });
  });

  async function* body() {
    for await (const chunk of response.body) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    }
  }

  return {
    status: response.status,
    headers: response.headers,
    body: body(),
    abort: () => controller.abort(),
  };
}
