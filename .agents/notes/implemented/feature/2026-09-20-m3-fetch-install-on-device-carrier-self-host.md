# Agent Note: M3 on-device fetch-install E2E — carrier self-hosted package over real httpFetch, startup replay, config-selected client

Status: implemented
Related: D5, D8

## Problem

PR-A proved the four M3 scope items on the shared JS, but the fetch leg ran
behind a logged stub — the brief requires a REAL on-device E2E where the tgz
is served by the iOS loopback carrier itself, and the config layer had to be
proven by a device screenshot, not just a CLI log. Two structural obstacles:
the scenario needs the carrier PORT before it can build the fetch URL, but
the existing readiness signal (`host.info`) is deliberately gated on the
page acking the plugin's toolbar slot — which only happens AFTER the install
— and the package bytes live in JS while the HTTP server lives in Swift.
The first on-device run also exposed a latent host bug: fsWrite append was
silently ignored.

## Decision

- Carrier self-hosting, transport only: the scenario serializes the
  deterministic fixture tgz and posts `{type:"http.serve", path, bodyB64}`
  over the EXISTING bus seam; `SessionRuntime` registers an in-memory route
  on `CarrierServer` (new `registerRoute`/`onRouteServed`, still
  JS-agnostic), and the fetch is a REAL gateway `httpFetch` over 127.0.0.1.
  No new gateway primitive (D5); the carrier never learns what the bytes
  mean.
- Port discovery without deadlock: in profile mode the carrier fires a
  `carrier.info` gateway event (with the port) when the page CONNECTS —
  earlier than `host.info`, which stays gated on the slot ack. The event
  order (ws.connected → carrier.info → route-registered → served) is
  causal on the runtime thread, so the carrier-side checker stays
  order-sensitive without racing the page.
- Config layer consumed by the host: `-dsh-profile m3-complete` loads the
  staged `profiles/m3-complete/cordis.patch.json` and merges it
  base → hostFace (launch args) → profile BEFORE eval — the patch selects
  the ACTIVE Web Client (mini) and REPLACES the toolbar slot allow-set.
  `SessionRuntime` enforces the set on the bus: a `slot.register` outside
  it is logged `slot.denied` and never delivered or replayed, so the page
  renders only the configured slot (screenshot evidence). The carrier
  evidence rides scenario `m3.fetch-carrier` (separate one-to-one manifest,
  same split as `m2.session`/`m2.webclient.mount`); the JS drive is
  `m3.fetch-install` (46/46). Drives without `-dsh-profile` keep the
  previous behavior byte-for-byte (regressions green).
- Host bug fix (fsWrite append): `FSPrimitives.write` read `append/create`
  from a nested `opts` object while the gateway shim flattens them at the
  top level of the args JSON (the reference encoding of the contract's
  `fsWrite(scope, path, bytes, opts)`), so append silently overwrote —
  caught by the receipt journal being the first append caller; fixed to
  read the flat fields (nested form tolerated) and recorded in
  `.gov/surprises.jsonl`.
- The runner `tools/e2e/run-ios-m3.sh` uninstalls the app before installing:
  the app scope persists across launches and the journal is append-only,
  so the startup-replay assertions need a container that starts empty.

On-device evidence: `m3.fetch-install` 46/46 + `m3.fetch-carrier` 11/11
under `hosts/ios/artifacts/m3-complete/` (screenshots include the rendered
"notes" button and the ABSENT denied slot in the config-selected mini
client). Regressions: `m2.session` 23/23 + `m2.webclient.mount` 7/7
(default), `m2.session` 23/23 + `m3.ui-swap` 7/7 (mini), `run-ios.sh` 4/4.

## Alternatives considered

- Swift builds the tgz to serve it — beat by JS-built bytes over the bus:
  duplicating tar-mini in Swift would create a second package
  implementation to keep in digest-sync with the fixture; the bus hand-off
  keeps ONE builder and makes the carrier a pure byte server.
- Firing `carrier.info` at server startup (before eval) — beat by firing at
  page-connect: events before eval are dropped by the shim, and the
  page-connect timing keeps every carrier event causally ordered after
  ws.connected, which the one-to-one checker requires.
- Profile patch delivered over the bus like the package — impossible for
  the CLIENT selection: the page to serve is chosen before the page exists;
  the patch must be read host-side pre-eval, hence a staged file + launch
  argument selecting the profile (the hostFace layer).
- Enforcing the slot set in the PAGE (web client JS) — beat by carrier
  enforcement: the carrier owns the projection bus, both shipped clients
  stay identical to their shipped bytes, and the denial is provable in the
  host log stream (the page logs nothing by design).
- Teaching the scenario to uninstall/reset the profile container — beat by
  doing it in the runner: storage lifetime is a host property, and an E2E
  that self-cleans its own assertions would be grading itself.
