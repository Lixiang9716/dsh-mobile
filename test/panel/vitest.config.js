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
    alias: {
      'logger.js': fileURLToPath(new URL('./logger-shim.js', import.meta.url)),
      'ed25519.js': fileURLToPath(new URL('../../runtime/spike/ed25519.js', import.meta.url)),
      'canonical-json.js': fileURLToPath(new URL('../../runtime/spike/canonical-json.js', import.meta.url)),
      'marketplace-resolver.js': fileURLToPath(new URL('../../runtime/spike/marketplace-resolver.js', import.meta.url)),
      'web-write-inventory.js': fileURLToPath(new URL('../../runtime/spike/upstream/web-write-inventory.js', import.meta.url)),
      '@deepseek-ai/dsh-timeout': fileURLToPath(new URL('./.vendored/dsh-timeout/lib/index.js', import.meta.url)),
      // The plugin-manager write-leg battery drives the REAL §4 pipeline
      // (tar bytes → digest → promote → receipt journal) over the gateway
      // shim (gateway-shim.js): the pipeline family's bare specifiers
      // resolve to the pinned runtime sources, and the marketplace face's
      // RELATIVE ../gateway.js import reaches the real spike gateway (only
      // its base64 helper runs in tests — via the util-crypto shim).
      'gateway.js': fileURLToPath(new URL('./gateway-shim.js', import.meta.url)),
      'dsh:util-crypto': fileURLToPath(new URL('./util-crypto-shim.js', import.meta.url)),
      'sha256.js': fileURLToPath(new URL('../../runtime/spike/sha256.js', import.meta.url)),
      'tar-mini.js': fileURLToPath(new URL('../../runtime/spike/tar-mini.js', import.meta.url)),
      'install-pipeline.js': fileURLToPath(new URL('../../runtime/spike/install-pipeline.js', import.meta.url)),
      'install-fetch.js': fileURLToPath(new URL('../../runtime/spike/install-fetch.js', import.meta.url)),
      'receipt-journal.js': fileURLToPath(new URL('../../runtime/spike/receipt-journal.js', import.meta.url)),
      'upstream/web-write-inventory.js': fileURLToPath(new URL('../../runtime/spike/upstream/web-write-inventory.js', import.meta.url)),
      'upstream/web-write-marketplace.js': fileURLToPath(new URL('../../runtime/spike/upstream/web-write-marketplace.js', import.meta.url)),
      'upstream/web-write-plugin-manager.js': fileURLToPath(new URL('../../runtime/spike/upstream/web-write-plugin-manager.js', import.meta.url)),
      'upstream/web-write-cordis.js': fileURLToPath(new URL('../../runtime/spike/upstream/web-write-cordis.js', import.meta.url)),
    },
  },
});
