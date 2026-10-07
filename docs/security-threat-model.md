# Security threat model — the adversarial evidence net

English | [简体中文](security-threat-model.zh.md)

The moat is not "there is a sandbox". A sandbox claim that nothing attacks
is prose, and prose does not catch regressions. This document is the
inventory of hostile surfaces this architecture exposes, the one-sentence
defense each has today, and the adversarial leg that attacks it — every leg
a committed, re-runnable evidence run whose rejection records are pinned
one-to-one by a checker. An attack that lands is a **finding**, recorded
here at its real severity, never absorbed into prose.

The legs live in the repo and re-run on the cheapest host (the macOS CLI):
[security.gateway-fuzz](../runtime/dsh/ci/run-security-gateway-fuzz.sh) ·
[security.jail](../runtime/dsh/ci/run-security-jail.sh) ·
[security.manifest-forgery](../runtime/dsh/ci/run-security-manifest-forgery.sh) ·
[security.byok-leak](../runtime/dsh/ci/run-security-byok-leak.sh).

## Adversary model

The attacker we defend against (per surface, the strongest of these):

- **A hostile plugin** — arbitrary JS running inside the runtime (the
  marketplace threat: any package that cleared the install pipeline), which
  may call the RAW `__dshGatewayCall` seam with arbitrary bytes, bypassing
  every typed shim.
- **A hostile mirror** — control of the marketplace hosting's bytes (any
  content at the catalog and package URLs), including stale content the
  publisher once legitimately signed.
- **Kerckhoffs** — everything in this repository, including every attack in
  the legs, is known to the attacker; the keys are the only secret, and the
  production signing keys never live here.

Out of scope (named honestly, not hidden): OS-level compromise, extraction
of a credential from the OS keychain (SecItem/Keystore) or from the
signing CI, memory-corruption attacks on the C interpreters themselves
(QuickJS-ng, wasm3 — the fuzz battery stops at the validation face and the
jail leg asserts the interpreters trap, not that the C is exploit-proof),
and side channels.

## The surfaces

### 1. Gateway validation face

**Defense today**: every primitive validates its arguments at the host
boundary and answers the frozen contract §3 vocabulary — `invalid`
(malformed), `denied` (a scope the host never granted), `unavailable` (a
primitive this host does not serve) — fail loud, never a default; a
rejection is structured, not a crash ([runtime/dsh/host/main_cli.c](../runtime/dsh/host/main_cli.c),
the smoke backend's per-primitive validation).

**This leg's attack**: [security.gateway-fuzz](../runtime/dsh/ci/run-security-gateway-fuzz.sh)
fires a 21-case battery through the raw seam — wrong types, missing fields,
`..` and absolute path escapes, unknown scopes (case and name), a 1 MB
path, an over-length keychain ref, negative/missing timer bounds, three
primitive names that must not exist, two malformed args-JSON bodies, and
two out-of-boundary socket targets — and demands a structured rejection
per case plus a benign post-battery roundtrip (the process survived).
Evidence: `runtime/dsh/artifacts/macos-cli-security-gateway-fuzz/`
(21/21 rejected; both socket attacks audited with fixed reason codes).

### 2. Marketplace supply chain — the signed catalog

**Defense today**: the catalog signature IS the trust (data-protocols
§7.1) — canonical-JSON ed25519 over the digests, keys pinned out-of-band,
rotation through the §7.2 dual-signed window, and the signed trust record
passed through untouched to the unchanged installer, so tampered hosting
can never produce an installable package.

**Attack (referenced, not duplicated)**: the §7.1 tamper ladder already
lives in the `marketplace.install` leg — bad signature, a self-consistent
attacker catalog (trust is the pin, not the document), a hostile mirror
serving flipped bytes behind an honest catalog, and an honestly re-signed
publisher metadata error. Four rungs, each `InstallRejected` + audited +
zero staging
([run-marketplace-install-e2e.sh](../runtime/dsh/ci/run-marketplace-install-e2e.sh),
evidence `runtime/dsh/artifacts/macos-cli-marketplace-install/`).

### 3. Marketplace supply chain — catalog freshness (defended: the freshness anchor; #295 HIGH closed)

**Defense today**: the client-side freshness anchor — a monotonic
`generatedAt` floor ([runtime/dsh/marketplace.js](../runtime/dsh/marketplace.js),
persisted by [runtime/dsh/freshness-store.js](../runtime/dsh/freshness-store.js)):
every refresh verifies the signature FIRST, then compares the catalog's
publication time against the newest one this client has ever ACCEPTED —
the floor, persisted through the caller's data plane (one app-scope file;
not the keychain, no new gateway primitive). Older than the floor →
`catalog` rejection BEFORE the resolver holds the document as state and
BEFORE rotation learning (a rejected document teaches nothing and moves
nothing); equal passes (a republished identical catalog must not brick);
newer advances the floor; first contact (no floor) accepts and anchors —
a fresh client is never bricked. The floor is keyed to the MARKETPLACE,
not a key: key rotation neither resets nor bypasses it, and only a catalog
that verified under the trusted set can advance it (an attacker cannot
poison the floor forward — their catalog never verifies). The anchor is
REQUIRED at resolver construction: a resolver without one fails loud
(rule 5). The anchor store reads the filesystem honestly: the gateway's
`io` code covers BOTH "absent" and "present but unreadable"
(contract/primitives.md, filesystem additions v1.1.0 — no second code),
so a failed read is never taken as first contact on faith — the store
consults the host's `fsStat` (stat-proven absence = first contact; a
file present but unreadable fails LOUD rather than silently resetting
the floor; the host shape that cannot prove absence resets only at WARN
level, never silent).

