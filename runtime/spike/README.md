# runtime/spike/

The M1 core spike: quickjs-ng shim running a pinned upstream pure-logic
package, with the E2E verdict emitted as structured logs.

- `vendor/ensure.sh` — materializes the engine sources: pinned upstream
  commit + sha256-verified tarball (PROVENANCE.md has the pin). The vendor
  tree is untracked by design; run it before any build.
- `vendor/quickjs-ng/0.17.0/` — verbatim quickjs-ng library sources
  (untracked; materialized by `ensure.sh`). `quickjs-libc` is deliberately
  excluded: the spike host provides its own minimal glue.
- `vendor/dsh/util-crypto@0.1.6-alpha.1/` — verbatim upstream
  `@deepseek-ai/dsh-util-crypto` (zero-dependency, pure logic). The shim
  provides the Web-API seams it needs (`crypto.getRandomValues`, `btoa`)
  instead of editing upstream.
- `logger.js` — plain-ESM port of `runtime/logger/index.ts` (same
  `createLogger` contract; emits one JSON line per entry through the
  host-bound sink).
- `scenario/m1-spike-boot.js` — the `m1.spike.boot` E2E scenario: ESM
  package load, host Web-API shims, async gateway call resolved from the
  host side on a later pump tick, declared-unavailable conformance path.
- `host/` — the platform-neutral C shim every platform host links
  (`dsh_spike_host.c` + `main_cli.c` desktop driver + `build.sh`).
- `artifacts/` — committed evidence per environment (logs, verdict,
  receipt).

## Embedding contract (platforms)

Run `vendor/ensure.sh` first, then link
`host/dsh_spike_host.c` + `vendor/quickjs-ng/0.17.0/{dtoa,libregexp,
libunicode,quickjs}.c`, then from a SINGLE thread:

1. `dsh_spike_new(bundle_root, &sink)` — sink receives canonical
   `dsh.spike.log: {...}` lines; print them to the native log unmodified.
2. read + `dsh_spike_eval(s, "scenario/m1-spike-boot.js", source)`.
3. `dsh_spike_pump(s)` — drains microtasks and settles pending gateway
   calls; returns when quiescent.
4. verdict = `dsh_spike_complete(s) && dsh_spike_pass(s)` (plus the
   `tools/e2e/check.mjs` one-to-one match over the captured lines).

## Desktop proof run

```sh
runtime/spike/host/build.sh
cd runtime/spike && ./build/dsh-spike-cli . > logs.txt
node tools/e2e/check.mjs --manifest tools/e2e/scenarios/m1-spike-boot.json --log runtime/spike/logs.txt
```
