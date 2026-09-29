# Troubleshooting — the cross-session trap ledger

English | [简体中文](troubleshooting.zh.md)

A trap paid for once should not be paid for twice. Every entry below cost a
real session real debugging time, and until now each lived only in the
memory of the agent that hit it — a fresh agent (or a fresh machine) started
from zero. This file is the ledger: each trap as a two-paragraph entry —
the symptom and its mechanism, then the fix — naming the code that encodes
the fix where one exists. Entries are appended the session the trap is
paid for, in the same spirit as the surprises ledger (`.gov/rules.md` §11):
recorded when it is cheapest, before the mental model rots.

## 1. A shim-shim import cycle kills QuickJS at link with an EMPTY error

Every file parses clean — `node --check` passes on each of them — yet the
runtime dies under the real engine with no message at all: the spike CLI
exits nonzero and prints `spike: error: ` followed by nothing (entry 6 is
how that empty line presents). The mechanism: a static ESM import cycle
between two files under `runtime/spike/upstream/shims/` aborts inside
QuickJS's module linker, which fails without an error string — measured,
not inferred (the split that introduced such a cycle was node-clean and
QuickJS-fatal, 2026-09-29). Node never reproduces it because `node --check`
parses without linking; the cycle only bites when the module graph is
actually instantiated.

