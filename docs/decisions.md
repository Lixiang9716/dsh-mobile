# Decisions

The project's decision log: one entry per settled decision, numbered D0,
D1, … contiguously. Allocate numbers with `gov decision next` (it checks
the branch base for collisions), append with `gov decision add`, and
never renumber or reuse a row — decisions are addresses, not prose.

Every entry records what the decision BEAT under its Alternatives
heading; a decision without its alternatives invites re-litigation,
which is the exact failure this log exists to prevent.
`gov decision verify` checks numbering, the alternatives record, and
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

## D9 — Port upstream DSH packages as verbatim plugins; never reimplement Harness behavior in-house

- **Decision**: product-carrying upstream packages (agent-loop, session, session-projection, llm, settings, cordis runners) are vendored VERBATIM (pinned tarball + sha256 + PROVENANCE, the ensure.sh pattern) and driven through adapter plugins: system plugins implement the upstream service contracts (fs / subprocess Service / ui) over the 9 gateway primitives, a transport seam maps upstream fetch onto httpFetch, and the runtime boot constructs the upstream runner with those services. In-house code is glue only (shims, adapters, scenarios) — never product behavior.

## Alternatives

- In-house reimplementation of the Harness flow on QuickJS (what the first overnight iteration drifted into: a self-authored mini agent-loop + mock LLM + in-house session flow): rejected — forks product behavior from upstream, guarantees divergence at 0.1.x velocity, and contributes none of the mobile constraints back to the ecosystem; the host would own a second Brain.
- Full nodejs-mobile to run upstream unshimmed: rejected — D1 already beat it (memory footprint an order of magnitude higher, JIT gray zones, no multi-runtime isolation); the shim surface is small and measured (ARCHITECTURE.md §3).
- Pin-and-fork upstream (vendor once, edit locally): rejected — D6's lineage discipline; verbatim + shims keeps re-pins cheap and upstream improvements flowing.
