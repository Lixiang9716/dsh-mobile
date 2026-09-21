# Evidence — the user-facing build (`dsh-ios`), plain launch

Proves the ABSENCE of test machinery in the release build, and that the
harness is unchanged. Both from the same command:

- Run: `hosts/ios/artifacts/release-logging/run.sh` (builds both
  configurations, clears the container, launches with NO arguments and
  NOTHING staged, asserts every count — exit non-zero on any violation).

## Release (`dsh-ios`) — plain launch, empty container

| assertion | result |
| --- | --- |
| `dsh.spike.log:` records anywhere (stdout, stderr, os_log) | **0** |
| `dsh.spike.verdict` verdict text | **0** |
| `"level":"debug"` records | **0** |
| `"level":"info"` records | **0** |
| `dsh.gateway.audit:` lines | **0** |
| stdout / stderr bytes | 0 / 0 — nothing is printed at all |
| official Web UI rendered | `plain-launch-release.png` (the DSH sidebar, the workspace picker and the composer, full screen, no verdict panel) |
| embedded resources in the shipped `.app` | 89 dist files + 129 client-bundle files (byte-verified against `presentation/official-web` at copy time by `Tools/stage_official_web.py`) |

The container's `Documents/` was empty before launch: the client is served
from the EMBEDDED bundle resources, so a plain launch needs nothing staged
from outside.

## Harness (`dsh-ios-harness`) — the same plain launch

| assertion | result |
| --- | --- |
| `dsh.spike.log:` records | **83** (61 `debug`, 22 `info`) |
| embedded resources | the debug `.app` carries no `official-web` resource — the harness stages `Documents` itself, exactly as before |

## The refusal (rules.md rule 5)

`-dsh-mode session` on the release build stops with:
`DSHSpike release build: refusing '-dsh-mode session'. This is the user-facing
distribution build — the verification drives, the verdict panel, and the
per-event E2E log stream are compiled out (AGENTS.md constraint 5, rules.md
rule L4). Build/run the harness variant (dsh-ios-harness) to drive E2E legs.`
(`refusal.oslog.txt`; the window carries zero E2E records of its own.)

Files: `plain-launch-release.{stdout,stderr,oslog}.txt` + `.png`,
`plain-launch-harness.{stdout,stderr,oslog}.txt` + `.png`,
`refusal.oslog.txt`, `run.sh`.

Screenshots are supplementary — every verdict above is a log assertion.
The iOS simulator is local evidence; CI (Xcode 16.4) is the arbiter.
