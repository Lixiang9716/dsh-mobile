# Agent Note: the iOS release-staging phase moves into the generator that owns it

Status: implemented
Related: D10

## Problem

`hosts/ios/project.yml` is the generator source for `DSHSpike.xcodeproj`
(`hosts/ios/gen.sh` runs `xcodegen generate`), and the generated project is ALSO
committed so CI and fresh clones build without xcodegen. Those two facts were
inconsistent: the **`StageOfficialWeb`** phase — the one that embeds the
vendored official Web client into a Release build — existed **only in the
committed `project.pbxproj`**, with no counterpart in `project.yml`.

Two consequences, one loud and one quiet.

**Quiet, and the reason this was found at all:** Xcode warned on every build,

```
Run script build phase 'StageOfficialWeb' will be run during every build
because it does not specify any outputs.
```

**Loud, and latent:** running `gen.sh` — the documented way to regenerate the
project — would have **silently dropped the phase**, and the next Release build
would have shipped with no embedded web client. The release workflow's dist
assertion (`test -f …/DSHSpike.app/official-web/dist/index.html`) catches that
downstream, but only after a failing build, and only on the release path. A
regeneration on any ordinary day would have removed it without a signal.

## Decision

**The phase is declared in `project.yml`, which now owns it**, and the generated
project is regenerated from there.

`basedOnDependencyAnalysis: false` is set deliberately. Xcode's warning offers
two remedies — declare outputs, or mark the phase as always-run — and
always-run is what this phase already does and *must* do: it fails loud on a
missing Release source tree or a copied byte that drifts, and that guarantee
only holds if it runs on every build. Declaring outputs would let Xcode skip it
on an incremental build, which is exactly when a drifted tree would go
unnoticed. xcodegen encodes the setting as `alwaysOutOfDate = 1`.

The regeneration is a 141-line diff in the committed `project.pbxproj`,
generated-file churn rather than a rewrite; the authoritative check that the
project is still sound is the `ios-e2e` build in the PR, which builds the app.

## Alternatives considered

**Declare `outputFiles` for the phase instead.** Rejected above: it converts a
guarantee into a cache hit. The phase's value is that it verifies on every
build.

**Leave the phase only in the pbxproj and accept the warning.** Rejected: the
warning was the visible symptom of a generator/artifact divergence, and
silencing the symptom would have left `gen.sh` destructive.

**Fix only the warning by editing the committed pbxproj by hand.** Rejected
outright — it is a generated file, and a hand edit would be erased by the next
`gen.sh` run while reintroducing the divergence this change removes.

**Have CI run `gen.sh` so the project is always freshly generated.** Rejected:
the committed project is deliberate (fresh clones and CI build without
xcodegen), and generating in CI would move the failure from a reviewable diff to
a build step.
