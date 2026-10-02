# Agent Note: Marketplace opt-in: the staged marketplace config claims the seat's resolver legs

Status: implemented
Related: D9

## Problem

The marketplace coverage legs (marketplace/index, /installed, /remove and
the /install stream — #288) are claimable only through a write-options
`marketplace` flag nothing on the mobile seat ever set: `options.marketplace`
was absent by construction, so the legs stayed unclaimed (the carrier
answers gateway/unimplemented) and the #306/#303 device testing had no way
to exercise them. The opt-in needed a user-staged config route shaped like
the staged llm credential's — a file in the reserved app scope the seat
reads at boot and relays through runtime.config.

## Decision

`<appScope>/profiles/default/marketplace/config.json` = `{indexUrl: string}`
opts the seat in: SessionServe.loadMarketplaceIndex reads it (malformed or
missing file → null — the loadCredential precedent, the boot stays
unclaimed) and runtimeConfig delivers `marketplaceIndex`; composer-web-live
maps it to the write options' `marketplace: {indexUrl}` (an explicit
`cfg.marketplace` object still wins). The opt-in validates fail loud
(marketplaceOf, the llm-route stagedModels pattern, living in
web-write-marketplace.js beside the shape it validates): `{indexUrl}` with
an http(s) URL, `publicKey` optional — without it the resolver runs its
DECLARED GAP trust mode (logged per fetch), which is exactly the device
testing posture. The api legs' rejections are rethrown as the module's
wireOf triples, so the resolver's audit codes reach the wire verbatim:
an unreachable index answers `marketplace/network` ("index fetch failed:
…", details {status} on an HTTP status) — never a generic
gateway/unavailable. The seat's drive contract still treats any
claimed-endpoint failure as fatal, so testing stages a reachable index.

## Alternatives considered

- Delivering `marketplace: {indexUrl}` straight from runtimeConfig (no
  scenario mapping): lost — the task fixes the seat's key as
  `marketplaceIndex` (a string), and the two-line scenario mapping keeps
  the runtime.config surface descriptive (a URL, not an options object)
  while the existing `cfg.marketplace` object relay stays for explicit
  drive injections.
- Validating the url shape Kotlin-side (loader returns null on a bad URL):
  lost to rule 5 — a silent null would bury a misconfigured opt-in as
  "unclaimed"; the JS-side throw surfaces the offending value at boot.
- Baking `publicKey` into the config schema now: lost for v0 — device
  testing explicitly runs the declared-gap mode; the option shape already
  accepts a pinned key, so the config grows a field when a production
  anchor exists, not before.
- Claiming the legs from the historical set (like selectModel): lost — the
  marketplace rows are coverage-plane rows by design (#288); the opt-in
  changes WHICH boots claim them, not where they live.
