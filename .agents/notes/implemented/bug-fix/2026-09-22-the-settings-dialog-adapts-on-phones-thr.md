# Agent Note: the settings dialog adapts on phones through the carrier style row

Status: implemented
Related: none

## Problem

The owner: "设置界面也不是和主界面一样，界面在手机上自动调整的". The main
screen adapts because the layout bundle's AppFrame measures its frame and
drops the sidebar below 1024px; the settings screen is upstream's fixed
800px desktop modal (`max-width: calc(100vw - 48px)`, a fixed 188px side
nav, zero media queries) — on a ~390pt phone it renders as a 342pt desktop
dialog with a half-screen sidebar. Upstream ships no narrow layout for it,
so no re-pin will fix it.

## Decision

Every official-page render now carries a webserver-contract §1.5 `style`
injection row with a phone adaptation, appended by all three row producers
per host (carrier defaults + runtime-composed rows; Android gained a
`Kind.Style`, Harmony a `renderRow` case, iOS already had the enum case).
At <=1024px the panel goes near-full-bleed (12px margins, radius 20); at
<=560px it is full-bleed, the panel flips to a column, and the nav becomes
a horizontal, horizontally-scrolling chip row. The scope hook is
structural — `div[role="dialog"][aria-modal="true"][aria-labelledby]`, the
served page's ONLY such element (attachment and the shell dialog use
`aria-label`) — never the unstable css-module hash classes. Specificity
(0,3,0) beats the bundles' hash classes (0,1,0) without touching inline
styles. Unknown injection-row kinds now abort with the offending name
(rule 5) instead of being silently dropped.

## Alternatives considered

- `:where()`-scoped low-specificity rules — rejected: specificity 0 loses
  to the bundles' hash classes and the patch would never apply.
- Patching the vendored bundle CSS or the dist build — rejected: vendoring
  a modified upstream build violates D6/D9 and breaks the manifest proofs.
- Hash-class selectors (`OQcYeW_*`) — rejected: the hash embeds the build
  path and changes on every upstream re-pin.
- `:has(> nav)` scoping — viable but unnecessary; `[aria-labelledby]`
  already uniquely identifies the settings panel.

## Consequences

The patch is fail-safe: if upstream changes the panel's a11y wiring the
patch silently stops applying (the desktop look returns) rather than
breaking. A future upstream row kind fails the boot loudly and must be
mapped. The CSS is duplicated as a constant per host by design (no
cross-host shared source exists); keep the three copies byte-equal.
