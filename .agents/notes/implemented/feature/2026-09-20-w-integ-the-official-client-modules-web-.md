# Agent Note: W-INTEG: the official client-modules web boot composes in-runtime over the bus seam

Status: implemented
Related: D9, D5, D8

## Problem

The official web UI mounts only when the injected boot rows exist — and the
Phase-B carrier generates them carrier-side from staged placeholder bundles,
so the page's `__ModuleLoader__.create` fails by design: no
`@deepseek-ai/dsh-client-modules/client.js` is ever preloaded, the boot
screen honestly names the missing bundle, and the b1 manifest carries
`runtime.pending`. The runtime half of D9's web mount was missing: nobody
composes the OFFICIAL `__DSH_BOOT__` wire (facade queue, revisioned combo
batches, entry graph) from the vendored upstream packages, and no `/api`
endpoint is claimed — the page cannot progress past the boot failure and the
session journal can never stream.

## Decision

- **The vendored composer runs in the spike runtime.** The
  `@deepseek-ai/dsh-client-modules@0.1.6-alpha.2` npm package is vendored
  verbatim (ensure-dsh.sh pin; sha256-verified) and its node half — the
  `ClientModuleRegistry` — composes the web boot inside QuickJS: incremental
  `dsh.client` scan, `orderByModuleGraph`, combo partitioning, upstream
  sha1-12 revision framing, and `bootInjections` row composition all execute
  as upstream code. The composed graph is cross-parsed through the SAME
  package's browser bundle (`lib/client.js`, materialized through the
  upstream queue facade) — the vendored `parseBootManifest` that will reject
  the wire in the WebView rejects it in the runtime first.
- **Staged scan scope over the bus seam.** The host stages the scan-scope
  file view (package manifest + client bundle, base64, fixed generation
  stamp `mtimeMs` — mobile staging has no wall-clock meaning, and the stamp
  keeps the composed revs reproducible across runs/devices) and delivers one
  `web.plugins` bus line; the runtime posts `web.boot` (rows + recovery +
  plugin revs), `api.claim`, and `mux.claim` back — the exact frames the
  carrier consumes. `upstream/web-boot.js` is the only new adapter code.
- **Shim additions, loud outside their seam** (upstream/shims/, documented in
  the module headers): `createHash('sha1')` (pure JS — the upstream revision
  scheme), `randomBytes`, `node:url` (`fileURLToPath`/`pathToFileURL` + the
  minimal `URL` global for combo-route resolution), a `Buffer` subset
  (from/concat/byteLength/isBuffer; utf8/hex/base64), and the node:fs
  STAGED WEB-PLUGIN VFS — `existsSync`/`readFileSync`/`statSync` serve the
  seeded `/web-plugins` view only (a question vs a read: `existsSync` answers
  false outside it, reads refuse loudly, matching the sandbox boundary);
  VFS state lives on a global because quickjs compiles the shim under BOTH
  its `node:fs` and bundle-relative names and module-local state would fork.
- **The CLI proves the seam end-to-end** (`m2.upstream-boot`,
  run-upstream-boot-e2e.sh, 12 one-to-one events, artifacts under
  runtime/spike/artifacts/macos-cli-upstream-boot/): the mobile profile boots
  and streams ONE REAL turn through the vendored dsh-llm (journal content is
  real), the composed wire is asserted (bootstrap-only batch over the single
  real entry, facade row shape, recovery defaults, single-combo URLs),
  `session.list` is answered from the REAL vendored session store (upstream
  `SessionSummary` rows), and a mux `session/journal` attach streams the
  journal baseline + live change frames in the Remote-journal envelope, then
  cancels. The mock-llm driver gains env-var script overrides; defaults keep
  the m2 script byte-identical.

## Alternatives considered

- **Re-typing the boot graph carrier-side (keep Phase-B defaults)** —
  rejected: it would freeze a hand-written graph that drifts from upstream
  composition rules (scan, ordering, revision framing) and keep the page
  stranded at the failure screen. Only the vendored composer makes the wire
  official.
- **Running the full cordis-plugin-loader + disk Loader to feed the
  registry** — lost to the minimal Loader face (`entries()` +
  `internal.resolveSync`, the documented v1 contract): the disk Loader is a
  declared staged gap and the gateway fs scopes are not the module
  filesystem; the face is the seam the browser client system implements too,
  so nothing upstream changes.
- **Faking the second graph entry to exercise the aggregate combo form
  live** — rejected: published upstream UI packages carry no `dsh.client`
  bundles (their browser halves are monorepo-build artifacts), so any second
  entry would be fake. The aggregate form stays proven by the Phase-B
  carrier conformance rows; the runtime graph is honestly single-entry.
- **Implementing `session.list` from a mobile-side cache or the
  session-controller service** — lost to reading the vendored session store
  directly: the desktop API surface (packages/api/session-controller) is the
  full composition's runtime; the mobile profile answers the attached-store
  subset (upstream row shapes, structured unavailable everywhere else) and
  says so.

## Consequences

- The bus-seam message schema is now live on both sides: the carrier (or any
  embedder) that applies `web.boot` rows and honors `api.claim`/`mux.claim`
  mounts the page past the boot failure into the real client-modules boot —
  the iOS b1 leg is the follow-up PR.
- Revs in the runtime graph are the upstream initial placeholders
  (per-boot nonce), so nothing may pin a raw rev; evidence pins derived
  deterministic facts (row kinds, entry ids, frame counts, texts) instead.
