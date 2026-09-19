# Capability Gateway — Primitive Contract v1.0.0

> **Status: FROZEN at M0** (2026-09-19, decision D5). Shapes in this document are immutable
> for the life of major version 1. Evolution policy in [§8](#8-versioning--evolution).
> Machine-readable surface: [primitives.d.ts](primitives.d.ts).
> English | [简体中文](primitives.zh.md)

This is the shared service foundation of all four platforms (iOS / Android / HarmonyOS /
desktop interop): the **narrow primitive table of the capability gateway**. Every host
implements the same table; everything above it — upstream Harness packages, system
implementation plugins, Web Clients — sees one service surface and negotiates platform
differences through capability negotiation. Platform branching (`hostType` conditionals,
RFC 0002 anti-pattern) is banned by construction: there is nothing to branch on.

## 1. Model

- The gateway is **host-fixed, never a plugin**. It is the only door between the JS runtime
  and the platform.
- One **primitive** = one typed operation with a closed request/response shape, a permission
  flag, and mandatory audit. No god-interfaces.
- Every primitive is **asynchronous** (Promise in, Promise out) and dispatched onto the
  runtime's serial queue when it completes. The bridge is an async event boundary (D8);
  nothing blocks the runtime thread.
- Calls are made **only from the runtime thread on behalf of a caller identity** (the plugin
  id the runtime executes). The gateway trusts the runtime for caller identity and checks the
  caller's negotiated permissions before dispatch.
- Primitive operations serve *plugin-reachable* work. The host's own bookkeeping (profile
  storage, checkpoints, blob cache) is host-internal and not expressed as primitives.

## 2. The v0 table (9 primitives)

| # | Primitive | Purpose | Permission flag | Streams |
| --- | --- | --- | --- | --- |
| 1 | `fsRead` | read a file inside an authorized scope | `fsRead` | no |
| 2 | `fsWrite` | create / overwrite / append a file inside an authorized scope | `fsWrite` | no |
| 3 | `fsScope` | persist and resolve user-granted scope access across launches | `fsScope` | no |
| 4 | `httpFetch` | HTTP request through the host network stack | `httpFetch` | response body |
| 5 | `notify` | schedule a local notification | `notify` | no |
| 6 | `presentApproval` | native approval dialog; doubles as a checkpoint boundary | `presentApproval` | no |
| 7 | `presentPicker` | native file / directory picker; grants a scope on success | `presentPicker` | no |
| 8 | `keychainGet` | read a credential by opaque reference | `keychainGet` | no |
| 9 | `keychainSet` | write or delete a credential by opaque reference | `keychainSet` | no |

Reserved identifiers: the scope handle `"app"` denotes the host's own profile container
(the storage layout of [data-protocols.md](data-protocols.md)); the capability name
`gateway` refers to this contract itself.

## 3. Signature conventions

Applies to every primitive; full types in [primitives.d.ts](primitives.d.ts).

- **Bytes** are `Uint8Array`. **Paths** are POSIX-style and scope-relative (`"logs/a.jsonl"`);
  a path that escapes its scope root is rejected as `invalid`. **Handles and references**
  (scope handles, persisted scope refs, credential refs, notification ids) are **opaque
  strings** — hosts define their form, callers treat them as tokens. **Timestamps** are
  ISO-8601 UTC strings.
- **Errors** reject with one structured `GatewayError`:

  | Code | Meaning |
  | --- | --- |
  | `denied` | caller lacks the permission flag (negotiation or user policy) |
  | `unavailable` | platform cannot provide the primitive; capability negotiation should have caught it — a plugin that sees this skipped required-capability checks |
  | `invalid` | malformed arguments (bad path, bad ref, oversized payload) |
  | `io` | filesystem-level failure |
  | `network` | transport-level failure |
  | `timeout` | host-declared deadline elapsed |
  | `cancelled` | the user or system aborted the operation |

  Unknown codes are fatal to the call and must surface loudly — receivers never fall back
  on an error code they do not recognize (fail-loud rule).
- **User dismissal is a value, not an error**: `presentPicker` resolves `null` and
  `presentApproval` resolves `{ approved: false }` when the user walks away; `cancelled` is
  reserved for system-initiated abortion.

## 4. Primitive semantics

### fsRead / fsWrite / fsScope

