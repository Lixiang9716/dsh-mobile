# Agent Note: the four residual agent-loop groups go green — closure-grade fs/zlib primitives, latin-1 atob, and the harness's Error/spy/wait surfaces

Status: implemented

## Problem

Four `core/agent-loop` spec groups could not run or failed through the CLI
harness: `config-session-id` (11/17), `shutdown-drain` (0/2),
`serial-listener-review` (hang on test 3), and `system-prompt-admission`
(13/15). The transpiler also still excluded the entire corpus family that
touches `expect.poll` and `@deepseek-ai/dsh-session-persistence-jsonl`, so
none of the persistence specs could even load. Underneath, the failures were
never agent-loop bugs: the vendored persistence spine's first real exercise
of our primitive layer exposed five independent gaps (a broken host
primitive among them) that ASCII-only consumers had never reached.

## Decision

- `node:fs/promises` shim grew node's common write flags — `w` (the jsonl
  write-lease lock file), `a` (durable append, handle writes append at EOF),
  `r+` (repair/rollback with handle `truncate`), `fd` identity on handles,
  options-passing `stat` (the lease's `{bigint}` inode-identity check), a
  recursive `readdir`, a real workspace `appendFile`, and a `truncate` that
  no longer lazy-self-imports (name-based relative resolution invented the
  nonexistent builtin `node:fs/fs-promises.js`).
- `DshBuffer` gained node's numeric byte accessors (`readUInt8` …
  `writeBigUInt64BE`, variable-width `readUIntLE`/`writeUIntLE`) — the zstd
  frame scanner binary-parses the container with them.
- `node:zlib` accepts strings (utf8, like node) and `node:timers/promises`
  resolves `setTimeout`/`setImmediate` on the v1.4.0 timer seam instead of
  refusing.
- The HOST `atob` now honors its latin-1 contract: bytes >= 0x80 re-encode
  as UTF-8 before `JS_NewStringLen`, so `charCodeAt(i)` is the byte. ASCII
  callers never noticed the old mangling; the zstd magic byte did.
- The harness: `toEqual` compares both-sides-Errors by name+message
  (quickjs owns `stack` as an enumerable own property, so the generic
  key-count walk failed every `toEqual(new Error(m))`), spy mocks forward
  `this` (vitest's spy does; a spied `resolveModel` reads `this.reasoning`),
  `vi.waitFor`/`vi.waitUntil` and the conditional collection forms
  (`it.skipIf` family) landed — the latter two extracted into shims files to
  keep the harness under the code-size budget.
- The transpiler's stale exclusions for `expect.poll` (timer seam exists)
  and `session-persistence-jsonl` (vendored koffi-free since the 2026-09-23
  harvest) are gone; corpus 207 → 229 specs.
- Result: all four groups 0-fail; the full 19-spec agent-loop group is
  389 passed / 0 failed through the CLI harness; parity stays
  golden-identical.

## Alternatives considered

- JS-side b64 decode in the zlib shim (avoid the host C change): rejected —
  `atob`'s contract is latin-1 and other vendored consumers (zod format
  validation) would keep hitting the same wall one byte above 0x7f; the
  primitive itself was defective.
- Keeping the one-sided Error branch in `matchSubset` (any Error vs
  anything): rejected after interception's `agent/error` collector failed —
  `expect.objectContaining` against an Error actual must stay a subset
  match, exactly like vitest; the branch now applies only when both sides
  are Errors.
- Whitelisting the four specs past the exclusions instead of removing the
  exclusion rules: rejected — the rules' premises were false (the seam
  exists; the package is vendored), and a whitelist would have left the
  next expect.poll spec excluded for no reason.

## Consequences

The corpus grew by 22 specs across other groups; they are transpiled but
unverified here — the sweep owners inherit them as runnable surface, not as
green claims. The sync-time BUNDLE_FILES guard disagreement (write mode
only) is pre-existing at this baseline and is recorded in the surprise
ledger, not fixed here.
