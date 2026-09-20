# runtime/spike/upstream/ — the system layer for the upstream port (D9)

The upstream DSH runtime packages (`runtime/spike/vendor/dsh/*@0.1.6-alpha.2`)
run VERBATIM — never edited, sha256-pinned by `vendor/ensure-dsh.sh`. This
directory is OUR side of the port: the shims, the boot, and the scripted
seams that stand in for the platform services Node.js provides on the
desktop. It mirrors dsh-desktop's role (a thin host that provides the system
layer the official Harness boots onto); on mobile the same role is played by
the spike runtime + this layer.

- `web-shims.js` — Web-API globals the vendored closure expects
  (`structuredClone`, `AbortController`/`AbortSignal`, `console` backstop,
  `queueMicrotask` context wrapper, native `Function.prototype.toString`
  formatting). MUST stay the first import of `boot.js`.
- `web-boot.js` — the WEB BOOT PRODUCER: mounts the vendored
  `ClientModuleRegistry` on a ctx over the staged web-plugin VFS and hands
  the composed wire plus the claimed `/api` + mux journal surface to the
  carrier over the bus seam. `web.plugins` deliveries come in TWO shapes:
  the iOS drive's single-shot message (stage + compose in one step) and
  the harmony drive's CHUNKED delivery (`chunked: true`, `final: true` on
  the last chunk — each chunk merges into the VFS and only the final one
  composes, so the carrier's main thread yields between packages and
  stays under the platform watchdog).
- `shims/*.js` — the `node:` builtin modules the closure imports, mapped by
  the host loader (`dsh_spike_host.c`, `dsh_map_bare`).
- `boot.js` — the mobile profile boot: the same entry shape as desktop's
  `apps/cli` profile boot (empty root + patch-layer composition → cordis
  host → settle), with the dsh-base bundle's spine rows mounted over the
  vendor closure and `llm` = the VENDORED dsh-llm `LlmRuntime` (adapter
  registry) with the gateway transport adapter registered.
- `llm-transport.js` — the GATEWAY TRANSPORT SEAM (the W-LLM leg): an
  upstream-SHAPE OpenAI-compatible chat-completions `LlmAdapter` whose
  entire transport is gateway `httpFetch` — wire request built from the
  harness request (attribution headers from the vendored package), SSE
  parsed from the http.body AsyncIterable (reads may split anywhere, incl.
  mid-UTF-8), abort mapped to ABORTED, non-2xx diagnosed into
  `LlmError`/provider-neutral codes — modeled on dsh-llm-deepseek's wire
  layer with the fetch seam swapped. Zero vendored edits.
- `settings-memory.js` — in-memory `SettingsProvider` backend (the desktop
  profile mounts `dsh-settings-file`; a phone profile has no settings file
  in PR-A).

## Shim coverage (upstream import → system layer)

Every row was verified against the vendored `lib/*.js` import statements
(closure: cordis, cosmokit, schemastery, zod + dsh-session, dsh-agent,
dsh-tools, dsh-system-prompt, dsh-settings, dsh-session-projection,
dsh-sandbox, dsh-scope, dsh-brand, dsh-util-values, dsh-util-crypto,
dsh-timeout, dsh-typert-protocol, dsh-agent-loop, dsh-llm — the W-LLM leg
added the llm closure + its mock-server test vehicle). The loader FAILS
LOUD naming any specifier not in this
table (rule 5) — a new upstream import can never be silently mis-served.

