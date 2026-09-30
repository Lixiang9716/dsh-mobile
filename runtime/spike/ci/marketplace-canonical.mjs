// dsh:logging-exempt (node-side driver support: console/error IS the product)
/**
 * marketplace-canonical.mjs — the node-side copy of the resolver's
 * canonicalJson (runtime/spike/marketplace-resolver.js exports it, but the
 * runtime module's bare `logger.js` import is unresolvable under plain
 * node). This copy exists ONLY for the node-side test vehicles
 * (mock-market-server.mjs signs the catalog; the runtime's pure-JS verifier
 * must agree).
 *
 * DRIFT DISCIPLINE: if this copy and the resolver's canonical form ever
 * diverge, the e2e leg goes red at the signature check — the signature IS
 * the drift detector (the same oracle discipline as test/panel). Never
 * "fix" a signature mismatch here without fixing the resolver, or vice
 * versa: the two must stay byte-identical.
 */
export const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
};
