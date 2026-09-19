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
