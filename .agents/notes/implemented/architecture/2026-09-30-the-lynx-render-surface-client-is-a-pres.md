# Agent Note: the lynx render-surface client is a presentation-plane plugin, off the contract

Status: implemented
Related: D5

## Problem

The presentation plane's clients all ride a WebView, and the owner wants a
Lynx face. The danger is architectural, not cosmetic: a Lynx client built
like a feature would either reach for the gateway (needing new primitives,
hence a contract change) or grow business logic into the render layer — and
the render-surface / event-channel proposals (`contract/proposals/
2026-09-26-*.md`, v1.7.0/v1.6.0 candidates) are still DRAFT, so any
contract-shaped work this round would have front-run the D5 process.

## Decision

`presentation/lynx-client/` ships as a presentation-plane CLIENT PLUGIN
running on the EXISTING product surface: it speaks the same SessionServe
wire the web clients speak (the wire client ported verbatim from
web-client-next, three-layer `{args:{request}}` envelope unmoved), adds ZERO
gateway primitives, edits NOTHING under `contract/`, and the two 2026-09-26
proposals STAY DRAFT — this pilot neither consumes nor commits them. The
seam is in-product (`RenderSurfaceClient`: mount / pushViewEvent / onIntent /
teardown); skins are swappable in one package at one version; the bundle is
pure presentation (zero network, zero gateway, zero business logic) with the
theme single-sourced to data. Acceptance rides two channels: the `lynx.mount`
CLI leg (34/34 one-to-one structured-log events on BOTH faces over one flow
— the replaceability proof; evidence
`presentation/lynx-client/artifacts/cli-lynx-mount-{lynx,stub}/`) and a
36-test vitest suite over the seam/fold/adapter/wire. The bundle also
renders for real on the @lynx-js/web-core platform in headless Chrome
(human-facing screenshot, gitignored `artifacts/screens/`).

## Alternatives considered

- Implementing the DRAFT render-surface proposal (`presentSurface` et al.)
  as gateway primitives this round: rejected — D5's contract-first order
  exists precisely so a pilot does not freeze its own contract; the
  proposals stay DRAFT until their own fold, and this pilot feeds them
  evidence instead of front-running them.
- A system-plugin with privileged capabilities: rejected — rendering is not
  a host capability; the client-plugin level (config-selected, wholly
  replaceable, zero gateway) is where the web clients already live.
- Bending the seam so the driver pushes domain events and the skins fold
  them independently: rejected — two folds drift; the fold is shared
  (`shared/fold.js`), the adapter is the one translator, and both faces are
  held to one structured-log contract by the same checker
  (`test/e2e/check.mjs`).
