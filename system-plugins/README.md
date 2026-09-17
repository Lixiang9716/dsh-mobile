# system-plugins/

System implementation plugins · contract adaptation (JS, shared across platforms):

- `dsh-fs-ios` → implements `ctx.fs` (security-scoped semantics + workspace boundaries)
- `dsh-subprocess-quickjs` → implements `ctx.subprocess` (the coroutine executor)
- `dsh-notify-ios` / `dsh-credentials-ios` / `dsh-ui-ios` …

They consume only `contract/` primitives and implement upstream DSH service contracts; the Harness core above runs unmodified.
