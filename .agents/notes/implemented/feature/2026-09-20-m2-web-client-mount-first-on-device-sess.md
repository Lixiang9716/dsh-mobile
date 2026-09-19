# Agent Note: M2 Web Client mount + first on-device session (iOS carrier)

Status: implemented
Related: D3

## Problem

The M2 gateway binding proved the privileged layer, but the UI on screen was
still the M1 spike page: no Web Client plugin existed, nothing mounted a
pluggable Presentation surface, and no agent session had ever run on device.
Without a mounted client, "the UI is a swappable plugin" (D3) and the
event pipeline "mock-LLM → projection → carrier WS push → rendered page"
(D8) remained unproven on real hardware.

## Decision

`presentation/web-client/` ships the first Web Client PLUGIN
(`dsh-web-client`, manifest type=web-client with a `web/` assets dir): a
static page that knows only the loopback HTTP + WS protocol and renders the
`session-projection@0` event vocabulary (session / agent / token-delta /
tool / complete) into a live transcript — zero host awareness. The iOS host
gains a session launch mode (`-dsh-mode session`, default launch sequence
unchanged): `SessionRuntime` stages the bundle INCLUDING the system plugins
and the configured Web Client (`-dsh-web-client`, default `dsh-web-client`),
serves the plugin's `web/` directory through the carrier, starts
`scenario/m2-session.js` (the PR-A scenario, unchanged except that it now
also pushes projection events over the bus seam, which hosts without a bus
sink drop silently), and releases the host.info readiness signal only when
the mounted page's WS hello arrives — so token deltas stream live into the
rendered page, with a replay buffer covering late connects. Carrier-side
evidence rides the canonical `dsh.spike.log:` envelope as scenario
`m2.webclient.mount` (mounted / connected / first-and-last streamed delta /
session complete), checked by `tools/e2e/scenarios/m2-webclient-mount.json`
alongside the unchanged 22-event `m2-session.json`; the auto-run driver is
`tools/e2e/run-ios-session.sh` (no UI interaction, no idb). Both checkers
pass on device; the four prior scenarios stay green through the unchanged
`run-ios.sh`.

## Alternatives considered

- **Swift-rendered transcript (native UITextView)** — rejected outright:
  it would have hardcoded UI in the host, the exact anti-thesis of D3.
- **Scenario waiting on a WS peer BEFORE starting (carrier-coupled)** —
  would have broken the platform-neutral CLI proof; instead the readiness
  signal is the existing `host.info` gateway event, which the CLI backend
  also emits (port 0), so one scenario serves both hosts with no
  hostType branching (RFC 0002).
- **WKWebView loading a bundled file:// page** — rejected: the carrier's
  loopback HTTP mount IS the architecture (static files served by the
  carrier, WS same-origin); file:// would fork the transport.
- **Pushing deltas only on request (page pull)** — rejected as polling
  (D8 forbids it); the page never asks — the host pushes, and a replay of
  already-pushed events keeps reconnects consistent without any pull path.
