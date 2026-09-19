# Agent Note: Checker function spans were vacuous or wrong for indented comment closers and destructured signatures

Status: implemented
Related: D0

## Problem

The shared function-span ruler (`tools/check-size.py`, reused by
`tools/check-logging.py`) mis-stripped block comments whose closer carried
leading whitespace (` */` — the common formatter style): the comment state
never closed, every following line was swallowed, and such files came back
with EMPTY function spans. The `code-size` and `logging` L2/L3 checks were
therefore vacuous on those files — green while proving nothing. Fixing the
stripper exposed a second pre-existing flaw: the brace counter closed a
span on its own signature line when parameters were destructured
(`function f({ a }) {`), and closed mid-body on a first-line destructuring
(`const { bytes, mtime } = ...`), producing false L3 violations against
code that does log. 16 real L3 gaps had accumulated invisibly under the
vacuous checker.

## Decision

`_consume_open` now scans forward to the first `*/` (block comments do not
nest) instead of only testing the resume index; `brace_functions` anchors
depth at the body opener (the signature line's last `{`) and accepts a
depth-0 `}` as the close only at the signature's indentation with no
further `}` on the line — anything else is a balanced in-body pair and
counting continues. Both `git ls-files` / `gov parse` subprocess calls
pass explicit `encoding="utf-8"`. The 16 real L3 gaps got their entry
`log.debug` calls (no `scenario` field, matching the gateway-shim debug
convention so the E2E one-to-one matchers are unaffected — verified
live: `m2.bridge.smoke` 6/6 and `m2.session` 22/22 still PASS), and the
two embedded copies of `m1-spike-boot.js` were re-synced byte-identical.

## Alternatives considered

- Marking the affected files logging-exempt: rejected — it would have
  parked the gate's promise instead of making the gate true (rule 6).
- Requiring a direct `log.` call only in functions above a size
  threshold: rejected for now — threshold tuning is policy creep at
  fix time; the repo convention (entry logs even on small handles)
  already exists and W-M2 code follows it.
- Replacing the heuristic with `gov parse` spans everywhere: the right
  long-term home, but a larger migration; the heuristic now fails loud
  in the right direction and the parse-backed path already covers 33 of
  52 files.
