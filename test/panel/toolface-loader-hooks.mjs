// dsh:logging-exempt (test provisioning module: console is unused here)
/**
 * toolface-loader-hooks.mjs — the module-resolution hooks the loop-v2
 * tool-face runner loads under (node --import toolface-register.mjs). They
 * reproduce the DEVICE loader's map for the vendored @deepseek-ai/dsh-fs-local
 * (the `fs` service backend boot.js plugs the file tools over):
 *
 *   - the vendored package's `node:fs` / `node:fs/promises` imports resolve
 *     onto the shim family — the runtime's world model, seam gate included;
 *   - the shim family's OWN node:fs imports stay REAL node (the desktop seam
 *     shape the loop-p/loop-r suites pin — the C seam is faked over it);
 *   - the vendored package graph's bare @deepseek-ai/* specifiers resolve to
 *     the pinned 0.1.6-alpha.2 closure the hosts ship (the tracked host
 *     copies the `closures` gate keeps in sync with canonical); dsh-llm is
 *     the suite's stub (HarnessError base only);
 *   - the shims' bare `upstream/shims/…` specifiers resolve to the canonical
 *     runtime tree, exactly as the spike loader does on device.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const vendorRoot = join(repoRoot, 'hosts/android/app/src/main/assets/dsh/vendor');

const VENDOR_BARE = {
  '@deepseek-ai/dsh-fs-local': join(vendorRoot, 'dsh/fs-local@0.1.6-alpha.2/lib/index.js'),
  '@deepseek-ai/dsh-fs': join(vendorRoot, 'dsh/fs@0.1.6-alpha.2/lib/index.js'),
  '@deepseek-ai/cordis': join(vendorRoot, 'npm/cordis@4.0.2/lib/index.js'),
  '@deepseek-ai/schemastery': join(vendorRoot, 'npm/schemastery@3.18.2/lib/index.mjs'),
  '@deepseek-ai/cosmokit': join(vendorRoot, 'npm/cosmokit@1.8.3/lib/index.js'),
  '@deepseek-ai/dsh-llm': join(here, 'dsh-llm-stub.js'),
  // loop-z3: the model-facing FILE TOOLS themselves (the read face and the
  // str_replace_editor face whose absolute-path gate the battery measured) —
  // the real vendored packages, with the registry/sandbox seams doubled by
  // test stubs (the suites drive valid args; defineTool's validation is not
  // the behavior under test).
  '@deepseek-ai/dsh-tool-fs': join(vendorRoot, 'dsh/tool-fs@0.1.6-alpha.2/lib/index.js'),
  '@deepseek-ai/dsh-tool-str-replace-editor': join(vendorRoot, 'dsh/tool-str-replace-editor@0.1.6-alpha.2/lib/index.js'),
  '@deepseek-ai/dsh-tools': join(here, 'dsh-tools-stub.js'),
  '@deepseek-ai/dsh-sandbox': join(here, 'dsh-sandbox-stub.js'),
  '@deepseek-ai/dsh-attachment': join(vendorRoot, 'dsh/attachment@0.1.6-alpha.2/lib/index.js'),
  diff: join(vendorRoot, 'npm/diff@9.0.0/libesm/index.js'),
};

const shimUrl = (name) => pathToFileURL(join(repoRoot, 'runtime/dsh/upstream/shims', name)).href;

export function resolve(specifier, context, next) {
  const parent = context.parentURL ?? '';
  const mapped = VENDOR_BARE[specifier];
  if (mapped !== undefined
    && (parent.includes('/vendor/dsh/') || parent.includes('/vendor/npm/') || parent.includes('/test/panel/'))) {
    return { url: pathToFileURL(mapped).href, shortCircuit: true };
  }
  if (specifier.startsWith('upstream/shims/')) {
    return { url: pathToFileURL(join(repoRoot, 'runtime/dsh', specifier)).href, shortCircuit: true };
  }
  // The spike-root spellings the loader serves on device ('/' IS the spike
  // root) — the same rows vitest.config.js aliases for the in-process suites.
  if (specifier.startsWith('/upstream/shims/')) {
    return { url: pathToFileURL(join(repoRoot, 'runtime/dsh', specifier.slice(1))).href, shortCircuit: true };
  }
  if (specifier.startsWith('/vendor/')) {
    return { url: pathToFileURL(join(repoRoot, 'runtime/dsh', specifier.slice(1))).href, shortCircuit: true };
  }
  // The panel's own shim doubles (the vitest aliases' equivalents); gateway
  // gains the inert socket faces raw-node ESM link-errors on (see
  // toolface-gateway.js).
  if (specifier === 'gateway.js') return { url: pathToFileURL(join(here, 'toolface-gateway.js')).href, shortCircuit: true };
  if (specifier === 'logger.js') return { url: pathToFileURL(join(here, 'logger-shim.js')).href, shortCircuit: true };
  // The device loader's fs map rows apply to EVERY importer: the vendored
  // backend's fs faces land on the shim family, and so do the shim family's
  // own `node:fs` / `node:fs/promises` imports (fs-promises-fh pulls the
  // _ws* internals through the mapped specifier). fs.js itself imports no
  // fs specifier (only a lazy node:child_process), so the map is acyclic.
  // The runner module itself is exempt: its FIXTURE side (mkdtemp/mkdir of
  // the outside-root shapes) must speak real host fs, the same split the
  // vitest suites have (test file = real node, shims = mapped).
  if ((parent.includes('/toolface-fs-local-runner.mjs')
    || parent.includes('/toolface-relative-spelling-runner.mjs'))
    && (specifier === 'node:fs' || specifier === 'node:fs/promises')) {
    return next(specifier, context);
  }
  if (specifier === 'node:fs') return { url: shimUrl('fs.js'), shortCircuit: true };
  if (specifier === 'node:fs/promises') return { url: shimUrl('fs-promises.js'), shortCircuit: true };
  return next(specifier, context);
}
