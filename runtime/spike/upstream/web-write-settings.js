// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-settings.js — the settings legs of the WRITE SURFACE
 * (decision D9, W-RPC leg): the settings-controller surface the official
 * page drives at boot and in its onboarding flow, answered by the REAL
 * vendored settings service. The mobile `ui-onboarding` namespace (the
 * product-wide GUI onboarding facts the page persists) is registered with a
 * REAL schemastery schema, mirroring the desktop web composition's host
 * rows; writes commit to the volatile in-memory provider (the durable
 * settings file is the staged gap). Failures stay loud: a missing provider
 * is a RemoteError, not a silent empty answer.
 */
import Schema from '@deepseek-ai/schemastery';

/** One registered namespace → the wire namespaceView (the controller's
 * own descriptor shape: ns/schema/value/base?/user?/applies/secrets/
 * revision). */
export const wireNamespaceView = (d) => ({
  ns: String(d.ns),
  schema: d.schema,
  value: d.value,
  ...(d.base === undefined ? {} : { base: d.base }),
  ...(d.user === undefined ? {} : { user: d.user }),
  applies: d.applies,
  secrets: (d.secrets ?? []).map((sec) => ({ path: [...sec.path], set: sec.set })),
  revision: d.revision,
});

/** Memoized registration of the namespaces the OFFICIAL web composition
 * registers host side. The acknowledgement write lands only after this
 * resolves, so every settings call awaits it first. */
export const makeNamespaceGuard = (ctx) => {
  let ready = null;
  const register = () => ctx.plugin({
    name: 'mobile web composition settings namespaces (ui-onboarding)',
    async apply(fiberCtx) {
      const settings = fiberCtx.get('settings');
      settings?.register('ui-onboarding',
        Schema.object({ welcomeNoticeVersion: Schema.string() }));
    },
  }).then(() => undefined);
  return () => {
    ready ??= register();
    return ready;
  };
};

/** The REAL provider describe, mapped through the upstream namespaceView:
 * writable/hasDocument report the provider truth (in-memory: writable, no
 * document) and namespaces list every registered section. */
export const makeDescribeSettings = (ctx, ensureNamespaces) => async () => {
  await ensureNamespaces();
  const settings = demandSettings(ctx);
  const namespaces = settings.describe({ redactSecrets: true })
    .map(wireNamespaceView);
  return {
    writable: settings.writable === true,
    hasDocument: settings.documentPath !== undefined,
    namespaces,
  };
};

/** One claimed settings-write endpoint (update/mutate): run the vendored
 * write, then answer with the namespace's wire view. */
export const makeSettingsWrite = (ctx, ensureNamespaces, run) => async (args) => {
  await ensureNamespaces();
  const settings = demandSettings(ctx);
  await run(settings, args);
  const descriptor = settings.describe({ redactSecrets: true })
    .find((d) => d.ns === String(args.ns));
  return wireNamespaceView(descriptor);
};

/** The mounted settings provider, or a loud RemoteError (the literal triple
 * keeps this module free of the web-write import cycle; errorOf maps it). */
const demandSettings = (ctx) => {
  const settings = ctx.get('settings');
  if (settings === undefined) {
    throw { remote: true, code: 'gateway/unavailable',
      message: 'no settings provider is mounted', details: {} };
  }
  return settings;
};
