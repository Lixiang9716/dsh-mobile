# Agent Note: logging gate and unified logger

Status: implemented

## Problem

Nothing prevented log drift: bare `console.*` calls scattered across modules, no per-module
logger identity, functions with zero observability, and no mechanism guaranteeing that logs
disappear in release builds while debug builds stay verbose. Retrofitting observability after
the runtime exists would be far more expensive than gating it in from day one.

## Decision

Two pieces shipped together:

1. **Unified logger** (`runtime/logger/index.ts`): the only permitted logging surface.
   Debug builds emit through the host sink (`globalThis.__DSH_LOG_SINK__`, bound by the
   capability gateway); release builds fold to no-ops via the `__DSH_RELEASE__` bundler
   define plus dead-code elimination — "logs vanish in release" is a compile-time property,
   not a runtime volume knob.
2. **`logging` hard gate** (`tools/check-logging.py`, registered in `gates.json`):
   - L1 no bare `console.*` calls
   - L2 every module with block-bodied functions declares `createLogger(...)`
   - L3 every block-bodied function body contains at least one `log.*` call
     (expression-bodied arrows exempt; nested bodies attributed to the innermost function)
   - L4 `runtime/logger` keeps its `__DSH_RELEASE__` branch wired
   - Scope: JS/TS under runtime/ system-plugins/ presentation/ hosts/; file-level
     exemption marker `// dsh:logging-exempt` (used by the logger library itself);
     tools/ dev scripts out of scope.

## Alternatives considered

- **Lint-plugin route (eslint no-console + custom rules)**: precise, but introduces a full
  ESLint toolchain before any source exists; the Python gate reuses the check-size parser
  and ships today. A per-host ESLint config can adopt these rules later.
- **Runtime-only suppression (log level flag, keep calls in release)**: rejected — dead
  calls still cost bundle size and leak message content into shipped binaries; compile-time
  elimination is strictly stronger.
- **Per-function log enforcement without exemptions**: expression-bodied arrows are exempt
  (logging them would force block bodies); the file-level exemption marker covers the logger
  library itself, which has nothing to log to.

## Consequences

Every future module writes `const log = createLogger('<area>:<name>')` first and calls
`log.debug(...)` on entry to non-trivial functions — the gate makes forgetting impossible.
The host must bind `__DSH_LOG_SINK__` before any module code runs (capability-gateway
obligation, tracked for M1). Cross-language (Swift/Kotlin) log gating is deferred until
those hosts exist; `print`/`println` bans will mirror L1 then.
