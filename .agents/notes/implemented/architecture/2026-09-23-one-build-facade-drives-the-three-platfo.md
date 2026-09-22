# Agent Note: one build facade drives the three platforms, and the periphery ring moves out

Status: implemented

## Problem

The owner's read of the repository ("架构太乱") was accurate on three counts.
First, there was no single build entry: building or testing a platform meant
knowing five script locations (hosts/<p>/ci/*, runtime/spike/ci/*,
tools/e2e/run-*.sh) and which of them the CI workflow for that platform
actually ran — knowledge that lived in workflow YAML and nowhere else.
Second, the outer ring did not read as periphery: test tooling lived under
`tools/e2e` beside release tooling under `tools/release`, so the tree's top
level mixed project surfaces with project-adjacent surfaces.
Third — the load-bearing one — the committed host copies of the canonical
`runtime/spike` closure drifted silently: CI re-stages before every build, so
`dev/harmonyos` was green while five rawfile files sat stale on main, the
committed iOS generated bundle could sit stale, and `Index.ets`'s BUNDLE_FILES
expected `vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs` that no closure list
staged — a harmony launch that would throw at copyRawfile, invisible to every
green check (the m5 surprise ledger's exact failure mode, measured again
2026-09-23).

## Decision

The repository is layered periphery-around-project, and one facade drives it:

- `build/build.sh` is the single build entry: `build|test|check|sync` ×
  `ios|android|harmony|core|all` (one or many platforms). `build` means
  sync → compile → test, per platform, running the EXACT commands the
  matching dev/<platform> CI workflow runs — mirroring is by construction,
  and BUILD.md keeps the mapping table. A missing toolchain fails loud naming
  the tool and how to get it (rule 5).
- The periphery ring at the top level is now `build/` (the build system),
  `test/` (was `tools/e2e` — the log-verified e2e checker, scenarios,
  runners), `docs/` (unchanged), `packages/` (was `tools/release` — the
  release/packaging surface); `tools/` keeps only the govrail checker
  scripts. Inner: `contract/ runtime/ system-plugins/ presentation/` (the
  shared core, one copy — the DSH method, D6/D9) + `hosts/{ios,android,
  harmony}` (the three platforms).
- The `closures` gate (`build/check-closures.sh`, wired via `gov gate add`)
  makes the committed copies themselves a claim that can fail: android and
  harmony stagers gained `--check` (byte-verify, no writes — a gate that
  heals what it checks is vacuous), iOS verifies by deterministic regen +
  `git diff --quiet` with restore. Rejection proven live: a one-byte probe
  in a staged copy fails the gate naming the file. The same change lands
  the harmony re-sync (10 stale files + the missing js-yaml + its closure
  list entry) so the gate is born green, and fixes the latent launch break.

## Alternatives considered

- Rewire the CI workflows to call the facade — the real end-state, deferred:
  the facade's commands are copied verbatim from the workflows, so there is
  no drift today, and rewiring five green workflows in the same change as a
  layout restructure stacks risk for symbolic gain. A pilot rewiring lands
  separately.
- Delete the committed host copies and generate at build time — the copies
  are deliberate (Android assets and HarmonyOS rawfile are committed so the
  APK/HAP is self-contained and the platform IDEs see the files; D6's
  committed-pin posture). The gate keeps them honest instead.
- Keep `tools/e2e` + `tools/release` where they were and only add `build/` —
  half the owner's ask (the outer ring) left unstated in the tree, and the
  test/release surfaces would keep masquerading as misc tooling.
- A Makefile/justfile instead of `build/build.sh` — another tool dependency
  for zero expressive gain; POSIX sh is already the repo's scripting layer.
