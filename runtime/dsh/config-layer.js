/**
 * config-layer — the FIRST of the three UI-plugin levels (ARCHITECTURE.md §6
 * "Three plugin levels for the UI"): `cordis.patch.yml`-style LAYERED
 * OVERRIDES consumed by the session/web-client stack. Layers, in override
 * order (later wins):
 *
 *   base (the stack's defaults) → hostFace (launch arguments) → profile
 *   (profiles/<name>/cordis.patch.*) → overlay
 *
 * FORMAT CHOICE, documented: the patch is JSON in the spike, not YAML. The
 * frozen gateway has no parser primitive and the spike vendors no YAML
 * library (D6: no random third-party copies in the audited runtime); the
 * layered-override SEMANTICS under test are format-independent, and the
 * file keeps the cordis.patch name so the swap to YAML at the real profile
 * host is a parse change, not a semantics change.
 *
 * Merge semantics: plain objects merge recursively key by key; every other
 * value (arrays included — a slot ALLOW-LIST is a set, not a merge target)
 * is REPLACED wholesale by the later layer. Resolution reports one trace
 * entry per non-empty layer so the caller can log provenance (event-driven,
 * D8) — the module never logs scenario events itself.
 */
import { createLogger } from 'logger.js';

const log = createLogger('dsh.config-layer');

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** deep-merge `patch` over `base` (objects merge, everything else replaces). */
export const mergePatch = (base, patch) => {
  log.debug('merge patch', { baseKeys: Object.keys(base ?? {}), patchKeys: Object.keys(patch ?? {}) });
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? mergePatch(out[k], v) : v;
  }
  return out;
};

/**
 * Resolve the layered config. `layers` = [{name, patch}] in override order.
 * Returns {config, trace} — trace carries one entry per layer with a
 * non-empty patch, in application order.
 */
export const resolveConfig = (layers) => {
  log.debug('resolve config', { layers: layers.length });
  let config = {};
  const trace = [];
  for (const { name, patch } of layers) {
    if (!isPlainObject(patch) || Object.keys(patch).length === 0) continue;
    config = mergePatch(config, patch);
    trace.push({ layer: name, keys: Object.keys(patch) });
  }
  log.debug('config resolved', { keys: Object.keys(config) });
  return { config, trace };
};

/** The session stack's slot gate: is `id` in the resolved allow-set? */
export const slotAllowed = (config, id) => {
  log.debug('slot gate', { id });
  const allow = config?.slots?.allow;
  return Array.isArray(allow) && allow.includes(id);
};
