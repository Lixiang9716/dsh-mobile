/**
 * freshness-store — the freshness anchor's DATA-PLANE half: the monotonic
 * `generatedAt` floor of the marketplace resolver (marketplace.js's
 * `anchor` parameter), persisted through the gateway's EXISTING fsRead/
 * fsWrite in one app-scope file. The catalog-replay defense (threat model
 * surface "marketplace supply chain — catalog freshness", the HIGH finding
 * the security.manifest-forgery leg pinned): the client remembers the
 * newest catalog publication it has ever accepted and never accepts an
 * older one, so a replayed stale-but-valid index — a compromised mirror
 * serving what the publisher once published — refuses even though its
 * signature honestly verifies.
 *
 * Deliberately NOT the keychain (the floor is not a secret — it is an
 * observed-publication watermark the device's own data plane already
 * protects), and deliberately NO new gateway primitive: the anchor is a
 * plain app-scope file, the same plane the installer's receipts live on.
 * The resolver stays carrier-neutral: it takes `{load, save}` as a
 * parameter exactly like `fetchImpl`; this module is the gateway wiring
 * a CLI/carrier scenario or embed passes.
 *
 * ABSENT vs UNREADABLE (the io face): on every host the `io` code covers
 * BOTH "path does not exist" and "exists but could not be read" — the
 * contract offers no second code, only the message distinguishes
 * (contract/primitives.md, filesystem additions v1.1.0). Believing io ==
 * absent would silently RESET the floor on a permission fault or a
 * transient EIO — reopening the replay window the anchor exists to close
 * — so load() never takes io as first contact on faith. Where the host
 * answers `fsStat` (the CLI smoke backend and the device gateways:
 * a missing path is `kind: "other"`, never a rejection — main_cli.c
 * smoke_fs_stat), absence is PROVEN: stat says the file is not there →
 * first contact (null); stat says `kind: "file"` while the read failed →
 * a live fault and a LOUD throw (fail loud, rule 5). Where even the stat
 * rejects io (the contract text's own missing-shape — host shapes differ),
 * absence is unprovable: the reset still happens but at WARN level
 * (warn survives release builds — the DSH_RELEASE rule), so a reset is
 * never silent. The one case no code can catch: an anchor DELETED by a
 * local actor is indistinguishable from never-saved — a local actor owns
 * the data plane by the threat model's own partition (the same trust
 * class as the installer's receipts), and it rides the same warn.
 *
 * Fail-loud (rule 5): a PRESENT but corrupt/unparsable anchor throws; a
 * present-but-unreadable one throws (where the stat can prove presence);
 * a missing file is the null case — proven or warned, never silent. A
 * fresh client is never bricked.
 */
import { createLogger } from 'logger.js';
import { fsRead, fsStat, fsWrite } from 'gateway.js';

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

/** The io read was NOT first contact on faith: consult the host's stat
 * (see "ABSENT vs UNREADABLE" above). stat `kind: "file"` while the read
 * failed → present-but-unreadable, LOUD throw. stat missing (kind
 * "other") → proven absent, null (debug — a clean first contact). stat
 * itself rejecting io → absence unprovable on this host shape → null but
 * WARNed (a reset is never silent; warn survives release builds). */
const proveAbsentOrWarn = async (scope, readErr) => {
  log.debug('freshness anchor read failed as io — consulting the stat', {
    scope, path: ANCHOR_PATH, reason: String(readErr?.message ?? readErr),
  });
  let st = null;
  try {
    st = await fsStat(scope, ANCHOR_PATH);
  } catch (statErr) {
    if (statErr?.code !== 'io') throw statErr; // unknown codes are fatal
  }
  if (st !== null && st.kind === 'file') {
    throw new Error(`freshness anchor is present but unreadable (${ANCHOR_PATH}):`
      + ` ${readErr?.message ?? readErr} — failing loud rather than silently`
      + ' resetting the floor (a reset would reopen the replay window)');
  }
  if (st !== null) {
    // the host's stat ANSWERED: kind "other" is its missing shape
    // (main_cli.c smoke_fs_stat — the device gateways' own answer).
    log.debug('freshness anchor proven absent (stat kind "other") — first contact',
      { scope, path: ANCHOR_PATH });
    return null;
  }
  log.warn('freshness anchor unreadable and unstatable — resetting the floor'
    + ' to null WITHOUT proof of absence (this host shape cannot distinguish'
    + ' absent from unreadable; a local fault here re-anchors on the next'
    + ' refresh — see the module header)', { scope, path: ANCHOR_PATH });
  return null;
};

/**
 * Build the gateway-backed freshness anchor: `{load, save}` for
 * marketplace.js's createResolver. `scope` defaults to 'app'.
 *   load() → the persisted floor (ISO string) or null on first contact
 *            (absent proven where the host stats — see proveAbsentOrWarn)
 *   save(iso) → persist `iso` as the new floor (overwrites)
 */
export const createFreshnessAnchor = ({ scope = 'app' } = {}) => {
  log.debug('freshness anchor built', { scope, path: ANCHOR_PATH });
  return {
    load: async () => {
      log.debug('freshness floor load', { scope, path: ANCHOR_PATH });
      let bytes;
      try {
        bytes = (await fsRead(scope, ANCHOR_PATH)).bytes;
      } catch (err) {
        if (err?.code !== 'io') throw err; // unknown codes are fatal (d.ts)
        return await proveAbsentOrWarn(scope, err);
      }
      return parseAnchor(bytes);
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
