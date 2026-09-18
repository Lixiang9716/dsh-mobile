# Agent Note: log-based E2E assertions in CI (no screenshots)

Status: implemented

## Problem

E2E assertions on screenshots do not scale in CI: they are brittle (rendering drift breaks
them), they hide failures (a green pixel layout can hide a wrong result), and they cannot be
reviewed as diffs. Nothing written down stopped a future E2E suite from becoming
screenshot-diff soup.

## Decision

CI end-to-end tests assert on structured logs, never screenshots:

- each scenario carries a unique `scenario-id`;
- the runtime emits one structured log entry per expected event
  (`scenario=<id> event=<name>`) via the unified logger — the same log
  surface the `logging` gate governs;
- the assertion is a one-to-one expected ↔ logged match (nothing missing,
  nothing extra, declared order);
- failure output lists the unmatched entries; that list is the diagnosis.

Codified in docs/ARCHITECTURE.md (§3 "E2E verification"), both platform
workflow templates (dev/ios, dev/harmonyos), and AGENTS.md constraint 7.

## Alternatives considered

- **Screenshot/diff assertions (per-platform)**: rejected — brittle, unreviewable, and requires
  image baselines that rot; screenshots remain available for local interactive debugging only.
- **UI-tree assertions only (XCUITest/uitest element queries)**: partially adopted — the
  drivers may use UI trees to *act* (tap, swipe), but the *verdict* comes from the log
  matching, keeping one verification surface across all three platforms.
- **Trace-file comparison instead of logs**: deferred — the log stream is already governed and
  structured; trace files can layer on later if timing/perf assertions are needed.

## Consequences

Every E2E scenario must be designed with its expected event sequence up front (scenario-id +
event list), which pushes verification thinking into M1 design instead of M2 debugging. The
unified logger becomes a verification-critical component: its log schema (scenario/event
fields) needs a contract entry when M1 defines the logger binding.
