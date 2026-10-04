import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The panel suite scopes collection to THIS directory: the repo's other
// trees carry their own suites (and the vendored corpus carries thousands),
// and a default-include run from the repo root sweeps them all (measured:
// 173 files, 3 failures that are not ours — vendored zod's own specs).
//
// The bare-import aliases resolve the RUNTIME modules the ed25519 /
// marketplace-resolver suites exercise (the spike host resolves these bare
// specifiers itself; plain node/vitest needs the map).
export default defineConfig({
  test: {
    include: ['*.test.js'],
    environment: 'node',
    // The #323 deadline suite exercises the vendored @deepseek-ai/dsh-timeout;
    // the vendor trees are untracked, so globalSetup stages the pinned
    // package into .vendored/ from the tracked mirror (see provision-vendor.mjs).
    globalSetup: ['./provision-vendor.mjs'],
  },
  resolve: {
    alias: [
      { find: 'logger.js', replacement: fileURLToPath(new URL('./logger-shim.js', import.meta.url)) },
      { find: 'ed25519.js', replacement: fileURLToPath(new URL('../../runtime/spike/ed25519.js', import.meta.url)) },
      { find: 'canonical-json.js', replacement: fileURLToPath(new URL('../../runtime/spike/canonical-json.js', import.meta.url)) },
      { find: 'marketplace-resolver.js', replacement: fileURLToPath(new URL('../../runtime/spike/marketplace-resolver.js', import.meta.url)) },
      { find: 'web-write-inventory.js', replacement: fileURLToPath(new URL('../../runtime/spike/upstream/web-write-inventory.js', import.meta.url)) },
      { find: '@deepseek-ai/dsh-timeout', replacement: fileURLToPath(new URL('./.vendored/dsh-timeout/lib/index.js', import.meta.url)) },
      // loop-u's supervisor imports two message utilities from @deepseek-ai/dsh-llm;
      // the vendored package needs zod + schemastery (outside the suite's
      // provisioned deps), so the alias doubles it (dsh-tools-stub's rule).
      { find: '@deepseek-ai/dsh-llm', replacement: fileURLToPath(new URL('./dsh-llm-stub.js', import.meta.url)) },
      // loop-v2's tool-face suite drives the vendored fs-local (the `fs`
      // service backend) over the shims; the package graph is the pinned
      // 0.1.6-alpha.2 closure the hosts ship (the tracked host copies the
      // `closures` gate keeps in sync with canonical).
      {
        find: '@deepseek-ai/dsh-fs-local',
        replacement: fileURLToPath(new URL('../../hosts/android/app/src/main/assets/spike/vendor/dsh/fs-local@0.1.6-alpha.2/lib/index.js', import.meta.url)),
      },
      {
        find: '@deepseek-ai/dsh-fs',
        replacement: fileURLToPath(new URL('../../hosts/android/app/src/main/assets/spike/vendor/dsh/fs@0.1.6-alpha.2/lib/index.js', import.meta.url)),
      },
      {
        find: '@deepseek-ai/cordis',
        replacement: fileURLToPath(new URL('../../hosts/android/app/src/main/assets/spike/vendor/npm/cordis@4.0.2/lib/index.js', import.meta.url)),
      },
      {
        find: '@deepseek-ai/schemastery',
        replacement: fileURLToPath(new URL('../../hosts/android/app/src/main/assets/spike/vendor/npm/schemastery@3.18.2/lib/index.mjs', import.meta.url)),
      },
      {
        find: '@deepseek-ai/cosmokit',
        replacement: fileURLToPath(new URL('../../hosts/android/app/src/main/assets/spike/vendor/npm/cosmokit@1.8.3/lib/index.js', import.meta.url)),
      },
      { find: 'gateway.js', replacement: fileURLToPath(new URL('./gateway-shim.js', import.meta.url)) },
      { find: '@deepseek-ai/dsh-tools', replacement: fileURLToPath(new URL('./dsh-tools-stub.js', import.meta.url)) },
      { find: 'dsh:util-crypto', replacement: fileURLToPath(new URL('./util-crypto-shim.js', import.meta.url)) },
      { find: 'sha256.js', replacement: fileURLToPath(new URL('../../runtime/spike/sha256.js', import.meta.url)) },
      { find: 'tar-mini.js', replacement: fileURLToPath(new URL('../../runtime/spike/tar-mini.js', import.meta.url)) },
      { find: 'install-pipeline.js', replacement: fileURLToPath(new URL('../../runtime/spike/install-pipeline.js', import.meta.url)) },
      { find: 'install-fetch.js', replacement: fileURLToPath(new URL('../../runtime/spike/install-fetch.js', import.meta.url)) },
      { find: 'receipt-journal.js', replacement: fileURLToPath(new URL('../../runtime/spike/receipt-journal.js', import.meta.url)) },
      { find: 'upstream/web-write-inventory.js', replacement: fileURLToPath(new URL('../../runtime/spike/upstream/web-write-inventory.js', import.meta.url)) },
      { find: 'upstream/web-write-marketplace.js', replacement: fileURLToPath(new URL('../../runtime/spike/upstream/web-write-marketplace.js', import.meta.url)) },
      { find: 'upstream/web-write-plugin-manager.js', replacement: fileURLToPath(new URL('../../runtime/spike/upstream/web-write-plugin-manager.js', import.meta.url)) },
      { find: 'upstream/web-write-cordis.js', replacement: fileURLToPath(new URL('../../runtime/spike/upstream/web-write-cordis.js', import.meta.url)) },
      { find: 'system-plugins/dsh-plugin-manager-tools/index.js', replacement: fileURLToPath(new URL('../../system-plugins/dsh-plugin-manager-tools/index.js', import.meta.url)) },
      { find: 'workspace-registry.js', replacement: fileURLToPath(new URL('../../runtime/spike/workspace-registry.js', import.meta.url)) },
      { find: 'scenario/probe-respond-await.js', replacement: fileURLToPath(new URL('../../runtime/spike/scenario/probe-respond-await.js', import.meta.url)) },
      { find: 'scenario/scenario-verdict.js', replacement: fileURLToPath(new URL('../../runtime/spike/scenario/scenario-verdict.js', import.meta.url)) },
      { find: 'scenario/api-handler-respond.js', replacement: fileURLToPath(new URL('../../runtime/spike/scenario/api-handler-respond.js', import.meta.url)) },
      // The fs-shim suite (loop-p): the spike's bare 'upstream/…' specifiers
      // resolve through the quickjs loader on device; the regex prefix maps
      // the whole shim family — the node:fs imports inside stay REAL, a
      // desktop host shape, which is exactly what the readdir fallback
      // targets.
      {
        find: /^upstream\/shims\//,
        replacement: fileURLToPath(new URL('../../runtime/spike/upstream/shims/', import.meta.url)),
      },
      {
        // The loader's spike-root-relative spelling ('/vendor/npm/…' in
        // node-zlib.js and friends) — '/' IS the spike root on device.
        find: /^\/vendor\//,
        replacement: fileURLToPath(new URL('../../runtime/spike/vendor/', import.meta.url)),
      },
    ],
  },
});
