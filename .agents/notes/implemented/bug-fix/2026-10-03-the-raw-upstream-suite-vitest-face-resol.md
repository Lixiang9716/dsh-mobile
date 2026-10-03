# Agent Note: the raw upstream-suite vitest face resolves its node-side deps through the vendor layout

Status: implemented

## Problem

The raw vitest face over the vendored upstream tests (`vitest run --config
test/upstream-suite/vitest.config.ts`, issue #321) failed to load whole file
families with `Cannot find package` — js-yaml ×63, node-addon-system/flock
×33, tsx ×34, chokidar ×16, jsdom ×10, @agentclientprotocol/sdk ×10 and a
~50-specifier long tail (264 occurrences, 61 distinct specifiers) in a
measured baseline of 532 failed / 251 passed of 785 files. The vendor tree
staged the dsh faces but almost none of the registry faces the specs
transitively import: the layout only linked a handful of packages into
`runtime/spike/vendor/node_modules` (the one `node_modules` on the specs'
real ancestor chain), so `test/upstream-suite`'s own `node_modules` —
never on that chain — could not help. The test-support vehicles were even
linked under shortened names (`@deepseek-ai/llm-replay`) that no importer
spells. The face has no CI consumer (weekly-sweep runs the transpiled
sweep), so nothing surfaced the gap until a human ran the raw face.

## Decision

`ensure-dsh-tests.sh` gains the test-face pins at the dsh-v0.1.6-alpha.2
pnpm-lock resolutions (each tarball sha256-pinned and mirrored into
`vendor/dsh-tarballs/`): js-yaml 4.3.1, picomatch 4.0.4, tsx 4.22.4 +
esbuild 0.28.1 (+linux x64/arm64 binaries), undici 8.10.0, fast-check 4.8.0
(+pure-rand), execa 10.0.0 with its 13-package transitive closure,
readable-stream 4.7.0 with its polyfill closure, sharp 0.35.3 (+detect-libc,
semver 7.8.5, @img/colour, the glibc linux @img binaries), compression 1.8.1
(+negotiator 0.6.4, debug/ms, bytes, vary, on-headers, compressible),
cross-spawn 7.0.6 (+path-key 3.1.1, shebang-command/regex, which, isexe),
@deepseek-ai/node-addon-system 0.1.2 (+both glibc linux platform packages),
@deepseek-ai/dsh 0.1.6-alpha.2 (the CLI entry `sdk/client` resolves
`@deepseek-ai/dsh/package.json` against) and
@deepseek-ai/dsh-sandbox-windows-acl (declared by the vendored
dsh-sandbox-local face). Deliberately NOT staged, named in the script:
koffi (tarball ships sources only), @anthropic-ai/claude-agent-sdk (peer
closure sits in known drift buckets), @earendil-works/pi-ai (AWS-SDK-sized
closure, same buckets).

`parity-node-modules.sh` now links EVERY vendored test face under its real
package.json name (generic loop; product-face links keep winning; a name
claimed by two test-face versions is reported loud and left to the explicit
staging below), fixes the vehicle links to their real names, and stages the
deliberate per-package decisions as nested symlinks: chokidar 4.0.3 for
settings-file/credentials-local and 5.0.0 for skill-filesystem and
webworker-runtime (dsh-tests sources and vendored closure faces both),
each chokidar with its own readdirp major, negotiator 0.6.4 nested inside
compression, path-key 3.1.1 inside cross-spawn, the @img binaries inside
sharp plus the unversioned `@img/sharp-libvips-linux-*` sibling the binding's
DT_RPATH expects, and the node-addon-system platform packages inside the
entry package. `test/upstream-suite/package.json` declares jsdom 29.1.1 —
vitest loads the jsdom environment from its own tree, so the tooling
manifest (not the vendor chain) owns it.

Measured on this tree (same materialization, only the fix differing): full
run 532→424 failing files of 785→795 collected, `Cannot find package`
264→31 occurrences; every residual is named — the `@deepseek-ai/dsh-*`
`/src/*` and `/invariant` families (~26, the source-face/lib-face semantics
the issue already scopes out — self-reference resolves against the extracted
source package.jsons whose `./invariant` points at an unbuilt `lib/`),
koffi ×1 (needs a build step), tsx ×1 inside webworker-runtime's
transform-corpus worker (individual triage).

## Alternatives considered

- Linking the missing packages from `test/upstream-suite/node_modules`
  (npm-install them and symlink that tree onto the chain): rejected — it
  would pin the suite's tooling ranges (^-ranges, whatever today's registry
  serves) as the spec face, off the vendor pin discipline; the vendored
  faces are sha256-pinned at the upstream lockfile resolutions.
- Aliases in `vitest.config.ts` (map bare specifiers to vendor paths):
  rejected — the config's doctrine is "no aliases, the verbatim vendored
  bytes", and the sweep's transpile-rewrites layer shows where aliasing
  leads; the raw face's point is to measure the plain resolution surface.
- A top-level chokidar/readdirp/picomatch link (one major for all): rejected
  — the consumers genuinely pin different majors (settings-file ^4,
  skill-filesystem ^5), and a silent glob-order pick would lie about which
  bytes ran; per-package nesting mirrors the pnpm workspace upstream runs.
- Pointing the `@deepseek-ai/dsh-*` links at the dsh-tests source trees to
  also fix `/src/*` and `/invariant`: rejected for this change — it would
  flip the whole face from the closure prove-out to run-from-source
  semantics (and `./invariant` still points at an unbuilt lib/), which is
  the issue's separate module-shape cluster, owned downstream.

## Consequences

The raw face is now a usable drift net: newly vendored test faces link
themselves by the generic loop, and a version collision fails loud instead
of silently choosing. The weekly sweep's node leg shares this layout and
gains the same resolution. Re-extracting the dsh-tests tree wipes the
nested links inside it; the layout script recreates them, so it must run
after `ensure-dsh-tests.sh` — the workflows already order it that way.
