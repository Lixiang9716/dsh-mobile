# Agent Note: E2E verdicts emit JUnit XML so a red scenario annotates its PR

Status: implemented
Related: D0

## Problem

The E2E verdict had exactly one machine-readable form: check.mjs's JSON, printed
to stderr on failure and (optionally) written to a file. A red `dev/ios` run
therefore reached a pull request as a red step and nothing more — which scenario
failed, and at which expectation, was only discoverable by opening the job log
and finding the JSON blob inside it. The industry-standard artifact contract for
mobile E2E is a JUnit XML next to the logs and screenshots; nothing under
tools/e2e/ produced one, so a reporter had nothing to attach to the PR.

The provenance rule that already governs the verdict JSON ("a verdict belongs to
the run that produced it" — the committed files under hosts/ios/artifacts are the
SAME paths a run writes) applies to whatever form the verdict ships in: an XML
that cannot be traced to a run id invites exactly the stale-pass reading that
the JSON provenance was added to stop.

## Decision

- `tools/e2e/junit.mjs` (new, stdlib-only Node ESM) renders one or more verdicts
  into ONE JUnit document: one `<testsuite>` and one `<testcase>` per verdict,
  `classname` = `e2e.<scenario>`, `name` = the scenario id. A verdict that is not
  `pass: true` carries a `<failure>` whose text is the checker's own diagnosis
  rendered readable (`expected[4] event "fs.denied" match {"code":"denied"}` /
  `logged line 22: {…}`), plus the unparsable-line list when the capture had any.
- The verdict's `runId` / `commit` / `producedAt` ride as suite `<properties>` and
  in the testcase `<system-out>`, so XML traceability is the same question the
  verdict JSON answers.
- `check.mjs --junit <path>` writes that form for the verdict it just produced,
  through the exported converter — not a second renderer — and writes it BEFORE
  the exit, so a FAILING run ships an XML too. The flag is in the checker's
  `usage` line (its discovery surface).
- `.github/workflows/dev-ios.yml` passes `--junit` on both m1 checkers and names
  the two XML files in the "Upload artifacts" path list.
- The converter never decides pass/fail: it reads `verdict.pass === true`, so a
  malformed or missing `pass` can only ever read as failing, never as green.
  A verdict that is not a checker verdict at all (no string `scenario`, no
  boolean `pass`) aborts the CLI with exit 2 naming the file (rule 5).

Verified by running it, not by inspection: a real PASS verdict, a deliberately
failing one (`m2-gateway-binding` negative fixture, expected[4] `fs.denied`), the
trailing-extras branch (`m2-llm-repeat` negative-extra) and the unparsable-line
branch all produced XML that `python3 -c "xml.dom.minidom.parse(...)"` accepts;
`junit.mjs --out` merged four verdicts into one document with
`tests="4" failures="3"`; `tools/e2e/selftest.sh` stays green, and a check.mjs run
without `--junit` is byte-identical in behaviour to before.

## Alternatives considered

- **A CI reporter action reading the verdict JSONs** (dorny/test-reporter and
  friends) instead of emitting XML ourselves: lost — reporters consume JUnit XML,
  not our verdict schema, so this would mean a marketplace action with its own
  permissions and version pinning to render a format we can produce from the
  verdict we already hold. The artifact is the contract; the consumer is
  replaceable.
- **A separate script that post-processes `--out` verdict files**: lost — it makes
  two renderers of one diagnosis (the checker's stderr report and the XML) and
  still needs the XML written before a failing checker exits, which only the
  checker can do reliably. One converter, imported, keeps one diagnosis.
- **Dumping the raw verdict JSON into the `<failure>` body**: lost — the
  annotation is read as a PR annotation; a nested JSON blob with the same fields
  three levels deep is noise there, while the readable rendering keeps each
  annotation one comparison wide.
- **Accumulating both checkers' exit codes (`|| rc=1`) so a failing first checker
  still produces the second XML**: not taken here. It would strengthen the
  evidence (both scenarios annotated, step still red), but it changes the step's
  control flow, which was not this change's mandate; the current shape is honest
  already — the first failure aborts, and "Report verdict" then reports the
  missing second verdict as absent rather than passing it. Recorded as a known
  limitation for a follow-up that owns that step's flow.
