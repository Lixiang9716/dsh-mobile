# Agent Note: gate tools see ArkTS and name their rulers: logging covers .ets, code-size labels the fallback

Status: implemented

Related: govrail issues #340, #342, #343

## Problem

The two hand-wired product gates misdescribed the tree they claimed to
judge. The logging gate's extension set omitted `.ets`, so the ArkTS UI
layer — the layer most likely to log through a native logger instead of
`createLogger` — was silently outside the contract: a bare `console.*`
in `Index.ets` scored zero violations while the same call in a `.js`
host file failed the run (a false green, rule 6). The code-size gate's
fallback backend counted INDENT against every code line's literal
indentation, so idiomatic Kotlin closure chains (`Thread { }`,
`synchronized { }`, `use { }`) failed at depths no brace-logic language
would reach — and the violation lines did not say WHICH ruler named
them, so an adopter could not tell parse-backed flags from the
language-blind line counter, and the fallback's semantics lived only
in this file's docstring. Separately, the comment-state machine in
`strip_code` had a reported stuck-state class (`*/` closing at
end-of-line) with no regression proof — the forward-scanning closer
fixed it, but nothing pinned it, so the vacuous-L3 failure mode could
return silently.

## Decision

- `check-logging.py` scopes `.ets` in. The tree-sitter TS grammar
  ERRORs on ArkTS `struct` syntax, so gov parse skips these files and
  the brace heuristic carries them — the same fallback path Kotlin and
  Swift already ride. `Index.ets` declares `// dsh:logging-exempt`
  with its reason: the page logs natively via hilog, and the JS
  `createLogger` contract does not reach that layer — a declared,
  greppable boundary instead of a silent gap. The other twelve `.ets`
  files pass clean under the gate today; new ArkTS files are enforced
  from their first commit.
- `check-size.py` labels fallback INDENT violations
  `INDENT(indent-fallback)` (gov-parse-backed lines keep the bare
  `INDENT`), and the docstring states the counter's language-blind
  semantics: any line 6 units deep fails regardless of what opened it,
  and extracting named functions — not flattening below a natural
  style — is the compliant fix. Long term a shipped Kotlin grammar
  retires the fallback entirely; that is a govrail parse-layer
  dependency decision, not this repo's.
- `check-size.py --self-test` pins the comment-state machine with
  known-answer fixtures: the `/** ... */` one-liner, the indented
  ` */` closer at EOL, the closer trailing prose, and back-to-back
  one-liners — each asserting the function spans the heuristic must
  see and that no comment/quote state leaks past the file.

## Alternatives considered

- **Wiring `createLogger` into `Index.ets`** — rejected for now: the
  runtime logger is a JS module of the spike host, and bridging it
  into ArkTS UI code is a design decision for the D9 host work, not a
  gate-scope fix; the declared exemption states the truth until that
  lands.
- **Adding `.ets` to the code-size gate's extension set too** —
  rejected: ArkTS UI builds deeply nested declarative trees that the
  language-blind fallback INDENT would fail wholesale; until the
  fallback names a real grammar, scoping ArkTS into a gate whose
  contract it cannot honestly meet would manufacture reds, not
  coverage.
- **Shipping a Kotlin tree-sitter grammar in govrail** — the right
  long-term fix for the fallback class itself, rejected here: new base
  dependencies are a govrail-level decision with a wheel-matrix
  verification burden (its parse-layer adoption bar), and the labeled,
  documented fallback unblocks adopters today.
- **Leaving `*/`-at-EOL untested** ("the forward scan already works")
  — rejected: the reported failure mode was vacuous PASS, exactly the
  kind a regression cannot prove its absence without a fixture.
