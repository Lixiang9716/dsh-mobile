# Agent Note: the frozen dsh-runtime ref pins the commit SHA, not the moving master branch

Status: implemented

## Problem

`ensure-dsh.sh` fetched the pinned 0.1.6-alpha.2 closure from
`raw.githubusercontent.com/anywhere-labs/dsh-desktop/master/vendor/dsh-runtime/0.1.6-alpha.2`
— "master" plus a directory upstream treats as per-beta-channel storage. On
2026-09-22 upstream's beta channel moved to 0.1.7-alpha.2 and DELETED the
0.1.6-alpha.2 directory from master (surprise sig
`the-016-alpha2-dsh-runtime-tarballs`, recorded 02:57Z that day). Every
workflow survived only because their Actions caches still held pin-stamped
trees; the first cold materialization — my new dev-harmonyos step exposing
exactly this hole — died fetching `dsh-agent` with three 404s (run
35831318313). The npm registry is no fallback: it re-cut the same version's
tarballs (verified 2026-09-23: dsh-agent/brand/agent-loop digests all
differ from the pins), which is the same upstream re-cut behavior the
2026-09-22 re-pin note already documented.

## Decision

DSH_BASE pins the commit SHA `a934d988610605078001d7c22bbaa2435cbeb385`
(2026-09-18, "beta 通道切到 dsh 0.1.6-alpha.2 内核" — the commit that
introduced the tree) instead of the `master` ref. Git history is immutable;
the bytes at that SHA match every pin in the table (proven by re-fetching
`dsh-brand` through the fixed URL: sha256 verified, pin-stamped, digest
47e97c6e… identical; `dsh-agent` verified the same way during diagnosis).
A comment at DSH_BASE names the deletion, the surprise sig, and why the
registry is not the source, so the next tag bump re-pins deliberately.
Note the side effect: ensure-dsh.sh is in the vendor-cache hashFiles key,
so this change rotates every workflow's vendor cache once — the first run
after merge does a full ~219-tarball materialization from the frozen SHA
and re-seeds the caches; that run is the cold-path proof.

## Alternatives considered

- Switch to the npm registry (the ensure-dsh-tests.sh source) — rejected:
  the registry tarballs are re-cuts, byte-different from the pins the whole
  closure is stamped against; re-pinning 219 packages to new digests is a
  closure-wide event, not a source fix, and would desynchronize the
  harmony/iOS/android committed rawfile copies until every one re-synced.
- Mirror the tarballs into THIS repository — rejected: vendoring by copy is
  the D6 anti-pattern; the provenance scripts are the record.
- Ask upstream to keep tag directories forever (an issue on
  anywhere-labs/dsh-desktop) — worth filing, but the fix must not depend on
  a third party's release hygiene; the SHA pin works regardless.
