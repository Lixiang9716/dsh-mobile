# Agent Note: the harmony release serves the official UI (serving/evidence split in OfficialServe.ets)

Status: implemented
Related: D5, D6

## Problem

The owner's semantics for the release/harness split (the note
`2026-09-21-the-release-log-strip-is-real-end-to-end.md`, PR #83) are that a
RELEASE build IS the user-facing product: a plain launch reaches the official
DSH Web UI, and the verification machinery is what the HARNESS has. iOS and
Android hold that on device; HarmonyOS did not. `dsh-harmony` defined the flag
correctly and stripped its logs, but a plain launch REFUSED instead of
serving:

```
DSH release build: refused — the user-facing serving path is not implemented
yet (the serving stack lives inside the E2E drives) — use the harness variant
```

The reason was structural, not a flag: the harmony serving stack (the carrier
seats `WebDist`/`WebPlugins`/`ApiBridge` on `CarrierServer`, the web-boot
runtime that composes the official boot wire, the `/plugins` delivery, the
origin open) was interleaved with evidence plumbing inside a 1377-line
`model/OfficialPhase.ets`. The row-swap, the plugin-rev override and the
origin open all happened between `emit(…)` calls, the hooks the drive
installed were the same objects the serving path wrote into
(`dist.onAssetServed`, `bridge.onMuxFrame`, …), and the page probe, the
`httpFetch` / session-live / write legs and the terminal verdicts all shared
the same class state (`bootApplied`, `finished`, `originOpened`). There was no
seam to point at, so "serve it in release" meant either duplicating the
serving logic (a second copy to drift) or shipping the drives — and the second
copy is exactly what the byte-identity discipline exists to prevent.

## Decision

**Two files, one direction of dependency.** `model/OfficialServe.ets` is the
SERVING seat. It owns `CarrierServer` + `WebDist` + `WebPlugins` +
`ApiBridge` + `HttpFetch`, the web-boot runtime (`hostStart`/`hostEval` on the
mount entry), the chunked `/plugins` delivery, the `web.boot` application
(rows into the index render pipeline, plugin revs, one origin open) and the
gateway dispatch for `httpFetch`. It runs in BOTH configurations: the release
boot in `pages/Index.ets` constructs it with NO hooks assigned and no launch
parameter, and `model/OfficialPhase.ets` — now the EVIDENCE drive — holds an
instance and verifies it.

**The seam is a hook block, and its defaults are no-ops.** `OfficialServe`
exposes `onCarrierUp`, `onIndexRendered`, `onIndexServed`, `onAssetServed`,
`onComboServed`, `onUpgradeAccepted`, `onSeatOpen`, `onAPICall`,
`onMuxOpen`, `onMuxFrame`, `onMuxErrorFrame`, `onWebBoot`, `onAPIRespond`
plus the serving output `onOrigin` and three serving calls the legs need
(`evalEntry`, `startLeg(ctx, scenario, capturePath, mounts)`, `deliverBus`,
`deliverWebPlugins`, `deliverEvent`, `finish`, `seat()`). The seat reports
serving FACTS; what a fact means — which canonical record it becomes, under
which scenario id, once or every time — is the drive's business. The drive
assigns the hooks in `wireEvidence()` and writes every `dsh.spike.log:`
record itself (`emit`/`emitOnce`/`carrierLine`), so the record order each
manifest pins is unchanged and lives in one place.

**The release boot is a serving boot and nothing else.** `Index.aboutToAppear`
splits three ways on `BuildFlavor.isRelease()`: an E2E leg is refused LOUD by
name (`release build: refusing: dsh.e2e.leg m2.llm asks for a verification
drive; a user-facing build runs none — use the harness variant
(dsh-harmony-harness) to drive E2E legs`, also rendered on screen), a plain
launch materializes the bundled closure and runs `OfficialServe` with the
web as the whole page (no verdict panel, no `spike: running…` placeholder,
no `onPageEnd` probe — the `OfficialPhase` object is not even constructed),
and the harness keeps its existing three-phase page unchanged.

