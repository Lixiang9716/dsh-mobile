// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-boot.js — the WEB BOOT PRODUCER (decision D9, W-INTEG leg).
 *
 * The official web app boots ONLY through the injected rows the upstream
 * `client-modules` node half composes (docs/webserver-contract.md §2.6): the
 * `__ModuleLoader__` facade queue, application preloads, the blocking
 * bootstrap batch, and the `__DSH_BOOT__` graph. This adapter lets the
 * VENDORED `ClientModuleRegistry` compose that wire inside the spike runtime
 * and hands the result to the carrier over the bus seam:
 *
 *   runtime → host: `web.boot` (index rows + plugin revs), `api.claim`,
 *                   `api.respond`, `mux.claim`, `mux.item|error|end`
 *   host → runtime: `web.plugins` (the staged scan-scope file set),
 *                   `api.request`, `mux.open|cancel`
 *
 * Upstream code runs VERBATIM: the registry's incremental `dsh.client` scan,
 * graph composition (`orderByModuleGraph`, combo partitioning, revision
 * framing) and the injected-row builder (`bootInjections`) are the pinned
 * package's own functions. Adaptation is confined to the seams below:
 *
 *   - stageWebPlugins: bus delivery → the read-only /web-plugins fs VFS
 *     (shims/fs.js) — the scan-scoped view: package.json + client bundle.
 *   - mountClientModules: the REAL cordis Loader service (boot.js mounts it on
 *     the spine shape; the bare shape mounts it here) decorated with the
 *     staged-plugin `entries()`/`internal.resolveSync` faces the registry's
 *     documented v1 contract reads — one loader service for the client
 *     composition AND the agent-presets inject (no second `loader` claim).
 *   - createApiHandlers / createMuxHandlers: the /api claims the boot actually
 *     calls, answered from the REAL vendored services (ctx.sessions), with
 *     every other endpoint left to the carrier's structured unimplemented.
 */
import './web-shims.js';
// The VENDORED browser bootstrap bundle: registers its closure factory on
// the queue facade (same file the page's blocking bootstrap batch loads).
import '@deepseek-ai/dsh-client-modules/client';
// The VENDORED cordis Loader SERVICE (mounted by boot.js on the full-spine
// shape; mounted HERE on the bare compose-only shape): one loader service
// owns the `loader` context property for both the client-module registry's
// resolution face and the agent-presets service's inject. The Loader reads
// the `process` GLOBAL (env/versions) at construction — the spine shape
// pins it in boot.js; the bare shape pins it here, same shim, same face.
import process from 'node:process';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import {
  mergeWebPlugins,
  seedWebPlugins,
  WEB_PLUGINS_ROOT,
} from 'upstream/shims/fs.js';
import {
  ClientModuleRegistry,
  bootInjections,
} from '@deepseek-ai/dsh-client-modules';
import { createWriteSurface, WRITE_ENDPOINTS, COVERAGE_ENDPOINTS } from 'upstream/web-write.js';
import { patchPresetSeedFiles } from 'upstream/preset-mobile-rows.js';

if (typeof globalThis.process === 'undefined') globalThis.process = process;

/** Materialize the VENDORED browser bootstrap bundle the same way the page's
 * facade does (queue registration → factory) to get its wire validator: the
 * client bundle IS the upstream boundary that will parse `__DSH_BOOT__` in
 * the WebView, so the runtime cross-parses the composed graph through IT. */
const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules';
const materializeBootstrap = () => {
  const queue = globalThis.window.__ModuleLoader__.pendingQueue;
  const index = queue.findIndex((registration) => registration.id === BOOTSTRAP_ID);
  if (index < 0) {
    throw new Error('web-boot: the vendored client-modules browser bundle never registered');
  }
  const [registration] = queue.splice(index, 1);
  return registration.factory(() => {
    throw new Error(`web-boot: ${BOOTSTRAP_ID}/client.js requested an external before the module system existed`);
  });
};
const bootstrapExports = materializeBootstrap();
const parseBootManifest = bootstrapExports.parseBootManifest;

/** Decode a bus delivery's base64 file payload (the Buffer shim accepts base64). */
const decodeB64 = (text) => globalThis.Buffer.from(text, 'base64');

