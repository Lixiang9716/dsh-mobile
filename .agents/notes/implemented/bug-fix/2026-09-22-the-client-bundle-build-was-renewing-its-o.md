# Agent Note: the client-bundle build was renewing its own manifest — the record is environment-bound, and now it says so

Status: implemented
Related: D15, D9, D6

## Problem

CI printed this on every `dev/android` run, and had for as long as the tree
existed:

```
ensure-client-bundles: npm tree present but MANIFEST mismatch — rebuilding
./@deepseek-ai/dsh-client-locale@0.1.6-alpha.2/lib/client.js: FAILED
… (40 files)
```

Three things were wrong at once, and only the third was visible.

**The build renewed its own certificate.** `build-client-bundles.sh` ended by
regenerating the tracked `MANIFEST.sha256` from the tree it had just produced,
and `ensure-client-bundles.sh` then rebuilt and verified against that file. So a
cold run could not fail: the record was written by the thing it was supposed to
judge. The `MANIFEST mismatch — rebuilding` line above is that loop mid-flight —
the cache had restored a tree from an earlier rebuild, the committed record
disagreed with it, and the next rebuild would overwrite the record again.

Consequently the cache never hit: the cache key includes
`MANIFEST.sha256`, and the cache saved trees that the committed record could
never verify, so every run rebuilt (the 230 s step in `dev/android`, more in
`release/ios`) and re-saved the same useless entry.

**And the underlying bytes are not reproducible across environments.** Measured,
not inferred: a fresh build on this machine reproduces the committed record
exactly — all 116 files, manifest sha256 `e20c3167…`, twice (2026-09-21 and
2026-09-22) — so the build is deterministic *given its environment*. What
differs in CI is the environment: the upstream client build **embeds the
absolute work path** in its output, both as the `//#region \0dsh-css:<abs-path>`
markers and through lightningcss's css-module class name (`pattern:
'[hash]_[local]'` hashes the absolute virtual filename). The work dir is pinned
(`/tmp/dsh-harness-src`), but its *realpath* is not the same everywhere: macOS
resolves `/tmp` to `/private/tmp`, Linux does not.

The bound is exact, and it is the whole story: **the 40 files CI reports as
mismatching are precisely the 40 files that contain the path** — compared
name-for-name between the CI log of `main` and `grep -l dsh-harness-src` over a
local build. Nothing else diverges.

## Decision

**Two records, two questions, and the build only writes the one that travels
with the tree** (D15).

| record | travels with | answers |
| --- | --- | --- |
| `MANIFEST.sha256.computed` (gitignored, cached with the tree) | the tree | the bytes *this* environment built |
| `MANIFEST.sha256` (committed) | the repository | the bytes the *reference* build produced |

`verify-manifest.mjs` is the comparison between the tree and the committed
record, and it **bounds** the divergence rather than forgiving it: a file whose
digest differs is accepted only if its bytes embed the work directory (as the
path given, or with any leading directory prefix — what another platform's
realpath looks like), and any divergence outside that class fails loud, naming
the files. All five outcomes were exercised against real trees: identical
(byte-for-byte PASS), a non-path divergence (FAIL, named), a path-class
divergence (PASS, named), a missing file (FAIL), an extra file (FAIL).

Consequences wired through: the build writes and verifies its own record and
never touches the committed one; `ensure-client-bundles.sh` verifies against the
committed record (the reference environment, or any tree that matches it),
otherwise against the tree's own record and then reports the bounded divergence;
`runtime/spike/ci/web-plugins-payload.mjs` verifies against the tree's record
(the one that can exist where the tree is) and says where the reference
comparison happens; the three workflows cache the computed record alongside the
tree, which is what makes a cache hit possible; `PROVENANCE.md` documents the
two records and the deliberate re-record procedure, and carries the measured
40-of-116 bound so the next reader does not re-derive it.

The reference record is not decoration: it is compared on every run by
`ensure-client-bundles.sh`, and a real byte change (a pin change, a toolchain
change, a tampered tree) lands outside the class and fails.

## Alternatives considered

**Patch upstream's css-module build to hash a path-independent filename.**
Rejected: it is the only route to genuinely byte-identical records across
platforms, but it means vendoring a *modified* upstream build — against D6's
never-vendor-modified-copies discipline and this directory's "no upstream file
was modified" — and it would regenerate all 116 staged files, invalidating the
official-web boot evidence on all three hosts. A product change wearing a
build-script costume.

**Commit the Linux CI build's record instead, making the pipeline the reference
environment.** Rejected: it moves the divergence to the developer's machine
rather than removing it, silently re-arms on any runner-image change (node
major, Ubuntu base), and leaves the record verifiable in exactly the one
environment that never needed help.

**Record per-file normalised digests (work path replaced by a placeholder) so
any environment could verify the reference record exactly.** Rejected on
measurement: the css-module class name is a hash *of* the path, not the path
itself, so normalisation cannot equalise it — the check would reject every
environment, the reference one included. This is why the class bound is the
strongest statement available.

**Only verify the tree against its own record (drop the committed one).**
Rejected: it removes the comparison that catches a real byte change, and the
committed record would become documentation that nothing reads — the same
decorative fate as the old one, one step quieter.
