# Agent Note: The security adversarial net lands: four attack legs + the threat model turn "the sandbox is the moat" into regression-observable evidence

Status: implemented

Related: D5 (contract first), D2 (no subprocess/thread), rule 6 (verify the world), rule 9 (task card T-0087)

## Problem

"Security" so far was prose plus a handful of rejection paths asserted
incidentally by feature legs. The claim "the sandbox is the moat" had no
evidence net: nothing attacked the gateway validation face, the wasm jail's
import surface, the install pipeline's manifest face, or the BYOK
credential's leak path; a defense could rot silently and no checker would
redden. Worse, the wasm jail was UNTESTABLE on the cheapest host — the CLI
answered `unavailable` for contract v1.2.0 `wasmRun`, so the import-surface
claim (the module's only host callback is `dsh.emit`) could not be attacked
anywhere CI reaches.

## Decision

Four adversarial legs (each a scenario + one-to-one checker + runner +
committed evidence) over the six surfaces inventoried in the new bilingual
threat model ([docs/security-threat-model.md](../../../docs/security-threat-model.md)):

1. **security.gateway-fuzz** (25/25): a 21-case malformed-primitive battery
   through the RAW `__dshGatewayCall` seam — wrong types, missing fields,
   path escapes, unknown scopes, a 1 MB path, an over-length keychain ref,
   negative/missing bounds, must-not-exist primitive names, malformed args
   JSON, two out-of-boundary socket targets — every attack must produce a
   structured §3 rejection (`invalid`/`denied`/`unavailable`), and a benign
   post-battery roundtrip proves the process survived. The two socket
   attacks are audited with the host's fixed reason codes.
2. **security.jail** (19/19): 8 crafted wasm modules (hand-assembled, the
   builder lives in the scenario) against the import surface — a hostile
   import called, the sanctioned name with the wrong signature, an
   out-of-bounds emit pointer, stack exhaustion, missing export, absent
   module, path escape, ungranted scope — plus 6 out-of-loopback socket
   dials (`::1`, `0.0.0.0`, `localhost`, `127.0.0.2`, mesh, no scope),
   every one denied and audited. The honest echo module runs BEFORE and
   AFTER the battery: the jail serves sanctioned callers and survives.
   **Enabler**: the CLI host now SERVES `wasmRun` through the portable
   spine (host/dsh_wasm.c + the same 11 wasm3 TUs the iOS app compiles,
   wired into build.sh and main_cli.c's dispatch with the fs primitives'
   scope discipline and a message sanitizer) — the dev/test profile no
   longer declares `unavailable` for a seam it already carries.
3. **security.manifest-forgery** (11/11): five pipeline forgery rungs
   (capability escalation past a stale trust record → `integrity`; the
   same escalation with fully recomputed trust → `capability`; entry
   replacement against the catalog anchor → `integrity`; id swap →
   `manifest`; an old package against the current anchor → `integrity`),
   each audited with zero staging and no journal — plus the control honest
   install after the ladder.
4. **security.byok-leak** (7/7): a canary credential through keychain save,
   relaunch route resolution, one REAL transport turn, and the 401 face —
   the error message asserted key-free IN RUNTIME — then the runner audits
   the RAW log for both secret values behind a MATCHER SELF-CHECK (the
   seeded-leak proof runs in the leg itself). The shared mock server
   wrapper gained `DSH_MOCK_LLM_KEY` (default unchanged: `mock-key-0001`)
   so the leg's real value is the one the mock demands.

**HIGH FINDING (recorded, not absorbed)**: the manifest-forgery leg's
freshness rung replays a stale-but-VALID catalog (honestly signed by the
landed publisher tooling under the test pin) and **the replay installs** —
`dsh-echo@0.9.0` lands through the resolver
(`forge.rollback.catalog outcome=installed`, evidence in
`runtime/spike/artifacts/macos-cli-security-manifest-forgery/`). The pin
anchors the signing key, not an epoch; `generatedAt` is checked for
presence only. Within the architecture's own adversary model (a hostile
mirror is why the catalog is signed at all) this is HIGH. Named follow-up:
a client-side freshness anchor (monotonic `generatedAt` floor or a publish
epoch in the pin); the leg's checker pins today's truth and flips to
`rejected` in the same change that lands the guard.

The threat model doc pairs EN/ZH with per-surface "defense today / how this
leg attacks it", the leg registry, and the maintenance contract (new attack
= new rung + manifest line + evidence re-run; a defense landing flips the
pinned expectation deliberately). Every leg keeps its counter-evidence:
fuzz/jail fail if an attack RESOLVES; the byok audit proves its matcher
before trusting its green.

## Alternatives considered

- **A separate wasm-jail harness binary** (driving dsh_wasm_run directly,
  bypassing the gateway): rejected — the ask's bar is "rejected + audited +
  no crash" AT the gateway; a harness below the seam would prove the
  interpreter but not the serving path, and audits live in the serve layer.
- **Leaving `wasmRun` unavailable on the CLI and skipping the wasm face as
  device-only**: rejected as the exact dishonesty the threat model exists
  to prevent — an unattackable claim; the spine already carried the code
  (dsh-core compiles dsh_wasm.c + wasm3 for iOS), so serving it on the CLI
  is ~40 lines of dispatch + the build wiring, not a port.
- **Duplicating the §7.1 signed-catalog tamper ladder** inside the forgery
  leg: rejected — the ask names it: reference the marketplace.install
  ladder; this leg owns the package face and the freshness face it does
  not cover.
- **Asserting the rollback rung as "rejected"** (assuming a freshness
  guard existed): rejected — the rung ran BEFORE pinning and the attack
  landed; pinning a rejection would have been a fabricated defense. The
  finding is reported at its real severity.
- **A new gov gate for the legs**: not needed — the legs ride the evidence
  matrix (committed dirs, manifests, receipts), the same plane every CLI
  leg uses; the e2e-matrix gate re-checked 80 dirs / 156 verdicts green.

## Consequences

- The CLI descriptor gained `wasmRun` in `available`; capability
  negotiation for packages requiring `wasmRun` now succeeds on the CLI
  (`dsh-shell-wasm` becomes installable there). No committed checker pinned
  the old unavailable-row set; the regression legs re-ran green
  (marketplace.install 71/71, onboarding.flow 9/9).
- The falsify-first proofs ran and are part of this record: a wrong
  expected code reddens gateway-fuzz; an injected canary log line reddens
  the byok audit ("a credential value leaked into the log (HIGH finding)").