/** The staged plugin DESCRIPTORS of a chunked delivery accumulate on the
 * global (the VFS pattern: quickjs may compile two module instances of this
 * adapter, so module state would fork — the global is the single store). */
const stagedDescriptorStore = () => {
  if (typeof globalThis.__DSH_WEB_PLUGIN_STAGED__ === 'undefined') {
    globalThis.__DSH_WEB_PLUGIN_STAGED__ = [];
  }
  return globalThis.__DSH_WEB_PLUGIN_STAGED__;
};

/**
 * Mount one `web.plugins` bus delivery into the fs VFS.
 * Delivery: { type: 'web.plugins', plugins: [{ loaderName, pkgJsonPath,
 * entryPath, files: { [absPath]: { b64, mtimeMs } } }] }.
 *
 * CHUNKED delivery (the harmony drive splits the multi-megabyte staging so
 * the carrier's main thread yields between packages — the 6s watchdog
 * appfreezed on the single-shot compose): `chunked: true` MERGES each
 * chunk's files into the VFS and accumulates the descriptors; only the
 * `final: true` chunk composes. Legacy single deliveries (the iOS drive's
 * shape) stage-and-compose in one step exactly as before.
 * Returns the plugin descriptors the Loader face resolves through.
 */
export const stageWebPlugins = (delivery) => {
  if (delivery?.type !== 'web.plugins' || !Array.isArray(delivery.plugins) || delivery.plugins.length === 0) {
    throw new Error('web-boot: malformed web.plugins delivery (need plugins: [...])');
  }
  const files = {};
  for (const plugin of delivery.plugins) {
    for (const [path, file] of Object.entries(plugin.files ?? {})) {
      files[path] = { bytes: decodeB64(file.b64), mtimeMs: file.mtimeMs };
    }
  }
  const descriptors = delivery.plugins.map((plugin) => ({
    loaderName: plugin.loaderName,
    baseUrl: `${WEB_PLUGINS_ROOT}/`,
    pkgJsonPath: plugin.pkgJsonPath,
    entryFileURL: `file://${plugin.entryPath}`,
  }));
  if (delivery.chunked === true) {
    mergeWebPlugins(files);
    const accumulated = stagedDescriptorStore();
    accumulated.push(...descriptors);
    if (delivery.final !== true) {
      return { staged: false, plugins: descriptors };
    }
    return stagedDescriptorStore().slice();
  }
  seedWebPlugins(files);
  stagedDescriptorStore().splice(0);
  stagedDescriptorStore().push(...descriptors);
  return descriptors;
};

/**
 * Mount the VENDORED ClientModuleRegistry on `ctx` over the staged plugins.
 *
 * The loader face is the REAL cordis Loader service (boot.js mounts it on the
 * full-spine shape; the bare compose-only shape mounts it right here) — the
 * registry's documented v1 contract (`ctx.loader.entries()` +
 * `ctx.loader.internal.resolveSync`) is served by decorating that ONE service,
 * never by claiming the `loader` property a second time (cordis refuses the
 * second claim, which is what kept the presets service unmounted before the
 * unification):
 *   - `entries()` delegates to the real tree, then appends one row per STAGED
 *     web plugin — the shape the registry's scan reads (`options.name`, a
 *     non-undefined `fiber`, `disabled: false`, `parent.tree.ctx.baseUrl`).
 *     Staged web plugins are bus-delivered bundle views, not loader entries:
 *     no fiber is created and no module is imported for them.
 *   - `internal` is the v1 resolver over the staged descriptors
 *     (`resolveSync(specifier) → {url}`); `import` refuses loudly — the web
 *     runtime SERVES client bundles, it never executes loader rows.
 *
 * Returns { registry, graph, rows, manifest } — the composed wire and the
 * client-face cross-parse (a graph the vendored parser rejects can never be
 * served).
 */
