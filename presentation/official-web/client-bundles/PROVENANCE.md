# Provenance — application-tier client bundles (`dsh.client` roster)

Vendored verbatim build output of the OFFICIAL upstream web client's
application tier (decision D9, W-SHELL leg): the per-package browser bundles
of the roster the shipped `@deepseek-ai/dsh-web-app` composition mounts.
No upstream file was modified; this directory carries BUILD ARTIFACTS only,
produced by upstream's own build commands (see `build-client-bundles.sh`).

## What the application tier is

The official web app's browser roster is whatever the mounted host plugins
declare through `dsh.client` (`platform: "web"`) in their package manifests:
the vendored `@deepseek-ai/dsh-client-modules` node half scans the Loader
entries for those declarations and composes `window.__DSH_BOOT__` from them.
Each declared package carries a built `lib/client.js` — a lazy-CJS FACTORY
bundle whose execution only calls
`window.__ModuleLoader__.load({id, factory})`; every module side effect runs
at materialization inside the browser module system. This directory stages
exactly those files, one directory per published package:

```
npm/@deepseek-ai/<package>@0.1.6-alpha.2/package.json   (dsh.client + exports["./client"])
npm/@deepseek-ai/<package>@0.1.6-alpha.2/lib/client.js  (the factory bundle)
```

The bootstrap package (`@deepseek-ai/dsh-client-modules` itself) is part of
the roster: the graph's `bootstrap` phase is defined as exactly that id
(`PARSER_PRELOAD_IDS` upstream); the other 57 packages form the
`application` phase (the shell's UI plugins).

## Roster derivation (ROSTER.json)

`roster.mjs` derives the roster from the upstream checkout, not from a
hand-written list:

1. read every `- name:` row of `packages/bundle/web-app/cordis.patch.yml`
   (the shipped web composition — the desktop's `dsh-web-app` package);
2. keep the packages whose manifest declares `dsh.client.platform = web`;
3. close over the declarations' `inject` + `external` fields (a bundle's
   externals must resolve to a graph row or a shell-static module, or
   materialization fails loud — the closure is therefore exact);
4. subtract the shell-static modules the vite entry shares through the seed
   table (`react`, `react-dom`, `@deepseek-ai/cordis`, `dsh-client-store`,
   `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`
   — compiled into the entry chunk, never fetched from `/plugins`).

Result at this pin: 58 packages, 116 staged files, 5.8 MB. `ROSTER.json` is
the generated record (names, versions, declarations, file lists).

## Excluded from staging (named gaps, not fakes)

- **Source maps** (`lib/client.js.map`): the graph serves identity maps when
  a map file is absent — upstream's own `ENOENT` fallback. Same allowlist
  choice as the `dist/` vendoring.
- **Package-local chunks** (`client.<name>.js`; recorded per package in
  `ROSTER.json.chunks`): off the boot path (lazy `require.async` inside
  their owner bundle — the terminal and document-preview panels) and carry
  most of the bytes (`client.pdf.js` alone is ~7 MB). A fetch for an
  unstaged chunk 404s — the same behavior upstream has for a stale-rev
  chunk — and the owning panel shows its error state. The carrier's chunk
  route is implemented, so staging a chunk later is a roster-list change,
  not code.

## Pin

- **Repository**: https://github.com/deepseek-ai/deepseek-harness
- **Commit**: `ddefc45fbc7f8e46dd73185e68295696d1297887`
- **Tag**: `dsh-v0.1.6-alpha.2` (same pin as `../dist` — see
  `../PROVENANCE.md` for the pin-authority records)
- **Version**: 0.1.6-alpha.2

## Build (reproduced 2026-09-20, re-verified 2026-09-21 and 2026-09-22)

- Toolchain: Node v24.14.0, pnpm 11.7.0 (the repo's `packageManager`
  field, via corepack), macOS arm64 (darwin 25.5.0).
- Command sequence: `./build-client-bundles.sh` — clone → checkout pin →
  `pnpm install --frozen-lockfile` → `pnpm run build:lib:host` (the client
  face type-checks against the host face's typert augmentations) →
  `pnpm run build:lib:client` (`tsdown --env.DSH_BUILD_FACE client`) →
  `roster.mjs` closure → staged allowlist copy → `MANIFEST.sha256.computed`.
- **The work dir, and its realpath, are part of the bytes**: the upstream
  build embeds the absolute source path in its outputs (`//#region
  dsh-css:<abs-path>` comments; the css-module class name is
  lightningcss's `[hash]_[local]`, which hashes that absolute virtual
  filename), so the build clones into the FIXED path `/tmp/dsh-harness-src`
  — never a random temp dir. Rebuilding anywhere else produces different
  (still verbatim-upstream) bytes that cannot verify this record.
- **And the fixed path is not one path across platforms**: `/tmp` is
  `/private/tmp` on macOS, so a macOS build and the Linux CI build differ in
  exactly the files that embed it — measured 2026-09-22: **40 of 116**, the
  same 40 files the Linux `dev-android` job reports as mismatching, and the
  same 40 that contain the path. Nothing else diverges; that bound is what
  `verify-manifest.mjs` enforces. A macOS↔Linux byte-identical record is not
  achievable while upstream's build embeds the path (the class-name hash
  cannot be normalised after the fact), so the record below is the REFERENCE
  build's record, and each environment's own record is the basis on which its
  tree is verified.
- The 2026-09-21 and 2026-09-22 re-runs at the fixed path each reproduced all
  116 staged files byte-identically (manifest sha256
  `e20c31675cbaff1068710083bdb71c660002860852471360e0f935deeda68abb`).
- Bootstrap bundle equivalence check: the workspace-built
  `dsh-client-modules/lib/client.js` is byte-identical (sha256
  `3f7769d5f860961d412810d6a88a359ba05fe19b77624bf6a31207dae6c22760`) to the
  vendored npm tarball the runtime stages
  (`runtime/spike/vendor/ensure-dsh.sh` pin); the manifests differ only in
  dependency ranges (`workspace:^` vs published ranges), which the
  `dsh.client` scan never reads.

## What is committed here

- `MANIFEST.sha256` — sha256 over every staged file (paths relative to
  `npm/`), sorted. This is the **reference build's** record (the one
  described under Build above); see the two-record note below.
