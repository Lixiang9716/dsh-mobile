# Agent Note: aoci-code lands as the repository cognition layer — signed binary, ZCode workspace MCP, skeleton + baseline tracked

Status: implemented
Related: D6 (upstream discipline, by contrast), D8 (event-driven agent work)

## Problem

Every agent session in this repository re-derives system understanding from
scratch: grep + read + recall-first notes. The notes capture *decisions* and
their rejected alternatives, and graphify answers one-shot structural
queries, but nothing maintains a per-file cognition layer bound to source
digests — nothing can tell a session "this file's contract changed since you
last understood it" (drift), and the many concurrent flywheel sessions each
pay the same re-search cost. The repo needed a persistent, Git-versioned,
incrementally-updatable index that coding agents read before touching
anything and maintain as a normal part of closing a task.

## Decision

[aoci-code](https://github.com/aoci-spec/aoci-code) v0.1.0-rc17 is the tool
for that job, introduced as development tooling (never a runtime dependency):

- **Binary**: signed release tarball for linux-amd64, sha256-verified against
  the release `SHA256SUMS`, installed at `/home/lx/tools/aoci/aoci` (stable
  absolute path; FSL-1.1-MIT; single CGO-free Go binary). NOT vendored into
  the runtime closure — it is a host-side agent tool, not a QuickJS/DSH
  package, so the vendor-package pin tables do not apply.
- **Agent wiring**: ZCode workspace scope — `.zcode/config.json` →
  `mcp.servers.aoci` → stdio (`aoci mcp --repo <root>`). Machine-bound
  absolute paths, so it is gitignored; workspace-scoped MCP servers
  auto-connect in ZCode. `aoci init --agent` was NOT used: it writes config
  for claude/codex/cursor/opencode hosts, none of which run here.
- **Repo integration** (tracked): the `aoci:` managed block appended to
  `AGENTS.md` (existing content byte-preserved; init's backup file removed),
  the `aoci.txt` / `aoci.meta.txt` / `aoci.code.txt` index skeletons, and
  `.aoci/` formal assets (`config.json`, `baseline.json`; runtime assets
  stay excluded by `.aoci/.gitignore`).
- **Scope** (production profile, repo-adjusted in `.aoci/config.json`):
  excluded `vendor` (pinned upstream + materialized embeds — the pin tables
  are the provenance record, D6), `upstream-tests` / `upstream-suite`
  (upstream corpora), `.agents` (notes + skills have their own discovery
  surfaces), `.gov` (governance churn), `.zcode` (session scratch);
  re-included `build/` (real source here — `build/build.sh`). Baseline:
  1424 files, 1323 Entries pending (~55 Guide batches).
- **Line endings**: `.gitattributes` pins LF for the AOCI-managed files only
  (`aoci*.txt`, `.aoci/**`) — aoci baselines exact raw bytes. aoci-init's
  greenfield default (`* text=auto eol=lf`, repo-wide) was deliberately not
  adopted (see alternatives).

## Alternatives considered

- **graphify knowledge graph (graphify-out/)**: kept — it answers structural
  queries on demand but is a regenerated artifact, not incrementally
  maintained cognition bound to file digests, and carries no drift
  verification. The two are complementary; aoci is the maintained layer.
- **Status quo (AGENTS.md + recall-first notes)**: notes record decisions but
  not per-file responsibilities/relations/constraints; nothing detects when
  source drifts past an agent's understanding. `aoci verify`/`check` close
  that gap.
- **Repo-wide `* eol=lf`** (what aoci-init writes on new projects): rejected
  — a whole-repository checkout-policy change smuggled in by a tooling
  introduction; the byte-stability requirement only covers aoci-managed
  files.
- **Vendor aoci into the runtime closure**: category error — a Go MCP binary
  cannot ride the QuickJS closure, and D5/D6 forbid reaching around the
  gateway for host-side tooling.

## Consequences

- The Entries bootstrap (1323 targets, ~55 batches of model-authored F/R/A/S)
  is still open; `automation.mode=auto` means subsequent sessions follow the
  live Guide incrementally. Until Whole-Index coverage exists, `aoci check`
  reports `authoring_required` — that is the expected state, not a failure.
- Every future session inherits the AGENTS.md managed block's obligations
  (call `aoci_rules` first, run `aoci_maintain` at task close when managed
  objects changed). Sessions that ignore it lose only the new value; nothing
  existing breaks.
- Whole-index delivery is budgeted at 200k target tokens
  (`cognition_budget.whole_index`), inside the configured caps.