export const mountClientModules = (ctx, plugins) => {
  if (plugins.length === 0) throw new Error('web-boot: no staged web plugins to compose');
  const byLoader = new Map(plugins.map((p) => [p.loaderName, p]));
  let loader = ctx.get('loader');
  if (loader === undefined) {
    // The bare compose-only shape (no spine mounted): the Loader constructor
    // self-provides the `loader` service synchronously — no fiber await needed.
    loader = new Loader(ctx, { baseUrl: `${WEB_PLUGINS_ROOT}/` });
  }
  if (loader.internal !== undefined) {
    throw new Error('web-boot: the loader service already carries an internal resolver'
      + ` (${typeof loader.internal}) — refusing to shadow it`);
  }
  loader.internal = {
    version: 'v1',
    resolveSync: (specifier) => {
      const plugin = byLoader.get(specifier);
      if (plugin === undefined) {
        throw new Error(`web-boot: resolveSync cannot map specifier '${specifier}'`);
      }
      return { url: plugin.entryFileURL };
    },
    import: (specifier) => {
      throw new Error(`web-boot: the staged web-plugin resolver does not import modules`
        + ` ('${specifier}') — client bundles are served, never executed, in the runtime`);
    },
  };
  const baseEntries = loader.entries.bind(loader);
  const stagedRows = plugins.map((p) => ({
    options: { name: p.loaderName },
    fiber: {}, // non-undefined: the staged view is composed (mounted), not pending
    disabled: false,
    parent: { tree: { ctx: { baseUrl: p.baseUrl } } },
  }));
  loader.entries = function* decoratedEntries() {
    yield* baseEntries();
    yield* stagedRows;
  };
  const registry = new ClientModuleRegistry(ctx);
  const graph = registry.graph();
  const manifest = parseBootManifest(graph); // loud on any wire violation
  const rows = bootInjections(graph);
  return { registry, graph, rows, manifest };
};

/** The `__DSH_CONNECTION_RECOVERY__` defaults, upstream recovery-config.ts. */
export const recoveryDefaults = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10000,
  generationReadyWarnMs: 3000,
  generationReadyTimeoutMs: 15000,
};

/**
 * Serialize the injection rows for the bus: upstream row shapes with the
 * `global` value JSON-encoded (the carrier's render splices it raw), `<`
 * escaped exactly like the upstream index renderer.
 */
export const serializeRows = (rows) => rows.map((row) => {
  if (row.kind === 'global') {
    const json = JSON.stringify(row.value).replaceAll('<', '\\u003c');
    return { kind: 'global', name: row.name, value: json };
  }
  return { ...row };
});

/** The `web.boot` bus message: rows + recovery + the staged plugin rows the
 * carrier's /plugins route serves revs from (the graph's own row objects). */
export const webBootMessage = (rows, graph) => ({
  type: 'web.boot',
  rows: serializeRows(rows),
  recovery: recoveryDefaults,
  plugins: graph.entries.map((entry) => ({ id: entry.id, rev: entry.rev, url: entry.url })),
  graph,
});

/** The /api endpoints this runtime answers for the official page. */
export const CLAIMED_ENDPOINTS = ['session.list'];

/**
 * The api.request handlers backed by the REAL vendored session store. The
 * full upstream API surface (packages/api/session-controller) is the desktop
 * composition's; the mobile profile answers the attached-store subset —
 * honest rows, structured failure never faked.
 */
