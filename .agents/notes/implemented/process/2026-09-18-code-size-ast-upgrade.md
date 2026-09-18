# Agent Note: code-size AST upgrade via govrail's tree-sitter stack

Status: implemented
Supersedes: the "Stricter AST-only checking for brace languages" alternative in
`2026-09-18-code-size-gate-500-50-5.md` (that rejection was made under govrail 0.29.4,
which shipped no parsing stack — the condition changed).

## Problem

The signature+brace-depth heuristic mis-measures function spans whenever strings contain
braces (template literals like `` `block { not-a-brace` ``), misses single-expression arrows
entirely, and mis-attributes object-method boundaries. On a governed repo those errors mean
the gate itself is an unreliable ruler.

## Decision

govrail 0.35.0 ships a tree-sitter stack, so `tools/check-size.py` now uses exact
tree-sitter spans for TS/TSX/JS/JSX/MJS/CJS (`function_declaration`,
`generator_function_declaration`, `method_definition`, `arrow_function`, `function`),
keeping `ast` for Python. The heuristic remains as an automatic fallback when the optional
dependency is absent, and the summary line reports the precise/heuristic split (e.g.
"4/4 parsed precisely"). CI installs the pinned grammars (`tree-sitter==0.23.*`,
`tree-sitter-typescript==0.23.2` — same stack govrail 0.35 ships; 0.23 because the local
CommandLineTools Python is 3.9).

## Alternatives considered

- **tree-sitter 0.26 (govrail's exact core)**: requires Python ≥3.10; the local
  CommandLineTools interpreter is 3.9. The 0.23 grammar line parses the same languages for
  this gate's purposes; revisit when the local toolchain moves to 3.12 (planned via uv).
- **Running the gate inside govrail's uv tool environment**: rejected — couples the project
  gate to govrail's install path; the gate must run identically under hooks, CI, and CLI.
- **Keep heuristics**: rejected after a side-by-side — on a sample with a template-literal
  brace, AST found 3 function spans where the heuristic found 1 and got lucky on the rest.

## Consequences

Swift/Kotlin files still use the heuristic until a host needs them gated precisely; adding
`tree-sitter-swift`/`-kotlin` grammars is now a known, small extension. The CI workflow
installs the grammars explicitly; a fresh clone without them degrades loudly (the summary
line shows the precise/heuristic split), never silently.

Update (govrail 0.37.0): the tree-sitter imports are gone again — the gate now
delegates parsing to govrail's declared `gov parse --json` primitive (#265 shipped),
keeping `ast`/heuristic only as a fallback when the command is unavailable. The
project gate is back to pure rule declaration.
