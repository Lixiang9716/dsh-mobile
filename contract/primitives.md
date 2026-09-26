# Capability Gateway — Primitive Contract v1.5.0

> **Status: FROZEN at the contract freeze** (2026-09-19, decision D5). Shapes in this document are immutable
> for the life of major version 1. Evolution policy in [§8](#8-versioning--evolution).
> Machine-readable surface: [primitives.d.ts](primitives.d.ts).
> English | [简体中文](primitives.zh.md)
>
> **v1.1.0 (additive, 2026-09-22)**: five filesystem operations the upstream file tools
> require — `fsStat`, `fsList`, `fsMkdir`, `fsRemove`, `fsRename` (table below, and §4
> "filesystem additions"). v1.0.0's nine primitives are untouched, so a `gateway@1` host
> that does not implement the additions keeps negotiating exactly as before and reports
> them `unavailable` — this is a minor bump in the sense §8 defines, not a new major.
>
> **v1.2.0 (additive, 2026-09-22)**: `wasmRun` — run one exported function of one
> WebAssembly module **inside the caller's own process** (§4, "wasm"). iOS forbids JIT and
> this architecture refuses subprocesses (D2), so the alternative to an in-process
> interpreter is no WebAssembly at all, not a child process. Same additive rule as v1.1.0:
> a host without it answers `unavailable`.
>
> **v1.3.0 (additive, 2026-09-22)**: `ishRun` — run one program in the host's **in-process
> emulated Linux userland** (§4, "emulated userland"): a userspace interpreter emulates both
> the guest's instructions and its syscalls, so a real Alpine userland runs inside the app
> process with no child process and no second OS (the same D2 reasoning as `wasmRun`, one
> step further out). Same additive rule as v1.1.0/v1.2.0: a host without it answers
> `unavailable` — iOS implements it today (the iSH-arm64 engine, vendored and sha256-pinned
> as an engine, never modified); the Android and HarmonyOS hosts answer `unavailable` and
> keep the WebAssembly shell, which is capability negotiation, not a platform branch.

> **v1.4.0 (additive, 2026-09-23)**: `timerSchedule` / `timerCancel` + the `timer.fire`
> event channel — one host-owned wake-up seam under one `timer` permission flag (§4,
> "timer"). The vendored upstream runtime calls timers as an ambient global
> (`dsh-timeout`'s deadline fuses arm a bare `setTimeout`), and nothing in this
> architecture can schedule a future callback without the host re-entering the serial
> queue — which is exactly the shape the gateway exists to govern. The mapping from
> `setTimeout`-shaped code to these primitives lives in the shim layer, which negotiates
> the flag and fails loud when it is absent; there is deliberately **no global
> `setTimeout`** in this contract (a global would be a second, un-governed surface for
> the same capability). Folded from the proposal in `contract/proposals/` (its evidence
> base: 22 suite failures + 2 hangs + 100+ excluded specs on the upstream-suite
> emulator run). Same additive rule as v1.1.0–v1.3.0: a host without the seam keeps
> negotiating `gateway@1` and answers `unavailable`.

> **v1.5.0 (additive, 2026-09-26)**: the device plane — six primitives for the host's
> platform-SDK surface (§4, "device plane"): `deviceInfo`, `haptic`, `clipboardRead` /
> `clipboardWrite`, `presentShare`, `keepAwake`, plus one extended shape: `presentPicker`
> gains `mode: "media"`. `clipboardRead` is approval-gated by default — surfaced through
> the same approval surface as `presentApproval`, honoring a standing grant when the user
> chose to remember one — because the read direction is the exfiltration direction, and
> its audit record carries the call, never the text. `presentShare` learns only that the
> sheet completed, never the destination. Folded from the proposal in
> `contract/proposals/` (its evidence base: the creation-mode clients' keep-awake need
> and the composer's inability to hand a deliverable to another app). Same additive rule
> as v1.1.0–v1.4.0: a host without a primitive keeps negotiating `gateway@1` and answers
> `unavailable`.

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

**v1.1.0 additions (5)** — the filesystem operations the upstream file tools
(`@deepseek-ai/dsh-tool-fs` over `@deepseek-ai/dsh-fs-local`) perform on every resolve,
stat, listing, edit and atomic write. They reuse the existing `fsRead` / `fsWrite`
permission flags, so no new capability has to be negotiated:

| # | Primitive | Purpose | Permission flag | Streams |
| --- | --- | --- | --- | --- |
| 10 | `fsStat` | stat a path inside an authorized scope | `fsRead` | no |
| 11 | `fsList` | list a directory inside an authorized scope | `fsRead` | no |
| 12 | `fsMkdir` | create a directory (recursively) inside an authorized scope | `fsWrite` | no |
| 13 | `fsRemove` | remove a file or directory inside an authorized scope | `fsWrite` | no |
| 14 | `fsRename` | rename or move inside an authorized scope | `fsWrite` | no |

**v1.2.0 addition (1)**:

| # | Primitive | Purpose | Permission flag | Streams |
| --- | --- | --- | --- | --- |
| 15 | `wasmRun` | execute one export of a WebAssembly module in-process | `wasm` | no |

**v1.3.0 addition (1)**:

| # | Primitive | Purpose | Permission flag | Streams |
| --- | --- | --- | --- | --- |
| 16 | `ishRun` | run one program in the host's in-process emulated Linux userland | `ishRun` | no |

**v1.5.0 additions (6)** — the host's own device surface, one capability family per
row; `deviceInfo` needs no flag (the same facts any web page's UA string carries):

| # | Primitive | Purpose | Permission flag | Streams |
| --- | --- | --- | --- | --- |
| 17 | `deviceInfo` | read-only device facts (platform, model, OS, screen, battery, locale, timezone) | — | no |
| 18 | `haptic` | one user-facing tactile cue | `haptic` | no |
| 19 | `clipboardRead` | read the system clipboard (approval-gated by default) | `clipboard` | no |
| 20 | `clipboardWrite` | write text to the system clipboard | `clipboard` | no |
| 21 | `presentShare` | hand a payload to the system share sheet | `share` | no |
| 22 | `keepAwake` | hold the screen on while the caller is showing something worth watching | `screen` | no |

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

### filesystem additions (v1.1.0)

The five operations below exist because the upstream file tools cannot work without them:
`@deepseek-ai/dsh-fs-local` resolves, stats and lists before it reads or writes, and its
atomic-write path creates a temporary sibling and renames it. Paths follow the same
scope-relative POSIX rule as `fsRead`/`fsWrite`, and a path that escapes its scope root is
rejected as `invalid` **before** any host call, exactly as those two do.

- `fsStat(scope, path) → { kind, size, mtime }` — `kind` is `"file"` | `"dir"` | `"other"`;
  `size` is bytes (0 for directories); `mtime` is ISO-8601 UTC. A missing path rejects with
  `io` and a message naming the path — the tools distinguish "absent" from "unreadable" by
  the message, not by a second code, because `io` already covers both on every host.
- `fsList(scope, path) → { entries: [{ name, kind }] }` — one directory level, **not**
  recursive; `entries` is sorted by `name` (byte order) so a listing is deterministic
  across hosts. `name` is the last path component; `kind` uses the `fsStat` vocabulary.
- `fsMkdir(scope, path, opts?) → {}` — creates the directory and any missing parents;
  succeeds when the directory already exists (`opts.existing: "ok" | "error"`, default
  `"ok"`, which is the `mkdir -p` behaviour the tools rely on).
- `fsRemove(scope, path, opts?) → {}` — removes a file or, with `opts.recursive: true`, a
  directory tree. A missing path is `opts.missing: "ok" | "error"` (default `"ok"`).
- `fsRename(scope, from, to) → {}` — moves within the scope; `from` missing rejects with
  `io`, and a `to` that already exists is replaced (POSIX rename semantics), because
  atomic-write depends on it.

Hosts that do not implement a listing may serve `fsList` as `unavailable` and everything
else as usual; a caller that needs listings must treat that as a capability gap, not an
error to retry.

### wasm (v1.2.0)

`wasmRun(scope, path, func, input?) → { result, output }` — loads the module at
`path` **inside the authorized scope** (the same scope-relative path rule the fs
primitives use, so a module is an ordinary file the user or a plugin put there)
and calls its export `func` with the caller's `input` string.

The module's ABI is what makes this a *seam* rather than a sandbox escape:

- the module exports its memory, and `func` takes `(param i32 ptr) (param i32 len)`
  and returns `i32`;
- the host writes `input` into the **last 4096 bytes of the module's current
  memory** and passes that offset and length, so a module keeps its own data below
  that region — or grows its memory and uses the new top, which the host
  recomputes on every run;
- everything the module reports goes through the imported function
  `dsh.emit(ptr, len)`; the host collects those bytes into `output`;
- `result` is the export's own `i32` return value (a status code is the intended
  use).

`input` is UTF-8 and `output` is UTF-8; a module that emits other bytes gets them
back as-is (the host escapes for JSON, it does not transcode). A trap, a missing
export, a module that does not parse or does not load, and a call that exceeds the
host's output buffer are all `io` rejections naming which of those happened —
never a partial result. Modules run **in-process**: no child process, no thread,
and the run occupies the runtime's serial queue like every other primitive.

`wasmRun` reads its module through the same scope machinery `fsRead` uses and adds
no filesystem capability of its own; the `wasm` flag is what gates *executing* one.

### emulated userland (v1.3.0)

`ishRun(scope, path, argv, opts?) → { exitCode, stdout, stderr, timedOut, truncated }` —
runs **one program** in the host's in-process emulated Linux userland and returns what it
printed and how it exited. "Emulated" is the whole design: the interpreter reproduces a
guest AArch64 instruction set and the Linux syscall surface *inside the app process* (no
child process, no second OS, no JIT — D2), so the program is an ordinary ELF binary from a
staged userland rather than a program the host could have spawned.

- `(scope, path)` names the **authorized directory the program starts in**. The host mounts
  that workspace inside the guest, so a relative path the program writes is a file the
  session sees and `fsRead` can read back — the round trip is the point of the primitive.
- `argv` is the program plus its arguments, resolved **inside the guest userland**:
  `["/bin/sh", "-c", "<line>"]` is how a shell command line is expressed. The primitive
  takes argv and never a command line — quoting, pipelines and redirection belong to the
  guest's own `/bin/sh`, and its exit status is the guest shell's.
- `opts.timeoutMs` is the run's deadline (the host clips it to a declared range).

Results and rejections, in the vocabulary of §3:

- A **non-zero exit status is a result, not a rejection**: `exitCode` carries it. An unknown
  program is the guest's own `127`, exactly as a Linux shell reports it.
- `timedOut: true` means the deadline fired and the guest task was killed (the reference host
  reports `exitCode: 128` for that kill — the shell convention for a signal death).
  `truncated: true` means the host's output cap was reached: the guest is **drained, never
  blocked** on a full pipe, and the streams come back cut rather than the call failing.
- `unavailable` means the host has **no guest userland staged** — a capability gap that
  negotiation should have caught, not an error to retry. `denied` when the caller has no grant
  for the scope; `invalid` for a malformed working directory or an empty argv; `io` when the
  guest cannot boot or the program cannot be started at all.
- The guest's filesystem, environment and process table live **inside the emulator**. What a
  program installs (`apk`, `pip`, `npm`) persists as long as the host keeps that userland
  staged, and a background job inside the guest survives only as long as the host process
  does: device lifecycle rules (suspension, memory pressure) take guest state with the
  process. D7's checkpoint format carries sessions — never a live userland.

**Audit honesty (see §6).** The host audits **the call** like every other primitive (caller,
verdict, outcome — never payloads) and **cannot** audit what the program does inside the
guest: the guest's sockets and files go through the emulator's own syscall layer, so
`fsWrite` / `httpFetch` permission flags do not gate them and no per-call record exists for
them. A host that offers this primitive is offering a whole Linux userland behind one grant;
its approval policy — not a per-call flag — is the control, and a host must say so in its
RuntimeDescriptor prose rather than let this document imply otherwise.

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
- `presentPicker(req) → { scope, path } | null` — `mode: "file" | "directory"`, plus
  `mode: "media"` (v1.5.0, below). On success the host grants a `ScopeHandle` usable with
  the fs primitives; user cancellation resolves `null` and grants nothing.

### device plane (v1.5.0)

- `deviceInfo() → DeviceInfo` — the read-only device facts, one snapshot per call: `platform`
  is one of `ios | android | harmonyos | macos | linux | windows`; `model` is the host's
  marketing or hardware name; `osVersion` and `appVersion` are version strings; `screen`
  carries width/height in points plus the scale factor; `locale` is BCP-47 and `timezone`
  IANA. `battery` (`level`, `state`) and `lowPowerMode` are the one field a host may omit —
  they stay absent where the OS hides them. No permission flag; the call is still audited
  (platform included, nothing else — §6).
- `haptic(pattern) → void` — exactly **one** user-facing tactile cue per call. `pattern` is
  the closed vocabulary `light | medium | heavy | rigid | soft | selection | success |
  warning | error`; each host maps it onto its own generator (iOS impact/notification
  generators, Android `VibrationEffect`, HarmonyOS `@ohos.vibrator`). A pattern the platform
  cannot express rejects `unavailable` — never a silent substitute.
- `clipboardRead() → { kind: "text", text } | null` — `null` for an empty or non-text
  clipboard. The read direction is the exfiltration direction, so hosts surface the call
  through the same approval surface as `presentApproval` **by default**, honoring a standing
  grant where the user chose to remember one. The audit record carries the call only — never
  the text (§6).
- `clipboardWrite(text) → void` — one call, one clipboard write. The audit record carries
  the kind and the text's length, never the text.
- `presentShare(payload) → { shared }` — hands a payload (`text` | `url` | `files` with
  scope-resolved paths) to the **system share sheet**, the OS's own trust boundary: the
  host learns only that the sheet completed, never the destination. `files` paths resolve
  through the same scope discipline as `fsRead` — outside a granted scope is `denied`. The
  sheet is its own per-call consent (no separate approval flag beyond `share`); the user
  walking away resolves `{ shared: false }` (dismissal is a value, §3).
- `keepAwake(hold) → void` — a boolean **latch, not a lease**: the caller holds the screen
  on while it is showing something the user is watching and releases when done (`keepAwake(false)`).
  A host without an idle timer answers `unavailable`.
- `presentPicker` `mode: "media"` — presents the platform's media picker (iOS
  `PHPickerViewController`, Android PhotoPicker, HarmonyOS PhotoViewPicker) and returns a
  scope handle the same way the file picker does: read-through-scope over **what the user
  picked**, never library access. Dismissal resolves `null` as before.

### keychainGet / keychainSet

### keychainGet / keychainSet

- Credentials are addressed by opaque `KeyRef` (the manifest-declared credential references
  live in profile `state/`). `keychainGet` resolves `null` for unset references.
- `keychainSet(ref, secret)` stores; `keychainSet(ref, null)` deletes. Secrets are bytes;
  string encoding is the caller's business.

### timer (v1.4.0)

`timerSchedule(delayMs, opts?) → { timerId }` — arms **one** wake-up; `timerCancel(timerId)
→ { cancelled }` — disarms it. The wake-up itself is not a response: it arrives on the
`timer.fire` event channel (§5), delivered onto the caller's serial queue like every host
event — a timer never runs JS on a second thread (D2) and never blocks (D8).

- `delayMs` is an integer ≥ 0 in **monotonic** time; the host fires no earlier than asked
  and promises no upper bound. The host may clamp to a tighter maximum and says so in the
  rejection `reason` — it never silently truncates (rule 5). Wall-clock needs are not timer
  fuses and stay out of this primitive.
- `opts.tag` (optional) is the caller-chosen audit tag: the audit trail must be able to
  answer *which plugin armed which timers* after a runaway.
- `timerSchedule` resolves when the timer is **armed**, not when it fires. `timerId` is an
  opaque integer, unique among *live* timers only (reuse after cancel-or-fire is legal and
  auditable). One arm fires **at most once** — no intervals in this version; a re-arm loop
  in the caller expresses repetition, and a stateless re-arm keeps the primitive minimal.
- `timerCancel` is idempotent: `{ cancelled: false }` for an unknown or already-fired id.
  A race between fire and cancel resolves one way or the other, never both; the host picks
  and the audit records which.
- Rejections in §3's vocabulary: `denied` without the `timer` grant; `invalid` for a
  non-integer or negative `delayMs`; `unavailable` on a host without the seam (a capability
  gap negotiation should have caught).

## 5. Event channels

Delivered by the bridge onto the runtime queue — not per-call primitives, part of this
contract and versioned with it:

| Channel | Payload | Purpose |
| --- | --- | --- |
| `app.state` | `{ state: "foreground" \| "background" }` | drives checkpoint / resume (D7) |
| `notify.response` | `{ id, action? }` | user interacted with a notification |
| `timer.fire` | `{ timerId, tag? }` | a `timerSchedule`d wake-up fired (v1.4.0; one arm ⇒ at most one fire) |

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
2. it enforces permission flags and emits the audit records of §6 — and, for `ishRun`,
   states in the descriptor what §6's audit cannot reach (the guest's own I/O), because a
   host that stays silent about it is claiming an enforcement it does not have;
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
- Deferred candidates for future minors (explicitly **not** in v0): biometric prompt,
  geolocation, streamed fs read, fs watch (clipboard and the share sheet arrived in
  v1.5.0; location/camera/sensors and a `deviceEvents` subscription stream are deferred
  to their own OS-permission lifecycle round). Restraint is the point of a
  narrow table; each addition must argue its necessity against negotiation data.
