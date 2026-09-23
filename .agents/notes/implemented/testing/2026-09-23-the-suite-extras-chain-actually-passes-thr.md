# Agent Note: the suite-extras chain actually passes through CI — the double-prefix vendor URLs, the missing lockfile, and the runner that could not build

Status: implemented

## Problem

PR #164 wired the harmony upstream-suite leg end to end but was merged
before any CI run reached the new steps (CompileArkTS failed first — see
the bug-fix note beside this one). With the ArkTS green, the next CI run
(run 35829896159) fell over at `ensure-dsh-tests.sh`: "shasum: WARNING: 1
computed checksum did NOT match". The cause was never a bad pin —
`ensure_npm` prefixed EVERY registry package name with `dsh-`, and the
test-closure table (185 of its 193 rows) already carries the prefix:
`dsh-agent-default-model` became the URL `@deepseek-ai/dsh-dsh-agent-default-model`,
which the registry answers with 404 JSON that `curl` (no `-f`) happily
saved as "the tarball", dooming the shasum step to a baffling mismatch.
Two more breaks sat behind it, equally unexecuted: the workflow's
`npm ci --prefix test/upstream-suite` can never pass on a fresh checkout
(the founding-commit .gitignore blanket-ignores `package-lock.json`, so
none was ever committed), and `run-upstream-suite.sh`'s build step ran
`bash "$DSH_CLT" hosts/harmony` — executing the CLT directory as a shell
script — while ignoring every hilog/capture convention the two reference
runners had already paid for in postmortems.

## Decision

Four fixes, each verified as far as this machine (no CLT locally) allows.
(1) `ensure_npm` prefixes only unprefixed names (`case dsh-*)`), and the
download now fails LOUD at curl (`-f` + the package named) and at shasum
(the package named) — run locally end to end, all 193 pins fetched and
sha256-verified ("upstream test assets ready"; the correct-URL digest of
`dsh-agent-default-model@0.1.6-alpha.2` matches the existing pin byte for
byte, so the table itself was always right). (2) `.gitignore` gains a
targeted negation and `test/upstream-suite/package-lock.json` is committed
— `npm ci` becomes reproducible instead of impossible. (3) The dry chain
beyond the fix is proven locally: transpile (636 specs), `--closure-only`
(byte-verified, check-bundle-files 324=324), `--suite-extras` (1479-line
manifest: 636 corpus specs + manifest.json + 217 packages' lib files and
package.jsons; 0 missing, 0 dupes, 0 packages with lib/ left unstaged).
(4) `run-upstream-suite.sh` is rewritten to the run-host-e2e/run-live-llm
conventions: hvigorw/ohpm build from `$DSH_CLT/bin`, hdc resolved from the
CLT toolchains, bounded device/install polls, hilog flow control OFF with
the loud warning, per-spec force-stop verified by pidof, launch verified by
process (not aa start's exit code), completion polled on the real
`suite/summary` record (the old script grepped `dsh.spike: ALL` — a line
no component emits), and the VERDICT read from the pulled
`dsh-suite-capture.log` (truncated per launch by C-side `fopen "w"`),
never from the hilog stream.

## Alternatives considered

- "Repin the table from a fresh fetch" — wrong diagnosis layer: the pins
  were correct; the URL construction was not (proven by fetching the
  correct URL and matching the existing digest).
- `npm install` in the workflow instead of committing a lockfile — works,
  but transitive drift in a CI that exists to prove reproducibility is the
  worse trade; the negation is one line and names its reason.
- Keeping the runner's stream-parsed verdicts — rejected by the repo's own
  rule (checkers read pulled captures, truncation-proof); the hilog stream
  stays as the completion signal only.
- Waiting to fix the runner until an emulator exists in CI — the runner is
  the document a future emulator-vehicle author will copy; landing it with
  a never-worked build step and a wait on a nonexistent marker line would
  poison that copy with two silent dead ends.

## Consequences

The runner remains UNEXECUTED anywhere (no CLT, no device on this machine;
CI has no emulator) — it is convention-aligned and shape-verified against
committed capture artifacts, nothing more. The next full CI run of
`dev-harmonyos` is the first that can actually reach the suite-HAP upload;
whether the HAP installs and the leg runs on a real device is still
unproven surface, honestly labeled in docs/e2e-matrix.md.
