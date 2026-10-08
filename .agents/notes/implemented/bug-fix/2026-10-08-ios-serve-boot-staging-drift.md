# Agent Note: the iOS serve boot boots again — three staging-drift layers closed at once

Status: implemented
Related: [[2026-09-22-the-ios-release-staging-phase-moves-into]], rule 5 (fail loud)

## Problem

The owner's first iOS Release run since the serve-seat era (2026-10-08) died
on every launch with `dsh.session.serve: runtime failed: web-boot eval:
ReferenceError: cannot load module …` — three independent drift layers, all
invisible to CI (the m1 legs drive a different boot path; the simulator-matrix
release leg is a non-gated ritual):

1. **19 embedded-but-never-staged modules** (`BundleStager.swift`): seven
   top-level boot.js imports (boot-coverage-rows, boot-subagent-rows,
   retry-telemetry, tool-deadline, turn-recovery, turn-watchdog,
   web-search-keyless) plus twelve transitive faces (llm-read-idle,
   llm-retry-pacing, model-selection-holder/-projection, tool-path-anchor,
   five web-write splits, wire-logger, workspace-registry) arrived with the
   loop-* fix rounds and #409/#411/#412 — the bytes were always in
   SpikeBundle.c, the hand-edited write rows never followed.
2. **A literal `%s` in a generator tuple** (`gen_bundle_header.py`): the
   api-full-coverage block formatted the SOURCE path but not the DESTINATION,
   so dsh-goal / dsh-file-reference(-local) / dsh-llm-retry all staged into
   one `vendor/npm/@deepseek-ai/dsh-%s@0.1.6-alpha.2/` directory,
   overwriting each other — every vendored-probe resolution of those
   packages failed since the tuple was written.
3. **Four plugin dirs missing from the TREES embed** (dsh-ble,
   dsh-device-plane, dsh-plugin-manager-tools, dsh-shell-wasm): only office
   rode a whole-dir tree row; the others' index.js + manifest.json had
   per-file rows, and `dsh-shell-wasm/programs.js` (imported by index.js)
   was never listed anywhere.
4. **domino's package.json absent from the staged tree**: the package rode
   a lib/-only tree row, but cjs-loader's BARE_PACKAGES loads it through
   loadPackageEntry, which reads `<dir>/package.json` for `main` — the
   missing manifest made the entry fall back to `'.'`, and the boot died at
   `require('./.')` when tool-web's turndown chain required domino bare
   (QuickJS has no DOMParser global). In Release this failure is invisible
   (its log line is debug-level, stripped by DSH_RELEASE) and the seat
   waits forever on `settings.probes.done` — the eternal "正在启动 DSH…"
   splash.

Android's committed assets and harmony's generated closure were both already
correct — iOS is the only hand-list host, and it drifted.

## Decision

- `BundleStager.swift` gains all 19 write rows, grouped with comments that
  name the layer and the live measurement (the serve boot named the modules
  one by one; the final list was diffed against harmony's generated
  `tools/generated/staging/harmony-BUNDLE_FILES.rows` to end the
  whack-a-mole — everything else in that closure either already had a row or
  rides the shims/vendor trees).
- The generator tuple's destination gets its `% n` (with a comment naming
  the literal-`%s` symptom: the staged tree named the bug).
- The four plugin dirs become TREES rows — the office row's whole-dir rule,
  applied to the rest ("a file joins the embed by existing, not by list
  edit").
- domino's package.json rides an explicit FILES row beside the lib/ tree
  (the cordis manifest pattern). A whole-dir row was tried first and broke
  the stager's fail-loud empty guard on the package's zero-byte
  `.yarn/versions/*.yml` junk — the explicit-file row avoids embedding it.
- Verified end-to-end on BOTH flavors: Debug (`-dsh-mode serve`) logs the
  full event chain (runtime.booted → settings.preset.roster →
  settings.plugin.inventory → settings.pluginManager.readonly) and the
  carrier takes 33 inbound page connections; the user-facing Release boots
  to the 内测声明 modal over the live sidebar (screenshot evidence,
  tmp/release-watch + /tmp/dsh-release-final.png this session).

## Alternatives considered

- **Stage the whole runtime/dsh tree on iOS** (harmony's approach): rejected
  for this change — it would bury which subset the serve boot actually needs
  and balloon the staged payload; the per-file rows plus tree rows now match
  the harmony closure's upstream/ surface exactly.
- **Wait for the loader to fail loud on each name and add rows one at a
  time**: that IS how layers 1–3 were found (the boot names one module per
  death); the harmony-closure diff exists so it never has to happen again
  for this class.
- **Fix only the first seven (boot.js top-level)**: measured insufficient —
  the next launch died on llm-read-idle.js (a transitive import), proving
  the diff had to be closure-wide.

## Consequences

- Any future module that boot.js (or its import graph) gains still needs a
  BundleStager row or a TREES row on iOS — the structural guard would be a
  gate that diffs the iOS staged set against the harmony closure; not built
  here.
- The `%s` bug means every iOS build since the api-full-coverage tuple
  landed carried a broken vendor/npm scope — Debug drives never imported
  those packages on this path, so nothing red fired.