**This leg's attack — and the flip**: [security.manifest-forgery](../runtime/dsh/ci/run-security-manifest-forgery.sh)
hosts the CURRENT catalog (generatedAt 2026-10-01) beside a stale-but-VALID
one (an honestly signed old index, generatedAt 2026-09-01 — the model for
a compromised mirror serving what the publisher once published). The rung
anchors the floor on the current catalog (first contact), then replays
the stale one: **the replay refuses at refresh** —
`"event":"forge.rollback.catalog","outcome":"rejected","code":"catalog","via":"catalog-replay"`
(evidence `runtime/dsh/artifacts/macos-cli-security-manifest-forgery/`)
— nothing stages, and the current catalog still refreshes afterward (the
equal floor passes; the guard holds no grudge). The rung previously pinned
today's-truth-as-HIGH-finding: the replay INSTALLED (#295 — the pin
anchored the signing key, not an epoch, and `generatedAt` was validated
for presence only). The checker flipped to `rejected` in the same change
that landed the guard, per the maintenance contract below; the
falsify-first proof keeps the flip honest — with the floor check neutered
the replay lands again and this checker reddens.

**Remaining faces (declared, not absorbed)**: FIRST, the first-contact
hijack — the boundary condition this defense's own design carries: the
floor defends a client that has contacted the marketplace honestly at
least once. A device whose FIRST refresh lands on the compromised mirror
has no floor yet — the stale-but-valid catalog installs and anchors the
floor at the stale value (everything ≥ it then passes). That is inherent
to the client-side floor: the epoch-in-the-pin alternative that would
bound even the first contact was considered and rejected (the Agent Note
"the freshness anchor lands" — an epoch is a second out-of-band artifact
to distribute and rotate). The #295 HIGH therefore closes for ESTABLISHED
clients; the first contact remains an honest trust bootstrap, in the same
class as the out-of-band pin itself (the pin's distribution is trusted
the same way). SECOND, the panel's install stream
([upstream/web-write-marketplace.js](../runtime/dsh/upstream/web-write-marketplace.js))
resolves through [marketplace-resolver.js](../runtime/dsh/marketplace-resolver.js),
whose rejection vocabulary (network/format/unknown-key/signature) has no
stale code — guarding that face is a wire-vocabulary decision, the named
follow-up. The contract face this leg attacks is the one the §7.3 install
passthrough rides. Consequence carried honestly: a publisher clock error
that publishes a FUTURE `generatedAt` advances clients' floors past the
correct present — catalogs then fail loud until the publisher republishes
with the corrected time. Fail-loud beats silent rollback.

### 4. QuickJS sandbox (no native surface)

**Defense today**: the runtime is one serial QuickJS thread with no
subprocess and no thread escape (D2); there is no native FFI surface from
JS — every capability crossing is a gateway call, so the validation face
(surface 1) is the whole attack surface from inside JS; module code never
executes with host privileges.

**Attack**: the raw-seam battery of `security.gateway-fuzz` IS the
from-inside attack (the strongest thing JS can do is call the seam); the
`unknown.spawn` / `unknown.fschmod` rungs pin that no subprocess- or
permission-granting primitive even exists to name. No native face to
fuzz beyond the seam is itself the claim this leg keeps honest.

### 5. The wasm jail

**Defense today**: a wasm module runs interpreted IN-PROCESS (vendored
wasm3, contract v1.2.0 `wasmRun`) and its ONLY host callback is the
imported `dsh.emit(ptr, len)`; a module importing anything else has
nothing to link to, an emit outside the module's memory traps in the
host-side bounds check, and every interpreter-level failure (bad parse,
missing export, stack exhaustion) is a structured `io` rejection —
[dsh_wasm.c](../runtime/dsh/host/dsh_wasm.c). Served on the CLI through
the same portable spine the iOS app compiles, so the jail is attackable on
the cheapest host.

**This leg's attack**: [security.jail](../runtime/dsh/ci/run-security-jail.sh)
runs crafted modules: a hostile import called (`env.evil` — nothing to
link), the sanctioned name with the wrong signature (link refusal), an
emit pointer past the memory (bounds trap), infinite recursion (stack
trap), a missing export, an absent module, a scope-escape path, a scope
the host never granted — 8/8 rejected, and the honest echo module runs
before AND after the battery (the jail serves sanctioned callers; the
process survived). Evidence:
`runtime/dsh/artifacts/macos-cli-security-jail/`.

