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
- `llm-transport.js` — the GATEWAY TRANSPORT SEAM (the LLM transport leg): an
  upstream-SHAPE OpenAI-compatible chat-completions `LlmAdapter` whose
  entire transport is gateway `httpFetch` — wire request built from the
  harness request (attribution headers from the vendored package), SSE
  parsed from the http.body AsyncIterable (reads may split anywhere, incl.
  mid-UTF-8), abort mapped to ABORTED, non-2xx diagnosed into
  `LlmError`/provider-neutral codes — modeled on dsh-llm-deepseek's wire
  layer with the fetch seam swapped. Zero vendored edits.
- `settings-memory.js` — in-memory `SettingsProvider` backend (the desktop
  profile mounts `dsh-settings-file`; a phone profile has no settings file
  in the first porting phase).

## Shim coverage (upstream import → system layer)

Every row was verified against the vendored `lib/*.js` import statements
(closure: cordis, cosmokit, schemastery, zod + dsh-session, dsh-agent,
dsh-tools, dsh-system-prompt, dsh-settings, dsh-session-projection,
dsh-sandbox, dsh-scope, dsh-brand, dsh-util-values, dsh-util-crypto,
dsh-timeout, dsh-typert-protocol, dsh-agent-loop, dsh-llm — the LLM transport leg
added the llm closure + its mock-server test vehicle; the file-tools row
added the fs-local + tool-fs + tool-str-replace-editor + attachment closure
and npm diff). The loader FAILS
LOUD naming any specifier not in this
table (rule 5) — a new upstream import can never be silently mis-served.

