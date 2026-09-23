# Upstream DSH test suite — CLI host sweep inventory

Generated 2026-09-23T05:50:09.004Z — driver: `build/dsh-spike-cli . scenario/upstream-suite-leg.js --env DSH_UPSTREAM_SPEC=upstream-tests/<NAME>.spec.mjs`, 90s alarm timeout per spec, logs in `logs/<NAME>.txt`.

**Totals: 252 specs — 12 green (0 failed), 17 partial, 223 red.** Test-level: 417 passed / 437 failed / 0 skipped.

## Exclusions (from manifest.json — never transpiled)

Total excluded: **602** specs (vs 252 transpiled).

| Reason | Specs excluded |
|---|---:|
| esbuild transform failed | 421 |
| vi.waitFor (timer-based polling) | 79 |
| vi.mock/doMock/resetModules (loader-level module interception) | 45 |
| fake timers (the runtime has no timer seam) | 21 |
| vi.mock/doMock/resetModules (loader-level module interception) + vi.waitFor (timer-based polling) | 19 |
| fake timers (the runtime has no timer seam) + vi.waitFor (timer-based polling) | 9 |
| vi.mock/doMock/resetModules (loader-level module interception) + fake timers (the runtime has no timer seam) + vi.waitFor (timer-based polling) | 4 |
| vi.mock/doMock/resetModules (loader-level module interception) + fake timers (the runtime has no timer seam) | 3 |
| expect.extend (custom matchers) | 1 |

## Green — 12 specs (0 failed)

| Spec | Exit | Passed | Failed | Skipped | First failure (truncated) | Dur (s) |
|---|---:|---:|---:|---:|---|---:|
| core__scope__tests__scope | 0 | 11 | 0 | 0 |  | 0 |
| core__scope__tests__store | 0 | 10 | 0 | 0 |  | 0 |
| core__session__tests__seq-ranges | 0 | 9 | 0 | 0 |  | 3 |
| hooks__hook-protocol__tests__codec | 0 | 25 | 0 | 0 |  | 0 |
| hooks__hook-protocol__tests__matcher | 0 | 10 | 0 | 0 |  | 0 |
| hooks__hook-protocol__tests__merge | 0 | 12 | 0 | 0 |  | 0 |
| llm__llm__tests__api-key | 0 | 17 | 0 | 0 |  | 0 |
| llm__llm__tests__invariant | 0 | 15 | 0 | 0 |  | 1 |
| llm__llm__tests__retry-policy | 0 | 20 | 0 | 0 |  | 0 |
| runtime-diagnostics__invariants__tests__service | 0 | 28 | 0 | 0 |  | 0 |
| sandbox__sandbox__tests__escalation | 0 | 13 | 0 | 0 |  | 0 |
| sandbox__sandbox__tests__vocabulary | 0 | 3 | 0 | 0 |  | 1 |

## Partial — 17 specs (some passed, some failed)

