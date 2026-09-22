# Upstream capability-mounting research (2026-09-23)

English | [简体中文](upstream-capability-mounting.zh.md)

Three sibling projects were studied overnight to sharpen how dsh-mobile mounts
platform capabilities: **@zseven-w/dsh-ios** (a DSH plugin exposing iOS
simulator/device abilities), **rish-app** (a React Native pocket agent with an
in-process Rust x86-64 Linux guest), and **deepseek-harness** at `v0.1.7-alpha.2`
(the upstream our vendored pin `0.1.6-alpha.2` predates by 1754 commits).
This file preserves the findings and the adoption decisions they produced.

## 1. dsh-ios — capability references as expiring, signed objects

Despite the name, not a native iOS host: a macOS-side DSH plugin whose "native
capabilities" are subprocess adapters (`simctl`, `devicectl`, WebDriverAgent, a
compiled OCR tool) behind a declarative tool table. The patterns worth keeping:

- **Expiring, single-purpose capability references.** Tool outputs never carry
  bytes; they carry replayable `presentationMeta`, and the client re-mints a
  short-lived (≤10 min) HMAC-signed URL per render via a `/grant` endpoint —
  with a loopback transport fence checked before any token. A leaked visual or
  stream reference is worthless within minutes.
- **Optional capabilities as scopes that never run.** Optional services mount
  via scoped `ctx.inject([service], cb)`; an absent service means the callback
  never fires — never a boolean flag, never a property probe (which throws).
- **"Registered but truthful" degradation.** Tools stay registered on hosts
  that cannot serve them and fail with a stable explanatory prefix and coded
  reasons (`device-locked`, `tunnel-failed`); discovery never 500s.
- **Disposal-symmetric registration + a boot-time mount inventory log** — the
  audit that an advertised verb has an implementation behind it.

## 2. rish-app — decision core, digests, and honest limits

A React Native agent app executing tools locally, with a full-system x86-64
interpreter booting a real kernel per program run (~40 s). Its lessons:

- **One shared decision core, digest-bound.** All agent rules live in a Rust
  core behind a C ABI; the tool table is a pure table whose `toolset_sha256`
  binds every stored grant and authority to the exact capability bytes, with
  versioned historical tables so old records stay valid but changes are
  detectable and refusable.
- **Durable denials, not errors.** A tool the root doesn't offer projects as a
  persisted denial with a sanitized name; UI-facing projections enumerate their
  keys and are tested against leaking paths/arguments.
- **Asset integrity at every mount.** Kernel/initramfs/disk SHA-256 constants
  re-verified on *every* boot and per-run — not just at install.
- **Ledger-recorded approvals** with idempotency keys and nested write budgets
  (single ≤ batch ≤ attempt).
- **Measured timeouts and honest runtime-mode labels** separating shipped
  capability from aspiration.
- What to *reject*: fresh-VM-per-run latency, single-VM-process-wide
  serialization, and one-shot exec with no interactive PTY — our persistent
  in-process Alpine userland is the right shape for a shell primitive.

## 3. deepseek-harness (0.1.7-alpha.2) — the upstream contract, and drift

- **The seam trio is the contract**: Service Definition (abstract `Service`
  owning `ctx.<key>`) + providers + consumers; "extension plugins depend on
  Service Definitions, never concrete providers". Capability facts
  (`sandboxMode` getters), honest optional members, and cordis `inject`
  (consumers pend until the service exists) are the negotiation vocabulary.
- **Mount like the desktop host, not beside it**: Electron boots the *shared
  profile runner* and adds host capabilities with `ctx.plugin(...)` onto the
  running context — a second backend composition is an explicitly rejected
  alternative. Our `runtime/spike/upstream/boot.js` mobile profile boot is the
  same shape; keep it that way.
- **Our pin is behind the preset wave**: `agent-preset-registry` (per-session
  composition with activation auditing), `config-editor`, account/job Remote
  controllers, duplex `RemoteStream`s, registry-fallback plugin manager all
  landed after `0.1.6-alpha.2`. A vendored refresh needs its own planned
  change; watch `docs/decisions.md` for it.
- **No hostType upstream either**: platform differences are provider swaps and
  client `platform` declarations; the wire never carries Host objects.

## Adoption decisions (what this produced in dsh-mobile)

1. **Boot-time capability inventory record** — the negotiated descriptor
   inventory is logged as one structured record at spine boot (reserved
   namespace, no scenario-stream impact): the "advertised = implemented" audit
   dsh-ios logs at mount, in our shape.
2. **Integrity-at-every-mount for the staged userland** — the ish rootfs
   digest is re-verified at each guest boot, not only at fetch time
   (rish-app's rule, applied to our `ishRun`).
3. **Coded reasons on unavailable capabilities** — candidate contract change
   (`contract/` proposal first, per D5): structured envelopes gain stable
   reason codes; discovery answers truthfully, callers branch on codes.
4. **Upstream watch** — ARCHITECTURE gains a standing section naming the
   0.1.7 seam additions so the next re-pin is planned, not surprised by.
