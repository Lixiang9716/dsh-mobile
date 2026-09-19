# Agent Note: M2 system implementation plugins + m2.session scenario (JS foundation)

Status: implemented
Related: D8

## Problem

The M2 gateway binding proved the frozen nine-primitive bridge, but nothing
consumed it above the raw shim: the architecture's system implementation
plugins (fs / subprocess / ui) existed only as names in the layout, and no
scenario ran an actual agent session. Without them there is no proof that a
session can stream token deltas as an event sequence (D8), route a tool
through an in-process executor, and persist its result through the contract
fs primitives — on ANY host.

## Decision

Three platform-neutral ESM plugins land under `system-plugins/` — `dsh-fs`
(the `fs` service over fsRead/fsWrite/fsScope with scope-relative POSIX
escape rejection), `dsh-subprocess-quickjs` (the in-process coroutine
executor: spawn returns a handle whose progress/completion are events, no OS
processes, no blocking whole-result API), and `dsh-ui` (approval, picker,
and notify that settles from the notify.response bridge event). Each ships a
manifest.json that validates against contract/schemas/manifest.schema.json
and an index.js exporting the same manifest plus the `activate` factory.
A spike service registry (`runtime/spike/registry.js`) installs them, and
`scenario/m2.session` proves the session end to end on the CLI smoke
backend: registry boot → host-readiness signal (`host.info`, port 0, a
contract both the CLI backend and carrier hosts emit) → mock-LLM token
deltas → one tool call through the subprocess plugin persisting via dsh-fs
under scope "app" → session.completed — 22 events, one-to-one against
tools/e2e/scenarios/m2-session.json.

Two loader-level decisions the next implementer must keep: plugins import
bundle-root modules by bare specifier (`gateway.js`, `logger.js`), and the
spike bundle exposes the repo-root plugin tree via a relative symlink.
Rationale below.

## Alternatives considered

- **Plugin-relative imports (`../../gateway.js`)** — broke once plugins were
  staged: `..` after the `system-plugins` symlink resolves through the link
  target, landing outside the bundle. Bare bundle-root-relative specifiers
  (`gateway.js`) are layout-independent. Cost: the loader's identity rule —
  one canonical specifier per stateful module (the gateway event hub) or the
  two specifiers yield two instances with two listener sets, silently
  splitting event delivery. Recorded here because the failure mode is
  silent and the checker cannot see it.
- **Copying the plugin tree into runtime/spike/** — made the CLI work
  without a symlink but forked the sources from the architecture's
  `system-plugins/` home; copies drift and D6 forbids exactly that shape.
- **Registry enforcing capability availability at install** — would have
  rejected dsh-ui on the CLI backend (presentApproval unavailable), making
  the scenario unrunnable headless. Negotiation stays the gateway's
  per-call job (contract error codes); install is a static check, which
  also keeps manifests honest without runtime probing.
- **Blocking spawn result (await-the-promise as THE contract)** — rejected:
  D8 forbids blocking whole-result APIs. `handle.done` exists as a promise
  derived from the 'complete' event for ergonomics; the event is the
  contract, documented in the plugin.
