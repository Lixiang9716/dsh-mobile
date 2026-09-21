# Agent Note: the vendored fetches retry a transient failure instead of failing the job

Status: implemented
Related: D6, D9

## Problem

`runtime/spike/vendor/ensure.sh` and `ensure-dsh.sh` are the tracked provenance
record for the vendored upstream trees (D6/D9): they pin versions and verify
sha256. They fetched with a bare `curl` and no retry, so a **transient** failure
at the origin took down a whole CI job:

```
curl: (56) The requested URL returned error: 504
##[error]Process completed with exit code 56.
```

(run 35614651794, the iOS step "Vendor quickjs-ng + the pinned upstream DSH
closure"). It did not recur across the following twelve runs, so the cause is
transient rather than systemic — but the cost was a red job on a push that had
nothing wrong with it, and the vendored closure is downloaded by **six**
workflows, so any of them could have been the victim.

The repository already had the right pattern: the HarmonyOS CLT download loops
`for attempt in 1 2 3` around its curl. It had simply never been applied here.

## Decision

One `fetch_retry <url> <out>` helper in each script, wrapping the three download
sites (quickjs-ng tarball; the two DSH/npm package fetches). Bounded at three
attempts with `--retry 3 --retry-delay 5 --connect-timeout 20`, and it **fails
loud, naming the URL**, when the attempts are exhausted.

`--retry` alone was rejected as insufficient: it covers connection-level blips,
while a 504 from the origin or an intermediary is not reliably in its retry set
— which is exactly the failure measured.

**The integrity check is deliberately outside the helper.** Every caller still
verifies sha256 over what lands, so a retry can never promote a corrupt or
truncated download into an accepted one. A retry policy that sat above the
verification would be a way to accept a bad artifact more persistently.

Verified both directions: a real fetch of a pinned npm tarball returned 759588
bytes; an unreachable URL produced three named attempts and exit 1. Both scripts
pass `bash -n`, and no bare `curl` remains on a download path.

## Alternatives considered

**Only add `--retry` / `--retry-all-errors` to the existing curls.** Rejected:
the measured failure is a 504, and relying on a flag's exact retry set to cover
it is a guess. The explicit outer loop states the policy where it can be read.

**Retry inside `have_all`/the verification step, re-fetching only what failed.**
Rejected as more machinery for the same outcome: the helper already re-runs the
whole fetch, and the sha256 check that follows is what decides.

**Cache the vendored closure in CI so it is rarely fetched at all.** Not
instead — *as well*, and it is the better fix for the common case (six workflows
re-download it every run). Left as a separate change so this one stays a
robustness fix with a single reason to exist.
