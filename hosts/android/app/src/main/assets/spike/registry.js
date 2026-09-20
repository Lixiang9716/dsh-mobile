/**
 * Spike service registry — the plugin mounting point the m2.session scenario
 * boots (the Harness core's real registry arrives with the upstream runtime;
 * this is the smallest thing that proves the plugin shape end to end).
 *
 * A plugin installs as { manifest, module }: the registry validates the
 * manifest statically (schemaVersion 1 shape, contract/data-protocols.md §2 —
 * reading it never executes code), then calls the declared activate hook with
 * a registration context. Service lookup fails loud on unknown names and
 * duplicate registration; capability NEGOTIATION stays the host gateway's
 * job — an install never probes availability, a call fails with the
 * contract's own error codes when the host lacks the primitive.
 */
import { createLogger } from 'logger.js';

const log = createLogger('dsh.registry');

/** Static manifest shape check (schemaVersion 1). Returns the problem or null. */
const manifestProblem = (m) => {
  log.debug('manifest check', { id: m?.id });
  if (!m || m.schemaVersion !== 1) return 'schemaVersion must be 1';
  if (typeof m.id !== 'string' || m.id.length < 3) return 'id missing';
  if (m.type !== 'service' && m.type !== 'web-client') return 'bad type';
  if (m.type === 'service' && typeof m.entry !== 'string') return 'service needs entry';
  if (!m.capabilities || !Array.isArray(m.capabilities.required)) {
    return 'capabilities.required missing';
  }
  return null;
};

export function createRegistry() {
  log.debug('registry created');
  const services = new Map();
  const ids = [];

  const register = (name, impl) => {
    log.debug('register', { name });
    if (services.has(name)) throw new Error(`service already registered: ${name}`);
    services.set(name, impl);
  };

  /** Resolved service reference — unknown names abort (fail loud). */
  const service = (name) => {
    log.debug('service lookup', { name });
    const impl = services.get(name);
    if (!impl) throw new Error(`service not installed: ${name}`);
    return impl;
  };

  return {
    register,
    /** Install one plugin {manifest, module}; activate hook may register.
     * The context carries `service` so an activating plugin can resolve
     * already-installed services (fail loud on unknown names). */
    install({ manifest, module }) {
      log.debug('install', { id: manifest?.id });
      const problem = manifestProblem(manifest);
      if (problem) throw new Error(`plugin manifest invalid (${manifest?.id}): ${problem}`);
      const hook = manifest.hooks?.activate ?? 'activate';
      const fn = module[hook];
      if (typeof fn !== 'function') throw new Error(`activate hook missing: ${manifest.id}`);
      fn({ register, manifest, service });
      ids.push(manifest.id);
    },
    service,
    /** Installed plugin ids, in install order. */
    pluginIds: () => ids.slice(),
  };
}
