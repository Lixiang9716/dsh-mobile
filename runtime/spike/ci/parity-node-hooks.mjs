// dsh:logging-exempt (loader plumbing: no logging surface of its own)
/**
 * parity-node-hooks — the module-resolution redirect that lets the Node
 * reference leg import the REAL gateway transport adapter verbatim.
 *
 * upstream/llm-transport.js imports `../gateway.js` (the quickjs gateway
 * seam). Under Node that specifier would load the quickjs shim, which needs
 * the C host bridge. This resolve hook redirects EXACTLY that one specifier
 * — imported from a file under runtime/spike/upstream/ — to the Node
 * httpFetch bridge (ci/parity-node-gateway.mjs). Everything else resolves
 * normally through the vendor node_modules layout (ci/parity-node-modules.sh).
 *
 * The redirect is deliberately narrow: any other file importing gateway.js
 * (the system plugins, the scenario drivers) still resolves the real shim,
 * so a stray import surfaces as a loud runtime error instead of silently
 * receiving the bridge.
 */
const GATEWAY_SPECIFIER = '../gateway.js';
const UPSTREAM_DIR_MARK = '/runtime/spike/upstream/';
const BRIDGE_URL = new URL('./parity-node-gateway.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === GATEWAY_SPECIFIER && typeof context.parentURL === 'string'
    && context.parentURL.includes(UPSTREAM_DIR_MARK)) {
    return { url: BRIDGE_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
