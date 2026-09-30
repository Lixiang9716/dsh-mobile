import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// This suite lives under test/ because presentation/web-client-next is
// WHOLE-TREE staged into the harmony HAP rawfile (vendor-official.sh
// webclient_files): the product directory must stay free of test tooling
// AND of every tool artifact — the staging find()s the whole tree, and
// check-bundle-files reds on anything the HAP cannot carry. Vitest's root
// therefore points at the PRODUCT directory (coverage can only include
// files under root) while the test glob reaches back into this suite.
// vitest 4 resolves BOTH artifact sinks against that root, so both are
// pinned by ABSOLUTE path into this suite's own directory:
//   - coverage.reportsDirectory (the v4 key; `outputDir` is silently
//     ignored — observed live: the HTML report landed in the product
//     tree, 30 files where 12 belong)
//   - cacheDir (the vite dep-optimize/vitest cache)
// A test run — plain or --coverage — leaves the product tree at its 12
// shipped files; .gitignore carries a coverage/ entry for the product
// dir as belt-and-braces, never as license. Coverage includes the
// browser-only files at their honest (near-zero) numbers: main.js,
// render-chat.js, render-home.js, composer.js and markdown.js's render
// half are DOM-tied and stay untested on purpose (no fake jsdom
// coverage). The Node-runnable faces are api.js (envelope bridge),
// mux.js (WS state machine, over a real socket) and timeline.js (the
// journal fold).
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
      reportsDirectory: resolve(here, 'coverage'),
    },
  },
});