**The last native verdict emitter is gated on the same define.** The harmony
C++ wrapper printed `dsh.spike.verdict: …` from `startSpike` (the regression
trio) and from `phase_drive` (the path a release boot's mount runtime actually
reaches). Both are now inside `#ifndef DSH_RELEASE`: a verdict stream is
harness machinery, and a user-facing launch must not put one in the user's
log. The latch (`verdict_logged`) stays outside the guard — the verdict is
still decided once per phase, only not printed.

**Evidence** (`hosts/harmony/artifacts/release-logging/`, `run.sh` re-runs
both configurations and exits non-zero on any violation): release plain
launch → the official DSH Web UI rendered (real PNG; the origin served to
ArkWeb, the app's own `/api/remote.mux` seat open, the clean index loaded),
0 `dsh.spike.log:` records, 0 verdict text, 0 debug/info records — in the
whole hilog window AND in the truncation-proof capture file; the refusal by
name; the harness contrast (the same suite re-run, all eight checker verdicts
green).

## Alternatives considered

- **Copy the serving path into a release-only class.** Two implementations of
  the same boot wire — the one the manifests verify and the one users run —
  drift by construction, and the vendored-bytes discipline (cmp-verified
  copies, `check-bundle-files.mjs`) exists precisely because that kind of
  split has burned this repo before. Rejected.
- **Keep one class and gate evidence on `BuildFlavor.isRelease()`.** The
  smallest diff and the shape PR #83 left on iOS (`OfficialWebRuntime(
  evidence:)`). It does not give the structure a name: the serving path stays
  interleaved, the release boot still names the drive, and the correctness of
  "release emits zero records" rests on every future edit remembering that an
  `if` is load-bearing. The file boundary is checkable by reading; the flag
  is checkable only by testing. Rejected after the iOS precedent was
  considered — harmony's drive was far more interleaved than iOS's.
- **Run the release boot through `OfficialPhase` with hooks unset.** The
  drive's constructor starts the SCRIPTED model boundary and its probe
  scaffolding, and `onPageFinished` would need a release branch anyway — i.e.
  a release build that constructs verification machinery it then ignores.
  Rejected: the honest version is that a user-facing build has no drive at
  all.
- **Strip the harness scenarios/system-plugins out of the release rawfile.**
  Shrinks the shipped bytes but changes the BUNDLE_FILES contract and the
  `check-bundle-files.mjs` invariant, and nothing in the acceptance semantics
  needs it — the bytes are inert without a leg to run. Out of scope here;
  if the shipped size matters later it is its own change with its own gate.
- **Leave the C++ verdict line ungated** (it is not a `dsh.spike.log:`
  record, so the release count assertions would still pass). Rejected: a
  verdict line in a user's log is verification machinery leaking through the
  one channel the log strip does not cover, and the acceptance bar is the
  user-facing build, not the string the test greps for.
- **Give the release boot an empty capture path so it writes no file at all.**
  `host_start` warns when the capture file is not writable, and a warn in a
  clean release window reads like a defect. The cache-dir file is the same
  channel that carries the critical set (warn/error) in release, so it stays —
  and its emptiness is asserted as part of the evidence.

## Consequences

- The release/harness split on HarmonyOS is now behavioural, not just a flag:
  the same serving seat runs in both configurations, and the difference is
  whether a drive is attached. `dsh-harmony` is a user-facing build on the
  same terms as `dsh-ios` / `dsh-android`.
- The gap the previous note recorded ("HarmonyOS release is honestly NOT yet a
  usable user build") is closed; the honest gaps that remain are the mount
  leg's own, shared with every host: `/api` and the mux answer unclaimed
  endpoints structurally (the session surface is served on the harness's
  spine legs only), and a real chat turn needs user-supplied credentials.
- `OfficialServe.ets` is now the place a new serving behaviour lands, and the
  hook block is the contract with any drive: adding a fact to the release path
  means adding a hook, not an `if (isRelease)`.
- The release build still ships the harness scenarios in rawfile (inert with
  no leg to run them) — a packaging simplification left for later, recorded
  above rather than silently done.