Keep shims-file dependencies one-directional. When a file must reach a
sibling's binding, split so the edge points one way and the original
re-exports for every existing specifier — never let two files import each
other. Where a true two-way shape is unavoidable, references back are
call-time only (an ESM-cycle-safe pattern: the importing module reads the
binding through the namespace at call time, after the definer's evaluation
completed — see the headers of `fs-paths.js`, `fs-readdir.js`, `fs-stat.js`,
`fs-writes.js`). Encoded: `runtime/spike/upstream/shims/fs-seeded.js:22-24`
("ONE-WAY EDGE … a static import cycle between two runtime/shims files
kills quickjs at link with an empty error (measured)") and
`runtime/spike/upstream/shims/buffer.js:31` ("one-way; a shim-shim import
cycle kills QuickJS at link").

## 2. aapt2's default ignoreAssetsPattern silently drops dotfiles from APK assets

The repo staging carries a vendored data face faithfully, the APK packages
everything else in that tree, and at runtime the mount dies with
`cannot read '.../data/.manifest.json'` — the parity m4 mount, 2026-09-29.
The mechanism: aapt2's default ignore pattern contains the `.*` token,
which excludes EVERY dotfile from packaged assets, so
`providers/data/.manifest.json` (the providers barrel's require target)
never enters the APK — no warning, no build error, the file is simply
absent at runtime while every staging check upstream of packaging passes.

Restate `androidResources.ignoreAssetsPattern` in
[hosts/android/app/build.gradle.kts](../hosts/android/app/build.gradle.kts)
without the `.*` token (`!.svn:!.git:!.ds_store:!*.scc:CVS:!thumbs.db:!
picasa.ini:!*~`), so the bundle's dotfiles package. Encoded at
`build.gradle.kts:91-99`, with the incident in the comment above the block.
When a new dotfile-bearing asset face is vendored, this is the line that
decides whether it ships.

## 3. `(cd X && find) | while` swallows a failed cd

A staging loop whose source directory is missing produces a silently EMPTY
destination — no error, exit 0, the rawfile tree (or assets tree) just
lacks the files. The mechanism: in `(cd "$DIR" && find …) | while …`, the
`cd` runs in the pipeline's left subshell; if `$DIR` is absent, `cd` fails,
`find` never runs, and the right side consumes empty input and exits 0 —
`set -e` never fires because the pipeline's status is the `while`'s. That
exact shape cost the CI gates failure of 2026-09-29: the vendor pins rode
only one ensure path, the spine ensure never materialized them, and 217
`BUNDLE_FILES` rows went red on CI while a local full-mode sync looked
green.

Guard the source directory with an explicit `-d` test that exits loud
BEFORE the staging loop — fail on the missing pin, never on the quiet
half-rawfile. Encoded in
[hosts/harmony/ci/vendor-official.sh](../hosts/harmony/ci/vendor-official.sh):
each `(cd "$DIR" && find …) | while` staging loop is preceded by
`[ ! -d "runtime/spike/$DIR" ] && echo "::error::… absent" && exit 1`
(`vendor-official.sh:474-481` for the noble pin, `:490-497` for pi-ai,
`:112` for `vendor/dsh`), and the comment above the first guard records the
incident.

## 4. `git show` / `git checkout` paths are repo-root-relative

Extracting a file from a ref with a path that looks right from where you
stand — `git show <ref>:scenario/upstream-suite-leg.js` from
`runtime/spike/`, or the same spelling in `git checkout <ref> -- …` —
produces EMPTY content, and nothing points at the cause. The mechanism:
pathspecs on a `<ref>:<path>` object (and in `git checkout <ref> -- <path>`)
resolve from the REPO ROOT, not the current directory — the same spelling
that is correct as a plain filesystem path names nothing in git's index.
Verified on this tree (read-only): the wrong spelling makes `git show` fail
with `fatal: path 'runtime/spike/scenario/upstream-suite-leg.js' exists,
but not 'scenario/upstream-suite-leg.js'` — on stderr, which is lost the
moment the output is piped or command-substituted, leaving an empty string
that flows on silently — while `git checkout HEAD -- scenario/…` from
`runtime/spike/` exits 0 having changed NOTHING (`git status --porcelain`
shows no new entry).

Spell git object paths repo-root-relative, always:
`git show <ref>:runtime/spike/scenario/upstream-suite-leg.js`. When git
does error, read its own hint — it names the root-relative form (and the
`<ref>:./<path>` cwd-relative spelling, which is the deliberate way to ask
for cwd-relative). No repo code encodes this discipline yet — no gate or
script validates `git show`/`git checkout` pathspell — so the convention
in this paragraph is the entire fix until one lands.

## 5. A regex literal containing an apostrophe poisons tools/check-size.py's quote scan

A file whose real indentation never changed suddenly reports dozens of
phantom `INDENT` violations — 48 of them in one incident (filed upstream as
govrail#411) — and re-formatting the file does nothing. The mechanism: the
code-size scanner's fallback is line-based and regex-blind. `strip_code`
([tools/check-size.py](../tools/check-size.py):139-181) treats `'` and `"`
as string delimiters and carries quote state across lines, but has no state
for `/regex/` literals — so a regex whose character class contains an
apostrophe (the RFC 7230 token charset is the classic:
`/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/`) opens a phantom string that swallows
the rest of the file, desyncs the scanner's comment tracking, and turns
every subsequent nested block into an indent violation.

Rebuild such patterns via `new RegExp`, so the apostrophe lives inside a
real string literal the scanner understands. Encoded:
`runtime/spike/upstream/shims/node-http-loopback.js:375-381` builds the
token charset as `new RegExp("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")` with the
reason in the adjacent comment ("a regex literal here carries ' and `
inside the class, and the code-size scanner (line-based, no regex state)
reads them as an unterminated string"). The scanner itself is unchanged —
this entry documents the workaround its blindness forces.

## 6. The spike CLI's empty `spike: error:` is its NORMAL no-completion shape

A plain (non-scenario) entry prints `spike: FAIL (complete=0 pass=0)`
followed by `spike: error: ` with NOTHING after the colon — which reads
like a crash that lost its message. It is not a crash and nothing was
lost: the mechanism is that `main_cli.c` prints `dsh_spike_error()` on any
nonzero exit
([runtime/spike/host/main_cli.c](../runtime/spike/host/main_cli.c):1305-1308),
while the error buffer is only written when the runtime records a real
error — `dsh_spike_host.c:3561` returns `s->err`, an empty string when
never set (`dsh_spike_host.h:31` notes a fresh struct carries no error
text). A plain entry that runs and exits without reaching the completion
face never records an error, so `complete=0` is the entire diagnosis and
the error line is legitimately empty.

Read it as "this entry never reached completion", not "something broke
silently": if a summary was expected, the entry is the wrong one (run a
scenario entry that calls the completion face) or the run ended early
(deadline — the CLI prints `smoke: Ns deadline elapsed before completion`
above it). No code change is wanted here; the fix is knowing the shape.
This entry exists so the next agent does not spend an hour hunting a
truncated log that was never truncated.

## 7. `logcat -c` races the reader snapshot — judge a canary-filtered view, always

An Android runner that clears the buffer (`adb logcat -c`) and then greps a
live stream for its completion patterns comes up empty — "no parity/event
records" — even though the device logged them (hit again 2026-09-29, and
recorded in the runner's own comment). The mechanism: `logcat -c` truncates
a buffer the streamer may not have snapshotted yet, so a wait that judges
the RAW stream can be satisfied by the start-of-buffer replay (stale,
previous-run records — a false positive) or starved by the truncation
(this-run records dropped between `-c` and the streamer's first read — a
false negative). The streamer design lost three separate ways on top of
that, measured 2026-09-26/27: zombie streamers from earlier runs kept
writing the same file, and an in-place rewrite orphaned the streamer's fd
([hosts/android/ci/run-device-plane.sh](../hosts/android/ci/run-device-plane.sh):70-73).

Pin a canary line the streamer can only see once attached
(`adb shell log -t dsh.canary <id>`), and judge BOTH the completion wait
AND the truncation on the canary-filtered view — `awk '/<canary-id>/{seen=1}
seen'` over the stream file — never the raw stream. Encoded in
[hosts/android/ci/run-upstream-parity.sh](../hosts/android/ci/run-upstream-parity.sh):63-94:
the `CANARY` pin, the `canary_view()` helper, and the comment at `:86-91`
naming the 2026-09-29 relapse (truncation was canary-pinned but the wait
still grepped the raw stream). The device-plane runner instead abandons the
live stream: force-stop, `logcat -c`, launch clean, then poll `logcat -d
-s dsh.spike` snapshots — a dump is inherently this-run-only
(`run-device-plane.sh:70-95`). Either discipline works; mixing them
(canary-pinned truncation, raw-stream waits) is the failure.

## 8. iOS simulator runtimes < 26 lack libswiftWebKit in the dyld cache

`DSHSpike.debug.dylib` dies AT LAUNCH with `Library not loaded:
@rpath/libswiftWebKit.dylib` on an iOS 18.5 simulator — and every runner
builds cleanly first, so the failure surfaces only after install+boot and
burns the run's whole budget on a launch that can never produce app logs.
The mechanism: simulator runtimes older than 26 do not carry libswiftWebKit
in the dyld shared cache, so the debug dylib's Swift-WebKit dependency
cannot resolve at load time — a property of the installed runtime, not of
the build, so no rebuild fixes it.

Run the iOS E2E legs on the proven pairing — the `dsh-iphone` simulator on
iOS 26.5 — and fail loud BEFORE boot/install when a device's runtime is
older. Encoded: [hosts/ios/Tools/sim-preflight.sh](../hosts/ios/Tools/sim-preflight.sh)
(`MIN_MAJOR=26` at `:19` — "oldest simulator runtime whose dyld cache
carries libswiftWebKit"), which reads `xcrun simctl list -j devices` and
exits 1 naming the offending runtime; the listing is a parameter
(`SIM_PREFLIGHT_DEVICES_JSON`) so the rejection path is assertable without
booting anything. Each `test/e2e/run-ios-*.sh` runner calls it one line
before its boot/install step.

## Adding an entry

When a session pays for a new trap, append it here in the same change that
fixes or documents it: a two-paragraph entry — symptom + mechanism, then
fix — citing the code that encodes the fix (path, and line when the
reference is fresh), or saying plainly that no code encodes it yet. Both
language sides of this file change together (`gov verify pairing` enforces
the pair). A trap that recurs across sessions belongs here even when it
also lives in a note or a postmortem — this file is the one a fresh agent
reads before it re-pays for any of them.
