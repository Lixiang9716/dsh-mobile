// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * scenario/write-surface-options.js — the write-surface options assembly for
 * composer-web-live (split at the file-size gate): the `write` options object
 * the resident runtime half composes, plus the workspace registry provider
 * that feeds the 插件 inventory's workspace tier.
 */
import { createLogger } from 'logger.js';
import { spineInventory } from 'upstream/boot.js';
import { errorOf } from 'upstream/web-write.js';

const log = createLogger('b4.web');

/** The workspace registry provider for the 插件 inventory's workspace tier:
 * the dsh.plugins/1 registry the agent self-installs into during creation
 * turns. The tier is advisory: ANY failure here degrades to an empty tier
 * with a warn — a throw rides the handler into the serial runtime thread and
 * wedges the spine (the #312 lesson). warn survives the release L4 strip, so
 * the reason stays loud. */
export const readWorkspaceRegistry = async () => {
  const { decodeUtf8 } = await import('node:buffer');
  const gw = await import('gateway.js');
  try {
    const raw = await gw.fsRead('app', 'plugins/registry.json');
    const doc = JSON.parse(decodeUtf8(raw.bytes));
    if (doc?.version !== 1 || !Array.isArray(doc.plugins)) {
      throw new Error('not a dsh.plugins/1 document');
    }
    return doc.plugins;
  } catch (err) {
    if (err?.code !== 'io') log.warn('workspace registry tier degraded', { error: errorOf(err) });
    return [];
  }
};

/** The `write` options object for createWebBootRuntime (web-boot.js). */
export const writeSurfaceOptions = (cfg, ctx, route) => ({
  root: cfg.containerRoot,
  fullCoverage: cfg.fullCoverage === true,
  provider: route.provider,
  model: route.model,
  models: route.models, // the staged roster (llm-route.js); absent on mock/byok routes
  baseURL: route.baseURL,
  routeKind: route.kind,
  // The seat's config-file opt-in (profiles/default/marketplace/config.json): marketplaceIndex names the resolver index — the same {indexUrl} option, no host-side key pin (the resolver's declared-gap trust mode). An explicit cfg.marketplace object (below) wins over it.
  ...(cfg.marketplaceIndex === undefined ? {} : { marketplace: { indexUrl: cfg.marketplaceIndex } }),
  // Marketplace opt-in (web-write-marketplace.js), relayed verbatim when the seat stages it; absent → unclaimed.
  ...(cfg.marketplace === undefined ? {} : { marketplace: cfg.marketplace }),
  spine: () => spineInventory(ctx), // the 插件 inventory's spine plane: REAL mounts from ctx
  workspaceRegistry: () => readWorkspaceRegistry(), // the one-sentence-creation tier (read-only)
});