export const createApiHandlers = (ctx) => ({
  'session.list': async () => {
    const summaries = [];
    for (const session of ctx.sessions.list()) {
      const running = ctx.agents.get(session.id)?.status === 'running';
      summaries.push({
        sessionId: session.id,
        updatedAt: session.header?.createdAt ?? 0,
        running: running === true,
        blank: session.seq === 0,
        ...(session.header?.cwd !== undefined ? { cwd: session.header.cwd } : {}),
      });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return { items: summaries };
  },
});

/** One journal wire frame per upstream session-log record. The envelope
 * passes through the event-local metadata the official client validates
 * (`ignorable` / `sourceEventSeqs` / the surface events' `surfaceOp`). */
const wireEvent = (record) => ({
  type: 'event',
  event: {
    type: record.type,
    seq: record.seq,
    time: record.time ?? 0,
    data: record.data ?? {},
    ...(record.ignorable === true ? { ignorable: true } : {}),
    ...(record.sourceEventSeqs === undefined ? {} :
      { sourceEventSeqs: record.sourceEventSeqs }),
    ...(record.surfaceOp === undefined ? {} : { surfaceOp: record.surfaceOp }),
  },
});

/** Resolve the attached session a journal open addresses, or post the
 * structured error frame and return null. */
const resolveJournalSession = (ctx, post, { streamId, endpoint, payload }) => {
  const args = payload?.args ?? {};
  const sessionId = args.address?.sessionId ?? args.sessionId;
  const session = sessionId !== undefined ? ctx.sessions.get(sessionId) : undefined;
  if (session !== undefined) return session;
  post({ type: 'mux.error', streamId, code: 'gateway/unavailable',
    message: `session ${JSON.stringify(sessionId ?? null)} is not attached to the mobile runtime`,
    details: { endpoint, sessionId: sessionId ?? null } });
  return null;
};

/** Attach one session/journal stream: baseline frames, then live records. */
const openJournalStream = (ctx, post, streams, { streamId, session }) => {
  for (const record of session.snapshotEvents()) {
    post({ type: 'mux.item', streamId, value: wireEvent(record) });
  }
  const unsubscribe = ctx.on('session/event', (updated, event) => {
    if (updated?.id !== session.id || event === undefined) return;
    post({ type: 'mux.item', streamId, value: wireEvent(event) });
  });
  streams.set(streamId, unsubscribe);
  return { kind: 'attached', sessionId: session.id };
};

/**
 * The mux stream handlers: one `session/journal` open attaches the REAL
 * session log in the upstream Remote-journal envelope (SessionEventEntry:
 * { type: 'event', event: {type, seq, time, data} }), baseline first, then
 * live records until cancel.
 */
export const createMuxHandlers = (ctx, post) => {
  const streams = new Map(); // streamId → unsubscribe
  return {
    open: (msg) => {
      if (msg.endpoint !== 'session/journal') {
        post({ type: 'mux.error', streamId: msg.streamId, code: 'gateway/unimplemented',
          message: `stream endpoint ${msg.endpoint} is not implemented by the mobile runtime`,
          details: { endpoint: msg.endpoint } });
        return { kind: 'error' };
      }
      const session = resolveJournalSession(ctx, post, msg);
      if (session === null) return { kind: 'error' };
      return openJournalStream(ctx, post, streams, { streamId: msg.streamId, session });
    },
    cancel: ({ streamId }) => {
      const unsubscribe = streams.get(streamId);
      if (unsubscribe !== undefined) {
        unsubscribe();
        streams.delete(streamId);
        post({ type: 'mux.end', streamId });
      }
      return { kind: unsubscribe === undefined ? 'unknown' : 'cancelled' };
    },
    dispose: () => {
      for (const [streamId, unsubscribe] of streams) {
        unsubscribe();
        streams.delete(streamId);
      }
    },
  };
};

/** The `web.plugins` delivery leg: seed the VFS, mount the vendored
 * composer, and post the boot wire + claims (the base set plus the write
 * surface's endpoints when composed with one). A non-final chunk of a
 * CHUNKED delivery only stages (the drive keeps delivering); the final
 * chunk — or a legacy single delivery — composes. */
const deliverWebPlugins = (ctx, post, msg, write, fullCoverage) => {
  const plugins = stageWebPlugins(msg);
  if (plugins.staged === false) {
    return { kind: 'staged', packages: plugins.plugins.length };
  }
  const { graph, rows } = mountClientModules(ctx, plugins);
  post(webBootMessage(rows, graph));
  const endpoints = write === null
    ? CLAIMED_ENDPOINTS
    : [...CLAIMED_ENDPOINTS, ...WRITE_ENDPOINTS,
       ...(fullCoverage === true ? COVERAGE_ENDPOINTS : [])];
  post({ type: 'api.claim', endpoints });
  post({ type: 'mux.claim' });
  return { kind: 'booted', entries: graph.entries.map((e) => e.id) };
};

/** The `api.request` leg: a claimed handler to run (the write surface's
 * first, then the base set), or a structured already-posted failure (not
 * composed / unimplemented endpoint). The handler runs with the request's
 * `args` (the frozen client-request payload's args object). */
const deliverApiRequest = (post, apiHandlers, write, mounted, msg) => {
  if (!mounted) {
    post({ type: 'api.respond', rpcId: msg.rpcId, result: {
      ok: false, error: { code: 'gateway/unavailable',
        message: 'the web boot is not composed yet', details: {} } } });
    return { kind: 'not-mounted' };
  }
  const handler = write?.api[msg.endpoint] ?? apiHandlers[msg.endpoint];
  if (handler === undefined) {
    post({ type: 'api.respond', rpcId: msg.rpcId, result: {
      ok: false, error: { code: 'gateway/unimplemented',
        message: `endpoint ${msg.endpoint} is not implemented by the mobile runtime`,
        details: { endpoint: msg.endpoint } } } });
    return { kind: 'unimplemented' };
  }
  const args = msg.payload?.args;
  return { kind: 'handler', run: () => handler(args) };
};

/**
 * The full bus-facing runtime half. `deliver` receives one JSON-serializable
 * message per runtime → host frame. Returns the host → runtime handler:
 * call it with every parsed bus delivery (web.plugins / api.request /
 * mux.open / mux.cancel). Unknown types answer loudly in the return value so
 * the caller can fail its drive.
 *
 * `options.write` (optional) composes the WRITE SURFACE (upstream/web-write.js):
 * `{root, provider, model}` — the profile container root for the seeded
 * workspace and the llm route new sessions select. Without it the runtime
 * claims exactly the b3 read surface (session.list + session/journal).
 */
/** The write surface from the write options (null on a bare compose boot).
 * The 插件 inventory's client-bundle plane reads the staged descriptors this
 * runtime composed (the delivery store; populated at composition). */
const mountWriteSurface = (ctx, post, write) => (write === undefined ? null
  : createWriteSurface(ctx, post, {
    ...write,
    stagedPlugins: () => stagedDescriptorStore(),
  }));

export const createWebBootRuntime = ({ ctx, post, write }) => {
  const apiHandlers = createApiHandlers(ctx);
  const mux = createMuxHandlers(ctx, post);
  // The coverage flag rides the write OPTIONS — the built surface does not
  // carry it, so read it here (the served claims were silently
  // coverage-free until measured on device 2026-09-24).
  const fullCoverage = write?.fullCoverage === true;
  const writeSurface = mountWriteSurface(ctx, post, write);
  let mounted = false;
  const deliver = (msg) => {
    switch (msg.type) {
      case 'web.plugins': {
        const outcome = deliverWebPlugins(ctx, post, msg, writeSurface, fullCoverage);
        mounted = true;
        return outcome;
      }
      case 'api.request':
        return deliverApiRequest(post, apiHandlers, writeSurface, mounted, msg);
      case 'mux.open': {
        if (!mounted) return { kind: 'not-mounted' };
        const claimed = writeSurface?.openStream(msg);
        return claimed ?? mux.open(msg);
      }
      case 'mux.cancel': {
        if (!mounted) return { kind: 'not-mounted' };
        // Coverage streams (workspaceFiles/changes) cancel through the write
        // surface's registry; unknown ids fall through to the base journal
        // map — the pre-coverage behavior, unchanged.
        const cancelled = writeSurface?.cancel?.(msg);
        return cancelled ?? mux.cancel(msg);
      }
      case 'agentPresets.seed': {
        // The host delivers the vendored presets tree (base64, the
        // web.plugins shape); the fs VFS is the only fs the walk sees. The
        // mobile composition disables its absent tool rows first — unpatched,
        // the health check marks them broken and 内置插件 answers 加载失败.
        const files = {};
        for (const [path, file] of Object.entries(msg.files ?? {})) {
          files[path] = { bytes: decodeB64(file.b64), mtimeMs: file.mtimeMs ?? 0 };
        }
        patchPresetSeedFiles(files);
        mergeWebPlugins(files);
        return { kind: 'seeded' };
      }
      default:
        return { kind: 'unknown', type: msg.type };
    }
  };
  return { deliver, dispose: () => { mux.dispose(); writeSurface?.dispose(); } };
};
