# Agent Note: the iOS live test runs four dimensions — ten legs green, four blocked by a machine wedge

Status: implemented
Related: D8 (E2E by logs), the simulator-matrix precedent (T-0074)

## Problem

The owner's brief asked for a full live battery of the iOS host on the
simulator across four dimensions — UI (Debug+Release control sweeps, official
and self-hosted session surfaces), backend (gateway family, session, BYOK
onboarding, a REAL LLM turn), tools (tool rows, todo, wasm echo, ish, office),
capabilities (device plane, camera, mic, BLE, and a REAL marketplace install,
"the newest, most fragile face"). Screenshots are an owner-named deliverable
of this round; the standing rule (E2E verdicts are logs) is unchanged.

## Decision

The battery ran on `dsh-iphone` (iOS 26.5) via the existing runners, one leg
at a time, with every artifact under
`hosts/ios/artifacts/ios-live-test/<dimension>/<leg>/` (logs, scenario.jsonl,
verdicts, receipt, PNGs) and 17 representative shots in `deliverables/`. Ten
legs went green with receipts — the gateway four-manifest family,
session.mock-llm on the official client and on whale, nextweb.mount,
composer.live-write (46/46, with the tool-rows probe, the wasm echo
`hello from wasm`, and a REAL ish guest run `exit=0
stdout="hello-from-guest"`), device-plane, camera (honest sim
`unavailable`), mic (real Mac-mic frames), BLE mock and BLE skip.

The live run surfaced five real defects, each fixed in this branch with its
own evidence: the iOS stager missing six modules the BYOK/marketplace rounds
added (`llm-route.js`, `web-write-marketplace.js`, `web-write-onboarding.js`,
`marketplace-resolver.js`, `canonical-json.js`, `ed25519.js` — every boot.js
drive died at eval), `gen.sh` fetching the guest tarball after xcodegen read
resources (fresh builds shipped without the ish userland), the whale receipt
naming a verdict file that never exists in that mode, and two stale manifests
(nextweb-mount's missing the BYOK boot probe; composer-live-write's predating
tool-rows/session-cancel/mobile-default).

The marketplace install leg required an enabler: the iOS seat never carried
the write surface's `marketplace` option, so the panel could only answer the
capability gap. The seat now relays a staged catalog config
(`profiles/default/marketplace/config.json` → `{indexUrl, publicKey}`, the
llm-credential staging pattern; absent file = absent option = today's
behavior), and `composer-web-live.js` passes it through verbatim. The ish
probe rides the b4 scenario the same way (`log.debug`, no canonical record
moved — the manifests were re-pinned only where a product round had moved
the wire).

**Four legs are blocked, and this note is the exception record**: the
marketplace real install, the BYOK onboarding flow, the real-LLM turn (Debug
streaming leg + the release 51-mechanism path), and the Debug/Release control
sweeps all died with a machine-level CoreSimulator XPC deadlock (every
`xcrun`/`simctl` call hangs, including `simctl help`; killing the whole
process stack, kickstart, and lock inspection did not recover it). They are
an honest skip with the resume entry point written down
(`hosts/ios/artifacts/ios-live-test/BLOCKED-LEGS.md`) — the drive scripts are
committed, the app is installed, the container staging is done, so each is
one command once the simulator service is restored.

## Alternatives considered

- **Faking the blocked legs** — never: a fabricated screenshot or a
  plausible-looking log would poison every future verdict.
- **Waiting for the machine to recover before opening anything** — rejected
  (the escalation answer): ten green legs with receipts are the deliverable;
  parking them on a wedged host risks losing the whole round.
- **Hardcoding a market URL in the seat** — rejected: the staged-file relay
  keeps the deployment surface in the container (the llm-credential
  precedent) and the pin is the trust anchor, so a partial file must yield
  nil, never a half-pinned resolver.
- **Hand-editing the stale manifests wholesale from the log** — rejected
  after one bad attempt (a blind field-refresh overwrote same-event
  different-endpoint matchers); the manifests were patched surgically, three
  to five events each, and re-verified 25/25 and 46/46 in order.

## Consequences

- Every future iOS leg depends on the stager/gen.sh fixes: without them the
  BYOK, marketplace and onboarding runtime legs cannot boot on this host.
- The blocked legs need no re-staging; after a CoreSimulator recovery each is
  one command (BLOCKED-LEGS.md).
- `dsh-office` stays unmounted on iOS — the office leg remains a CLI and
  HarmonyOS story, disclosed rather than attempted.
- CI's assertion surface is untouched: all verdicts remain one-to-one log
  checks; screenshots enter the repo as the owner-named deliverable only.