| upstream import | system layer | status |
| --- | --- | --- |
| `node:path` (`isAbsolute`; boot: `join`/`resolve`/`dirname`/`basename`) | `shims/path.js` (POSIX) | supported |
| `node:crypto` (`randomUUID`) | `shims/crypto.js` over the host `crypto.getRandomValues` seam | supported |
| `node:async_hooks` (`AsyncLocalStorage`) | `shims/async-hooks.js` — frame stack + `Promise.prototype.then/catch/finally` capture (single-threaded serial runtime; context = what was current when the continuation attached) | supported (no timer contexts — timers unsupported) |
| `node:util/types` (`isPromise`) | `shims/util-types.js` | supported |
| `node:util` (`format`/`inspect`/`promisify`) | `shims/util.js` — JSON-form rendering, not node's depth/color machinery | partial |
| `node:fs` (`accessSync`, `realpathSync`, `statSync`, `constants`) | `shims/fs.js` — LOUD stubs; the sandbox's disk gate is the desktop capability; mobile boundary = gateway fs scope (follow-up wiring). Web-integration-leg exception: the STAGED WEB-PLUGIN VFS (`seedWebPlugins` replace / `mergeWebPlugins` chunked-add). File-tools-row exception: the WRITABLE WORKSPACE VFS (`mountWorkspace` — one pinned in-memory root with explicit dirs, per-file ino/mode/mtime/ctime version stamps, `createReadStream` as the async-iterable byte window, callback `realpath`/`.native`); writes serve the workspace only and the seeded views stay read-only | supported for the staged views only (else loud) |
| `node:fs/promises` (`readFile`, `readdir`, `stat`, `opendir`, `realpath`, `access`) | `shims/fs-promises.js` — the async face of both staged views; the presets walk consumes the read side | supported |
| `node:fs/promises` (`stat {bigint}`→`dev/ino/mode/mtimeNs/ctimeNs`, `lstat`, `mkdir`, `rm`, `rename`, `link`, `chmod`, `writeFile`, `open`→FileHandle `writeFile/stat/read(ch advancing cursor)/chmod/sync/close`) | `shims/fs-promises.js` over the workspace VFS — the exact face the vendored fs-local drives (exclusive-create open, no-replace link, sequential null-position reads); seed views refuse writes loudly | supported (workspace) |
| `node:buffer` (`Buffer.from/alloc/allocUnsafe/concat/byteLength/isBuffer`, `buffer.constants`) | `shims/buffer.js` — the Uint8Array-backed DshBuffer (also installed as the global `Buffer` by web-shims.js); `alloc` zero-fills, `allocUnsafe` is its honest signature twin (nothing uninitialized to hand out) | supported |
| `node:url` (`pathToFileURL`, `fileURLToPath`, `URL`) | `shims/url.js` (web-integration leg) — fs-local's `pathToFileURL` rides the same file: encoder | supported |
| `node:util` `TextDecoder` (`utf-8`; `fatal` strict walk, `{stream}` carry of split multi-byte sequences) | `shims/util.js` — the face fs-local decodes file text with (`FS_NOT_TEXT` on invalid bytes); only utf-8, any other label loud | supported |
| `node:path` (`toNamespacedPath`) | `shims/path.js` — POSIX identity (namespacing is a win32 concern; fs-local only calls it in its win32 branch) | supported |
| `node:process` (`pid`) | `shims/process.js` — constant 1: ONE runtime process by construction (§6 single serial thread); vendored temp-name builders use it for uniqueness only | supported |
| `diff` (bare npm; `structuredPatch` for write/edit hunk diffs) | `shims/npm-bridges.js` — registers a one-line re-export through the host's `__dshModuleDefine` runtime-module seam pointing at the VERBATIM `vendor/npm/diff@9.0.0/libesm/` tree; the host bare-map (hosts/**) is not touched and no upstream byte is copied. Must be imported BEFORE the tool packages resolve (ESM links static graphs before any module body runs) | supported |
| `node:os` (`tmpdir`) | `shims/os.js` — profile container pinned by `boot.js` | supported (after container pin) |
| `node:process` (global `process`) | `shims/process.js` — env = launch snapshot, cwd = container, `nextTick` = microtask | supported (subset) |
| `node:module` (`createRequire`) | `shims/node-module.js` over the host `__dshBundleRequire` seam — resolves `base` through the loader's own bare map, serves relative `.json` reads under the bundle root only | supported (subset) |
| `structuredClone` | `web-shims.js` — JSON-safe superset (Date/RegExp/Map/Set, cycles); else loud | supported |
| `AbortController`/`AbortSignal` (`addEventListener`, `throwIfAborted`, `AbortSignal.any`) | `web-shims.js` | supported |
| `AbortSignal.timeout` | `web-shims.js` — throws (no wall-clock timers in the spike runtime) | unsupported (loud) |
| `setTimeout`/`setInterval` | NOT PROVIDED — absent on purpose; an accidental call is a loud ReferenceError. Only `cordis-host-runner` (the Node host runner, replaced by `boot.js`) uses them; vendored `dsh-timeout` is pure arithmetic (constants + signal classification), no timers | unsupported (loud) |
| `fetch`, `TextEncoder`, global `TextDecoder` | NOT PROVIDED as globals — closure-verified: only `cordis-host-runner` (not mounted) and unreached zod paths use them. `TextDecoder` IS served as a `node:util` import (fs-local's text decode — see the shim row above); `Buffer` is the DshBuffer global + `node:buffer`; the host binds `atob`/`btoa` natively | partial (globals), supported (imports) |
| `@deepseek-ai/dsh-llm` (+ `/invariant`, `/message`, `/assistant-stream`, `/types`, `/typert`, `/remote` runtime subpaths) | `vendor/dsh/llm@0.1.6-alpha.2/lib/…` — the VERBATIM vendored package (LLM transport leg; the staged `shims/dsh-llm*.js` value-helper port retired by this row). `node:module` (`createRequire`, dsh-llm's `../package.json` attribution read) → `shims/node-module.js` over the host `__dshBundleRequire` seam — package-style RELATIVE `.json` reads only, everything else loud | supported (LLM transport leg) |
| `@deepseek-ai/dsh-session-persistence` (`SessionPersistenceNotFoundError` + sibling error classes) | `shims/dsh-session-persistence.js` — errors-only linkage shim; resume stays unavailable (loud "persistence is not configured" upstream path) | staged (follow-up: real backend over the gateway fs) |
| `@deepseek-ai/dsh-*` bare + `/invariant` subpaths | host loader → `vendor/dsh/<pkg>@0.1.6-alpha.2/lib/…` (verbatim tarballs) | supported |
| `@deepseek-ai/cordis`, `@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`, `zod` (+ zod relative subpaths) | host loader → `vendor/npm/…` (pinned) | supported |
| anything else bare | host loader fails loud naming the specifier | fail loud |

## Desktop → mobile system-capability mapping

How dsh-desktop's host capabilities map onto the mobile system layer, with
the honest gaps declared:

| desktop (Node.js host) | mobile (this port) | state |
| --- | --- | --- |
| `node:fs` at absolute paths (`$DSH_HOME`, workspace) | gateway `fsRead`/`fsWrite`/`fsScope` — scope-relative POSIX under the granted scope; the scope root IS the profile container (`fsScope.resolve` returns its absolute path, which pins session `cwd`). The file-tools row (dsh-fs-local + tool-fs + tool-str-replace-editor) runs over the in-memory workspace VFS (`shims/fs.js mountWorkspace`) — full read/write/list/edit semantics, no disk | live: the vendored `ctx.fs` backend + tool family (scenario/tool-fs-probe.js); product boot wiring is the coordinator's follow-up; a DISK-backed workspace over the gateway fs scopes is the follow-up |
| `child_process` (dsh-subprocess-local) | `subprocess` Service — in-process coroutine executor (`system-plugins/dsh-subprocess-quickjs`); no OS processes on the runtime thread (D2) | service shipped in the spike; upstream `dsh-shell`/`dsh-tool-bash` rows are the follow-up |
| `@vscode/ripgrep` binary (dsh-tool-fs-search's grep/glob engine) | none — a packaged OS binary driven through real subprocesses has no in-runtime equivalent | staged with the follow-up subprocess/fs-service seam (same class as the native rows) |
| `node:fetch` / undici (llm adapters, web tools) | gateway `httpFetch` — streaming AsyncIterable body, abortable, base64 byte bridge | live: `upstream/llm-transport.js` streams the vendored dsh-llm service over it (E2E against the vendored dsh-llm-mock-server, node-side loopback) |
| `$DSH_HOME` (`~/.dsh`) | the host-granted profile container (one directory per install), pinned by `boot.js` for `process.cwd()`/`os.tmpdir()`/`os.homedir()` | live |
| Electron window / WebContents | carrier loopback HTTP+WS + WebView mounting the Web Client (the early carrier spike; the platform hosts since) | carrier proven separately; the upstream port runs headless |
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
   The follow-up drives a real tool through the subprocess Service + gateway fs.
3. Persistence/resume, webserver carrier rows (`ctx.webServer`,
   frontend-static), shell/bash tools, settings file — later follow-ups.
4. Wall-clock timers: nothing in the mounted closure uses them; when a
   slice needs them, the host gains a timer primitive (contract proposal
   first — never a global hack).