### 6. The socket seam's loopback boundary

**Defense today**: audited LOOPBACK-ONLY TCP (contract v1.8.0's five-rule
model) — the narrowest-scope default, only the literal `127.0.0.1`
dialable, one structured audit record per listen/connect/accept with FIXED
reason codes (attacker-controlled text never enters the audit JSON).

**This leg's attack**: `security.jail`'s socket battery dials four targets
outside the boundary — the IPv6 loopback `::1`, the unspecified `0.0.0.0`,
the NAME `localhost`, the loopback-adjacent `127.0.0.2` — plus a
mesh-scope listen and a listen with no scope at all: 6/6 `denied`, each
one audited (`host-not-loopback=4`, `scope-not-loopback=2`), and
`security.gateway-fuzz` adds a lan listen and a `169.254.169.254`
metadata-service dial on top. The metadata dial matters: a plugin that
could reach it could harvest cloud credentials — it is refused at the
serve layer with an audit record.

### 7. Capability authorization & audit

**Defense today**: install-time negotiation (data-protocols §2) — every
`capabilities.required` entry must be offered by the host's descriptor,
fail loud BEFORE anything unpacks; at run time every grant-checked call
(socket seam) and every rejection (this whole net) leaves a structured
audit record with a fixed vocabulary.

**This leg's attack**: [security.manifest-forgery](../runtime/dsh/ci/run-security-manifest-forgery.sh)
escalates a manifest's capability requirements two ways — past a stale
trust record (`integrity`, the anchor catches the tamper before
negotiation) and with fully recomputed trust (`capability`, the negotiation
face refuses what even self-consistent bytes cannot buy: `notify@2` is not
offered). The pipeline rungs also pin the id anchor and zero staging after
every rejection (no `.staging-<tx>/` tree, no journal line — the
transaction never reached its commit point).

### 8. BYOK credential flow

**Defense today**: the credential lives in the keychain (frozen
`keychainSet`/`keychainGet`, contract v1.0.0 rows 8–9) under one ref,
never a plaintext file; route resolution is the one home that reads it
([upstream/llm-route.js](../runtime/dsh/upstream/llm-route.js)); llm.js
never logs a header or body — the key rides the Authorization header,
wire-only; credential values never cross the wire back (the write
surface's own rule).

**This leg's attack**: [security.byok-leak](../runtime/dsh/ci/run-security-byok-leak.sh)
drives a CANARY through the save, the relaunch route resolution, a REAL
transport turn, and the 401 error face — asserting IN RUNTIME that the
error message carries neither the canary nor a separate wrong-key probe
value — then the runner audits the RAW log for both values, after first
proving its matcher fires on a seeded line (a grep that cannot match is an
audit that cannot catch). Screenshot capture has no runtime surface (it is
host/OS-side); the leak faces code can reach — logs, error messages, route
facts — are the ones this leg audits, and the shared mock now accepts the
leg's canary as its expected bearer so the REAL value is the one on the
wire. Evidence:
`runtime/dsh/artifacts/macos-cli-security-byok-leak/`.

## The leg registry

| Leg | Scenario id | Checker | Evidence dir | Regression it catches |
| --- | --- | --- | --- | --- |
| gateway fuzz | `security.gateway-fuzz` | [security-gateway-fuzz.json](../test/e2e/scenarios/security-gateway-fuzz.json) | `runtime/dsh/artifacts/macos-cli-security-gateway-fuzz/` | a primitive that stops validating (an attack case resolves, or a code drifts) |
| jail (wasm + socket) | `security.jail` | [security-jail.json](../test/e2e/scenarios/security-jail.json) | `runtime/dsh/artifacts/macos-cli-security-jail/` | a wider wasm import surface, a missing emit bounds check, or a leakier loopback boundary |
| manifest forgery | `security.manifest-forgery` | [security-manifest-forgery.json](../test/e2e/scenarios/security-manifest-forgery.json) | `runtime/dsh/artifacts/macos-cli-security-manifest-forgery/` | a weaker pipeline anchor/negotiation, or a freshness anchor that stops refusing the replayed catalog (falsify-first: neuter the floor check and this checker reddens) |
| byok leak | `security.byok-leak` | [security-byok-leak.json](../test/e2e/scenarios/security-byok-leak.json) | `runtime/dsh/artifacts/macos-cli-security-byok-leak/` | a credential value reaching any log sink, or an error face that echoes secrets |

## Maintenance contract

- A new attack case is a new rung: a case in the scenario, one line in the
  checker, one evidence re-run — never a prose claim.
- A defense landing flips the pinned expectation deliberately, in the same
  change (the freshness rung is written for exactly that flip).
- Every leg keeps its counter-evidence (rule 6): the fuzz/jail rungs fail
  if an attack RESOLVES; the byok audit proves its matcher on a seeded
  leak before trusting its green.
