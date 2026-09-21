# Agent Note: the HarmonyOS release HAP shipped debuggable: a product-level override beat buildMode

Status: implemented
Related: D10

## Problem

The release pipeline claimed three release builds and shipped two. iOS and
Android were genuine Release (`Release-iphoneos/`, no `libswiftSwiftOnoneSupport`,
zero `__debug` sections; `app-release-unsigned.apk` from `assembleRelease`), but
the HAP that `release/packages` built with `-p buildMode=release` and attached
to `v0.0.1` carried this in its packaged `module.json`:

```
"buildMode": "debug",
"debug": true,
```

The log-strip side of the release policy was working — `DSH_RELEASE = true` was
generated into `BuildProfile.ets`, the define reached the native library, and
debug/info were folded away. So every check the project had agreed to look at
was green. What nobody had checked is a different axis: whether the artifact is
*debuggable*. The release builds were stripping their logs while remaining
debuggable binaries.

The cause is in `hosts/harmony/build-profile.json5`:

```json
"buildOption": { "debuggable": true }
```

A **product-level** `buildOption` applies to every build mode. Passing
`-p buildMode=release` on the command line selects the release
`buildOptionSet`, and the ArkTS/CMake defines from that set took effect — but
the product-level `debuggable` still won the debuggable bit. It also explains
why this hid for so long: hvigor skips obfuscation for a debuggable build, so a
second latent defect (below) never resolved.

## Decision

The switch moves to where the mode is known. `debuggable` now appears in
`hosts/harmony/entry/build-profile.json5`'s per-mode `buildOptionSet` — `true`
for `debug`, `false` for `release` — and the product-level override is gone.
It is declared explicitly in **both** entries because the field's schema
default is `true`; omitting it from the release entry ships a debuggable
release build, which is the bug being fixed.

Fixing it exposed the latent second defect. The release entry's
`arkOptions.obfuscation.ruleOptions` pointed at `./obfuscation-rules.txt`, a
file that **has never existed in this repository** — the release build only
succeeded because hvigor skips obfuscation for a debuggable build, so the
dangling path was never resolved. Obfuscation is deliberately off
(`enable: false`), and hvigor's own schema requires only `enable` under
`ruleOptions`, so the `files` reference is dropped rather than inventing a
rules file the project has no use for.

Verified by real local builds in **both** directions, not by reading config:

| buildMode | `buildMode` in HAP | `debug` | `DSH_RELEASE` |
| --- | --- | --- | --- |
| release (before) | `debug` | `true` | `true` |
| release (after) | `release` | `false` | `true` |
| debug (after) | `debug` | `true` | `false` |

The same change adds `release_tag` as a `workflow_dispatch` input on
`release/packages`. Until now the only way to correct an asset on a published
release was to delete the release and re-publish it; the new input builds from
the current `main` and replaces that tag's assets in place — which is how the
corrected HAP replaces the bad one on `v0.0.1`.

Release assets are also renamed to the project's own vocabulary. The workflow
had been uploading the build system's internal output paths as asset names —
`entry-default-unsigned.hap`, `app-release-unsigned.apk` — while the
workflow-artifact names right beside them already said `dsh-harmony` and
`dsh-android`. A downloader saw a name invented by hvigor and Gradle. The
attach steps now `cp` each output to a `dsh-<host>…` filename before uploading,
so the assets are `dsh-harmony-unsigned.hap`, `dsh-android-unsigned.apk`,
`dsh-ios-device-unsigned.zip` and `dsh-ios-simulator-unsigned.zip`, while the
build outputs keep the names their toolchains dictate. The `-unsigned` suffix
stays: it is the one property a downloader must know before the file is any
use.

The first attempt at that rename got it wrong and was caught against the
release API rather than by reading the docs: `gh release upload`'s
`file#text` form reads as "rename this to text", but it sets only the asset's
display **label** —

```
name=entry-default-unsigned.hap   label=dsh-harmony-unsigned.hap
```

— and a browser download uses the **name**. Renaming the file before upload is
what actually changes it. The distinction is why the attach steps carry a
comment saying so.

## Alternatives considered

- **Adding the missing `obfuscation-rules.txt`.** Rejected: obfuscation is
  explicitly disabled, so the file would exist only to satisfy a dangling
  reference — a file whose content nothing reads, added to make a validator
  quiet. Dropping the reference states the intent instead.
- **Setting `debuggable: false` at the product level.** Rejected: it would make
  the harness non-debuggable too, and it repeats the original mistake — one
  value for a setting the two modes genuinely differ on.
- **Leaving `debuggable` out of the release entry and relying on the default.**
  Rejected: the schema's default is the value that caused this bug (`true`), so
  relying on it would be relying on the defect.
- **Deleting and re-publishing `v0.0.1` to refresh the asset.** Rejected as the
  recovery mechanism: it takes the release (and its notes) off the page to fix
  one file, and it is not repeatable in a way a future maintainer can find. The
  `release_tag` input is the documented path instead.
- **Building the corrected HAP locally and uploading it by hand.** Rejected:
  the release assets are CI-built on purpose, and a hand-uploaded binary breaks
  the property that a release asset is reproducible from its tag.

## Consequences

The three host packages on a release are now all genuinely release
configuration, and the claim is checkable per host rather than per project.

The axis that let this ship is now guarded. The release job had one HarmonyOS
assertion — `grep -q 'DSH_RELEASE = true'` on the generated `BuildProfile.ets`
— which proves the log strip and says nothing about the debuggable bit. A new
step reads the packaged `module.json` out of the built HAP and refuses unless
`debug` is exactly `false` and `buildMode` is exactly `release`, and the guard
is proven against real artifacts rather than asserted:

| Input | Result |
| --- | --- |
| the HAP attached to `v0.0.1` (built before this fix) | fails: `debug=True, buildMode='debug'` |
| the HAP built after this fix | passes: `debug=False buildMode='release'` |

iOS and Android have no equivalent guard — the run would catch a Debug build
indirectly (the release job asserts the embedded `official-web/dist` and the
Release output path), but there is no assertion on the configuration itself.
Adding one per host is a reasonable follow-up.
