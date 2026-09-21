# Evidence — the user-facing build (`dsh-harmony`), plain launch

Proves the HarmonyOS release HAP SERVES the official DSH Web UI with no
verification machinery, that it still refuses an E2E drive LOUD by name, and
that the harness is unchanged. All from the same command:

- Run: `hosts/harmony/artifacts/release-logging/run.sh` (builds BOTH
  configurations, launches with NO launch parameter and NOTHING staged,
  asserts every count — exit non-zero on any violation).

The two configurations are built with a clean of `entry/build` + `entry/.cxx`
in between: hvigor's `buildMode` does not enter the native output path, so the
second mode otherwise packs the first mode's `libspike.so` (a log-stripped
"debug" build — observed, then recorded in the surprise ledger). The counts
below are the proof the right library was packed.

## Release (`dsh-harmony`) — plain launch

| assertion | result |
| --- | --- |
| `dsh.spike.log:` records — FULL hilog window | **0** (`plain-launch-release.records.txt`, empty by construction) |
| `dsh.spike.log:` records — the capture file | **0** |
| `dsh.spike.verdict` verdict text | **0** |
| `"level":"debug"` / `"level":"info"` records | **0 / 0** |
| `dsh.*` lines from the app's own tags | the serving facts only (`plain-launch-release.dsh.txt`) |
| official origin served to ArkWeb | `arkweb: controller attached for http://127.0.0.1:17890/?token=…` |
| the official client module system live | `carrier: ws established /api/remote.mux` (the page's own seat) |
| official index finished loading | `arkweb: page end http://127.0.0.1:17890/` |
| official DSH Web UI rendered | `plain-launch-release.png` — the DSH sidebar, the workspace picker and the composer, full screen, no verdict panel |

Nothing was staged into the app container and no launch parameter was passed:
the dist + client bundles are served straight from the shipped rawfile tree and
the boot rows come from the in-runtime composer (the serving seat,
`model/OfficialServe.ets`).

## The refusal (rules.md rule 5)

`aa start … --ps dsh.e2e.leg m2.llm` on the same release HAP stops with:

```
release build: refusing: dsh.e2e.leg m2.llm asks for a verification drive; a
user-facing build runs none — use the harness variant (dsh-harmony-harness) to
drive E2E legs
```

(`refusal.txt`; also rendered on screen — `refusal.png`.) The refusing window
carries **0** `dsh.spike.log:` records (`refusal.records.txt`).

## Harness (`dsh-harmony-harness`) — unchanged

Same host, debug configuration, the same plain launch (no leg parameter) runs
the full default chain (regression trio → m5 binding → the four D9 legs) and
emits the full structured stream: **832 records** across the six capture files
(`harness-contrast.txt`), where the release build emitted **0** in the same
window. All eight checker verdicts stay green, one manifest each:

| manifest | events matched |
| --- | --- |
| `m1-spike.boot` | 7/7 |
| `m2.bridge.smoke` | 6/6 |
| `m2.session` | 23/23 |
| `m5.host-binding` | 27/27 |
| `b-harmony.official-web-mount` | 17/17 |
| `b-harmony.httpfetch-v2` | 6/6 |
| `b-harmony.session.live` | 43/43 |
| `b-harmony.write.live` | 33/33 |

The committed per-leg evidence for that suite — captures, verdicts,
screenshots — is unchanged under `artifacts/d9-official-web/`,
`d9-session-live/`, `d9-write-live/` and `m5-host/`.

Files: `plain-launch-release.{png,dsh.txt,records.txt,capture.txt}`,
`refusal.{png,txt,dsh.txt,records.txt}`, `harness-contrast.txt`, `run.sh`.
Screenshots are supplementary — every verdict above is a log assertion; the
`.dsh.txt` files are the hilog window's `dsh`-tag lines (milestone-artifact
convention, cf. `artifacts/m5-host/logs.txt`), while the assertions ran over
the FULL window.

## Device prerequisites the runner sets (and why)

`hilog -Q pidoff` + `hilog -Q domainoff`: hilog flow control drops the
canonical record stream under burst. The committed d9-* artifacts carry 6 of
the httpfetch leg's 368 records, and one run delivered none of the four lines
`ci/drive-official.mjs` waits for while every leg had in fact completed (all
four capture files carried their terminal verdicts) — the drives read the
stream, the checkers read the files. Off for the duration of a drive; a
temporary setting (lost on reboot), not a code path.
