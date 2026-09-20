# Agent Note: Official upstream web UI dist vendored + ctx.webServer carrier contract frozen

Status: implemented
Related: D9, D3, D5

## Problem

D9 requires the mobile WebView to mount the OFFICIAL upstream web UI
served by OUR carrier, with zero upstream edits — but two prerequisites
did not exist: (1) no built artifact of `apps/web`
(`@deepseek-ai/dsh-web-frontend`) had ever been vendored, so no carrier
work could even be staged against real bytes; (2) the `ctx.webServer`
contract the carrier must implement existed only inside upstream source,
so a Phase-B carrier PR would start from archaeology instead of a spec.
Building and reading upstream ad hoc would repeat for every future
worker; the pin-to-artifact lineage (which upstream commit do OUR
vendored runtime tarballs correspond to?) was also undocumented.

## Decision

- `presentation/official-web/` carries the official SPA dist, vendored
  verbatim: upstream pin `ddefc45fbc7f8e46dd73185e68295696d1297887`
  (tag `dsh-v0.1.6-alpha.2`), which is the SAME commit recorded twice in
  anywhere-labs/dsh-desktop (`upstream.json` channels.beta and the
  deepseek-harness submodule gitlink) — lineage-compatible with our
  vendored runtime tarballs. Committed subset = upstream's own
  published `files` allowlist (dist minus `*.map`, `preview.html`,
  `preview/`): 89 files, ~4.7 MB, under the 10 MB guard, so artifacts
  (not fetch-only manifests) are committed. `MANIFEST.sha256` covers
  every file; `PROVENANCE.md` records pin, toolchain, command sequence,
  and the manifest's own digest;
  `build-upstream.sh` reproduces the bytes — verified by a full rerun
  that regenerated a byte-identical manifest
  (`sha256:6014f2af…` both times). Build order per upstream's own
  scripts: install → webworker-runtime tsdown → `build:lib:host` →
  `build:lib:client` → `build:web` (vite).
- `docs/webserver-contract.md` (+ `.zh.md`, pairing-confirmed) extracts
  the carrier-facing contract from upstream SOURCE at the pin:
  webServer service/config/route/upgrade/fallback/index-render
  semantics; the shipped composition's wire surface (`GET /` with
  injection rows, `/plugins/**`, `POST /api/<endpoint>` envelope,
  `WS /api/remote.mux`, exact fetch routes); then the per-host
  CarrierServer alignment plan (route table, multi-seat upgrade
  dispatch, fallback seat → official dist, POST body handling, MIME
  generalization, auth-lite reduction) and the E2E evidence plan
  (proposed scenario `b1.official-web.mount`, carrier-side wire
  observations + one rendered-state probe, since upstream code cannot
  emit our log envelope).
- `presentation/README.md` status updated: v1 is now "dist vendored,
  mount pending the Phase-B carrier PR", not "future".

## Alternatives considered

- **Commit the raw 18 MB dist** (including 13 MB of source maps and the
  static-worker preview) — rejected: maps/preview are outside upstream's
  published allowlist and would triple repo weight for zero served
  value; the fetch-script-instead-of-artifacts escape hatch stays
  unnecessary while the subset fits the guard.
- **Write the carrier contract from upstream READMEs** — rejected: the
  READMEs omit the wire details the carrier implementer needs (upgrade
  rejection shape, `__DSH_BOOT_READY__` tail, `<base href="/">`
  transform, GET-only fallback semantics, 404-not-SPA-fallback for deep
  paths). Source was read line-by-line at the pin; every claim in the
  doc cites a file.
- **Serve the bare dist and let the page show its boot-failure screen
  until Phase B** — rejected as a deliverable (it boots nothing:
  `__ModuleLoader__`/`__DSH_BOOT__` are carrier-injected), but kept as
  the documented failure mode: a carrier that skips the index render
  pipeline fails loud upstream-style, which is the correct behavior.
- **Vendor by npm tarball instead of source build** — rejected: the
  npm artifact excludes the injection-critical surfaces we must
  document and breaks pin-to-commit lineage; building FROM the pinned
  commit keeps PROVENANCE exact and re-pins cheap (D6).
