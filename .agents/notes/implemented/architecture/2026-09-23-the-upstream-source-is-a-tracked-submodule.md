# Agent Note: the upstream DSH source is a tracked submodule — the reference baseline run against our pin

Status: implemented

## Problem

dsh-mobile consumed upstream DSH only through extracted artifacts (the
pinned npm-style tarball closure, and the test-support vehicles). Two things
that shape needed were missing: an auditable, version-controlled record of
the FULL upstream source our pin describes (the tarballs carry builds, not
the monorepo), and an authoritative upstream-side test baseline — how many
tests the tag itself passes under its own runner — which every
our-runtime number had been implicitly compared against without a measured
denominator.

## Decision

The upstream monorepo is now a **git submodule**:
`third-party/deepseek-harness` pinned at `ddefc45f` (= tag
`dsh-v0.1.6-alpha.2`, the same tag the vendored closure and the test-support
vehicles pin). The submodule is tracked (gitlink + `.gitmodules`), never
modified in place (D6: adaptations stay on our side of the seam), and
advanced only by deliberate pin moves. `git submodule update --init` is the
fetch step for anything that needs the source (the tag-source builds of the
~40 unpublished packages are the first planned consumer).

The baseline run (the pinned tag, its own vitest/Node, on this machine):
**26,282 tests — 25,435 passed / 654 failed / 192 skipped (1 expected-fail);
1,529 test files — 1,468 passed / 44 failed / 17 skipped; 551 s.** The 654
failures concentrate in process-bound surfaces whose support is partially
environmental on this host: session-persistence-jsonl (205) and subagent
(191) need native/system bits whose published platform matrix has
darwin-x64/linux but NOT darwin-arm64 (measured: `build:native-system`
warns "Unsupported platform" for this cpu/os; the root postinstall
(lefthook) also cannot install inside a submodule's split git config);
acp (96) and the experimental agent-team groups (44+37) follow. Our
compatibility surface against this baseline: the transpiled-on-our-runtime
suite is 31 green / 16 partial / 6 red of 252, with 199 blocked on
unpublished-package vendoring — now buildable from THIS submodule.

## Alternatives considered

- **A gitignored working-tree clone** — rejected (owner direction): it is
  invisible to the audit surface and cannot be advanced as a reviewable
  pin move; the submodule records the exact upstream commit in OUR history.
- **Rely on the extracted tarballs only** — rejected: they pin builds, not
  sources; the gap-fill rounds need the monorepo's sources and lockfile.
- **Fork the monorepo and pin the fork** (the quickjs pattern) — rejected
  for now: we modify nothing upstream; a fork would be an empty
  indirection until a divergence actually exists.
