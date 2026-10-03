# Agent Note: the keyless search's zero-anchor non-result pages fail, not parse to silent-empty (#346)

Status: implemented
Related: #346, #335 B5

Date: 2026-10-04 · Class: bug-fix

## Problem

The real-model device battery (2026-10-04, release seat, evidence
`.zcode/battery-real/web-search/`) drew `web_search` 4/4 times and every
call SUCCEEDED with zero sources — the model honestly reported "the search
tool returned no results" and gave up, when the truth was that this
network path is blocked. The provider's challenge detection (HTTP 202 /
the "bots use DuckDuckGo too" marker, the 2026-10-03 measurement) missed
a variant: DDG's anomaly-detection interstitial served as **HTTP 200
without the marker sentence** — the anomaly-modal chrome, zero
`result__a` anchors, and neither a results list nor a no-results
structure. `parseDuckDuckGoHtml` walked it, found no result rows, and
returned `{sources: [], truncated: false}` — a legal-looking empty answer.
A silent-empty success is worse than the coded error: at the seam the
model cannot distinguish "no news" from "blocked", so it never retries,
re-points the endpoint, or reports the block.

## Decision

The parser now classifies the page structurally before answering empty.
`parseDuckDuckGoHtml` (`runtime/spike/upstream/web-search-keyless.js`)
throws `webSearchError(CODE_CHALLENGED, …)` — with a whitespace-collapsed,
240-char page sample riding the message plus the standard escape-hatch
suffix — when the parse yields zero sources AND the page wears neither of
the two DOM shapes a real DDG answer can:

- the **results-list structure** (`result__a`/`result-link` titles, their
  `result__snippet`/`result-snippet` bodies, the `links_main`/`web-result`/
  `serp__results` containers) — exported as `hasResultsListDom`; and
- DDG's **genuine no-results structure** (`span.no-results` inside
  `.no-results__container`, the "No results found for" heading,
  `.result--no-result`) — exported as `hasNoResultsDom`.

Both shapes answer `{sources: [], truncated: false}` as before — a real
zero-hit page is an honest empty (the fixture is live-measured: a
force-zero-hit query fetched 2026-10-04 shows the no-results block wrapped
in the usual links chrome, which is why either marker suffices). The
existing HTTP 202 / marker leg in `searchOnce` is untouched and fires
first; the structural leg is the parser-level catch-all that ends the
200-variant hole. The panel suite carries both new fixtures
(`test/panel/web-search-keyless.test.js`): the marker-less anomaly page
fails with `CODE_CHALLENGED` (parser- and provider-level — the #346
regression), the no-results page stays an empty success.

While re-staging, the sync machinery itself showed the same silent-drift
class: #343 committed the harmony rawfile copy of
`upstream/web-search-keyless.js` but never listed it in
`vendor-official.sh`'s closure set, so `--closure-only` never refreshed it
and `--check` never byte-verified it (android's whole-dir mirror covered
its copy; harmony's sat one refactor away from this same bug). The file
now rides `SPINE_OURS` beside `turn-watchdog.js`; the committed copy is
byte-identical and the closures gate verifies it (494 → 495 verified
files).

One gate-integration wrinkle, recorded for the next editor of this file:
the new classifier regexes carry their quote characters as `\x22`/`\x27`
escape, not raw `["']`. `tools/check-size.py`'s line scanner has no regex
literal state — raw quote characters inside a regex toggle its string
state machine, and the wrong parity leaves a stuck quote at the file's
first regex (line 106's `uddg` pattern, pre-existing), after which every
block comment is consumed as string and the indent unit collapses to 1 →
phantom `INDENT level 6` violations on healthy lines. The hex escape is
semantically the same character class and keeps the scanner sane; the
checker's regex-blindness is filed for govrail feedback.

## Alternatives considered

- **Extend the marker list** (grep for more challenge sentences) —
  rejected: it is whack-a-mole against an adversary that varies the copy
  and the status code; the structural check needs no marker at all and
  also covers consent/portal pages that are not DDG's at all.
- **Treat every zero-anchor page as challenged** — rejected: DDG's real
  no-results page also parses to zero anchors; the model would lose the
  honest "no results" answer, which is a legitimate search outcome.
- **Classify in `searchOnce` by status alone** (fail any 200 that isn't
  accompanied by anchors) — rejected: the status is transport knowledge
  the pure parser intentionally lacks; putting the shape knowledge in the
  parser keeps `parseDuckDuckGoHtml` independently unit-testable (and the
  provider path inherits it).
- **Return `{sources: [], challenged: true}`** as a success with a flag —
  rejected: it changes the seam's shape for every consumer instead of
  using the coded in-band failure the tool layer already routes on
  (`error.code`), and a flag the model side can ignore is how the
  silent-empty survived to the device in the first place.
