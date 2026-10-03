# Agent Note: the binding scenarios pin the documented PHASED_ROWS set; the full runner's pins follow the runtime again

Status: implemented
Related: D3

## Problem

`run-android-full.sh` phase 2 was red on any cold AVD (issue #332, the
recurrence of the #176 class): `android.capability-binding` aborted with
`host declared unavailable primitives: cameraRecordStart,cameraRecordStop`.
The root cause is not the host — the capability plane's v1.10.0 phased rows
are unavailable BY DESIGN (`GatewayCore.PHASED_ROWS`, `HostPhase.ets`) and
the manifest itself expects `descriptor.declared {available: N,
unavailable: 2}` — it is the SCENARIO: `android-capability-binding.js` (and
`harmony-capability-binding.js`, whose 27/27 register row predates #252 and
whose `available === 15` pin is a fossil of the nine-primitive era) still
demanded zero unavailable primitives. The demands and the manifests
contradict each other, and no CI leg runs these scenarios, so the
contradiction sat unseen until a local full run hit it.

Chasing the red exposed the same silent-rot class on two more fronts, all
downstream of "nothing executes the full runner": the stager's scenario
roster omitted `android-capability-binding.js` entirely (the file's own
"embed-list trap" — staged bytes frozen on a fresh install while the source
moved), and three manifest pins had drifted from the live runtime
(descriptor available 32→34, agent-turn tools 6→14 after the creator-mode
tool-surface growth, write-surface endpoints 17→21 after
model-selection/session-control landed).

## Decision

- The binding scenarios pin the DOCUMENTED unavailable set instead of zero,
  mirroring the rule `gateway-binding.js` already established: every
  unavailable row must be one of `PHASED_ROWS`
  (`['cameraRecordStart','cameraRecordStop']`, cited to the capability-plane
  proposal), so a primitive regressing to unavailable — or a face quietly
  widening the list — still fails loud, by name. harmony's stale
  available-count pin goes with it; the available count stays the
  manifest's assertion, not the scenario's.
- `stage-spine-closure.sh`'s scenario roster carries
  `android-capability-binding.js` (both legs), and the staged copy updates
  with this commit.
- The drifted manifest pins follow the runtime with values read off live
  device runs, never guessed: descriptor 34/2, tools 14, write-surface
  endpoints 21 (order preserved). `expect.length` is unchanged everywhere —
  frozen evidence's expected counts stay valid, so no committed capture is
  re-opened.

## Alternatives considered

- Drop the scenarios' unavailable check entirely: rejected — the check is
  the regression net; pinning the documented set keeps it loud while making
  it honest about the phased rows.
- Loosen the manifest pins to tolerances (`repeat`-style ranges) so counts
  stop drifting: rejected — exact pins are what make the drift LOUD; the
  disease is not the pins but that nothing executes them between landings.
  The cure for that half is #332's still-open process point (a CI leg for
  the full runner), which this change deliberately does not claim.
- Update only Android (the face I can run locally) and leave harmony's
  identical latent red: rejected — one runtime semantic, one rule; the
  harmony scenario is the same one-line pattern and its register evidence
  is stale precisely because nobody could see it fail.

## Consequences

The full 5-phase runner is green end-to-end on a cold AVD again (phases
1-5, including the layout-truth probe leg from the ui-occlusion round):
capability-binding 35/35 + audit 16/16, officialweb-mount 14/14 + probe
1/1, session-live-read 46/46, composer-live-write 45/45. The next
capability-plane or tool-surface landing will drift these pins again —
that is by design; what changes is that #332's process half (a CI leg)
is now cheap to adopt because the runner is green to build on.
