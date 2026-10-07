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
import {
  workspaceRegistryPath, readWorkspaceRegistryDoc,
} from 'workspace-registry.js';

const log = createLogger('b4.web');

/** The workspace registry provider for the 插件 inventory's workspace tier:
 * the dsh.plugins/1 registry the agent self-installs into during creation
 * turns — read from the WORKSPACE's own file. #346: the registry lives at
 * `<containerRoot>/plugins/registry.json`, which on a real device seat is
 * BELOW the app scope's root (Android: `dsh/plugins/registry.json`
 * under `profiles/default/`) — the pre-#346 bare `plugins/registry.json`
 * spelling named the app scope root and degraded the tier to empty on
 * every real seat. The path derives from the boot config (injected: the
 * panel suite asserts the derivation) via the shared registry module.
 * The tier is advisory: ANY failure here degrades to an empty tier with a
 * warn — a throw rides the handler into the serial runtime thread and
 * wedges the spine (the #312 lesson). warn survives the release L4 strip,
 * so the reason stays loud; a plain missing file is the fresh roster (the
 * normal pre-creation state) and stays quiet. */
export const readWorkspaceRegistry = async (cfg = {}) => {
  const path = workspaceRegistryPath(cfg);
  const gw = await import('gateway.js');
  const read = await readWorkspaceRegistryDoc({ fsRead: gw.fsRead, path });
  if (read.ok) return read.plugins;
  if (read.code !== 'io') {
    log.warn('workspace registry tier degraded', { path, error: read.message });
  }
  return [];
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
  // The workspace registry's gateway path, derived ONCE from the boot
  // config and injected into every face that reads the document: the LIST
  // provider below AND the pluginManager WRITE legs (#346 — the write
  // legs' bare spelling named the app scope root, so an install's roster
  // adoption landed beside the §4 trees while the tier read the root).
  registryPath: workspaceRegistryPath({
    containerRoot: cfg.containerRoot,
    scopeRoot: cfg.fsScopeRoot,
  }),
  spine: () => spineInventory(ctx), // the 插件 inventory's spine plane: REAL mounts from ctx
  workspaceRegistry: () => readWorkspaceRegistry({ // the one-sentence-creation tier (read-only)
    containerRoot: cfg.containerRoot,
    scopeRoot: cfg.fsScopeRoot,
  }),
});