| upstream import | system layer | status |
| --- | --- | --- |
| `node:path` (`isAbsolute`; boot: `join`/`resolve`/`dirname`/`basename`) | `shims/path.js` (POSIX) | supported |
| `node:crypto` (`randomUUID`) | `shims/crypto.js` over the host `crypto.getRandomValues` seam | supported |
| `node:async_hooks` (`AsyncLocalStorage`) | `shims/async-hooks.js` — frame stack + `Promise.prototype.then/catch/finally` capture (single-threaded serial runtime; context = what was current when the continuation attached) | supported (no timer contexts — timers unsupported) |
| `node:util/types` (`isPromise`) | `shims/util-types.js` | supported |
| `node:util` (`format`/`inspect`/`promisify`) | `shims/util.js` — JSON-form rendering, not node's depth/color machinery | partial |
| `node:fs` (`accessSync`, `realpathSync`, `statSync`, `constants`) | `shims/fs.js` — LOUD stubs; the sandbox's disk gate is the desktop capability; mobile boundary = gateway fs scope (PR-B wiring). W-INTEG exception: the STAGED WEB-PLUGIN VFS (`seedWebPlugins` replace / `mergeWebPlugins` chunked-add) | supported for the staged view only (else loud) |
| `node:os` (`tmpdir`) | `shims/os.js` — profile container pinned by `boot.js` | supported (after container pin) |
| `node:process` (global `process`) | `shims/process.js` — env = launch snapshot, cwd = container, `nextTick` = microtask | supported (subset) |
| `node:module` (`createRequire`) | `shims/node-module.js` over the host `__dshBundleRequire` seam — resolves `base` through the loader's own bare map, serves relative `.json` reads under the bundle root only | supported (subset) |
| `structuredClone` | `web-shims.js` — JSON-safe superset (Date/RegExp/Map/Set, cycles); else loud | supported |
| `AbortController`/`AbortSignal` (`addEventListener`, `throwIfAborted`, `AbortSignal.any`) | `web-shims.js` | supported |
| `AbortSignal.timeout` | `web-shims.js` — throws (no wall-clock timers in the spike runtime) | unsupported (loud) |
| `setTimeout`/`setInterval` | NOT PROVIDED — absent on purpose; an accidental call is a loud ReferenceError. Only `cordis-host-runner` (the Node host runner, replaced by `boot.js`) uses them; vendored `dsh-timeout` is pure arithmetic (constants + signal classification), no timers | unsupported (loud) |
| `Buffer`, `fetch`, `TextEncoder`/`TextDecoder`, `atob` | NOT PROVIDED — closure-verified: only `cordis-host-runner` (not mounted) and unreached zod paths use them; the host binds `atob`/`btoa` natively | not needed in PR-A |
| `@deepseek-ai/dsh-llm` (+ `/invariant`, `/message`, `/assistant-stream`, `/types`, `/typert`, `/remote` runtime subpaths) | `vendor/dsh/llm@0.1.6-alpha.2/lib/…` — the VERBATIM vendored package (W-LLM leg; the staged `shims/dsh-llm*.js` value-helper port retired by this row). `node:module` (`createRequire`, dsh-llm's `../package.json` attribution read) → `shims/node-module.js` over the host `__dshBundleRequire` seam — package-style RELATIVE `.json` reads only, everything else loud | supported (W-LLM) |
| `@deepseek-ai/dsh-session-persistence` (`SessionPersistenceNotFoundError` + sibling error classes) | `shims/dsh-session-persistence.js` — errors-only linkage shim; resume stays unavailable (loud "persistence is not configured" upstream path) | staged (PR-B: real backend over the gateway fs) |
| `@deepseek-ai/dsh-*` bare + `/invariant` subpaths | host loader → `vendor/dsh/<pkg>@0.1.6-alpha.2/lib/…` (verbatim tarballs) | supported |
| `@deepseek-ai/cordis`, `@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`, `zod` (+ zod relative subpaths) | host loader → `vendor/npm/…` (pinned) | supported |
| anything else bare | host loader fails loud naming the specifier | fail loud |

## Desktop → mobile system-capability mapping

How dsh-desktop's host capabilities map onto the mobile system layer, with
the honest gaps declared:

| desktop (Node.js host) | mobile (this port) | state |
| --- | --- | --- |
| `node:fs` at absolute paths (`$DSH_HOME`, workspace) | gateway `fsRead`/`fsWrite`/`fsScope` — scope-relative POSIX under the granted scope; the scope root IS the profile container (`fsScope.resolve` returns its absolute path, which pins session `cwd`) | live for install/session state; the dsh-sandbox disk gate (`node:fs` stubs) wires in PR-B |
| `child_process` (dsh-subprocess-local) | `subprocess` Service — in-process coroutine executor (`system-plugins/dsh-subprocess-quickjs`); no OS processes on the runtime thread (D2) | service shipped in the spike; upstream `dsh-shell`/`dsh-tool-bash` rows are PR-B |
| `node:fetch` / undici (llm adapters, web tools) | gateway `httpFetch` — streaming AsyncIterable body, abortable, base64 byte bridge | live: `upstream/llm-transport.js` streams the vendored dsh-llm service over it (E2E against the vendored dsh-llm-mock-server, node-side loopback) |
| `$DSH_HOME` (`~/.dsh`) | the host-granted profile container (one directory per install), pinned by `boot.js` for `process.cwd()`/`os.tmpdir()`/`os.homedir()` | live |
| Electron window / WebContents | carrier loopback HTTP+WS + WebView mounting the Web Client (m1 carrier loopback; m5 host binding) | carrier proven separately; the upstream port runs headless |
| cordis-host-runner + disk Loader (`cordis.yml` include tree) | `boot.js` composes the same layer order in memory over the pinned vendor closure (the gateway fs scopes are not the module filesystem; the host loader maps specifiers) | live; the disk Loader + `cordis.patch.yml` parsing is a deliberate staged gap |
| timers (`setTimeout` etc.) | absent — the runtime has no timer seam; upstream packages that need wall-clock timeouts (dsh-timeout rows) are not mounted | staged: a timer seam is a host primitive decision, not a shim |
| dsh-settings-file (`$DSH_HOME/settings.yaml` + watcher) | `SettingsMemory` (empty document, same base contract) | staged: persists over the fs scope when the profile container gains durable KV |
| dsh-session-persistence-jsonl (koffi/sqlite native) | not mounted — sessions live in the memory store; resume unavailable (loud) | staged: jsonl backend over the fs scope (no native deps) |

## Deliberate staged gaps (declared, not hidden)

1. Provider adapters (dsh-llm-deepseek / dsh-llm-pi-ai) stay unvendored:
   they are the desktop's direct-fetch transports. The mobile equivalent is
   `upstream/llm-transport.js` (gateway `httpFetch`), which is the seam a
   real provider route plugs its credentials/endpoint into. Real-provider
   E2E (live endpoint policy, retries, usage metering) is later work.
2. Tool-execution depth: the mock turn completes without tool calls;
   PR-B drives a real tool through the subprocess Service + gateway fs.
3. Persistence/resume, webserver carrier rows (`ctx.webServer`,
   frontend-static), shell/bash tools, settings file — PR-B+.
4. Wall-clock timers: nothing in the mounted closure uses them; when a
   slice needs them, the host gains a timer primitive (contract proposal
   first — never a global hack).
