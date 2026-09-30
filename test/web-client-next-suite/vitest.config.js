import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// This suite lives under test/ because presentation/web-client-next is
// WHOLE-TREE staged into the harmony HAP rawfile (vendor-official.sh
// webclient_files): the product directory must stay free of test tooling
// AND of every tool artifact — the staging find()s the whole tree, and
// check-bundle-files reds on anything the HAP cannot carry. Vitest's root
// therefore points at the PRODUCT directory (coverage can only include
// files under root) while the test glob reaches back into this suite, and
// BOTH artifact sinks (the vite cache, the coverage report) are pinned
// back into this suite's own directory. Coverage includes the
// browser-only files at their honest (near-zero) numbers: main.js,
// render-chat.js, render-home.js, composer.js and markdown.js's render
// half are DOM-tied and stay untested on purpose (no fake jsdom
// coverage). The Node-runnable faces are api.js (envelope bridge), mux.js
// (WS state machine, over a real socket) and timeline.js (the journal
// fold).
const here = import.meta.dirname;
const product = resolve(here, '../../presentation/web-client-next');
export default defineConfig({
  root: product,
  cacheDir: resolve(here, 'node_modules/.vite'),
  test: {
    include: [resolve(here, 'tests/**/*.test.js')],
    coverage: {
      provider: 'v8',
      include: ['web/js/**/*.js'],
      outputDir: resolve(here, 'coverage'),
    },
  },
});
