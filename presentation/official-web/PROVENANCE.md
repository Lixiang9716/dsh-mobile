# Provenance — official upstream Web UI dist (`dsh-web-frontend`)

Vendored verbatim build output of the OFFICIAL upstream web application
(decision D9 / D3): `apps/web` (`@deepseek-ai/dsh-web-frontend`) from
`deepseek-ai/deepseek-harness`. No upstream file was modified; this
directory carries BUILD ARTIFACTS only, produced by the upstream's own
build commands (see `build-upstream.sh` for the reproducible recipe).

## Pin

- **Repository**: https://github.com/deepseek-ai/deepseek-harness
- **Commit**: `ddefc45fbc7f8e46dd73185e68295696d1297887`
- **Tag**: `dsh-v0.1.6-alpha.2` (release merge: "Merge pull request #4469
  from deepseek-harness/worktree/release-dsh-0.1.6-alpha.2")
- **Version**: 0.1.6-alpha.2 (root `package.json` version field)
- **Pin authority**: the pin is recorded twice in
  `anywhere-labs/dsh-desktop` and both records agree:
  1. `upstream.json` → `channels.beta.commit` =
     `ddefc45f…`, `sourceVersion` / `runtimePackageVersion` =
     `0.1.6-alpha.2` (activeChannel = `beta`);
  2. the `deepseek-harness` submodule gitlink at dsh-desktop HEAD =
     `ddefc45fbc7f8e46dd73185e68295696d1297887`.
  Our vendored runtime tarballs (0.1.6-alpha.x, via dsh-desktop's
  `vendor/dsh-runtime/`) are built FROM this same source tag, so this UI
  build is lineage-compatible with the carrier's staged runtime.

## Build (reproduced 2026-09-20)

- Toolchain: Node v24.14.0, pnpm 11.7.0 (the repo's `packageManager`
  field, via corepack), macOS arm64 (darwin 25.5.0).
- Command sequence: see `build-upstream.sh` in this directory. Every
  step is an upstream-authored script or a documented prerequisite the
  upstream scripts themselves declare; nothing upstream was edited.
- The full-repo orchestrator is `pnpm build`; the script below performs
  the minimal verified subset that produces `apps/web/dist`.

## What is committed here

- `dist/` — the built SPA, filtered to upstream's own published
  allowlist (`apps/web/package.json` → `files`: `dist` minus
  `!dist/**/*.map`, `!dist/preview.html`, `!dist/preview`). 89 files,
  ~4.7 MB. Source maps and the static-worker preview artifacts are
  intentionally excluded (not part of the published surface; keeps the
  vendored size under the 10 MB repo guard).
- `MANIFEST.sha256` — sha256 over every committed dist file (paths
  relative to `dist/`), sorted. This file's own digest:
  `sha256:6014f2af6e5b83e928d3d2cc1c10bd841d449cee2d62939bb7c80c0e9ccc9dc0`.
- `build-upstream.sh` — the reproducible recipe: clone → checkout pin →
  install → build prerequisite faces → `vite build` → copy → re-verify.

## Verification

```sh
cd presentation/official-web/dist && shasum -a 256 -c ../MANIFEST.sha256
```

## Serving note (not part of provenance, but binding)

The built `index.html` carries NO boot state: `window.__DSH_BOOT__` and
`window.__ModuleLoader__` must be injected into the served index by the
carrier (upstream: the webserver `renderIndex` pipeline). Serving these
files as-is yields the upstream boot-failure page by design —
`apps/web` is explicitly "not a standalone application". See
`docs/webserver-contract.md` for the contract the Phase-B carrier must
implement.
