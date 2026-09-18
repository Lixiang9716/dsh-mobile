# Decisions

The project's decision log: one entry per settled decision, numbered D0,
D1, … contiguously. Allocate numbers with `gov decision next` (it checks
the branch base for collisions), append with `gov decision add`, and
never renumber or reuse a row — decisions are addresses, not prose.

Every entry records what the decision BEAT under its Alternatives
heading; a decision without its alternatives invites re-litigation,
which is the exact failure this log exists to prevent.
`gov verify-decisions` checks numbering, the alternatives record, and
orphaned references; `gov recall` searches these entries.

## D0 — Adopt the govrail governance plane

- **Decision**: gates + notes + receipts as the working discipline
- **Alternatives**: prose-only agent rules (not checkable); ad-hoc conventions (drift silently)

## D1 — quickjs-ng as the mobile JS engine

- **Decision**: quickjs-ng (pure-C interpreter) carries the Harness core; nodejs-mobile rejected
- **Alternatives**: nodejs-mobile (V8: an order of magnitude more memory, JIT gray zones, no multi-runtime isolation)

## D2 — single-threaded coroutines replace subprocesses

- **Decision**: tool execution re-implemented in-process as coroutines behind `ctx.subprocess`
- **Alternatives**: requiring real subprocesses (physically refused on iOS); worker threads (defeats single-runtime auditability)

## D3 — UI is a Web Client plugin rendered in WKWebView

- **Decision**: official React UI is the default Web Client plugin; mobile-ui is another
- **Alternatives**: native-only UI (loses the official frontend and slot ecosystem); React Native rewrite (heavy, diverges from upstream web)

## D4 — distribution outside the App Store

- **Decision**: open-source, self-signed/TrollStore/EU channels
- **Alternatives**: App Store (guideline 2.5.2 bans downloaded code — a plugin ecosystem cannot pass); TestFlight (same review)

## D5 — contract first

- **Decision**: `contract/` (primitives + data protocols) frozen before any implementation
- **Alternatives**: code-first, freeze later (AI-era rework cost; four platforms drift before the地基 exists)

## D6 — pinned upstream + outboard implementation packages

- **Decision**: upstream DSH pinned (manifest), adaptations live in `system-plugins/`, never in vendored edits — same discipline applied to govrail itself in CI
- **Alternatives**: tracking upstream main (lineage breakage at 0.1.x velocity); wholesale fork (permanent merge debt)

## D7 — checkpoint as roaming

- **Decision**: checkpoint format shared across hosts; background suspension becomes cross-device handoff
- **Alternatives**: demanding background residency (physically refused by iOS); no persistence (tasks die at lock screen)

## D8 — all modules event-driven, including streaming

- **Decision**: inter-module communication is events or explicit async interfaces; LLM token streams are event pipelines; checkpoint = event queue drained
- **Alternatives**: direct module calls + blocking whole-result APIs (couples components, kills substitutability); polling (wasted battery, races)
