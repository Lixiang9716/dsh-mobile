# Agent Note: W-SHELL: the application-tier client bundles boot the official app shell

Status: implemented
Related: D9, D3

## Problem

The official web app booted on the mobile carrier only up to its loader
progress state: HARNESS wordmark, live spinner, "Loading plugins…" — the
honest stop. The embedded runtime composed the `__DSH_BOOT__` wire with the
VERBATIM `@deepseek-ai/dsh-client-modules` half (#58/#60), but that graph
carried exactly one entry: the bootstrap package itself. The APPLICATION
tier — the client-web shell's UI plugins the loader graph wants after the
bootstrap — exists only as BUILD artifacts of the upstream monorepo (the
desktop serves them from its installed `dsh-web-app` package tree; they ship
in no npm tarball we vendor). Without them the page's loader waits forever,
and no amount of carrier work changes that: the roster is a property of the
staged plugin set, not of the carrier.

The port needed three questions answered before any code: what exactly IS
the prepared-module format the loader graph consumes; where do the built
bundles come from at our pin; and what is the minimal honest surface to
stage.

## Decision

The prepared-module format (read from the vendored client-modules source and
the desktop's composition, then reproduced): an application-tier client
bundle is a PUBLISHED PACKAGE FACE, not a byte format —

- each package's manifest declares `dsh.client` (`platform: "web"`) and
  resolves `exports["./client"]` to its built bundle file;
- the bundle itself is a lazy-CJS FACTORY script: executing it only calls
  `window.__ModuleLoader__.load({id, factory})`; every side effect runs at
  materialization inside the browser module system;
- the node half scans the Loader entries for those declarations and composes
  `__DSH_BOOT__`: `{rev, entries, batches}` — per-package revisioned
  single-resource combo URLs (`/plugins/??<id>/client.js&rev=<rev>`),
  dependency-ordered (`orderByModuleGraph` over the declarations' `external`
  fields), partitioned into `bootstrap` (exactly `@deepseek-ai/dsh-client-modules`)
  and `application` phases under the 3 KiB combo-URL limit.

So we built the upstream monorepo at the SAME pin as the dist
(`dsh-v0.1.6-alpha.2`) with upstream's own client-face build
(`build:lib:host` → `build:lib:client`), derived the roster from the shipped
web composition (`packages/bundle/web-app/cordis.patch.yml`) by closing over
the `dsh.client` declarations minus the shell-static seed modules — 58
packages — and vendored the built bundles verbatim under
`presentation/official-web/client-bundles/` (PROVENANCE + ROSTER.json record
+ MANIFEST.sha256 + reproducible `build-client-bundles.sh`, the #52 pattern).
The boot graph now composes the full roster in the runtime (CLI-proven by
`m2.upstream-boot`, 12/12: bootstrap batch exact, one application combo over
the other 57, externals ordered), the carrier stages and serves the same
tree at the graph's URLs (chunk route included for the staged-chunk case),
and b1.official-web.mount now runs 14 one-to-one events ending in
`app.shell.rendered`: the boot page DISPOSED — the upstream UI renderer
mounted the real app shell on device (workspace picker rendered; the
backend-RPC surfaces answer structured `gateway/unimplemented`, the named
next gap).

Staging exclusions are named gaps, not fakes: source maps (the graph serves
identity maps, upstream's own ENOENT fallback) and package-local chunks
(`client.<n>.js` — off the boot path, `require.async`-loaded only by the
terminal/document-preview panels, ~7.8 MB; a fetch 404s with upstream's own
stale-rev behavior while the carrier's chunk route is implemented).

## Alternatives considered

- **Trim a minimal roster** (shell + renderer only). Lost: the manifest's
  rows must ALL activate (`assertEntriesActive` rejects startup otherwise)
  and every bundle's externals must resolve to a staged row or a
  shell-static module — a partial set that is dependency-closed IS the full
  set (the closure is exact); anything smaller fails the boot page loudly.
- **Bundle the application tier ourselves** (one vite/rollup pass over the
  plugin sources). Lost: violates verbatim-upstream discipline (D6/D9) —
  the desktop's loader consumes the PUBLISHED per-package faces; a
  custom bundling would be our own build of upstream sources, a fork by
  another name, and would break the registry's scan contract (per-package
  manifests + `./client` exports).
- **Serve the bundles from npm tarballs** (vendor 58 more tgz pins like the
  runtime closure). Lost for THIS wave: the published tarballs carry the
  same bytes but the pull would add 58 pin-table rows to fetch for files we
  already build reproducibly from the same pin as the dist; the bundle dir
  keeps one provenance surface for the UI tier. Revisit if the runtime
  closure ever needs the application-tier NODE halves.
- **Skip `client-hmr`** (the dev-reload row). Lost: upstream mounts it
  "always" in the shipped composition; its client half opens one
  EventSource that 404s against the carrier (spec: non-200 fails the
  connection, no retry) and stays idle — desktop parity with a named,
  inert gap beats a divergent roster.

## Consequences

- The official shell renders on the carrier; every backend-RPC surface it
  touches answers the structured `gateway/unimplemented` envelope — the
  next named gap is the claimed session/API surface in the embedded runtime
  (the full agent spine is the m2 profile, not the b1 web-boot closure).
- `presentation/` grows ~5.8 MB of vendored build artifacts (bundled bytes
  + manifests; maps/chunks excluded, documented).
- The carrier's endpoint validation now follows the upstream per-segment
  rule (`settings/describe` was rejected before — found by the live page,
  not by review).
- The wire-evidence hooks are single-emission (first occurrence wins):
  with the app live, the PAGE generates the first RPC/mux traffic, and the
  manifest pins those honest firsts.
