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
      // The shell-executor suite runs the REAL plugin over a gateway shim
      // whose wasmRun executes on Node's own WebAssembly (the dsh_wasm.c
      // ABI mirrored byte for byte — see gateway-shim.js).
      'gateway.js': fileURLToPath(new URL('./gateway-shim.js', import.meta.url)),
      '@deepseek-ai/dsh-tools': fileURLToPath(new URL('./dsh-tools-stub.js', import.meta.url)),
      // The plugin-manager write-leg battery drives the REAL §4 pipeline
      // (tar bytes → digest → promote → receipt journal) over the gateway
      // shim (gateway-shim.js): the pipeline family's bare specifiers
      // resolve to the pinned runtime sources, and the marketplace face's
      // RELATIVE ../gateway.js import reaches the real spike gateway (only
      // its base64 helper runs in tests — via the util-crypto shim).
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
      // The plugin_manager tool suite (#346): the outboard plugin-manager
      // package over the shared workspace-registry module (its gateway and
      // dsh-tools imports alias above; the §4 validator aliases below).
      'system-plugins/dsh-plugin-manager-tools/index.js': fileURLToPath(new URL('../../system-plugins/dsh-plugin-manager-tools/index.js', import.meta.url)),
      'workspace-registry.js': fileURLToPath(new URL('../../runtime/spike/workspace-registry.js', import.meta.url)),
    },
  },
});
