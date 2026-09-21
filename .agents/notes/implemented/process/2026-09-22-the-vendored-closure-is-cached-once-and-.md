# Agent Note: the vendored closure is cached once, and both iOS checkers always run

Status: implemented
Related: D13, D9, D6

## Problem

Two independent costs, both measured.

**The vendored closure was downloaded six times per push.** `ensure.sh` +
`ensure-dsh.sh` fetch the pinned quickjs-ng / DSH closure, and every workflow
that needs it did so from scratch: dev-ios (29 s), dev-android, dev-harmonyos,
release-ios, release-android, release-harmony. Nothing cached it, because the
trees are untracked by design (D6/D9 — the content gates must never judge
verbatim upstream JS), so git cannot supply them.

**The iOS step hid one of its own failures.** The two `check.mjs` invocations
ran under `set -e`, so a FAILING FIRST checker aborted the step: the second
scenario produced **no verdict and no JUnit XML**. A real failure was partially
invisible — the same class of dishonesty the pipeline had just been cleaned of,
where a red result can end up looking like no result.

## Decision

**Cache the closure once, keyed on its pins.** All six workflows gain an
`actions/cache` step over `runtime/spike/vendor/{quickjs-ng,dsh,npm}`, keyed on
`hashFiles('ensure.sh', 'ensure-dsh.sh')` — those scripts ARE the tracked
provenance record, so a pin change rotates the key. This is safe for the same
reason the tree is untracked in the first place: the scripts re-verify sha256
over whatever lands, so a restored tree is **verified, not trusted**. The key is
a single-line expression, because a folded scalar can resolve to a literal and
produce a cache that never hits while looking like an optimisation.

**Both checkers always run.** The exit codes are accumulated (`|| check_rc=1`)
and the step fails at the end if either failed, so both verdicts and both JUnit
documents are always produced and always authoritative. Failing after both have
reported is strictly more informative than failing before the second one is
asked.

## Alternatives considered

**Bump `actions/setup-java@v4` to `@v5` in the same change.** Deliberately NOT
done. v4's own log line says it is deprecated and will stop receiving updates,
so the bump is warranted — but it is a **warning, not a failure**, and I could
not verify from here that v5 accepts the same `distribution` / `java-version` /
`cache` inputs this repo passes. A wrong bump breaks the Android build and both
release builds; a deprecation warning breaks nothing. Left as a named follow-up
rather than guessed at, which is the same standard applied to the HarmonyOS CLT
cache trim below.

**Trim the HarmonyOS CLT cache (2017 MB, 52 s = 55% of dev/harmonyos).** Not
done, for the same reason: narrowing a cached path that the build actually needs
turns a 52 s restore into a hard failure, and enumerating what hvigor resolves
needs a build to establish. Named, not guessed.

**Cache the closure by hashing the tree.** Circular — the tree is what the cache
is for.

**Let the second checker be skipped when the first fails.** Rejected: that is
the behaviour being removed.
