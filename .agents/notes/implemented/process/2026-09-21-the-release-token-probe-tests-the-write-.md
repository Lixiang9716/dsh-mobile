# Agent Note: the release token probe tests the write, and the status docs are reconciled to the tree

Status: implemented
Superseded by: 2026-09-21-the-release-pr-gets-its-required-check-b.md — the PAT requirement and the three probes below were removed the same day, in favour of `GITHUB_TOKEN` plus an explicit `gates` dispatch (D11). The probe technique is still the reason the diagnosis was possible; the code it lived in is gone.
Related: D10

## Problem

Two independent defects, both of the same shape: a claim that was true when it
was written and silently stopped being true.

**The release token probe proved the wrong thing.** `release/please` had been
red on every push to `main` for days. The run log showed the token
authenticating (`GET /user` → HTTP 200), the release branch being created, the
release commit being created — and then
`release-please failed: Resource not accessible by personal access token` at
`POST /pulls`. The workflow already carried a probe built for exactly this
class of confusion, added when the failure was an opaque `Bad credentials`
from a secret pasted with trailing whitespace; its own comment says "Probe the
credential here, where the message can name the real cause." But it probed
*authentication*, and the failure was *authorization*. A token carrying
`contents: write` but not `pull requests: write` passes that probe, gets the
action all the way to the last step, and dies where the message names neither
the missing permission nor the fix. The version stream could therefore not
propose a release PR at all — `v0.0.2` could not be opened — and the failure
was indistinguishable, from the outside, from a bad secret.

**The status documents had drifted from what the tree contains.** A code-vs-doc
audit found the drift clustered where docs quote measured numbers:
`README.md`/`README.zh.md` said `m2.session` 22/22 where both cited verdicts now
record 23/23, and `m2.llm` "device 14/14" where the verdicts record expected 14
against 148 (iOS) and 171 (Android) logged events — a ratio that reads as a
failure once the scenario's logging is understood; the D9 paragraph cited "26
evidence dirs, 59 green verdicts" against the matrix's own 32 and 73.
`docs/release.md`/`.zh.md` told a reader to give the PAT "contents: write and
pull requests: write" — the exact incomplete list that produces the failure
above — and described release builds as taking "30–60 min per host" where the
one real release event measured 15/11/2 min for iOS/Android/HarmonyOS, and
named the iOS harness archive with a glob (`DSHSpike-harness-*-unsigned.zip`)
matching only one of the two files the workflow writes. `AGENTS.md` pointed at
`runtime/logger` for `createLogger` when nothing bundles that module — the
operative logger is `runtime/spike/logger.js`, as the repo's own `logging` gate
already states — described the release log strip as "compile logs away" when
the mechanism is a C-injected flag plus a runtime no-op table that keeps
`warn`/`error`, and gave a `gov` install path (`~/Library/Python/3.9/bin/gov`)
that does not exist and cannot: govrail requires Python ≥3.10.

## Decision

**The probe now tests the operation that fails, and the docs are corrected
against the tree.**

The token check is three probes, each catching one failure and naming the
permission it needs, so the failure identifies itself instead of surfacing from
inside release-please:

| Probe | Catches | Replaces |
| --- | --- | --- |
| secret present | unset secret | the action silently skipping |
| `GET /user` = 200 | trailing whitespace, expired/revoked PAT, truncated paste | opaque `Bad credentials` |
| `POST /pulls` = 422 | valid token missing `pull requests: write` | `Resource not accessible by personal access token` |

The third probe submits an empty body deliberately: for a token that may open
pull requests that is a validation error and creates nothing, while a token
that may not gets 403/404. The pass condition is therefore 422, verified
against a real token before wiring (HTTP 422, no PR created — `gh pr list`
unchanged). A non-422 is split by code so the message stays honest: 401/000
reports a credential problem and points back at the probe above, anything else
reports the permission problem, echoing `X-Accepted-GitHub-Permissions` when
the API supplies it. `issues: write` is documented as required for
release-please's `autorelease:` labels, with `skip-labeling: true` named as the
way to drop that requirement.

The documentation corrections are per-file and carry their source of truth:
README counts now match the verdicts and the matrix's own totals; the release
doc's permission list gains `issues: write`, states the three-probe contract,
notes that `CHANGELOG.md` is created by the first merged release PR and is
deliberately absent until then, cites the measured build durations, and names
both iOS harness archives. `AGENTS.md` names the operative logger, describes
the real release-strip mechanism, and gives the actual uv-tool install.

`.gitignore` gains `docs/.decision.lock`, which `gov decision add` writes and
by design never unlinks — it was permanent untracked noise in an otherwise
clean tree while its sibling `.gov/tasks/.new.lock` was already ignored.

Three completed cards (`T-0020`, `T-0027`, `T-0028`) are retired with recorded
reasons under `gov task void`, per the repository's standing practice while the
upstream close/receipt dead-end is unshipped.

## Alternatives considered

**Probe the permission with a read instead of a write.** Rejected: no read
endpoint distinguishes read from write on a pull request, so a read probe would
pass for exactly the token that fails — the vacuous-check failure mode
rules.md rule 6 exists to prevent.

**Discover the 403 the honest way — let the action fail and annotate its
error.** Rejected: the action's step fails the job, so there is no post-step to
annotate from; the diagnosis has to happen before the write, which is why the
probe is a pre-flight.

**Add `.gov/pairing.json` so that rules.md's "the naming conventions this
project declared in `.gov/pairing.json`" becomes literally true.** Rejected:
`gov init` never creates that file and the repo runs govrail's defaults, so
writing it changes nothing functionally — and `gov verify-plane` treats a
present `.gov/pairing.json` as a plane config that must be inside the seal, so
adding it would force a constitution re-baseline (`gov verify-plane --write`)
for a sentence in sealed upstream template text. Reporting it upstream is the
proportionate fix; a seal re-baseline is a reviewed decision, not a doc
correction.

**Close the ten completed task cards instead of voiding them.** Rejected as
impossible on the pinned govrail, not as undesirable: `gov task close` stamps a
receipt whose `verify-decisions` entry reads `NOT_SELECTED`, which
`gov task check` then rejects, and `void` refuses a done card. Only three of
the ten are reachable at all — the other seven share their id with an
already-retired card (`T-0008` ×4, `T-0009` ×3, `T-0010` ×4, `T-0013` ×5,
`T-0017` ×3, `T-0024` ×2 in the tree), and the resolver reads the `id` field
only: `gov task void T-0024` prints `'T-0024' is ambiguous (T-0024, T-0024)`
while the filename stem prints `no card matches`. Both limitations are fixed
upstream in the staged govrail 0.48.0, so those seven are left for the upgrade
rather than worked around by hand-editing card JSON under `.gov/`.

**Reconcile the drift by deleting the quoted numbers instead of correcting
them.** Rejected: the numbers are the evidence that the milestone rows are
claims rather than assertions, and the matrix is regenerable — a number that
can be checked is worth more than a sentence that cannot.
