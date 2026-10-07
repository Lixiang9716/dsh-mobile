// dsh:logging-exempt (node-side driver)
/**
 * api.js — the POST /api envelope bridge (docs/webserver-contract.md §2.3).
 * PORTED from presentation/web-client-v2/web/js/api.js — not rewritten.
 * Deltas from the browser original, all transport-level only:
 *   - the base URL is a constructor parameter (the driver is not same-origin)
 *   - Node 24 global fetch; no token-cookie handling (the dev carrier's
 *     ?token= redirect is a browser surface — loopback driver↔serve pairs
 *     carry no auth, matching run-mock/mock-serve)
 * The envelope itself is UNMOVED: request {type:'client-request', rpcId,
 * method, payload}; response {type:'server-response', rpcId, result:
 * {ok,value}|{ok,error:{code,message,details}}}.
 */

let rpcCounter = 0;

const mintRpcId = () => `rpc-${Date.now().toString(36)}-${rpcCounter++}`;

/** The wire error triple, thrown by failed RPCs. */
export function RemoteError(code, message, details = {}) {
  this.code = code;
  this.message = message;
  this.details = details;
}
RemoteError.prototype = Object.create(Error.prototype);

export const isRemoteError = (value) => value instanceof RemoteError;

/** One unary RPC. Resolves the ok value; throws the structured error.
 * `payload` defaults to {} — the envelope contract requires the KEY to be
 * present, and JSON.stringify drops an undefined value silently. */
export const makeRpc = (baseUrl) => async function rpc(method, payload = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: mintRpcId(), method, payload,
      }),
    });
  } catch (cause) {
    throw new RemoteError('gateway/unavailable', `transport failed: ${cause}`);
  }
  if (!response.ok) {
    throw new RemoteError('gateway/unavailable', `HTTP ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw new RemoteError('gateway/bad-response', `malformed body: ${cause}`);
  }
  if (body?.type !== 'server-response' || body.rpcId === undefined
    || typeof body.result !== 'object' || body.result === null) {
    throw new RemoteError('gateway/bad-response', 'unexpected envelope shape');
  }
  const { ok, value, error } = body.result;
  if (ok === true) return value;
  throw new RemoteError(
    error?.code ?? 'gateway/unknown',
    error?.message ?? 'unknown error',
    error?.details ?? {},
  );
};
