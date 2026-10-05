# Agent Note: windows-test-plan first full pass — receipt host line + hdc send path fixes, execution status recorded

Status: implemented
Related: D5

## Problem

Executing docs/windows-test-plan.md on the freshly provisioned Windows host
hit two defects in `hosts/harmony/ci/run-live-llm.sh` (the plan's T3
vehicle): the machine-authored receipt hardcoded the host line
`127.0.0.1:5555` while this host's emulator answers on `127.0.0.1:5559` —
the receipt would certify a device that did not run — and `hdc file send`
treated the mktemp credential path (`C:/Users/...`, forward slashes) as a
RELATIVE path, prefixing the runner's cwd, so the credential handoff could
never land. Separately, the plan's T1 readiness poll reads
`/proc/net/tcp6` for the carrier's LISTEN row, and this image hides every
socket row from the shell user — the poll starves while the app is
perfectly healthy.

## Decision

- `run-live-llm.sh`: the receipt host line now reads the LIVE hdc target
  (`$HDC list targets`), and the credential send converts the local path
  through `cygpath -w` when available (a no-op spelling on POSIX hosts).
- docs/windows-test-plan.md (+zh) gained an "Execution status" section:
  P0/T1/T2/T6 done (T6: 5/5 cold boots, boot 31-69s, ready +3s, PSS 1.09×,
  FAIL delta 0), T3 done-with-deviation (OpenRouter free pool — no bigmodel
  key on this host; scenario verdict PASS + carrier 7/7 on BOTH hosts, the
  device manifest's `llm.reasoning.delta` pin is the one red expectation and
  it fails IDENTICALLY on Android — the seats match, the manifest's provider
  pin is the named gap), T4/T5 queued on the real-model-composer harness
  gap, and the environment facts (/proc/net/tcp6 hidden rows, hdc path
  forms, the IME wizard, the free-pool 429/no-reasoning reality) recorded
  where the next executor will find them.

## Follow-up (same day): T3 closed at the pinned seat

The bigmodel key arrived and the leg re-ran at the seat the plan pins:
glm-5.3-flash streamed reasoning + content on the Windows emulator —
scenario verdict PASS, device manifest 14/114 (repeat-aware), carrier 7/7,
key-leak audit clean, credentials removed, receipt authored by the runner
on the green path with the LIVE host line (`harmony 127.0.0.1:5559` — the
fix above verified in production). The evidence dir lands committed
(`hosts/harmony/artifacts/windows-t3-live-llm/`); the plan doc's T3 row and
both matrix docs record the closure, and the totals correct to the
committed-state measurement (93 dirs / 205 verdicts / 212 pngs — the
previous 211/220 had counted a since-removed scratch dir). The OpenRouter
attempt stays in the T3 row as the transport-proof intermediate; the
manifest's `llm.reasoning.delta` pin is named there as bigmodel-seat-specific
(Android behaves identically), not widened.

## Alternatives considered

- Making the readiness poll root the emulator or privileged-shell its way
  to /proc/net/tcp6: lost — the app's own `session.mock-llm PASS` hilog
  marker is a strictly stronger readiness fact and needs no privilege.
- Patching the vendored dsh-llm adapter to read OpenRouter's reasoning
  field spelling: lost — D6 forbids modifying vendored upstream, and the
  manifest pin (not a host defect) is the honest record; the bigmodel seat
  keeps its reasoning leg by its own contract.
- Retrying reasoning models until one fits the 256-token cap: measured and
  rejected — dots-studio burned the whole cap on thinking (finish=length,
  zero content); OpenRouter free routes surface no reasoning field through
  this adapter at all, so model roulette cannot green the pin.
