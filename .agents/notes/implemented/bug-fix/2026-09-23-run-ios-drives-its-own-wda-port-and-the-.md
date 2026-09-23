# Agent Note: run-ios drives its own WDA port, gates on a per-udid lock, and the live-write rpc manifest stops claiming an order the page never promised

Status: implemented

## Problem

Three defects surfaced by the all-iOS-legs day (2026-09-23), each measured:

1. **run-ios.sh assumed exclusive ownership of WDA's host-global port 8100.**
   With a second simulator active (the bisect worker's device), every WDA
   call either talked to the OTHER device's server or the stale-reap pkills
   (`pkill -f "xcodebuild test-without-building"`) murdered it — and a
   runner invocation killed mid-flight survived for HOURS as a zombie,
   invisible to every later run on the same simulator.
2. **`wait_line "notify.response"` matched a debug substring.** The scenario
   logs `wait for event notify.response` while BLOCKED on the banner — the
   bisect run recorded a "banner tap accepted" that never happened (the
   anchored form `"event":"notify.response"` appears exactly once in a green
   capture; the debug twin appears whenever the wait is long).
3. **The composer-live-write manifest pinned an ORDER the official page never
   promised.** The page's mount-time rpc burst (settings/describe …
   terminal/list, 16 endpoints) fires concurrently; two same-day captures
   both failed purely on sequence (settings/mutate arrived as early as the
   dynamicCordisRunner block in one, as late as its pinned slot in the
   other) while every MATCHER held — a flake factory with zero diagnostic
   value in the ordering claim.

## Decision

run-ios.sh now derives its WDA port from the udid
(`8100 + 16#<last-4-hex> % 500`), passes it into the runner via the
`TEST_RUNNER_USE_PORT` env prefix (Xcode forwards `TEST_RUNNER_*` to the test
host; WDA reads `USE_PORT`), reaps only its OWN port's listener
(`lsof -ti tcp:$WDA_PORT | xargs kill`) instead of host-global pkills, and
takes a per-udid lock (`~/dsh-e2e/run-ios-<udid>.lock`) that names the live
pid and dies loud on contention — the zombie detector. The EXIT trap releases
the lock and reaps the server. The two banner waits anchor to the e2e
envelope (`'"event":"notify.response"'`) and the picker done-wait to the
`spike: ui-done picker` marker form. The live-write manifest marks the 16
mount-burst rpc rows `order: "any"` (check.mjs's first-unconsumed-claim
pre-pass; `session/prompt` stays ordered — it is drive-causal): both of the
day's "failing" captures pass 46/46 with the relaxation, matchers untouched.

## Alternatives considered

- **A single global WDA with a queue** — rejected: the runner's value is
  being independently launchable per device; a shared queue couples every
  drive to one server's lifetime (exactly today's failure mode).
- **Kill-any-zombie heuristics (age-based)** — rejected: a lock that NAMES
  the contending pid is fail-loud and needs no guesswork about liveness.
- **Order-tolerant rpc matching with duplicated rows** — rejected: `order:
  "any"` already claims-first-unconsumed, keeps one row per endpoint, and
  the checker's self-test covers its semantics.
