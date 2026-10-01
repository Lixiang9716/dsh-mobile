# Agent Note: BYOK tails — onboarding/clear and the models-directory row that follows the live route

Status: implemented

Related: D5 (contract first — no new gateway primitive), D8 (event-driven),
D9 (the coverage plane); supersedes the two named follow-ups in
[the BYOK onboarding note](2026-09-30-byok-onboarding-the-first-run-credential-panel.md)
(same directory, 2026-09-30 — its Consequences named both tails; that note
is not edited).

## Problem

The BYOK onboarding round shipped save without removal: "the boot adapter's
key is not reachable from the write surface, so an in-process un-rebind
would be a lie" — a user who saved a wrong key had no way back except
reinstalling the app. The same round left the models 设置页 answering the
BOOT provider row forever: after saving a byok credential, the page's
directory join (`llm/listConfigurableProviders` × `credentials/describe` ×
the settings mirror) still showed the boot row — a display-only mismatch,
but a lie on the configuration surface. Both were named follow-ups.

## Decision

**The #280 constraint was re-investigated and does not hold in its absolute
form.** What is still true: the write surface's route view
(`deps.llmRoute` in web-write.js) deliberately carries no credential facts,
and no key crosses the wire in either direction. What changed: the
onboarding legs live RUNTIME-side with the boot context — save already
established that a wire handler may be handed what it needs at install time
(boot.js hands its adapter disposer to upstream/llm-route.js). The boot
route is a PURE function of runtime.config (`bootRouteOf(cfg) =
stagedRoute(cfg) ?? mockRoute(cfg)`), and the installer holds cfg. So an
in-process un-rebind is honest: the clear leg re-derives the boot adapter
from the same facts boot itself used. The lie the old note feared —
restoring a boot route without its credential — is exactly what the
factory prevents.

1. **`onboarding/clear`** (web-write-onboarding.js): `keychainSet(BYOK_REF,
   null)` — the frozen delete half (contract v1.0.0 row 9), no new
   primitive — THEN `restoreBootRoute(ctx)` (dispose the byok adapter,
   re-register the boot adapter through the registered factory) THEN the
   surface's `llmRoute` mutation back. Takes NO arguments, returns {} — the
   call is key-free by construction. Idempotent (clearing an unset ref
   deletes nothing). Fail-loud when the installer registered no factory (the
   save leg's own no-runtime precedent). Sessions created while the byok
   route was live keep their provider binding (session/CREATE reads the
   route then) — the same live-session semantics a save's rebind has always
   had, in reverse; the page copy says so.
2. **The unbind seam** (upstream/llm-route.js): `registerBootRouteFactory`
   (the installer registers `() => bootRouteOf(cfg)` — composer-web-live and
   the scenario legs) and `restoreBootRoute`. `rebindLlmRoute` gains the
   directory swap: boot.js hands its configurable-provider DIRECTORY
   registration over (`registerDirectoryHandle`), and every route swap
   atomically `.replace()`s the models-directory row — the display follows
   the live route (tail ②), display-only; the turn path reads the adapter
   registry.
3. **The settings mirror follows too** (web-write-settings.js): the
   namespace guard top-ups per provider — the first settings call after a
   route swap registers `llm-<provider>` with the route's CURRENT facts as
   its base layer (never the key; `apiKeyEnv` is the ref NAME). The
   superseded namespace stays registered (the vendored settings service has
   no unregister) but names no directory row anymore — the directory swap
   is what delists it.
4. **The page affordance** (web-client-next): the home view gains 模型密钥 ·
   Model key; it opens the onboarding panel — a saved byok key lands on a
   MANAGE face (provider + endpoint summary, bilingual, from
   `onboarding/status` — never key material) with 移除已保存的密钥 · Remove
   saved key; staged reads informational-only (the host seat owns it —
   removal is not this panel's to offer); mock lands on the setup form. The
   overlay gained a close button (the manage face is user-opened; the
   overlay is no longer strictly modal).
5. **The seam registries key on the boot CONTEXT, not the llm service.**
   Measured on the CLI spike host (quickjs-ng 0.17): `ctx.get('llm')` hands
   out a FRESH wrapper per access — two gets of the same mounted service
   fail `===` while carrying the same target state (property stamps visible
   on both). The pre-existing runtime-keyed disposer registry therefore
   silently missed every lookup through a later get; the #280 dispose step
   was a no-op that never mattered only because save always SWITCHED
   provider (no DUPLICATE_ADAPTER conflict). All three registries
   (routeDisposers / bootRouteFactories / directoryHandles) are now
   ctx-keyed strong Maps. Recorded as surprise
   `module-level-registry-keyed-ctxgetllm`.

Evidence: `onboarding.flow` 13/13 (`run-onboarding-e2e.sh`, dir
`runtime/spike/artifacts/macos-cli-onboarding/` — the clear leg asserts
status mock, the directory row restored to the boot provider, and a SECOND
TURN answered from the restored mock adapter with no relaunch; the key audit
stays green); `models.directory` 6/6 re-run; the api-coverage probe re-run
(37 coverage endpoints); the panel vitest 24 onboarding-core tests (71 total)
green; the evidence-matrix checker PASS (76 dirs / 152 verdicts, 7 accepted
owned gaps). Host mirrors re-staged byte-verified (android
stage-spine-closure, harmony vendor-official --closure-only; iOS embeds at
build time).

## Alternatives considered

- **Keychain delete + "takes effect after relaunch"** (the honest fallback
  the task sketched): rejected — the constraint it worked around no longer
  holds; a relaunch requirement would be a worse product with no honesty
  gain. The delete-only shape survives as the clear leg's FIRST step (the
  durable truth lands before the live swap, mirroring save's
  persist-then-rebind order).
- **A new gateway primitive (`llm/unbind` or a credential-wire
  primitive)**: rejected — D5; the frozen keychain delete half plus the
  vendored registry's own swap API cover it. `contract/` untouched.
- **Clearing through the models page's `credentials/unset`** (the plaintext
  credentials.json store): rejected — the boot route never reads that store
  for the byok route (the keychain is the source of truth); unsetting there
  would be the lie the old note feared, one store over.
- **Leaving the boot provider's directory row visible alongside the byok
  row**: rejected — the boot adapter is disposed on save; advertising a
  provider whose route is gone trades one display lie for another. The
  directory shows the LIVE route, one row.
- **Keying the seam registries on the llm service object (the #280
  shape)**: rejected after measurement — see Decision 5; the wrapper
  identity is not stable.

## Consequences

- Removal is a first-class product flow: save → manage → clear round-trips
  live, no relaunch, on every host that implements the frozen keychain.
- The directory row + settings namespace follow any future route swap that
  goes through `rebindLlmRoute`/`restoreBootRoute` — new route sources get
  the display for free by calling the seam.
- A live session bound to a cleared provider errors loudly on its next turn
  (the disposed adapter), exactly as a pre-save session does after a save;
  the page copy and this note say so. A relaunch clears the state.
- The vendored `DirectoryRegistrationHandle.replace` is load-bearing for
  tail ②; an upstream change to its all-or-nothing commit contract would
  need this seam re-checked.
- The `ctx.get` wrapper identity is now a known platform fact (surprise
  recorded); any future per-service registry in this runtime should key on
  the context or a process-global, never on a `ctx.get` result.
