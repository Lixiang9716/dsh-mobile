# Plugin development on dsh-mobile — the tutorial, one-to-one

This is the mobile counterpart of the upstream "first plugin" tutorial
(deepseek-harness docs → develop → basic): every capability that tutorial
teaches exists on the mobile host, through the same cordis shapes, proven by
the `plugin.forms` E2E leg (`runtime/dsh/ci/run-plugin-forms-e2e.sh`, receipts
under `runtime/dsh/artifacts/macos-cli-plugin-forms/`).

## What a plugin is

Identical to upstream: a module exporting an `apply` function that receives a
cordis `ctx`. Three forms are first-class (the mount chain normalizes all of
them, `runtime/dsh/plugin-mount.js`):

| Form | Entry shape | Use |
| --- | --- | --- |
| object | `export const name/inject/apply` (or the same under `default`) | the default choice |
| function | `export default (ctx) => {}` | minimal plugins |
| class | `export class X extends Service` (a single class/function export is picked) | plugins that provide a service |

```js
import { Service } from '@deepseek-ai/cordis';   // resolves on-device (pinned vendored copy)
export class MyService extends Service {
  static inject = ['tools'];                     // dependencies load first
  constructor(ctx) { super(ctx, 'myService'); }
}
```

`inject` is honored exactly as upstream: the framework loads the plugin only
after the named services are up.

## Declaring effects (and the one semantic to know)

Everything registered through `ctx` (listeners, tools, timers) is cleaned up
automatically on unload. For manual resources use `ctx.effect` — in the
vendored `cordis@4.0.2` the callback runs **immediately as setup and its
return value is the disposer**:

```js
export const apply = (ctx) => {
  const heartbeat = setInterval(() => {}, 1000);
  ctx.effect(() => () => clearInterval(heartbeat));   // setup returns the cleanup
};
```

## How plugins mount (the mobile differences)

There is no `pnpm dsh web` on a phone; the three registration paths map onto
the tutorial's `cordis.yml` insert:

1. **Chat-created** (the product path): ask the agent to make a plugin — the
   model authors the tree, a native approval gate asks you, and the plugin
   mounts live (`plugin-mount.js`: read → validated → approved → adopted →
   linked → mounted).
2. **Marketplace**: signed packages install through the marketplace plane —
   same registry, same boot behavior.
3. **Developer push** (the tutorial's loop): `tools/plugin/dev.sh` compiles
   your TypeScript on the dev machine (the device never compiles — it only
   interprets prebuilt bytes), stages the tree into the simulator's app
   container, and enables the registry row. Relaunching the app mounts every
   ENABLED registry row at spine boot — the one-to-one equivalent of the
   tutorial's `--patch` layer, which is also per-launch:

   ```sh
   tools/plugin/dev.sh my-plugin/            # compile → stage → enable → relaunch
   ```

   `my-plugin/` is the tutorial's scratch-plugin in mobile spelling:
   `plugin.json` (`{id, name?, version?, entry?, capabilities?}`) plus
   `src/index.ts` (or `.js`, passed through verbatim).

## Unload and reload

Unload is a first-class operation: `unmountWorkspacePlugin(spec)` awaits the
cordis fiber's `dispose()` (every effect the plugin registered unwinds) and
disables the registry row. Mounting again re-links the **current** source
under an epoch query (`?e=1` — the loader's node-style cache-buster), so
edit → relaunch is a true reload, not a stale module. Removing through the
plugin manager (`marketplace/remove`) disposes a live mount first — a tree
never disappears under a running fiber.

## Where the E2E proof lives

`scenario/plugin-forms.js` (deterministic, no model): all three forms mount,
`inject` orders the load, the service answers through the resolver, effect
cleanups run on unload, edited source reloads, and the boot list mounts
exactly the enabled rows. Run it with `runtime/dsh/ci/run-plugin-forms-e2e.sh`
(wired into `build/build.sh test core`); the manifest is
`test/e2e/scenarios/plugin-forms.json`.

---

[中文版](plugin-dev.zh.md)
