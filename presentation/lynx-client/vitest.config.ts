import { defineConfig } from 'vitest/config'

/**
 * Line coverage over the Node-testable surface of the lynx-client driver.
 *
 * What counts in: the seam libraries the vitest suite actually exercises —
 * `driver/` (RenderSurfaceClient seam, adapter, wire) and `shared/` (fold,
 * surface-core, view-events). Test discovery stays at vitest's defaults so
 * this config changes no test semantics — it only adds measurement.
 *
 * Honest boundaries (never counted here, by name):
 *   - `bundle/` — the ReactLynx render face; it runs on the Lynx engine,
 *     not on Node. Fake node-side coverage would lie the way node-side
 *     coverage of QuickJS-bound shims lies.
 *   - `driver/run-*.mjs`, `driver/mock/mock-serve.mjs`, `driver/driver.js`,
 *     `driver/skin-*.js` — the CLI/e2e face: `driver.js` and the skins are
 *     imported only by the run-mock/run-lynx entrypoints, and the full
 *     driver loop through both skins is exercised by the e2e evidence net
 *     (`test/e2e/run-cli-lynx-mount.sh` — stub and lynx receipts on file),
 *     not by this unit suite.
 *   - `theme/gen.mjs` — owned by the `theme:check` script gate.
 *   - `artifacts/`, `node_modules/` — never product code.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['driver/**', 'shared/**'],
      exclude: [
        'node_modules/**',
        'artifacts/**',
        'tests/**',
        'coverage/**',
        'driver/run-mock.mjs',
        'driver/run-lynx.mjs',
        'driver/driver.js',
        'driver/skin-lynx.js',
        'driver/skin-stub.js',
        'driver/mock/mock-serve.mjs',
      ],
    },
  },
})
