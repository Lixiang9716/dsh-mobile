# Agent Note: the whale client fixes the HIG bake-off round's defects

Status: implemented

## Problem

A four-skill HIG bake-off (one agent per skill, same target:
`presentation/web-client-whale/web/`) converged on the same defect list,
and every finding was cross-verified before this fix round:

1. `whale.css:113` (`#whale { animation-name: cruise, bob; }`) clobbered
   the `face-mirror` shorthand at `:59` — the whale never mirrored and
   swam backwards on the return leg (found by 4/4 reviewers, confirmed by
   computed-style probe).
2. Toolbar slot buttons rendered ~22px tall (11px type, `2px 8px`
   padding) — half the HIG minimum control size, on the page's only
   interactive controls (4/4).
3. Six infinite animations with no `prefers-reduced-motion` answer (4/4).
4. Transcript and connection state invisible to assistive tech: no live
   region on `#stream`, none on the status chip (4/4).
5. Fixed-px type throughout, ignoring the system text-size setting (4/4).
6. A zh-CN page whose entire dynamic vocabulary was English dev jargon —
   "connecting…", "live", "complete … deltas" (3/4).
7. The disconnected dot `#b3413c` measured ~2.9:1 against the blurred
   header — under the 3:1 non-text floor; and connecting vs disconnected
   shared the same red (3/4).
8. `cruise` animated `left` — a main-thread layout animation, the one
   motion anti-pattern the web checklist flags (1/4).
9. `#ocean[aria-hidden]` contained an SVG with `role="img"` +
   `aria-label` — unreachable dead semantics (1/4). Forced autoscroll
   yanked re-readers to the bottom on every delta (1/4). No empty state:
   "waiting" looked like "broken" (1/4).

## Decision

Canonical fix in `presentation/web-client-whale/web/`, re-staged byte
identically to the Android (`assets/spike/webclient-whale`) and HarmonyOS
(`rawfile/spike/webclient/dsh-web-client-whale`) mirrors:

- The stray override rule is deleted; `face-mirror` is the SVG's only
  animation again. `cruise` now animates the individual `translate`
  property (compositable) while `bob` keeps `transform` — independent
  properties compose, so no `animation-name` override can clobber a
  neighbor's work.
- Slot buttons: `min-height: 44px`, `0.8125rem` type, `6px 12px` padding,
  `:active` press feedback.
- `@media (prefers-reduced-motion: reduce)` stops every ambient loop;
  page JS gates bubble production on the same query, so the whale rests
  instead of freezing mid-gesture.
- `#stream` carries `aria-live="polite"` + an accessible name; the status
  chip is `role="status"`; the whale SVG drops its unreachable
  role/label (decorative inside the hidden ocean).
- Type moves to `rem` (body `0.9375rem`, chrome `0.75rem`), so the page
  tracks the system text-size setting.
- All user-facing strings are zh-CN (连接中… / 已连接 / 会话通道已连接 /
  已断开 / 会话… / 代理… / 工具… / 完成… · N 个增量 / 等待会话…). Verified
  first that no probe or E2E asserts on the old page strings: the
  whale-mount evidence flows from the WS projection JSON (`M4PagePump`
  parses `kind`/`deltas` payload fields), not the DOM.
- Three-state dot on the WWDC25 dark system palette (orange connecting /
  `#30D158` live / `#FF453A` lost), all clearing 3:1 on the header.
- Autoscroll sticks only when the reader is already within 40px of the
  bottom, measured before the append; an empty state (`等待会话…`) shows
  until the first event.

Visually verified with local playwright screenshots (debug-only per the
E2E rule): outbound leg whale faces right, return leg faces left,
reduced-motion context renders a still whale with zero bubbles, hit
target measures 44px, status/empty-state strings render, and the only
console error is the expected WS 404 against a static server.

## Alternatives considered

- Detenting the transcript as a bottom sheet (HIG Sheets pattern) and
  tokenizing the palette — real improvements, but they redesign the
  client's signature layout; deferred out of a defect round.
- `font: -apple-system-body` on the root to inherit WebKit Dynamic Type —
  non-standard and inconsistently supported outside WebKit (the client
  also renders in Android's Chromium WebView); rem tracks the OS setting
  portably.
- Keeping `left` and skipping the perf item — rejected: the `translate`/
  `transform` split composes correctly, so the anti-pattern fix and the
  override bug fix reinforce each other rather than conflicting.

## Consequences

The whale-mount E2E scenarios are untouched (WS contract unchanged; the
page's display vocabulary was never asserted). The page no longer reads
as an English dev console over Chinese chrome. Reviewers that re-run the
skill against this target should now clear the eight consensus findings
except the two deliberately deferred design-level items.
