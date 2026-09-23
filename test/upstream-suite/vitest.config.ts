import { defineConfig } from 'vitest/config'

/**
 * The upstream DSH test suite against OUR vendored closure.
 *
 * What this proves: every spec upstream ships at the pinned tag
 * (dsh-v0.1.6-alpha.2 — the exact version, and the exact bytes, our runtime
 * vendors) passes with the packages resolved to `runtime/spike/vendor/`
 * through the node_modules layout. A green run means: the vendored build we
 * ship satisfies upstream's own unit and integration expectations.
 *
 * Resolution: vite realpaths symlinked imports by default, so a spec at
 * vendor/dsh-tests@<tag>/packages/core/agent-loop/tests/*.spec.ts resolves
 * '@deepseek-ai/dsh-agent-loop' by walking its REAL ancestor chain into
 * vendor/node_modules — no aliases, no copies, the verbatim vendored bytes.
 *
 * Segmentation (mirrors upstream's own vitest configs):
 *   - `*.spec.ts` — the deterministic suites (unit + integration). This
 *     config's default.
 *   - `*.e2e.ts` — real-API legs (upstream runs them credentialed, with
 *     token budgets) and `*.expected.e2e.ts` (owner-local assembled
 *     expectations): imported per-package in follow-up phases, not by
 *     default here.
 */
export default defineConfig({
  test: {
    include: [
      'runtime/spike/vendor/dsh-tests@*/packages/*/*/tests/**/*.spec.ts',
    ],
    exclude: [
      '**/node_modules/**',
      // ---- counted, named exclusions (never silent) ----
      // Browser/jsdom tier — the client face; a later phase owns it.
      '**/packages/client/**',
      // Dual-face controllers' browser halves (need `window`).
      '**/packages/api/*/tests/**/*client*',
      // Native / platform-bound dependencies (upstream runs these per-OS):
      // koffi (win32/sqlite bindings), sharp (office), landlock-run, node-pty,
      // playwright/browserbase/stagehand (browser-use), ripgrep binary.
      '**/packages/document/office-to-pdf/**',
      '**/packages/sandbox/sandbox-local/**',
      '**/packages/sandbox/sandbox-windows-acl/**',
      '**/packages/subprocess/win32-process/**',
      '**/packages/terminal/**',
      '**/packages/browser-use/**',
      '**/packages/experimental/browser-use-*/**',
      '**/packages/experimental/computer-use-*/**',
      '**/packages/fs/tool-fs-search/**',
      '**/packages/experimental/speech-to-text*/**',
      '**/packages/experimental/voice-input-bundle/**',
      '**/packages/experimental/ptc-runtime-python/**',
      // Node host internals (app-boot/hmr test Node module reachability —
      // the seam our port replaces by construction; the parity differential
      // owns that proof).
      '**/packages/boot/app-boot/**',
      '**/packages/boot/hmr/**',
      // The vendored cordis timer carries source-only (no built entry).
      '**/packages/boot/hmr/tests/**',
      // Real-API / credentialed legs — a credentialed phase owns them.
      '**/*.e2e.ts',
      '**/*.expected.e2e.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Deterministic CI: one file at a time is slower but reproducible and
    // keeps memory flat on small runners; raise when the suite count is
    // known-stable.
    fileParallelism: false,
    passWithNoTests: false,
  },
})