- `fsRead(scope, path) → { bytes, mtime }` — reads the whole file. v0 has **no streaming
  read**; hosts declare a maximum file size and reject larger reads as `invalid` (streamed
  reads are a candidate for a minor-version addition).
- `fsWrite(scope, path, bytes, opts?) → { written }` — `opts.append` appends, `opts.create`
  (default `true`) allows creation.
- `fsScope.persist(scope) → { ref }` / `fsScope.resolve(ref) → { scope }` — makes a
  user-granted scope (from `presentPicker`) survive relaunch. Each platform maps this to its
  native mechanism (iOS security-scoped bookmarks, Android SAF persisted permissions,
  HarmonyOS equivalent). Hosts may garbage-collect refs that no longer resolve; resolution
  failure rejects with `io`.

### httpFetch

- `httpFetch(url, init?) → { status, headers, body, abort() }` — the response **body is an
  async iterable** of byte chunks: one event sequence, never a blocking whole-result (D8).
  Request `body` may likewise be a byte array or async iterable (upload streaming).
- `abort()` cancels the in-flight request; the pending `httpFetch` promise rejects with
  `cancelled`. Redirect and timeout policies are host defaults; v0 does not expose them.

### notify

- `notify(payload) → { id }` — schedules a **local** notification (push ingestion is host
  capability, not a primitive). User interaction with the notification arrives on the
  `notify.response` event channel (§5).

### presentApproval / presentPicker

- `presentApproval(req) → { approved, remember? }` — the native approval surface. While an
  approval is pending the host **may checkpoint** the runtime: background suspension during
  a pending approval must degrade to local-notification-then-resume, not data loss (D7).
- `presentPicker(req) → { scope, path } | null` — `mode: "file" | "directory"`. On success
  the host grants a `ScopeHandle` usable with the fs primitives; user cancellation resolves
  `null` and grants nothing.

### keychainGet / keychainSet

- Credentials are addressed by opaque `KeyRef` (the manifest-declared credential references
  live in profile `state/`). `keychainGet` resolves `null` for unset references.
- `keychainSet(ref, secret)` stores; `keychainSet(ref, null)` deletes. Secrets are bytes;
  string encoding is the caller's business.

## 5. Event channels

Delivered by the bridge onto the runtime queue — not per-call primitives, part of this
contract and versioned with it:

| Channel | Payload | Purpose |
| --- | --- | --- |
| `app.state` | `{ state: "foreground" \| "background" }` | drives checkpoint / resume (D7) |
| `notify.response` | `{ id, action? }` | user interacted with a notification |

Streaming progress of a specific `httpFetch` call is delivered through that call's response
body, not a global channel.

## 6. Permissions and audit

- Each primitive's permission flag is a **capability string** with the grammar
  `<name>` or `<name>@<major>` (e.g. `fsWrite`, `gateway@1`). Plugins declare them in the
  manifest under `capabilities.required` / `capabilities.optional`
  ([data-protocols.md](data-protocols.md)); the gateway checks before dispatch.
- **Audit is mandatory and host-fixed**: for every call the host records primitive name,
  caller identity, permission verdict, and outcome code — never payload contents. Audit
  sinks are host-defined but must be structured records, not prose.

## 7. Conformance

A host conforms to `gateway@1` when, and only when:

1. it implements **all nine primitives** with the shapes of this document, or declares an
   absent primitive `unavailable` honestly in its `RuntimeDescriptor` — absence is
   information for negotiation, never faked (ARCHITECTURE.md §12);
2. it enforces permission flags and emits the audit records of §6;
3. it delivers §5 channels and completes every call by dispatching onto the runtime queue;
4. platform-specific behavior lives behind the same table — a conforming host adds no
   primitives outside this contract and no conditionals above it.

Platform mapping notes belong to each host (`hosts/<platform>/`), not to this contract.

## 8. Versioning & evolution

- The contract is **semver**-versioned; this document froze `1.0.0`. The negotiation string
  is major-only: `gateway@1`.
- **Minor** (`1.x`): adding primitives or event channels, adding optional request fields.
  Frozen call sites keep working; new surface is opt-in via negotiation.
- **Major** (`2.0.0`): any change to an existing shape, removal, or renumbering. Requires a
  new contract document and a migration note.
- Deferred candidates for future minors (explicitly **not** in v0): clipboard, share sheet,
  biometric prompt, geolocation, streamed fs read, fs watch. Restraint is the point of a
  narrow table; each addition must argue its necessity against negotiation data.