- `ROSTER.json` — the generated roster record: the parts of the identity that
  are environment-independent (package names, versions, exact staged file
  list) and therefore verifiable everywhere.
- `roster.mjs`, `build-client-bundles.sh`, `verify-manifest.mjs` — the
  reproducible derivation, the recipe, and the comparison that bounds the
  divergence from the reference record.

The `npm/` tree itself is UNTRACKED (like `../dist`): content gates never
judge verbatim upstream JS, and the bytes are reproducible **at the fixed
work path, per environment**. Verify or materialize it with
`tools/e2e/ensure-client-bundles.sh`:

```sh
tools/e2e/ensure-client-bundles.sh            # verify, or rebuild + verify
```

### Two records, and what each one proves

| record | travels with | answers |
| --- | --- | --- |
| `MANIFEST.sha256.computed` (untracked, gitignored, cached with the tree) | the tree | "are these the bytes the build **in this environment** produced?" — the integrity question a cache restore can answer everywhere |
| `MANIFEST.sha256` (committed) | the repository | "are these the bytes the **reference** build produced?" — compared on every run, divergence bounded to the embedded-work-path class |

A build writes the first and **never renews the second**: a build that
re-issues its own certificate is not a verification, and the previous recipe
did exactly that (`MANIFEST.sha256` was regenerated at the end of every
build, so `ensure-client-bundles.sh` verified a freshly written record and
could never detect non-reproducibility — while the CI cache, keyed on the
committed record, could never hit either). `verify-manifest.mjs` is the
comparison: a divergence outside the work-path class fails loud, so the
reference record is not decoration.

Re-record the reference deliberately after reviewing the diff, and update
this file in the same change:

```sh
diff <(sort MANIFEST.sha256) <(sort MANIFEST.sha256.computed)
cp MANIFEST.sha256.computed MANIFEST.sha256
```

At this pin the tree is 58 packages, 116 files, 5.8 MB.

## Serving note (binding)

The `/plugins` route on the carrier serves these files at the upstream
combo/chunk URLs with revisions framed by the RUNTIME's composed graph
(`web.boot` over the bus seam); the carrier never invents roster rows. The
`dsh.client` scan itself runs inside the embedded spike runtime over the
bus-delivered file view — this directory is the staging source for both.
