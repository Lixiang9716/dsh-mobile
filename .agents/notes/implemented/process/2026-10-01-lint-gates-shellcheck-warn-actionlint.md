# Agent Note: the lint gates — #289's zeroed shellcheck surface gets a keeper, the workflow lint stops being a ritual

Status: implemented
Related: 2026-10-01-the-ci-warning-surface-goes-to-zero-path.md (#289 zeroed the
surface this note gates); 2026-09-30-the-weekly-upstream-suite-sweep-joins-gi.md
(the skip-on-absent availability pattern reused here); the quickjs-boot-parse
gate note (the rejection-case + skip-loud shape both gates follow).

## Problem

#289 zeroed the CI warning surface — 37 warning/error-grade shellcheck findings
fixed across 23 scripts, the last workflow-lint finding fixed — but the zero
was an event, not a place. Nothing re-runs that judgment: a fresh warning-grade
finding (one unquoted expansion, one dead variable) re-accumulates silently
until someone re-runs a hand-rolled sweep. The workflow lint
(`actionlint -shellcheck=shellcheck .github/workflows/*.yml`) was worse: a
local ritual, run by whoever remembered — that is exactly how #289 found its
last finding, and exactly how the next one would be missed. The 38 info-grade
findings #289 deliberately left ("style is not a CI warning") also aged: their
host scripts keep being edited, and the ledger in /tmp is not a contract.

## Decision

Two gates join the plane's DAG, both shipping rejection cases and skip-loud
availability contracts (the quickjs-boot-parse shape):

- `shellcheck-warn` (`tools/check-shellcheck-warn.sh`): shellcheck over the
  CI-reachable shell scripts, **threshold 0 at warning grade and above**;
  info/style findings out of scope by design. The surface is enumerated BY
  RULE, not a hand list: every tracked `.sh` under build/, tools/,
  hosts/{android,harmony,ios}/, test/{e2e,tools,panel}/, packages/release/,
  deploy/marketplace/, presentation/, runtime/spike/{ci,vendor}/, plus
  runtime/spike/host/build.sh — minus `**/artifacts/**` fixtures (run outputs
  and guest-root profiles, never entry points). 89 scripts on landing day; the
  rule covered every script #289 swept-with-findings (33/33), every script its
  PR touched (29/29), and every workflow-reachable script (28/28) — verified
  set-theoretically the day this gate landed. The gate accepts narrowed paths
  for the rejection case's 10-second budget; the DAG always runs the full
  surface.
- `actionlint` (`tools/check-actionlint.sh`): every `.github/workflows/*.yml`,
  zero findings; `run:` blocks are shell-linted too when a shellcheck binary is
  present (the exact #289 invocation, now enforced). A missing actionlint
  binary SKIPs loudly (named reason, exit 0) — and `.github/workflows/gov.yml`
  installs the pinned v1.7.12 release (verified against the release's own
  checksums.txt before it lands on PATH) and asserts shellcheck's presence, so
  the gate is never vacuous in CI.

The 38 info findings are cleared in the same change (one commit ahead of the
gates), so the swept surface is green at style grade, not just warning grade —
SC2015 explicit if/else (4), SC2086 single-token quotes + documented disables
for the flag-bundle/roster splits where quoting would change behavior (23),
SC2012 ls→find (7), SC2011 ls|xargs→find -print0|sort -z|xargs -0 (1), SC2016
node -e template literal → `join(" ")` (2), SC2295 quoted patterns (2), plus
SC2162/SC2029/SC1091 singles and pairs. The rule-based surface surfaced 4 more
info findings beyond the #289 ledger (run-shim-exposure-sweep.sh's SC2011
warning + SC2012, deploy-local.sh's SC2029 ×2) — fixed too, so the gate's
surface is fully style-green, not green-except-the-corners.

## Alternatives considered

- Gating at style grade (threshold 0 at `-S style`) — lost for now: it turns
  every future stylistic preference into a CI failure and re-litigates #289's
  explicit "style is not a CI warning" bar. The style-green state is recorded
  here; escalating the threshold is a deliberate later decision, not a
  side effect.
- A hand-copied 69-path manifest file — lost: #289's sweep list was never
  committed (only its findings ledger in /tmp survived), and a hand list rots
  the moment a script moves; the rule-based enumeration is auditable against
  #289's evidence (the 33/29/28 superset check above) and cannot go stale.
- `# shellcheck disable` everywhere instead of fixes — lost, with the same
  exception class #289 named: almost every fix hardens the script (cd-equivalent
  guards aside: real quotes, find pipelines, explicit if/else); disables are
  used ONLY where word-splitting (or client-side expansion, or an unfollowable
  dev .env) IS the contract, each with a comment naming why.
- Failing the gate when the binaries are absent — lost for agent machines
  (rule 5's loud skip is the quickjs-boot-parse precedent; a hard fail would
  lock every fresh clone out of `gov run` over a brew install), but the CI
  install step makes the skip unreachable where the evidence matters.

## Consequences

Warning-grade shellcheck regressions and workflow lint regressions now go red
at the plane, with rejection cases proving both gates' teeth (SC2034 injected
→ red; probe workflow with a broken `if:` → red; each restored → green). The
38 info findings stay at zero on the landed surface; the four extras the wider
rule surfaced are gone with them. CI gains one pinned-download step (~1s) and
the gate DAG gains two roots (~5s + ~0.5s locally).