| Spec | Exit | Passed | Failed | Skipped | First failure (truncated) | Dur (s) |
|---|---:|---:|---:|---:|---|---:|
| attachment__attachment__tests__admission | 1 | 9 | 1 | 0 | not a function @ admitEncodedImages > propagates the store batch rejection unchanged | 0 |
| core__agent-loop__tests__loop | 1 | 1 | 64 | 0 | AbortController is not defined @ agent loop > publishes one dense live attempt and commits one v2 message with the exact embedded stream | 5 |
| core__session__tests__fork | 1 | 1 | 13 | 0 | session header is not losslessly JSON-serializable @ SessionStore.fork > forks an empty live session as an empty child with lineage metadata | 1 |
| core__session__tests__request-header | 1 | 3 | 7 | 0 | structuredClone is not defined @ headerEquals > compares every canonical field and preserves tool order | 0 |
| core__session__tests__scoped | 1 | 1 | 11 | 0 | session header is not losslessly JSON-serializable @ session dispatch carriers > a session entered through a scoped context dispatches its events in that scope | 0 |
| core__session__tests__sequence-types | 1 | 6 | 10 | 0 | session header is not losslessly JSON-serializable @ Session log positions > keeps event identities separate from log offsets | 0 |
| core__session__tests__session | 1 | 4 | 73 | 0 | session header is not losslessly JSON-serializable @ Session > exposes one stable readonly surface view | 1 |
| core__system-prompt__tests__scoped | 1 | 10 | 3 | 0 | structuredClone is not defined @ scoped tool providers and toolOrder × restriction > scoped providers are consulted only for their scope | 1 |
| core__system-prompt__tests__system-prompt | 1 | 44 | 8 | 0 | structuredClone is not defined @ SystemPrompt > assembles sections in order with context-resolved text and collected tools | 2 |
| core__system-prompt__tests__tool-order | 1 | 7 | 8 | 0 | structuredClone is not defined @ SystemPrompt tool order > assembles tools in lexicographic name order when no toolOrder is configured | 0 |
| fs__fs__tests__service | 1 | 10 | 2 | 0 | TextEncoder is not defined @ FileSystem provider seam > readByteRange returns the window, shorter at the end and empty past it | 0 |
| hooks__hook-protocol__tests__events | 1 | 3 | 7 | 0 | session header is not losslessly JSON-serializable @ hook/* session events > appendHookInvoked records a log-only hook/invoked (with matcher when present) | 0 |
| hooks__hook-protocol__tests__runner | 1 | 1 | 11 | 0 | AbortController is not defined @ runHook — payload + env + stdin plumbing > serializes the payload to stdin (with trailing newline when requested) | 0 |
| llm__llm__tests__assembler | 1 | 21 | 1 | 0 | structuredClone is not defined @ BlockAssembler > assembles interleaved text, reasoning, and tool-call deltas | 0 |
| llm__llm__tests__assistant-stream | 1 | 31 | 6 | 0 | Assistant stream chunk must be losslessly JSON-serializable @ AssistantStreamAccumulator > keeps delta boundaries and timestamps while compacting one attempt | 0 |
| llm__llm__tests__service | 1 | 72 | 15 | 0 | structuredClone is not defined @ LlmRuntime > trusts the immutable message creation boundary for direct calls | 1 |
| llm__llm__tests__topology | 1 | 20 | 2 | 0 | process is not defined @ llm/adapters-updated > contains an ASYNC listener rejection instead of leaving it unhandled | 0 |

## Red — 223 specs

### module-resolution (package/module not vendored, not shimmed) — 171 specs

| Spec | Exit | Missing module specifier | Dur (s) |
|---|---:|---|---:|
| boot__plugin-manager__tests__install-spec | 1 | `@deepseek-ai/dsh-plugin-manager` | 0 |
| compaction__command-compact__tests__command-compact | 1 | `@deepseek-ai/dsh-commands` | 0 |
| compaction__command-compact__tests__loader-composition | 1 | `@deepseek-ai/dsh-commands` | 0 |
| compaction__compaction__tests__compaction | 1 | `@deepseek-ai/dsh-compaction` | 0 |
| compaction__compaction__tests__invariant | 1 | `@deepseek-ai/dsh-compaction` | 1 |
| compaction__compaction__tests__tool-pairing | 1 | `@deepseek-ai/dsh-compaction` | 0 |
| compaction__compaction-basic__tests__compaction-basic | 1 | `@deepseek-ai/dsh-compaction-basic` | 1 |
| compaction__compaction-basic__tests__compaction-loop-repro | 1 | `@deepseek-ai/dsh-compaction` | 0 |
| compaction__compaction-basic__tests__loader-composition | 1 | `@deepseek-ai/dsh-token-meter` | 0 |
| compaction__compaction-tool-result-pruner__tests__loader-composition | 1 | `@deepseek-ai/dsh-token-meter` | 0 |
| compaction__compaction-tool-result-pruner__tests__tool-result-pruner | 1 | `@deepseek-ai/dsh-compaction-image-offload/projection` | 0 |
| context__session-reference__tests__loader-composition | 1 | `diff` | 1 |
| context__time-context__tests__invariant | 1 | `@deepseek-ai/dsh-time-context/invariant` | 0 |
| core__agent__tests__agent | 1 | `@deepseek-ai/dsh-typert-registry` | 0 |
| core__agent__tests__invariant | 1 | `@deepseek-ai/dsh-agent/invariant` | 0 |
| core__agent-loop__tests__config-session-id | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 1 |
| core__agent-loop__tests__contract-regressions | 1 | `@deepseek-ai/dsh-session/invariant` | 0 |
| core__agent-loop__tests__invariant | 1 | `@deepseek-ai/dsh-agent-loop/invariant` | 0 |
| core__agent-loop__tests__properties | 1 | `fast-check` | 0 |
| core__agent-loop__tests__serial-listener-review | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 1 |
| core__agent-loop__tests__shutdown-drain | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| core__agent-loop__tests__system-prompt-admission | 1 | `@deepseek-ai/dsh-llm-pi-ai/src/context.ts` | 1 |
| core__agent-loop__tests__tool-calls | 1 | `@deepseek-ai/dsh-ptc-runtime` | 0 |
| core__agent-tool-presentation__tests__agent-tool-presentation | 1 | `@deepseek-ai/dsh-ptc-runtime` | 0 |
| core__scope__tests__invariant | 1 | `@deepseek-ai/dsh-scope/invariant` | 0 |
| core__session__tests__invariant | 1 | `@deepseek-ai/dsh-session/invariant` | 0 |
| core__session__tests__properties | 1 | `fast-check` | 0 |
| core__session__tests__surface | 1 | `@deepseek-ai/dsh-session/surface` | 0 |
| core__session__tests__typert | 1 | `@deepseek-ai/dsh-typert-registry` | 0 |
| core__system-prompt__tests__invariant | 1 | `@deepseek-ai/dsh-system-prompt/invariant` | 0 |
| core__tools__tests__invariant | 1 | `@deepseek-ai/dsh-tools/invariant` | 0 |
| core__tools__tests__properties | 1 | `fast-check` | 1 |
| core__tools__tests__ptc | 1 | `@deepseek-ai/dsh-ptc-runtime` | 0 |
| core__tools__tests__py-types | 1 | `@deepseek-ai/dsh-tools/src/py-types.ts` | 0 |
| core__tools__tests__tools | 1 | `@deepseek-ai/dsh-user-approval` | 0 |
| core__tools__tests__ts-types | 1 | `@deepseek-ai/dsh-tools/src/ts-types.ts` | 0 |
| credentials__authorization__tests__authorization | 1 | `@deepseek-ai/dsh-credentials` | 0 |
| deliverables__workspace-changes__tests__loader-composition | 1 | `@deepseek-ai/dsh-subprocess-local` | 0 |
| experimental__auto-review__tests__auto-review | 1 | `@deepseek-ai/dsh-compaction` | 0 |
| experimental__webworker-runtime__tests__node__fs | 1 | `@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts` | 0 |
| experimental__webworker-runtime__tests__node__path-diff | 1 | `@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/path.ts` | 0 |
| experimental__webworker-runtime__tests__node__shim-diff | 1 | `@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/crypto.ts` | 0 |
| experimental__webworker-runtime__tests__polyfill__als-shim | 1 | `@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts` | 0 |
| experimental__webworker-runtime__tests__shell__injected-run | 1 | `@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/interpret.ts` | 0 |
| experimental__webworker-runtime__tests__shell__shell | 1 | `@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts` | 0 |
| experimental__webworker-runtime__tests__transport__tunnel-client | 1 | `@deepseek-ai/dsh-experimental-webworker-runtime/src/client/client.ts` | 0 |
| experimental__webworker-runtime__tests__vfs-example-fixture | 1 | `@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts` | 1 |
| feedback__command-feedback__tests__loader-composition | 1 | `@deepseek-ai/dsh-commands` | 0 |
| fs__fs__tests__invariant | 1 | `@deepseek-ai/dsh-fs/invariant` | 0 |
| fs__fs-observation-policy__tests__policy | 1 | `@deepseek-ai/dsh-fs-observation-policy` | 0 |
| fs__tool-fs__tests__integration | 1 | `@deepseek-ai/dsh-fs-observation-policy` | 0 |
| fs__tool-str-replace-editor__tests__tools | 1 | `@deepseek-ai/dsh-fs-observation-policy` | 1 |
| goal__command-goal__tests__command-goal | 1 | `@deepseek-ai/dsh-commands` | 0 |
| goal__goal__tests__invariant | 1 | `@deepseek-ai/dsh-goal` | 0 |
| goal__goal-round-driver__tests__invariant | 1 | `@deepseek-ai/dsh-goal` | 0 |
| goal__tool-goal__tests__tool-goal | 1 | `@deepseek-ai/dsh-goal` | 0 |
| guard__repeat-tool-reminder__tests__repeat-tool-reminder | 1 | `@deepseek-ai/dsh-agent-loop-testkit` | 0 |
| hooks__hook-protocol__tests__invariant | 1 | `@deepseek-ai/dsh-hook-protocol/invariant` | 0 |
| hooks__hooks-claude-code__tests__bridge | 1 | `@deepseek-ai/dsh-agent-loop-testkit` | 1 |
| hooks__hooks-claude-code__tests__config | 1 | `@deepseek-ai/dsh-hooks-claude-code/src/config.ts` | 0 |
| hooks__hooks-claude-code__tests__coverage-config | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| hooks__hooks-claude-code__tests__coverage-context | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| hooks__hooks-claude-code__tests__coverage-edge-paths | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| hooks__hooks-claude-code__tests__coverage-stop | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| hooks__hooks-codex__tests__bridge | 1 | `@deepseek-ai/dsh-agent-loop-testkit` | 1 |
| hooks__hooks-codex__tests__config | 1 | `@deepseek-ai/dsh-hooks-codex/src/config.ts` | 0 |
| hooks__hooks-codex__tests__coverage-post-tool | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| hooks__hooks-codex__tests__coverage-prompt | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| hooks__hooks-codex__tests__coverage-result-shape | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| interaction__commands__tests__invariant | 1 | `@deepseek-ai/dsh-commands/invariant` | 0 |
| interaction__permission-presets__tests__invariant | 1 | `@deepseek-ai/dsh-permission-presets/invariant` | 0 |
| interaction__permission-presets__tests__permission-presets | 1 | `@deepseek-ai/dsh-permission-presets` | 1 |
| interaction__tool-ask-user__tests__tool-ask-user | 1 | `@deepseek-ai/dsh-user-questions` | 0 |
| interaction__user-approval__tests__approval | 1 | `@deepseek-ai/dsh-user-approval` | 0 |
| interaction__user-approval__tests__invariant | 1 | `@deepseek-ai/dsh-user-approval` | 0 |
| interaction__user-questions__tests__user-questions | 1 | `@deepseek-ai/dsh-user-questions` | 1 |
| jobs__jobs__tests__invariant | 1 | `@deepseek-ai/dsh-jobs` | 0 |
| jobs__jobs__tests__service | 1 | `@deepseek-ai/dsh-jobs` | 0 |
| jobs__jobs-local__tests__jobs | 1 | `@deepseek-ai/dsh-jobs` | 0 |
| jobs__jobs-local__tests__loader-composition | 1 | `@deepseek-ai/dsh-jobs-local` | 0 |
| jobs__tool-jobs__tests__tool-jobs | 1 | `@deepseek-ai/dsh-jobs` | 0 |
| llm__llm__tests__properties | 1 | `fast-check` | 0 |
| llm__llm-deepseek__tests__dynamic-config | 1 | `@deepseek-ai/dsh-credentials` | 0 |
| llm__llm-pi-ai__tests__dynamic-config | 1 | `@deepseek-ai/dsh-credentials` | 1 |
| llm__llm-retry__tests__persistence | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| llm__token-meter__tests__token-meter | 1 | `@deepseek-ai/dsh-token-meter` | 0 |
| llm__token-meter__tests__token-usage-projection | 1 | `@deepseek-ai/dsh-token-meter` | 0 |
| lsp__lsp__tests__lsp | 1 | `@deepseek-ai/dsh-lsp` | 0 |
| lsp__lsp-stdio__tests__connection | 1 | `@deepseek-ai/dsh-lsp-stdio` | 0 |
| lsp__lsp-stdio__tests__framing | 1 | `@deepseek-ai/dsh-lsp-stdio` | 0 |
| lsp__lsp-stdio__tests__instance | 1 | `@deepseek-ai/dsh-lsp-stdio` | 1 |
| lsp__lsp-stdio__tests__provider | 1 | `@deepseek-ai/dsh-subprocess-local` | 0 |
| lsp__lsp-stdio__tests__translate | 1 | `@deepseek-ai/dsh-lsp-stdio` | 0 |
| lsp__tool-lsp__tests__integration | 1 | `@deepseek-ai/dsh-subprocess-local` | 0 |
| lsp__tool-lsp__tests__load-path | 1 | `@deepseek-ai/dsh-tool-lsp` | 0 |
| lsp__tool-lsp__tests__render | 1 | `@deepseek-ai/dsh-tool-lsp` | 0 |
| lsp__tool-lsp__tests__tool-lsp | 1 | `@deepseek-ai/dsh-lsp` | 0 |
| mcp__mcp-client__tests__load-path | 1 | `@deepseek-ai/dsh-mcp-client` | 0 |
| mcp__mcp-client__tests__mcp-client | 1 | `@modelcontextprotocol/client` | 0 |
| plan__plan-mode__tests__integration | 1 | `@deepseek-ai/dsh-plan-mode` | 1 |
| plan__plan-mode__tests__invariant | 1 | `@deepseek-ai/dsh-plan-mode/invariant` | 0 |
| plan__plan-mode__tests__projection | 1 | `@deepseek-ai/dsh-user-questions` | 0 |
| preset__agent-presets__tests__invariant | 1 | `@deepseek-ai/dsh-agent-presets/invariant` | 0 |
| preset__agent-presets__tests__mount | 1 | `@deepseek-ai/cordis-plugin-group` | 0 |
| preset__agent-presets__tests__settings | 1 | `@deepseek-ai/dsh-settings-file` | 0 |
| preset__persona__tests__persona | 1 | `@deepseek-ai/dsh-persona` | 0 |
| ptc-runtime__ptc-runtime__tests__reserved | 1 | `@deepseek-ai/dsh-ptc-runtime` | 0 |
| ptc-runtime__ptc-runtime__tests__service | 1 | `@deepseek-ai/dsh-ptc-runtime` | 0 |
| sandbox__sandbox-policy__tests__invariant | 1 | `@deepseek-ai/dsh-sandbox-policy/invariant` | 0 |
| sandbox__sandbox-policy__tests__policy | 1 | `@deepseek-ai/dsh-sandbox-policy` | 0 |
| session__session-format-v1-to-v2__tests__codec | 1 | `@deepseek-ai/dsh-session-format` | 1 |
| session__session-stats__tests__loader-composition | 1 | `@deepseek-ai/dsh-session-stats` | 0 |
| session__session-stats__tests__projection | 1 | `@deepseek-ai/dsh-session-stats` | 0 |
| session__session-title__tests__invariant | 1 | `@deepseek-ai/dsh-session-title/invariant` | 0 |
| session__session-title__tests__persistence | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| session__session-title__tests__projection | 1 | `@deepseek-ai/dsh-session-title` | 0 |
| session__session-title__tests__provider | 1 | `@deepseek-ai/dsh-session-title` | 1 |
| session__session-title__tests__rename | 1 | `@deepseek-ai/dsh-session-title` | 0 |
| session__session-title__tests__service-contracts | 1 | `@deepseek-ai/dsh-session-title` | 0 |
| session__session-title__tests__session-title | 1 | `@deepseek-ai/dsh-session-title` | 0 |
| session__session-title-all-prompts-llm__tests__provider | 1 | `@deepseek-ai/dsh-session-title` | 0 |
| session__session-title-first-prompt-llm__tests__loader-composition | 1 | `@deepseek-ai/dsh-session-title` | 1 |
| session__session-title-first-prompt-llm__tests__provider | 1 | `@deepseek-ai/dsh-session-title` | 0 |
| session__session-turn-outline__tests__loader-composition | 1 | `@deepseek-ai/dsh-session-turn-outline` | 0 |
| session__session-turn-outline__tests__projection | 1 | `@deepseek-ai/dsh-session-turn-outline` | 0 |
| session-query__session-log-export__tests__loader-composition.host | 1 | `@deepseek-ai/dsh-commands` | 0 |
| session-query__session-query__tests__search-helpers | 1 | `@deepseek-ai/dsh-session-query` | 0 |
| session-query__session-query__tests__tracing | 1 | `@deepseek-ai/dsh-session-query` | 0 |
| session-query__tool-session-query__tests__sqlite-integration | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| shell__bash-local__tests__executor | 1 | `@deepseek-ai/dsh-bash-local` | 1 |
| shell__bash-local__tests__settings | 1 | `@deepseek-ai/dsh-subprocess-local` | 0 |
| shell__bash-sandbox__tests__partial-landlock | 1 | `@deepseek-ai/node-addon-system/landlock-run` | 0 |
| shell__pwsh-local__tests__settings | 1 | `@deepseek-ai/dsh-shell` | 0 |
| shell__shell__tests__service | 1 | `@deepseek-ai/dsh-shell` | 0 |
| shell__shell-env__tests__shell-env | 1 | `@deepseek-ai/dsh-shell-env` | 0 |
| shell__tool-bash__tests__integration | 1 | `@deepseek-ai/dsh-session-persistence-jsonl` | 0 |
| shell__tool-bash-persistent__tests__loader-composition | 1 | `@deepseek-ai/dsh-terminal` | 0 |
| shell__tool-bash-persistent__tests__tools | 1 | `@deepseek-ai/dsh-terminal` | 0 |
| shell__tool-pwsh-persistent__tests__tools | 1 | `@deepseek-ai/dsh-terminal` | 1 |
| skill__skill__tests__skill | 1 | `@deepseek-ai/dsh-skill` | 0 |
| skill__skill-badge__tests__skill-badge | 1 | `@deepseek-ai/dsh-skill` | 0 |
| skill__skill-office__tests__skill-office | 1 | `@deepseek-ai/dsh-skill` | 0 |
| skill__tool-skill__tests__tool-skill | 1 | `@deepseek-ai/dsh-skill` | 0 |
| spill__spill__tests__service | 1 | `@deepseek-ai/dsh-spill` | 1 |
| spill__spill-local__tests__loader-composition | 1 | `@deepseek-ai/dsh-spill-local` | 0 |
| subagent__subagent__tests__control | 1 | `@deepseek-ai/dsh-subagent` | 0 |
| subagent__subagent__tests__invariant | 1 | `@deepseek-ai/dsh-subagent` | 0 |
| subagent__subagent__tests__service | 1 | `@deepseek-ai/dsh-subagent` | 0 |
| subagent__tool-subagent__tests__scripted-provider | 1 | `@deepseek-ai/dsh-subagent` | 0 |
| subprocess__subprocess-local__tests__process-inspector | 1 | `@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts` | 0 |
| terminal__terminal-bash__tests__config | 1 | `@deepseek-ai/dsh-terminal-bash/src/config.ts` | 0 |
| terminal__terminal-bash__tests__sanitize | 1 | `@deepseek-ai/dsh-terminal-bash/src/sanitize.ts` | 0 |
| terminal__tool-terminal__tests__loader-composition | 1 | `@deepseek-ai/dsh-terminal` | 0 |
| terminal__tool-terminal__tests__render | 1 | `@deepseek-ai/dsh-terminal` | 1 |
| terminal__tool-terminal__tests__tools | 1 | `@deepseek-ai/dsh-terminal` | 0 |
| test-support__loader-smoke__tests__example-launch | 1 | `@deepseek-ai/dsh-loader-smoke` | 0 |
| test-support__loader-smoke__tests__loader-smoke | 1 | `@deepseek-ai/dsh-loader-smoke` | 0 |
| test-support__remote-mock__tests__proxy-types.client | 1 | `typescript` | 0 |
| todo__tool-todo__tests__integration | 1 | `@deepseek-ai/dsh-agent-loop-testkit` | 0 |
| todo__tool-todo__tests__invariant | 1 | `@deepseek-ai/dsh-tool-todo/invariant` | 0 |
| todo__tool-todo__tests__loader-composition | 1 | `@deepseek-ai/dsh-agent-loop-testkit` | 1 |
| todo__tool-todo__tests__projection | 1 | `@deepseek-ai/dsh-user-questions` | 0 |
| util__deque__tests__deque | 1 | `@deepseek-ai/dsh-deque` | 0 |
| util__native-command__tests__native-command | 1 | `@deepseek-ai/dsh-native-command` | 0 |
| util__output-retention__tests__output-retention | 1 | `@deepseek-ai/dsh-output-retention` | 0 |
| util__time__tests__time | 1 | `@deepseek-ai/dsh-util-time` | 0 |
| util__workspace-path__tests__index | 1 | `@deepseek-ai/dsh-util-workspace-path` | 0 |
| web__tool-web__tests__load-path | 1 | `@deepseek-ai/dsh-web` | 0 |
| web__web__tests__web | 1 | `@deepseek-ai/dsh-web` | 0 |
| web__web-search-deepseek__tests__settings | 1 | `@deepseek-ai/dsh-web` | 0 |
| workflow__workflow__tests__invariant | 1 | `@deepseek-ai/dsh-workflow` | 0 |

### all-tests-failed — 19 specs

| Spec | Exit | Failure class | Detail (truncated) | Dur (s) |
|---|---:|---|---|---:|
| bundle__acp-app__tests__acp-app | 1 | all-tests-failed |  | 0 |
| bundle__base__tests__base | 1 | all-tests-failed |  | 0 |
| bundle__sdk-app__tests__sdk-app | 1 | all-tests-failed |  | 0 |
| bundle__sdk-minimal__tests__sdk-minimal | 1 | all-tests-failed |  | 0 |
| core__agent__tests__consumed-work | 1 | all-tests-failed |  | 0 |
| core__agent-loop__tests__agent | 1 | all-tests-failed |  | 1 |
| core__agent-loop__tests__cancel | 1 | all-tests-failed |  | 2 |
| core__agent-loop__tests__coverage-edges | 1 | all-tests-failed |  | 1 |
| core__agent-loop__tests__interception | 1 | all-tests-failed |  | 0 |
| core__agent-loop__tests__request-error | 1 | all-tests-failed |  | 0 |
| core__agent-loop__tests__request-reconstruction | 1 | all-tests-failed |  | 1 |
| core__agent-loop__tests__settings | 1 | all-tests-failed |  | 0 |
| core__agent-loop__tests__tool-order | 1 | all-tests-failed |  | 1 |
| core__session__tests__derived-cache | 1 | all-tests-failed |  | 0 |
| experimental__agent-team-profile__tests__profile | 1 | all-tests-failed |  | 1 |
| experimental__agent-team-web-profile__tests__profile | 1 | all-tests-failed |  | 0 |
| hooks__hook-protocol__tests__detached | 1 | all-tests-failed |  | 0 |
| llm__llm__tests__message | 1 | all-tests-failed |  | 0 |
| session__session-projection__tests__registry | 1 | all-tests-failed |  | 0 |

### missing-node-builtin (no spike shim for node builtin) — 16 specs

| Spec | Exit | Failure class | Detail (truncated) | Dur (s) |
|---|---:|---|---|---:|
| core__agent__tests__agent-initiator | 1 | missing-node-builtin: node:vm | no spike shim for node builtin 'node:vm' (see runtime/spike/upstream/README.md) | | 0 |
| core__session__tests__json | 1 | missing-node-builtin: node:vm | no spike shim for node builtin 'node:vm' (see runtime/spike/upstream/README.md) | | 0 |
| experimental__webworker-runtime__tests__compile__transform-corpus | 1 | missing-node-builtin: node:child_process | no spike shim for node builtin 'node:child_process' (see runtime/spike/upstream/README.md) | | 0 |
| lsp__lsp-stdio__tests__host | 1 | missing-node-builtin: node:child_process | no spike shim for node builtin 'node:child_process' (see runtime/spike/upstream/README.md) | | 0 |
| mcp__mcp-client__tests__egress | 1 | missing-node-builtin: node:http | no spike shim for node builtin 'node:http' (see runtime/spike/upstream/README.md) | | 0 |
| session-query__session-query-sqlite__tests__sqlite | 1 | missing-node-builtin: node:sqlite | no spike shim for node builtin 'node:sqlite' (see runtime/spike/upstream/README.md) | | 0 |
| shell__pwsh-local__tests__executor | 1 | missing-node-builtin: node:child_process | no spike shim for node builtin 'node:child_process' (see runtime/spike/upstream/README.md) | | 0 |
| shell__tool-pwsh__tests__integration | 1 | missing-node-builtin: node:child_process | no spike shim for node builtin 'node:child_process' (see runtime/spike/upstream/README.md) | | 0 |
| shell__tool-pwsh__tests__loader | 1 | missing-node-builtin: node:child_process | no spike shim for node builtin 'node:child_process' (see runtime/spike/upstream/README.md) | | 0 |
| shell__tool-pwsh-persistent__tests__loader-composition | 1 | missing-node-builtin: node:child_process | no spike shim for node builtin 'node:child_process' (see runtime/spike/upstream/README.md) | | 0 |
| skill__skill-office__tests__checkers | 1 | missing-node-builtin: node:child_process | no spike shim for node builtin 'node:child_process' (see runtime/spike/upstream/README.md) | | 0 |
| ssh__ssh__tests__inspector-signal | 1 | missing-node-builtin: node:child_process | no spike shim for node builtin 'node:child_process' (see runtime/spike/upstream/README.md) | | 0 |
| subagent__subagent-codex__tests__real-product-cleanup | 1 | missing-node-builtin: node:http | no spike shim for node builtin 'node:http' (see runtime/spike/upstream/README.md) | | 0 |
| subprocess__subprocess__tests__service | 1 | missing-node-builtin: node:stream | no spike shim for node builtin 'node:stream' (see runtime/spike/upstream/README.md) | | 0 |
| terminal__terminal-bash__tests__local | 1 | missing-node-builtin: node:child_process | no spike shim for node builtin 'node:child_process' (see runtime/spike/upstream/README.md) | | 0 |
| web__web-search-deepseek__tests__redirect | 1 | missing-node-builtin: node:http | no spike shim for node builtin 'node:http' (see runtime/spike/upstream/README.md) | | 0 |

### missing-export (vendored module/shim lacks an export) — 8 specs

| Spec | Exit | Failure class | Detail (truncated) | Dur (s) |
|---|---:|---|---|---:|
| core__agent-loop__tests__scope-lifecycle | 1 | missing-export: onTestFinished from scenario/upstream-test-harness.js | Could not find export 'onTestFinished' in module 'scenario/upstream-test-harness.js' | | 0 |
| extensions__tool-cordis__tests__cordis-lifecycle | 1 | missing-export: FiberState from @deepseek-ai/cordis | Could not find export 'FiberState' in module '@deepseek-ai/cordis' | | 0 |
| preset__agent-presets__tests__authoring | 1 | missing-export: mkdtemp from node:fs/promises | Could not find export 'mkdtemp' in module 'node:fs/promises' | | 0 |
| preset__agent-presets__tests__remote | 1 | missing-export: mkdtemp from node:fs/promises | Could not find export 'mkdtemp' in module 'node:fs/promises' | | 1 |
| preset__agent-presets__tests__shipped-root | 1 | missing-export: mkdtemp from node:fs/promises | Could not find export 'mkdtemp' in module 'node:fs/promises' | | 0 |
| preset__agent-presets__tests__user-root | 1 | missing-export: mkdtemp from node:fs/promises | Could not find export 'mkdtemp' in module 'node:fs/promises' | | 0 |
| sandbox__sandbox__tests__roots | 1 | missing-export: mkdtempSync from node:fs | Could not find export 'mkdtempSync' in module 'node:fs' | | 0 |
| util__home-paths__tests__home-paths | 1 | missing-export: mkdtemp from node:fs/promises | Could not find export 'mkdtemp' in module 'node:fs/promises' | | 0 |

### missing-global (JS global absent from the runtime) — 5 specs

| Spec | Exit | Failure class | Detail (truncated) | Dur (s) |
|---|---:|---|---|---:|
| core__agent-loop__tests__agent-initiator | 1 | missing-global: AbortController | AbortController is not defined | | 0 |
| core__session__tests__canonical-envelopes | 1 | missing-global: structuredClone | structuredClone is not defined | at createMessage (@deepseek-ai/dsh-llm:40:19) / at createUserMessage (@deepseek-ai/dsh-llm:50:6) / at createToolResultMessage ( | 0 |
| core__tools__tests__execution-mode | 1 | missing-global: AbortController | AbortController is not defined | | 1 |
| core__tools__tests__scoped | 1 | missing-global: AbortController | AbortController is not defined | | 0 |
| experimental__inspector__tests__layout.host | 1 | missing-global: URL | URL is not defined | | 0 |

### transpile-artifact: invalid property name — 2 specs

| Spec | Exit | Failure class | Detail (truncated) | Dur (s) |
|---|---:|---|---|---:|
| api__gateway__tests__gateway.host | 1 | transpile-artifact: invalid property name | invalid property name | | 0 |
| typert__protocol__tests__protocol | 1 | transpile-artifact: invalid property name | invalid property name | | 0 |

### scenario-failure: error — 2 specs

| Spec | Exit | Failure class | Detail (truncated) | Dur (s) |
|---|---:|---|---|---:|
| core__tools__tests__execution-signal-types | 1 | scenario-failure: error | unsupported JSON schema: parameters must be an object of value schemas | at JsonSchemaError (@deepseek-ai/dsh-tools:29:48) / at authorError (@deepseek-ai/dsh-to | 0 |
| llm__llm__tests__attribution | 1 | scenario-failure: error | require('../package.json') from upstream-tests/llm__llm__tests__attribution.spec.mjs: cannot read 'package.json' | at <anonymous> (node:module:26:56) / at <anon | 0 |
