// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * web-plugins-payload.mjs — build the `web.plugins` bus delivery for the
 * web-boot CLI drive from the vendored @deepseek-ai/dsh-client-modules tree
 * (the OFFICIAL web boot composer, runtime/spike/vendor/ensure-dsh.sh-pinned).
 *
 * The payload is exactly what a platform embedder stages and delivers over
 * the bus seam: the scan-scope file view (package manifest + the client
 * bundle), base64-encoded, with a FIXED mtimeMs — mobile staging has no
 * wall-clock meaning, and a fixed generation stamp makes the composed graph
 * revs reproducible across runs and devices (the client-modules rev at this
 * stage is the upstream initial placeholder regardless; the stamp pins the
 * HMR baseline input).
 *
 * usage: node web-plugins-payload.mjs <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..', 'vendor', 'npm', '@deepseek-ai/dsh-client-modules@0.1.6-alpha.2');
const VFS_ROOT = '/web-plugins';
const PKG_DIR = `${VFS_ROOT}/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2`;
const STAGED_MTIME_MS = 0;

const payload = {
  type: 'web.plugins',
  plugins: [{
    loaderName: '@deepseek-ai/dsh-client-modules',
    pkgJsonPath: `${PKG_DIR}/package.json`,
    entryPath: `${PKG_DIR}/lib/index.js`,
    files: {
      [`${PKG_DIR}/package.json`]: {
        b64: readFileSync(join(PKG_ROOT, 'package.json')).toString('base64'),
        mtimeMs: STAGED_MTIME_MS,
      },
      [`${PKG_DIR}/lib/client.js`]: {
        b64: readFileSync(join(PKG_ROOT, 'lib/client.js')).toString('base64'),
        mtimeMs: STAGED_MTIME_MS,
      },
    },
  }],
};

const out = process.argv[2];
if (!out) {
  console.error('usage: node web-plugins-payload.mjs <out.json>');
  process.exit(2);
}
writeFileSync(out, JSON.stringify(payload));
console.error(`web-plugins-payload: ${Object.keys(payload.plugins[0].files).length} files, ${JSON.stringify(payload).length} bytes -> ${out}`);
