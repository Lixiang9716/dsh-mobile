// dsh:logging-exempt (loader plumbing: no logging surface of its own)
/**
 * fs-watch-idle-hooks — the module-resolution redirect of the loader-faces
 * fs-watch idle-count probe (ci/fs-watch-idle-probe.mjs), the parity-node-
 * hooks pattern pointed at the shim tree:
 *
 *   - `gateway.js` imported from under runtime/dsh/upstream/ → the FAKE
 *     gateway (ci/fs-watch-idle-gateway.mjs — the counting timer seam), so
 *     upstream/shims/timers.js installs its globals over the counted arms;
 *   - the pathy bare specifiers the shim layer uses among itself
 *     (`upstream/...`, `web-live/...`, `logger.js`, `surface.js`,
 *     `gateway.js`, `canonical-json.js`, ...) — imported from a file under
 *     runtime/dsh/ — resolve against the runtime root instead of failing
 *     Node's bare-specifier lookup.
 *
 * DSH_FS_WATCH_TREE (absolute POSIX/Windows path) overrides the runtime
 * root, so the same probe can measure a PRISTINE tree (the pre-fix
 * baseline) and the working tree without copying the probe around.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// This module lives at runtime/dsh/ci/ — the runtime root is its parent.
const DEFAULT_TREE = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREE = process.env.DSH_FS_WATCH_TREE ?? DEFAULT_TREE;
const GATEWAY_URL = new URL('./fs-watch-idle-gateway.mjs', import.meta.url).href;

// The pathy bare specifiers the runtime's own modules import each other by
// (the quickjs host's bare map serves these; Node needs the redirect).
const RUNTIME_SPECIFIER = /^(?:upstream|web-live|system-plugins|web|host|scenario)\//;
const RUNTIME_FILE_SPECIFIER = /^(?:gateway|logger|surface|llm|registry|sha256|tar-mini|ed25519|canonical-json|marketplace|freshness-store|install-pipeline|install-fetch|receipt-journal|plugin-mount|workspace-registry|config-layer|transport-tokens|marketplace-resolver|semver-range)\.js$/;

const toFileURL = (path) => pathToFileURL(path.replaceAll('\\', '/')).href;

export async function resolve(specifier, context, nextResolve) {
  const parent = typeof context.parentURL === 'string' ? context.parentURL : '';
  const fromRuntime = parent.includes('/runtime/dsh/') || parent.includes('\\runtime\\dsh\\');
  if (fromRuntime) {
    if (specifier === 'gateway.js') {
      return { url: GATEWAY_URL, shortCircuit: true };
    }
    if (RUNTIME_SPECIFIER.test(specifier) || RUNTIME_FILE_SPECIFIER.test(specifier)) {
      return { url: toFileURL(join(TREE, specifier)), shortCircuit: true };
    }
    // The absolute /vendor/... roots the quickjs host serves (the vendored
    // npm trees some shims re-export from) — the same bytes, from the tree.
    if (specifier.startsWith('/vendor/')) {
      return { url: toFileURL(join(TREE, 'vendor', specifier.slice('/vendor/'.length))), shortCircuit: true };
    }
  }
  // The `dsh:` virtual modules the quickjs host injects (gateway.js links
  // dsh:util-crypto at import time). Only the faces the probe's import
  // chain reaches are stubbed; anything else fails loud right here.
  if (specifier === 'dsh:util-crypto') {
    return { url: new URL('./fs-watch-idle-dsh-util-crypto.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
