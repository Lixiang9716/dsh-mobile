import { defineConfig } from 'vitest/config'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The tools face: unit tests for the repo's own gate tools (tools/).
 *
 * What this proves: the tools that gate every landing — the staging
 * verifier/generator pair, the code-size gate, the dev-web-carrier's
 * /plugins mux — behave as documented on a happy path AND catch the
 * counterexamples their headers claim (a staging gap, a stale row, a
 * broken import edge, a size violation, a round-trip drift). The
 * counterexamples run against HERMETIC fixture repos assembled in tmp
 * (helpers/staging-fixture.mjs copies the real tool sources verbatim and
 * surrounds them with minimal manifests), so no test mutates the repo.
 *
 * Colocation: the .mjs tests live next to their subjects (tools/*.test.mjs,
 * the repo's stated convention for this face); the config only points the
 * runner at them. The python face (tools/check-size.py) has its own runner
 * (test/tools/run_check_size.py) — pytest or unittest, per its docstring.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export default defineConfig({
  root: REPO,
  test: {
    include: ['tools/**/*.test.mjs'],
    // The fixture repos copy tool sources into tmp; never scan those.
    exclude: ['**/node_modules/**', 'tmp/**'],
    testTimeout: 30_000,
    passWithNoTests: false,
  },
  coverage: {
    provider: 'v8',
    include: ['tools/**'],
    exclude: [
      'tools/**/*.test.mjs',
      // Honest boundary: dev-carrier.mjs starts a server at import (its WS
      // mux is not exported) and the official leg needs the materialized
      // vendored closure + official-web dist; next-mode/compose-boot/ws-lite
      // are its server-mode satellites. plugins-route.mjs — the pure,
      // exported /plugins mux — IS measured.
      'tools/dev-web-carrier/dev-carrier.mjs',
      'tools/dev-web-carrier/next-mode.mjs',
      'tools/dev-web-carrier/compose-boot.mjs',
      'tools/dev-web-carrier/ws-lite.mjs',
    ],
    reportsDirectory: 'test/tools/coverage',
    reporter: ['text', 'json-summary'],
  },
})
