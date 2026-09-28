# Agent Note: The upstream dsh-tests suite goes green on the mobile runtime

Status: implemented
Related: T-0070; the upstream-suite regression program (rounds 1–2); D1/D2/D6

## Problem

The upstream dsh-tests suite (671 specs, tag dsh-v0.1.6-alpha.2) ran at 314
green (47%) on our QuickJS runtime; every red was a silent assertion that
the "upstream packages run on the mobile host" claim could not survive.

## Decision

Three parallel waves (nine workers, every attempt and exclusion ledged under
tmp/r3-ledger-*.json) took the suite to 500 green of 678 staged (~74%), with
each remaining red classified. Fixes live only in OUR layer: transpiler
resolution (bare→subpath chunk rewrite, submodule src hoists, manifest↔dir
prune), the shim layer (fs/util/os/path/URL/buffer/web streams+events,
node:http loopback without sockets, worker close-ordering), the harness
(it.each row-spread, .resolves/.rejects on thunks, vi.stubGlobal
descriptors), 24+ pinned npm test faces, and one host-C addition
(import.meta.dirname/resolve in dsh_spike_host.c). The engine itself was
NOT modified: the one engine-class crash (GC assertion in JS_FreeRuntime
during timer-heavy teardown) is diagnosed to the fork's AsyncContext
reaction machinery with a repro ladder and fix plan (ledger F) — fork PR
follow-up, per the owner's standing license for engine edits.

112+ specs are EXCLUDED with named reasons under the 3-attempt rule: the
D2 subprocess/socket seams (createServer/spawn — the ish-guest route is
the named follow-up), CJS-only packages, native addons, node:vm as an
embedding surface, and workspace-only packages never published at the pin.

## Alternatives considered

- Switching the runtime to libnode/nodejs-mobile to inherit Node's stdlib:
  rejected — D1's measured verdict stands (jitless V8 on iOS has no
  WebAssembly, an order of magnitude more memory, and a libuv thread pool
  breaks the single-runtime audit model); the sweep's Node reference leg
  already provides libnode's answer (0 disagreements every run).
- Faking the residual greens by editing vendored specs: refused (D6) —
  every fix lives in our layer, every exclusion is reproducible.

## Consequences

The suite is now a real regression gate for the mobile runtime: a green
spec that goes red names the exact behavior change. Follow-ups: the fork
PR for the AsyncContext leak; the ish-guest route for OS-surface shims;
round 4 (the same suite as receipts on iOS/Android/Harmony + CI wiring).
