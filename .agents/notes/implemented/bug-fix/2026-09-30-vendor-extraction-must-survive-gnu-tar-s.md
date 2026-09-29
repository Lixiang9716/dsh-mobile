# Agent Note: Vendor extraction must survive GNU tar's immediate directory-mode restore

Status: implemented
Related: D6

## Problem

The npm pin materializer extracts registry tarballs verbatim, and
pngjs@5.0.0 packs every directory `drw-rw-rw-` (no execute bit). The two
tar flavors disagree on what that means mid-extract: bsdtar (macOS) defers
all directory modes to the end, so local trees always extracted clean and
only the post-state was wrong (fixed 2026-09-29 by the trailing
`chmod -R u+rwX`); GNU tar (CI, ubuntu) applies a directory's archived mode
the moment the entry lands, so pngjs's `lib/` and `coverage/` blocked their
OWN children and `tar xzf` itself died `Cannot open: Permission denied`
across `lib/*` and `coverage/lcov-report/*` before any chmod could run
(PR #246, 2026-09-30 — `gates` and `harmonyos-build` both red on the same
root). A fix verified only on a macOS checkout is therefore not verified:
the failing stage never runs locally.

## Decision

`fetch_npm` in `runtime/spike/vendor/ensure-dsh.sh` detects the tar flavor
(`tar --version`) and passes `--delay-directory-restore` to GNU tar, so
children extract before directory modes are restored; the existing
trailing `chmod -R u+rwX` then normalizes the end state on both hosts.
bsdtar needs no flag (it already defers). The pin rows, digest checks, and
materialized bytes are unchanged (D6: owner hygiene only).

## Alternatives considered

- `--no-same-permissions` on every host: also strips archived execute bits
  from files, silently changing exec semantics for all pins to fix one —
  wider blast radius than the defect.
- Route all extraction through the python3 `tarfile` fallback (the
  `ensure-dsh-tests.sh` pattern): a bigger rewrite of the hot path for a
  one-tarball problem; mode handling would still need the trailing chmod.
- Re-pack or exclude `coverage/` from the pngjs mirror: edits the pinned
  bytes, which D6 forbids — the mirror is the verbatim pin record.
- Do nothing and wait for upstream to repack pngjs: the registry tarball
  is content-addressed by the pin's sha256; a re-pack changes the pin, not
  this repo's exposure to the next modeless-packaging package.
