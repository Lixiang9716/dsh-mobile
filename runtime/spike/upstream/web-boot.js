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
 *   - mountClientModules: a minimal Loader face (`entries()` +
 *     `internal.resolveSync`, the documented v1 contract) so the registry
 *     resolves staged packages without the cordis-plugin-loader disk Loader
 *     (the deliberate staged gap in runtime/spike/upstream/README.md).
 *   - createApiHandlers / createMuxHandlers: the /api claims the boot actually
 *     calls, answered from the REAL vendored services (ctx.sessions), with
 *     every other endpoint left to the carrier's structured unimplemented.
 */
import './web-shims.js';
// The VENDORED browser bootstrap bundle: registers its closure factory on
// the queue facade (same file the page's blocking bootstrap batch loads).
import '@deepseek-ai/dsh-client-modules/client';
import { seedWebPlugins, WEB_PLUGINS_ROOT } from 'upstream/shims/fs.js';
import {
  ClientModuleRegistry,
  bootInjections,
} from '@deepseek-ai/dsh-client-modules';

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

/**
 * Mount one `web.plugins` bus delivery into the fs VFS.
 * Delivery: { type: 'web.plugins', plugins: [{ loaderName, pkgJsonPath,
 * entryPath, files: { [absPath]: { b64, mtimeMs } } }] }.
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
  seedWebPlugins(files);
  return delivery.plugins.map((plugin) => ({
    loaderName: plugin.loaderName,
    baseUrl: `${WEB_PLUGINS_ROOT}/`,
    pkgJsonPath: plugin.pkgJsonPath,
    entryFileURL: `file://${plugin.entryPath}`,
  }));
};

/**
 * Mount the VENDORED ClientModuleRegistry on `ctx` over the staged plugins.
 * The registry reads `ctx.loader.entries()` and resolves rows through
 * `ctx.loader.internal.resolveSync` (v1: (specifier, baseUrl, attrs) → url).
 * Returns { registry, graph, rows, manifest } — the composed wire and the
 * client-face cross-parse (a graph the vendored parser rejects can never be
 * served).
 */
export const mountClientModules = (ctx, plugins) => {
  if (plugins.length === 0) throw new Error('web-boot: no staged web plugins to compose');
  const byLoader = new Map(plugins.map((p) => [p.loaderName, p]));
  ctx.loader = {
    entries: () => plugins.map((p) => ({
      options: { name: p.loaderName },
      fiber: {}, // non-undefined: mounted (the spike runtime mounts directly)
      disabled: false,
      parent: { tree: { ctx: { baseUrl: p.baseUrl } } },
    })),
    internal: {
      version: 'v1',
      resolveSync: (specifier) => {
        const plugin = byLoader.get(specifier);
        if (plugin === undefined) {
          throw new Error(`web-boot: resolveSync cannot map specifier '${specifier}'`);
        }
        return { url: plugin.entryFileURL };
      },
    },
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

/** One journal wire frame per upstream session-log record. */
const wireEvent = (record) => ({
  type: 'event',
  event: {
    type: record.type,
    seq: record.seq,
    time: record.time ?? 0,
    data: record.data ?? {},
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
 * composer, and post the boot wire + claims. */
const deliverWebPlugins = (ctx, post, msg) => {
  const plugins = stageWebPlugins(msg);
  const { graph, rows } = mountClientModules(ctx, plugins);
  post(webBootMessage(rows, graph));
  post({ type: 'api.claim', endpoints: CLAIMED_ENDPOINTS });
  post({ type: 'mux.claim' });
  return { kind: 'booted', entries: graph.entries.map((e) => e.id) };
};

/** The `api.request` leg: a claimed handler to run, or a structured
 * already-posted failure (not composed / unimplemented endpoint). */
const deliverApiRequest = (post, apiHandlers, mounted, msg) => {
  if (!mounted) {
    post({ type: 'api.respond', rpcId: msg.rpcId, result: {
      ok: false, error: { code: 'gateway/unavailable',
        message: 'the web boot is not composed yet', details: {} } } });
    return { kind: 'not-mounted' };
  }
  const handler = apiHandlers[msg.endpoint];
  if (handler === undefined) {
    post({ type: 'api.respond', rpcId: msg.rpcId, result: {
      ok: false, error: { code: 'gateway/unimplemented',
        message: `endpoint ${msg.endpoint} is not implemented by the mobile runtime`,
        details: { endpoint: msg.endpoint } } } });
    return { kind: 'unimplemented' };
  }
  return { kind: 'handler', run: handler };
};

/**
 * The full bus-facing runtime half. `deliver` receives one JSON-serializable
 * message per runtime → host frame. Returns the host → runtime handler:
 * call it with every parsed bus delivery (web.plugins / api.request /
 * mux.open / mux.cancel). Unknown types answer loudly in the return value so
 * the caller can fail its drive.
 */
export const createWebBootRuntime = ({ ctx, post }) => {
  const apiHandlers = createApiHandlers(ctx);
  const mux = createMuxHandlers(ctx, post);
  let mounted = false;
  const deliver = (msg) => {
    switch (msg.type) {
      case 'web.plugins': {
        const outcome = deliverWebPlugins(ctx, post, msg);
        mounted = true;
        return outcome;
      }
      case 'api.request':
        return deliverApiRequest(post, apiHandlers, mounted, msg);
      case 'mux.open':
        return mounted ? mux.open(msg) : { kind: 'not-mounted' };
      case 'mux.cancel':
        return mounted ? mux.cancel(msg) : { kind: 'not-mounted' };
      default:
        return { kind: 'unknown', type: msg.type };
    }
  };
  return { deliver, dispose: () => mux.dispose() };
};
