<!-- gov:rules --> Read .gov/rules.md and follow it before starting work.

# Agent Working Agreement — dsh-mobile

## Project in one line

A mobile host for the DSH (DeepSeek Harness) ecosystem: QuickJS single-threaded coroutine runtime
carrying the Harness core, iOS capabilities wrapped as privileged layer / capability gateway /
system implementation plugins, and the UI as a pluggable Web Client. Full design in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Non-negotiable constraints

1. **Contract first (D5)**: `contract/` is frozen before any implementation code lands. If your
   change needs a new gateway primitive, propose it in `contract/` first — never reach around the
   gateway.
2. **No subprocesses, no threads touching the JS runtime**: JS executes on one serial thread only;
   all host callbacks dispatch onto the runtime queue (see ARCHITECTURE.md §6 thread rules).
3. **Upstream discipline (D6)**: upstream DSH packages are pinned; never vendor modified copies —
   adaptations live in `system-plugins/` as outboard implementation packages.
4. **No `hostType` branching (RFC 0002 anti-pattern)**: platform differences are expressed only via
   capability negotiation.
5. **Logging through the unified logger only**: `createLogger` — the module every host actually
   bundles is `runtime/spike/logger.js` (the canonical TS source `runtime/logger/index.ts` is the
   contract that port must match, but nothing bundles it; the `logging` gate names the operative
   one) — with `log.debug(...)` at entry of every non-trivial function; bare `console.*` fails the
   `logging` gate. Release builds keep only `warn`/`error`: each platform's Release configuration
   compiles the shared C host with `-DDSH_RELEASE`, which injects `globalThis.__DSH_RELEASE__`, and
   the logger's `debug`/`info` become no-ops — keep that branch wired (rule L4).
   Exemption marker: `// dsh:logging-exempt`.
6. **Event-driven only (D8)**: modules communicate via events or explicit async interfaces —
   no polling another component's state, no shared mutable state across module boundaries, and
   any long-running work (LLM streaming, tool runs, subagents) reports progress as an event
   sequence. Blocking whole-result APIs are rejected in review (ARCHITECTURE.md,
   "Event-driven execution").
7. **E2E by logs, not screenshots**: CI end-to-end tests assert on structured
   logs — each scenario has a unique `scenario-id` and a one-to-one
   expected ↔ logged match (ARCHITECTURE.md, "E2E verification"). Screenshots
   are for local interactive debugging only, never CI assertions.
8. **Bilingual docs, English-first**: code, commits, and reviews are English. Human-facing docs
   follow the govrail pairing convention — `<stem>.md` (English source) with a `<stem>.zh.md`
   counterpart and a `<stem>.i18n.yaml` pairing record. When you edit one side of a pair, run
   `gov verify pairing --write <stem>` to re-confirm (never hand-edit the record).

## Quality gates

This repo is gated by govrail: `gov run` executes the gate DAG (wired into pre-push and CI via
`.github/workflows/gov.yml`); pre-commit runs cheap content gates on staged files. `gov` is not on
PATH by default — it is a uv tool install (`uv tool install govrail`, entry point `gov`), which on
this machine lands at `~/.local/bin/gov`. Govrail requires Python ≥3.10.

## Where things live

See the repository layout in [docs/ARCHITECTURE.md §9](docs/ARCHITECTURE.md#9-repository-layout)
and the milestone table in [README.md](README.md). M0 scope lives in `contract/`.
The build entry is **`build/build.sh`** — `build|test|check|sync` ×
`ios|android|harmony|core|all` (build = sync + compile + test); see
[BUILD.md](BUILD.md). The committed host copies of the canonical closure are
gated by `closures` — if it is red, run `build/build.sh sync <platform>`.

## Landing changes (main is protected)

`main` requires a pull request with a passing `gates` check; force pushes and deletion are
refused. The owner retains an admin bypass — reserved for deliberate direct landings, not a
default. Default flow for every change: branch → commit → push → `gh pr create` → wait for the
`gates` check → merge (squash). Do not push straight to main. Commits and squash-merge PR
titles follow Angular Conventional Commits (`type(scope): subject` — feat/fix/docs/style/
refactor/perf/test/build/ci/chore/revert; enforced by the `commit-format` gate).

## File issues proactively (standing duty)

If a tool, dependency, or upstream project misbehaves or lacks something you need, **open an issue
in its repository — never stay silent**. Same for missing features you find yourself wanting.
De-duplicate first, write repro steps over opinions, English only. (govrail-specific assessments
belong to the section below; the principle is general.)

## govrail field feedback (standing duty)

govrail is early-stage and this repository is one of its practice grounds. **After every completed
task, assess how govrail behaved during that task** and report it to the user alongside the task
summary: what worked, what was friction (install/PATH/hooks/gate behavior), what was missing, what
you wanted but didn't exist, and any false positives/negatives the gates produced. Be specific and
concrete — repro steps over opinions. These observations feed govrail's iteration.
(Agent skill: `govrail-field-feedback` — follow its full procedure when available.)
