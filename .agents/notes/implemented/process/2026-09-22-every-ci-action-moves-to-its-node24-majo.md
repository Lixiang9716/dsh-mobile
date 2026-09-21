# Agent Note: every CI action moves to its node24 major, and expected states stop alarming

Status: implemented
Related: D13

## Problem

Read out of the accumulated GitHub **annotations** across the last 25 runs (no
re-runs — the history is the evidence), two families of warning, 36 occurrences
in total:

**1. The actions themselves target Node 20, which the runners force to Node 24.**

```
Node.js 20 is deprecated. The following actions target Node.js 20 but are being
forced to run on Node.js 24: actions/checkout@v4, actions/cache@v4,
actions/setup-node@v4, actions/setup-java@v4, actions/upload-artifact@v4.
```

plus `setup-java v4 is deprecated and will no longer receive updates. Please
migrate to actions/setup-java@v5.` Four distinct messages, 22 occurrences. A
deprecation is not a failure, but it is a scheduled one: the forcing is a
compatibility shim, and the shim is what eventually goes.

**2. Two warnings that fire on every green run because the m2 UI leg cannot be
driven on CI** — 7 occurrences each. These were *added by this repo* two changes
ago, when the m1 step stopped declaring "verdict never appeared" and started
verifying the m1 scenarios it can actually run. The condition they report is
expected and documented; the alarm is not. Fourteen yellow annotations across
green runs is the same "teach people to ignore yellow" dynamic the pipeline was
just cleaned of, one severity level down.

## Decision

**Move every action to the minimum major that targets node24**, verified against
each action's own `action.yml` rather than assumed:

| Action | from | to | `using:` |
| --- | --- | --- | --- |
| `actions/checkout` | v4 | **v5** | node24 |
| `actions/setup-node` | v4 | **v5** | node24 |
| `actions/setup-java` | v4 | **v5** | node24 (its own recommended migration) |
| `actions/cache` | v4 | **v5** | node24 |
| `actions/upload-artifact` | v4 | **v6** | node24 (v5 is still node20) |
| `actions/setup-python` | v5 | **v6** | node24 |

39 call sites across 7 workflows. **The minimum major, not the latest**: the
latest are v6/v7, and jumping three majors blind to clear a deprecation warning
trades a schedule for a risk. One major at a time is the smaller change.

**The two expected-state warnings become `::notice::`.** The information is worth
keeping — the log should say that only the m1 scenarios were verified — but an
expected, documented condition is not an alarm. `::warning::` stays reserved for
states that are *not* expected, which is what makes it worth reading.

## Alternatives considered

**Jump to the latest majors (v6/v7).** Rejected for now: it clears the same
warning with a larger blast radius, and the extra majors buy nothing this repo
needs. Revisit when a specific input requires it, not for tidiness.

**Silence the Node-20 warning with a suppression or by pinning the runner's node.**
Rejected: the warning is correct — the actions *are* out of date — and suppressing
a correct deprecation is how a future upgrade becomes a surprise.

**Delete the two dev/ios notices entirely.** Rejected: the log should still state
that the m2 leg did not run, otherwise a reader may assume full coverage. The
message says what was verified as well as what was not.

**Leave everything and accept the warnings.** Rejected: 36 occurrences across 25
runs is a baseline of noise, and a warning channel that is always non-empty
carries no signal when something is genuinely wrong.
