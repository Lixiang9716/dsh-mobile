# system-plugins/

System implementation plugins · contract adaptation (JS, shared across platforms):

- `dsh-fs` → implements the `fs` service (read/write/append/exists/stat-ish
  semantics) over the fsRead/fsWrite/fsScope primitives; scope-relative POSIX
  paths, escapes rejected with the contract's `invalid` code
- `dsh-subprocess-quickjs` → implements `ctx.subprocess` (the coroutine
  executor): spawn returns an event-driven handle — progress and completion
  arrive as events on the runtime queue; no OS processes, no blocking
  whole-result API
- `dsh-ui` → composes presentApproval / presentPicker / notify into the `ui`
  service; notify settles from the notify.response bridge event
- platform-specific adaptations (`dsh-fs-ios`, `dsh-notify-ios`,
  `dsh-credentials-ios` …) land here as they are needed

Each package ships a `manifest.json` that validates against
contract/schemas/manifest.schema.json and declares its required capabilities
honestly; an `index.js` exporting the manifest plus the `activate` factory
that registers the service; logging through the unified logger only.

They consume only `contract/` primitives and implement upstream DSH service
contracts; the Harness core above runs unmodified.

## Install pipeline (the plugin system)

Plugins reach users through the install transaction of
contract/data-protocols.md §4, implemented platform-neutrally in
`runtime/spike/install-pipeline.js`: tgz bytes → sha256 → content-addressed
blob (`cache/blobs/<sha256>`) → verify against the caller's trust record →
unpack → strict manifest validation (the manifest rules of this section,
enforced in JS with unknown fields failing loud) → integrity ledger →
`plugins/<pkg>@<semver>/` → receipt (the commit point). A package whose
bytes drift from the trust record is rejected before anything is unpacked;
the installed tree stays untouched and no receipt is journaled.
`dsh-notes` (the `runtime/spike/fixtures/` package) is the reference plugin
that rides this pipeline in the `install.verified-tarball` scenario; the system plugins
above ship inside the bundle and mount through the same registry either
way — activation semantics do not depend on how the bytes arrived.
