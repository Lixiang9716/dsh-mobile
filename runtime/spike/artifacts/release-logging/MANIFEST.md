# Evidence — release log strip on the desktop CLI (`macos-cli`)

The two logging regimes the platform Release configurations produce, run
against the SAME bundle on the cheapest host. Debug is the harness: full
structured logging. Release (`-DDSH_RELEASE`, the shared C host injecting
`globalThis.__DSH_RELEASE__`) keeps only the critical set.

- Run: `runtime/spike/artifacts/release-logging/run.sh` (builds both CLI
  variants, runs both probes, asserts the counts — exit non-zero on any
  violation).
- The final line of a green run: `debug=18 records, release=0 records;
  levels debug=4 → release=2 (warn+error only)`.

## The numbers

| probe | debug | release | assertion |
| --- | --- | --- | --- |
| `scenario/m2-bridge-smoke.js` (a real E2E scenario) | 18 records (12 `debug`, 6 `info`) | 0 records | release carries ZERO `"level":"debug"` / `"level":"info"` |
| `probe/probe.js` (one record per level) | 4 records (`debug`/`info`/`warn`/`error`) | 2 records (`warn`/`error`) | the critical set SURVIVES the strip |

Files: `m2-bridge-smoke.debug.txt` / `.release.txt`, `levels.debug.txt` /
`levels.release.txt` (raw CLI stdout), `probe/probe.js` (the level probe —
it imports the canonical `runtime/spike/logger.js`, which `run.sh` copies in
beside it so no third committed copy of the logger can drift).

## Why this is the same mechanism the apps run

`runtime/spike/logger.js` is embedded byte-identically into all three hosts
(iOS C arrays, Android assets, HarmonyOS rawfile). It is the logger the
shipped app actually runs; `runtime/logger/index.ts` is the canonical
declaration and is bundled by nothing. Before this change the operative
logger had no release branch at all and no build config defined the flag —
the mechanism was cosmetic. `tools/check-logging.py` L4 now fails on exactly
that tree (`.gov/rejections/case-logging-l4.sh` proves it).

The device halves of this evidence: `hosts/ios/artifacts/release-logging/`
(the user-facing plain launch) and the per-platform builds in the PR body.
