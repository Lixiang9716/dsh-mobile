# Agent Note: the staged spine-root closure carries install-fetch.js + receipt-journal.js on android and harmony

Status: implemented
Related: D9

## Problem

PR #288's marketplace UI face gave `upstream/web-write-marketplace.js` static
imports on `../install-fetch.js` and `../receipt-journal.js`. The serve-boot
chain (`scenario/composer-web-live.js` → `upstream/web-write*.js`) therefore
dies at import-link on every host whose staged bundle is a curated mirror
that predates those imports. The first symptom surfacing was the Android
release seat (simulator-matrix release leg, 2026-10-01, tree 3f463c4, WSL2
emulator API 35): `SessionServe: FAIL serve bootstrap — ReferenceError:
cannot load module 'install-fetch.js'`, and with the spine dead the page
never receives the `__ModuleLoader__` injection rows, so the official client
renders "Failed to load plugins". No gate caught it: `closures` byte-checks
only the files its hand lists name, `staging-check`'s android surface reads
the same rows ("clean"), and `bundle-files` cross-checks the harmony list
against Index.ets — both lists were stale together. CI stayed green because
dev/android compiles and unit-tests only; the release boot has no CI leg
(the matrix is deliberately unwired, a release ritual — and it had not been
run on this machine before).

## Decision

The spike-root hand lists on both curated hosts now carry the two modules
the serve-boot chain imports: `hosts/android/ci/stage-spine-closure.sh`
(staging loops and the drift-check loop) name `install-fetch.js` and
`receipt-journal.js` beside the existing six, and `hosts/harmony/ci/
vendor-official.sh`'s `SPIKE_ROOT` gains the same two with `Index.ets`'s
`BUNDLE_FILES` mirrored (the bundle-files cross-check stays 951 = 951 in
both directions). The committed mirrors carry the staged bytes
(`assets/spike/`, `rawfile/spike/`), byte-identical to `runtime/spike` —
the single source. The other three unreferenced spike-root modules
(`config-layer.js`, `marketplace.js`, `semver-range.js`) stay unstaged:
only CLI-side scenarios import them today, and staging unreached files
would hand the staging-check rows with no graph justification.

## Alternatives considered

- Whole-directory mirror of `runtime/spike/*.js` (the script's own
  upstream/ philosophy, drift-proof by construction): rejected for this PR
  because the staging-check host surface parses the hand rows, so reshaping
  the lists is a gate-tooling change that deserves its own round; the two
  missing modules close today's boot-killer exactly.
- Extending `check-staging-hosts.mjs` so a graph-reached-but-unstaged file
  fails the gate (the real class fix — this drift was invisible to every
  gate): agreed it should exist, filed separately; it does not repair the
  on-device red by itself and ships later.
- Fixing only android (the host with evidence in hand): rejected — the
  harmony rawfile carries the identical import edge and would die the same
  death at import-link on the next on-device run.
