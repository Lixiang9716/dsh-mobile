# Evidence — release log strip on the desktop CLI (`macos-cli`)

The two logging regimes the platform Release configurations produce, run
against the SAME bundle on the cheapest host. Debug is the harness: full
structured logging. Release (`-DDSH_RELEASE`, the shared C host injecting
`globalThis.__DSH_RELEASE__`) keeps only the critical set.

- Run: `runtime/spike/artifacts/release-logging/run.sh` (builds both CLI
  variants, runs all three probes, asserts the counts per route — exit
  non-zero on any violation).
- The final lines of a green run: `debug=18 records, release=0 records;
  levels debug=4 → release=2 (warn+error only);`
  `sink routes debug=15 → release=7 (3 routes × warn+error)`.

## The numbers

| probe | debug | release | assertion |
| --- | --- | --- | --- |
| `scenario/m2-bridge-smoke.js` (a real E2E scenario) | 18 records (12 `debug`, 6 `info`) | 0 records | release carries ZERO `"level":"debug"` / `"level":"info"` |
| `probe/probe.js` (one record per level) | 4 records (`debug`/`info`/`warn`/`error`) | 2 records (`warn`/`error`) | the critical set SURVIVES the strip |
| `probe/sink-probe.js` (every sink route, one call per level) | 13 records + verdict | 6 records + verdict | the strip holds on the ROUTES, not only on `createLogger` |

### Per route (the sink probe)

| route (`module`) | debug `debug`/`info`/`warn`/`error` | release | assertion |
| --- | --- | --- | --- |
| `probe.sink` — `createLogger` (`runtime/spike/logger.js`) | 1 / 1 / 1 / 1 | 1 / 1 / 1 / 1 → **0 / 0 / 1 / 1** | release keeps warn+error only |
| `upstream.console` — the forwarding console (`upstream/web-shims.js`) | 1 / **2** / 1 / 1 | **0 / 0 / 1 / 1** | `console.log`+`console.info` → level `info`, `console.debug` → `debug`; both stripped in release, warn/error kept |
| `cordis:probe.boot` — the cordis logger exporter (`upstream/boot.js`) | 1 / 1 / 1 / 1 | **0 / 0 / 1 / 1** | the exporter route honors the same policy |

The console route's two `info` records in debug are the level mapping (5
calls landing in 4 levels), not a double emission; `run.sh` asserts them by
name, so a mapping change must be a deliberate edit.

Files: `m2-bridge-smoke.debug.txt` / `.release.txt`, `levels.debug.txt` /
`levels.release.txt`, `sink.debug.txt` / `sink.release.txt` (raw CLI stdout),
`probe/probe.js` (the level probe — it imports the canonical
`runtime/spike/logger.js`, which `run.sh` copies in beside it so no third
committed copy of the logger can drift), `probe/sink-probe.js` (the route
probe — it runs from the bundle root, so its three routes ARE the canonical
`runtime/spike/logger.js` / `upstream/web-shims.js` / `upstream/boot.js`),
`sink-route-rejection.release.txt` (the rule-6 proof: the pre-fix emitters
leaking, and `run.sh` going red when one gate is deleted).

## Why this is the same mechanism the apps run

`runtime/spike/logger.js` is embedded byte-identically into all three hosts
(iOS C arrays, Android assets, HarmonyOS rawfile). It is the logger the
shipped app actually runs; `runtime/logger/index.ts` is the canonical
declaration and is bundled by nothing. Before the first release-logging
change the operative logger had no release branch at all and no build config
defined the flag — the mechanism was cosmetic. `tools/check-logging.py` L4
now fails on exactly that tree (`.gov/rejections/case-logging-l4.sh` proves
it).

## Why the strip now belongs to the flag, not to upstream's silence

The first round of this evidence asserted the strip on `createLogger` alone.
Two other writers on the sink — the forwarding `console` in
`upstream/web-shims.js` (on the release graph through
`scenario/b-android-web-live.js` → `upstream/web-boot.js`) and the cordis
logger exporter in `upstream/boot.js` — wrote UNCONDITIONALLY. The release
captures were clean only because the vendored closure happened to contain no
`console.*` calls; the property rested on upstream's continued silence. The
fix puts the policy in ONE place (`runtime/spike/logger.js`:
`RELEASE_CRITICAL_LEVELS` + `releaseKeeps()`, consulted by all three
writers), and this probe exercises the two shim routes in BOTH builds so the
property is asserted instead of assumed. `sink-route-rejection.release.txt`
is the same probe's pre-fix ancestors leaking in a release build — the
assertions can fail.

The device halves of this evidence: `hosts/ios/artifacts/release-logging/`
(the user-facing plain launch) and `hosts/android/artifacts/release-logging/`
(emulator, both variants) plus the per-platform builds in the PR body.
