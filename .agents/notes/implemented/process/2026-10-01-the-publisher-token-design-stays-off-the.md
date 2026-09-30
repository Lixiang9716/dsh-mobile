# Agent Note: The publisher token design stays off the gateway — v0 owner-as-publisher, a named v1 token model, and a mock validator that caught its own implementation

Status: implemented

## Problem

The marketplace proposal (D5 draft, data-protocols v1.1.0 candidate) named
publisher v0 as "the owner's token" and left the v1/v2 identity evolution
undesigned. The user-management wiring face needed that shape on record —
who may publish, what credential proves it, where it is consumed — WITHOUT
turning it into a gateway change, and with evidence that the v1 token model
is more than prose.

## Decision

- `docs/marketplace-publisher-auth.md` (+ `.zh.md`, pairing-confirmed):
  v0 publisher = repo owner; CI is the acting identity (GitHub credentials
  in Actions secrets; no token artifact exists at all); the consumption
  point is the marketplace publish flow ONLY — end users stay on the
  already-vendored anonymous device identity
  (`@deepseek-ai/dsh-anonymous-user-id@0.1.6-alpha.2`,
  `runtime/spike/vendor/ensure-dsh.sh`). v1 (named, not built): short-lived
  PAT-shaped bearer `dshpub-v1.<claims>.<sig>`, TTL ceiling 8 h, issued via
  the OIDC IdP (CI exchanges GitHub Actions OIDC per run), validated
  entirely at the publish API side. Explicit non-coupling with #268
  profile-manifest (production-side vs consumption-side).
- Gateway-primitive survey verdict, recorded in the doc's §6: ZERO new
  gateway primitives at v0 or v1 — publish flow never touches the device;
  consumption rides frozen `httpFetch` + the install pipeline's trust
  record. No D5 stop. The one hypothetical that WOULD open the gateway
  (publishing FROM the phone) is named as out-of-scope-until-D5.
- `tools/publisher-token.mjs` + colocated `tools/publisher-token.test.mjs`
  (vitest, the test/tools face): the v1 envelope as executable design —
  pure function, offline, signature check injected, no gate or service
  wiring (v0 wires nothing). 15/15 green.

Falsify-then-restore was executed for real: the suite ran first against a
deliberately rule-less stub (14–15/15 RED), then against the real
validator. The restore leg then caught TWO genuine bugs the suite was
built to catch: (1) `hmacVerifier` returned the digest STRING while the S1
contract is `=== true` — fixed by making the verifier a strict boolean
predicate (timing-safe compare) and splitting mint from verify
(`hmacSigner` vs `hmacVerifier`); (2) the tamper leg's string `.replace`
was a no-op on a base64url payload — fixed by decoding, editing claims,
re-encoding, keeping the original signature. The counterexamples are the
permanent falsification record (rules.md rule 6).

## Alternatives considered

- A token artifact at v0 (API keys minted for CI): rejected — the repo's
  own credentials already ARE the v0 publisher identity; minting a second
  one adds a secret to leak and nothing to prove.
- Validating publisher tokens anywhere on-device "for defense in depth":
  rejected — the phone never receives a publisher token; consumer trust is
  the catalog signature (ed25519, pinned key). On-device publisher-token
  logic would be a gateway-face change requiring a D5 proposal, exactly
  what this task was scoped to avoid.
- Putting the validator under a new `test/` subpackage with its own runner:
  rejected — the test/tools face already owns the `tools/*.test.mjs`
  colocated convention and its vitest config; a new package would add
  plumbing for one pure function.
