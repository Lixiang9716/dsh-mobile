# Agent Note: the web_search tool's failure text carries its machine-routable code — the model's text-only seat can route on the error class (loop-n)

Status: implemented
Related: D9

## Problem

The keyless web_search's coded errors never reached the model's seat: the
runtime throws `{name: 'WebError', code, message}` (the codes are
machine-routable — WEB_SEARCH_KEYLESS_CHALLENGED/STATUS/UNREACHABLE/
CONFIG), but the tool-result surface a model or battery reads is TEXT
ONLY, and that text carried just the explain() message. Tester r3 leg B
observed the consequence directly: the challenge variant fired correctly
(the dedicated pre-throw warn ×3) yet the assistant answered "There is no
numeric error code — the tool returned a plain-text error message" — the
model could not route on the error class (retry vs reconfigure vs give
up), and tests/gates could assert the code only from the runtime seat,
never from the tool-result surface.

## Decision

`webSearchError(code, message)` prefixes the message with the code:
`[WEB_SEARCH_KEYLESS_CHALLENGED] web_search: …`. One line at the
constructor — every throw site inherits the prefix, and the code rides
BOTH the structured metadata (unchanged: name/code/objectContaining
assertions) and the text the model actually sees. The bracket form keeps
the code greppable and distinct from prose.

## Verification

`test/panel/web-search-keyless.test.js`: a new case asserts the challenge
error's message starts with `[WEB_SEARCH_KEYLESS_CHALLENGED] ` and still
carries the page sample; the constructor's shape case now asserts the
prefixed message. Panel suite: 195 passed (14 files).

## Alternatives considered

- A structured tool-result envelope (the tool returning
  `{error: {code, message}}` instead of throwing): rejected here — the
  result-vs-throw shape is the vendored tool layer's contract (D6); the
  text channel is what this repo's adapter controls, and the prefix
  achieves loop-n's routability at one line.
- A per-site message rewrite naming each code in prose: rejected — eight
  throw sites would drift from the code constants; one constructor
  guarantees the prefix by construction.
- Teaching the model the code VOCABULARY (a prompt-side legend of the
  four codes): deferred — the codes are self-describing
  (CHALLENGED/STATUS/UNREACHABLE/CONFIG); a legend is worth adding only
  if tester rounds show the model misrouting despite the visible code.
