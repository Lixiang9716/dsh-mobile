/**
 * freshness-store — the freshness anchor's DATA-PLANE half: the monotonic
 * `generatedAt` floor of the marketplace resolver (marketplace.js's
 * `anchor` parameter), persisted through the gateway's EXISTING
 * fsRead/fsWrite in one app-scope file. The catalog-replay defense
 * (threat model surface "marketplace supply chain — catalog freshness",
 * the HIGH finding the security.manifest-forgery leg pinned): the client
 * remembers the newest catalog publication it has ever accepted and never
 * accepts an older one, so a replayed stale-but-valid index — a
 * compromised mirror serving what the publisher once published — refuses
 * even though its signature honestly verifies.
 *
 * Deliberately NOT the keychain (the floor is not a secret — it is an
 * observed-publication watermark the device's own data plane already
 * protects), and deliberately NO new gateway primitive: the anchor is a
 * plain app-scope file, the same plane the installer's receipts live on.
 * The resolver stays carrier-neutral: it takes `{load, save}` as a
 * parameter exactly like `fetchImpl`; this module is the gateway wiring
 * a CLI/carrier scenario or embed passes.
 *
 * Fail-loud (rule 5): a MISSING anchor file is first contact (load
 * resolves null — a fresh client is never bricked); a PRESENT but
 * corrupt/unparsable one throws — silently resetting the floor would
 * reopen the replay window the anchor exists to close.
 */
import { createLogger } from 'logger.js';
import { fsRead, fsWrite } from 'gateway.js';

const log = createLogger('dsh.freshness');

/** The anchor document's path inside the app scope (one marketplace per
 * host embed — the file IS the marketplace's publication watermark). */
const ANCHOR_PATH = 'marketplace/freshness-anchor.json';

const textBytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const toText = (bytes) => [...bytes].map((c) => String.fromCharCode(c)).join('');

/** The floor as an ISO string, or null on first contact. A present-but
 * invalid anchor aborts loud (a silently dropped floor reopens the replay
 * window); the io error of a missing file is the null case. */
const parseAnchor = (bytes) => {
  log.debug('freshness anchor parse', { bytes: bytes.length });
  let doc;
  try {
    doc = JSON.parse(toText(bytes));
  } catch (err) {
    throw new Error(`freshness anchor is not valid JSON (${ANCHOR_PATH}): ${err}`);
  }
  if (!doc || typeof doc !== 'object' || doc.schemaVersion !== 1
    || typeof doc.generatedAt !== 'string'
    || Number.isNaN(Date.parse(doc.generatedAt))) {
    throw new Error(`freshness anchor is malformed (${ANCHOR_PATH}):`
      + ' expected {"schemaVersion":1,"generatedAt":"<ISO>"}');
  }
  return doc.generatedAt;
};

/**
 * Build the gateway-backed freshness anchor: `{load, save}` for
 * marketplace.js's createResolver. `scope` defaults to 'app'.
 *   load() → the persisted floor (ISO string) or null on first contact
 *   save(iso) → persist `iso` as the new floor (overwrites)
 */
export const createFreshnessAnchor = ({ scope = 'app' } = {}) => {
  log.debug('freshness anchor built', { scope, path: ANCHOR_PATH });
  return {
    load: async () => {
      log.debug('freshness floor load', { scope, path: ANCHOR_PATH });
      try {
        return parseAnchor((await fsRead(scope, ANCHOR_PATH)).bytes);
      } catch (err) {
        if (err?.code === 'io') return null; // first contact — no anchor yet
        throw err;
      }
    },
    save: async (generatedAt) => {
      log.debug('freshness floor save', { scope, generatedAt });
      if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) {
        throw new Error(`freshness floor must be an ISO timestamp: ${JSON.stringify(generatedAt)}`);
      }
      await fsWrite(scope, ANCHOR_PATH, textBytes(JSON.stringify({
        schemaVersion: 1,
        generatedAt,
      })));
      return generatedAt;
    },
  };
};
