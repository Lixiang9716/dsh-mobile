# Agent Note: the vendor present-check becomes pin-stamped — a stale engine can no longer compile silently

Status: implemented

## Problem

`ensure.sh` (quickjs-ng) and `ensure-wasm3.sh` decided "already vendored"
by checking only that the pinned FILE NAMES exist on disk; the tarball
sha256 was verified exclusively at fetch time. A vendor tree materialized
under an OLDER pin therefore passed the check forever while carrying
stale bytes — and because tar preserves the upstream archive's mtimes,
the platform compilers (ninja/cmake) also saw nothing to rebuild. This
exact sequence consumed the 2026-09-24 overnight session: a pre-fork
quickjs (no async-context intrinsic) sat in `runtime/spike/vendor/
quickjs-ng/0.17.0/` from September 19, compiled into every local build,
and the failure surfaced far from the cause — every upstream agent turn
died with `not a function` inside the node:async_hooks shim
(`runWithInitiator`, dsh-agent), reading like a runtime regression until
the engine was diffed (issue #180). CI never saw it because its vendor
cache key rotates with the pin scripts' hash, so CI always rebuilt fresh
— the hole fires only on long-lived development trees.

## Decision

Both scripts adopt the stamp discipline `ensure-zstd.sh` already used:
the presence check requires `.vendor-pin` (holding the pinned tarball
sha256) to exist AND match AND the file list to be complete; a verified
fetch wipes the directory, re-extracts, and writes the stamp. Consequences
of the shape: a stale tree (right names, wrong/absent stamp) re-fetches
once and re-stamps; a half-written tree re-fetches; the wipe before
extraction also removes files a previous pin extracted but the current
one no longer lists. CI impact is one extra fetch per cache key, and the
cache keys already rotate on `hashFiles('runtime/spike/vendor/ensure.sh',
...)`, so no workflow change is needed.

## Alternatives considered

- Verifying content sha256 over every vendored file on every run —
  stricter than upstream evidence warrants (the tarball hash already
  pins content transitively) and slow enough to matter on the six CI
  workflows that call these scripts.
- Bumping the directory name with the pin suffix — the directory is
  hardcoded in three platform build files precisely because a
  suffix-coupled rename broke the harmony build once before; the stamp
  decouples identity from path instead.

## Consequences

Reproduced and verified: stamping the freshly fetched quickjs tree
(after the overnight incident's manual `rm -rf` + re-fetch) reports
`present (pin-stamped)` on the second run, and a tree with its stamp
removed re-fetches and re-verifies. wasm3 gains the same guarantee
before its next pin change, not after its first stale-tree incident.
