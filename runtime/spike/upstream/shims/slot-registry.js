// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/slot-registry.js — the SlotRegistry class, mirrored from the
 * vendored @deepseek-ai/dsh-client-ui-renderer bundle's registry region
 * (lib/types/client/registry.js inside lib/client.js): a cordis Service
 * ("slots") delegating to the vendored SlotCore (ui-slots owns registration
 * semantics, the declaration ledger, load-time validation, the unload
 * cascade), plus the instance axis and the root/scope publish faces. The
 * methods follow the vendored implementation verbatim where the runtime can
 * express them; the render/host faces exist so boot-order guards fail loud
 * with the vendored messages instead of TypeErrors. register/registerFactory
 * stay PROTOTYPE methods: the cordis service proxy binds `this.ctx` to the
 * CALLER's context at call time, which routes the effect (and the unload
 * cascade) into the caller's fiber — an instance arrow would freeze `this`
 * to the service's own root ctx.
 */
import { Service } from '@deepseek-ai/cordis';
import {
  SlotCore,
  StaleAuthorizationError,
  standardHookPropName,
} from '/vendor/npm/@deepseek-ai/dsh-client-ui-slots@0.1.6-alpha.2/lib/index.js';

const ROOT_INSTANCE_KEY = 'root';

class SlotAssemblyError extends Error {}

const copyUnique = (kind, target, values, finalProps, propNameOf) => {
  if (values === undefined) return;
  for (const [name, value] of Object.entries(values)) {
    const propName = propNameOf(name);
    if (finalProps.has(propName)) {
      throw new Error(`duplicate root standard ${kind} '${name}' at prop '${propName}'`);
    }
    finalProps.add(propName);
    target[name] = value;
  }
};

const requireScopeKey = (definition, binding) => {
  if (binding === undefined) {
    throw new Error(`${definition.scope} factory store resolution requires a session id`);
  }
  return binding.key;
};

class SlotRegistryImpl extends Service {
  _core = new SlotCore();
  _stores = new Map();
  _factoryStores = new Map();
  _storeScopeOwners = new Map();
  _renderer = undefined;
  _locale = undefined;
  _host = undefined;
  _rootContributions = [];
  _rootListeners = new Set();
  _rootBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
  _rootSource = {
    getSnapshot: () => this._rootBinding,
    subscribe: (listener) => {
      this._rootListeners.add(listener);
      return () => this._rootListeners.delete(listener);
    },
  };
  _scopes = new Map();
  _scopeRevision = 0;
  _scopeListeners = new Set();
  _scopeRevisionSource = {
    getSnapshot: () => this._scopeRevision,
    subscribe: (listener) => {
      this._scopeListeners.add(listener);
      return () => this._scopeListeners.delete(listener);
    },
  };

  constructor(ctx) {
    super(ctx, 'slots');
    this._core.onMutate((key) => {
      ctx.emit('slots/changed', key);
    });
  }

  /** Effect-per-declaration-lifetime (the vendored inject): the controller
   * belongs to the caller's fiber, so plugin unload cancels a pending wait. */
  inject(key, callback) {
    const ctx = this.ctx;
    const disposeController = ctx.effect(() => {
      let active;
      let activeEpoch;
      let stopped = false;
      let unsubscribe = () => {};
      const stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        const dispose = active;
        active = undefined;
        activeEpoch = undefined;
        dispose?.();
      };
      const reconcile = () => {
        if (stopped) return;
        const spec = this._core.specDynamic(key);
        const epoch = this._core.declarationEpoch(key);
        if (active !== undefined && activeEpoch === epoch) return;
        const dispose = active;
        active = undefined;
        activeEpoch = undefined;
        dispose?.();
        if (spec === undefined) return;
        const disposeEffect = ctx.effect(callback, `slots.inject(${JSON.stringify(key)}): declaration`);
        active = () => disposeEffect();
        activeEpoch = epoch;
      };
      const changed = () => {
        try {
          reconcile();
        } catch (error) {
          stop();
          if (error?.code !== 'INACTIVE_EFFECT') {
            const failure = error instanceof Error ? error : new Error(String(error));
            queueMicrotask(() => { throw failure; });
          }
        }
      };
      unsubscribe = this._core.subscribeDeclaration(key, changed);
      try {
        reconcile();
      } catch (error) {
        stop();
        throw error;
      }
      return stop;
    }, `slots.inject(${JSON.stringify(key)})`);
    return () => disposeController();
  }

  install(renderer) {
    if (this._renderer !== undefined) throw new Error('slot renderer already installed (install() is boot-once)');
    this.ctx.effect(() => {
      this._renderer = renderer;
      return () => {
        if (this._renderer === renderer) this._renderer = undefined;
      };
    }, 'slots.install()');
  }

  installLocale(face) {
    if (this._locale !== undefined) throw new Error('locale face already installed (installLocale() is boot-once)');
    this.ctx.effect(() => {
      this._locale = face;
      return () => {
        if (this._locale === face) this._locale = undefined;
      };
    }, 'slots.installLocale()');
  }

  provideRoot(contribution) {
    const dispose = this.ctx.effect(() => {
      this._rootContributions.push(contribution);
      try {
        this.rebuildRootBinding();
      } catch (error) {
        this._rootContributions.pop();
        throw error;
      }
      return () => {
        const index = this._rootContributions.indexOf(contribution);
        if (index === -1) return;
        this._rootContributions.splice(index, 1);
        this.rebuildRootBinding();
      };
    }, 'slots.provideRoot()');
    return () => dispose();
  }

  installScope(scope, adapter) {
    if (this._scopes.has(scope)) throw new Error(`slot scope '${scope}' already has an adapter`);
    this.ctx.effect(() => {
      this._scopes.set(scope, adapter);
      this.publishScopeRevision();
      return () => {
        if (this._scopes.get(scope) === adapter) {
          this._scopes.delete(scope);
          this.publishScopeRevision();
        }
      };
    }, `slots.installScope(${JSON.stringify(scope)})`);
  }

  bindStoreScope(binding) {
    if (this._storeScopeOwners.get(binding.key) === binding.ctx) return;
    this._storeScopeOwners.set(binding.key, binding.ctx);
    binding.ctx.effect(() => () => {
      if (this._storeScopeOwners.get(binding.key) !== binding.ctx) return;
      this._storeScopeOwners.delete(binding.key);
      this.releaseStoreScope(binding.key);
    }, `slots: store scope ${binding.key}`);
  }

  renderSlot(key, owner) {
    if (key !== 'root') {
      throw new Error(`ctx-level renderSlot only renders 'root' (got "${key}"); child slots render through the component props face`);
    }
    if (this._renderer === undefined) {
      throw new Error("slot renderer not installed — boot must call ctx.slots.install(createSlotRenderer()) before rendering 'root'");
    }
    if (this._core.entries('root').length === 0) {
      throw new Error("'root' has no registration — a layout entry must register into 'root' before the shell renders it");
    }
    return this._renderer.renderRoot(this.hostFace(), owner);
  }

  entries(key) { return this._core.entries(key); }
  entriesOfSlot(key) { return this._core.entriesOfSlot(key); }
  snapshot(root) { return this._core.snapshot(root); }
  onEntryError(fn) { return this._core.onEntryError(fn); }
  spec(key) { return this._core.spec(key); }
  subscribe(key, fn) { return this._core.subscribe(key, fn); }
  getVersion(key) { return this._core.getVersion(key); }

  _register(options, component) {
    const store = typeof options.store === 'function' ? options.store() : options.store;
    const registrant = options.registrant ?? this.ctx.fiber?.name;
    const erased = {
      ...options,
      ...(store !== undefined ? { store } : {}),
      ...(registrant !== undefined ? { registrant } : {}),
    };
    const dispose = this._core.register(erased, component);
    if (store !== undefined) {
      const scope = this._core.specDynamic(options.name).scope;
      this._acquire(store, scope);
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      dispose();
      if (store !== undefined) this._release(store);
    };
  }

  _registerFactory(options, component) {
    const registrant = this.ctx.fiber?.name;
    const erased = {
      ...options,
      ...(registrant === undefined ? {} : { registrant }),
    };
    const dispose = this._core.registerFactory(erased, component);
    const definition = this._core.factory(options.name);
    if (definition === undefined) throw new Error(`slot factory "${options.name}" disappeared during registration`);
    if (definition.store !== undefined && typeof definition.store !== 'function') {
      this._acquire(definition.store, definition.scope);
    } else if (typeof definition.store === 'function') {
      this._factoryStores.set(definition, { occurrences: new WeakMap(), mounted: new Map() });
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      dispose();
      this._factoryStores.delete(definition);
      if (definition.store !== undefined && typeof definition.store !== 'function') {
        this._release(definition.store);
      }
    };
  }

  hostFace() {
    if (this._host !== undefined) return this._host;
    const service = this;
    this._host = {
      subscribe: (key, fn) => this._core.subscribe(key, fn),
      getVersion: (key) => this._core.getVersion(key),
      entriesOf: (key) => this._core.entries(key),
      entriesOfSlot: (key) => this._core.entriesOfSlot(key),
      reportEntryError: (key, entry, error, info) => this._core.reportEntryError(key, entry, error, info),
      reportFactoryError: (name, registration, error) => this._core.reportFactoryError(name, registration, error),
      specOf: (key) => this._core.specDynamic(key),
      isLive: (entry) => this._core.isLive(entry),
      storeOf: (entry, scopeBinding) => (entry.store === undefined ? undefined : this.resolveStore(entry.store, scopeBinding)),
      factoryStoreOf: (definition, scopeBinding, occurrence) => this.resolveFactoryStore(definition, scopeBinding, occurrence),
      retainFactoryOccurrence: (definition, occurrence) => this.retainFactoryOccurrence(definition, occurrence),
      subscribeFactory: (name, fn) => this._core.subscribeFactory(name, fn),
      getFactoryVersion: (name) => this._core.factoryVersion(name),
      factoryOf: (name) => this._core.factory(name),
      isFactoryLive: (definition) => this._core.isFactoryLive(definition),
      root: this._rootSource,
      scopeRevision: this._scopeRevisionSource,
      scope: (scope) => service._scopes.get(scope === 'session-maybe' ? 'session' : scope),
      get locale() { return service._locale; },
    };
    return this._host;
  }

  rebuildRootBinding() {
    const hooks = {};
    const keyedHooks = {};
    const props = {};
    const finalProps = new Set();
    for (const contribution of this._rootContributions) {
      copyUnique('hook', hooks, contribution.hooks, finalProps, standardHookPropName);
      copyUnique('keyed hook', keyedHooks, contribution.keyedHooks, finalProps, standardHookPropName);
      copyUnique('prop', props, contribution.props, finalProps, (name) => name);
    }
    this._rootBinding = { key: undefined, hooks, keyedHooks, props };
    for (const listener of [...this._rootListeners]) {
      try { listener(); } catch { /* one subscriber's throw must not stop the publish */ }
    }
  }

  publishScopeRevision() {
    this._scopeRevision += 1;
    for (const listener of [...this._scopeListeners]) {
      try { listener(); } catch { /* same publish isolation as the root face */ }
    }
  }

  resolveStore(handle, scopeBinding) {
    const record = this._stores.get(handle);
    if (record === undefined) throw new Error('store handle is not registered (entry unloaded, or the handle never went through register)');
    let key;
    if (record.scope === 'root') {
      key = ROOT_INSTANCE_KEY;
    } else {
      if (scopeBinding === undefined) throw new Error(`${record.scope} store resolution requires a session id`);
      key = scopeBinding.key;
      this.bindStoreScope(scopeBinding);
    }
    let instance = record.instances.get(key);
    if (instance === undefined) {
      instance = record.scope === 'root' ? handle.create() : handle.create(key);
      record.instances.set(key, instance);
    }
    return instance;
  }

  resolveFactoryStore(definition, scopeBinding, occurrence) {
    if (!this._core.isFactoryLive(definition)) {
      throw new StaleAuthorizationError(`slot factory "${definition.name}" is not registered`);
    }
    const declaration = definition.store;
    if (declaration === undefined) return undefined;
    if (typeof declaration !== 'function') return this.resolveStore(declaration, scopeBinding);
    const axis = this._factoryStores.get(definition);
    const scopeKey = definition.scope === 'root' ? ROOT_INSTANCE_KEY : requireScopeKey(definition, scopeBinding);
    if (scopeBinding !== undefined && definition.scope !== 'root') this.bindStoreScope(scopeBinding);
    let record = axis.occurrences.get(occurrence);
    if (record === undefined) {
      const handle = declaration();
      if (handle.spec.persist !== undefined) {
        throw new SlotAssemblyError(`exclusive store for factory "${definition.name}" cannot declare persistence`);
      }
      record = { handle, instances: new Map(), retainers: 0 };
      axis.occurrences.set(occurrence, record);
    }
    const existing = record.instances.get(scopeKey);
    if (existing !== undefined) return existing;
    const instance = definition.scope === 'root' || scopeBinding === undefined
      ? record.handle.create()
      : record.handle.create(scopeBinding.key);
    record.instances.set(scopeKey, instance);
    return instance;
  }

  retainFactoryOccurrence(definition, occurrence) {
    if (!this._core.isFactoryLive(definition)) return () => {};
    if (typeof definition.store !== 'function') return () => {};
    const axis = this._factoryStores.get(definition);
    const record = axis.occurrences.get(occurrence);
    record.retainers += 1;
    axis.mounted.set(occurrence, record);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      record.retainers -= 1;
      if (record.retainers !== 0) return;
      axis.mounted.delete(occurrence);
    };
  }

  releaseStoreScope(key) {
    for (const record of this._stores.values()) {
      if (record.scope === 'root') continue;
      record.instances.delete(key);
    }
    for (const axis of this._factoryStores.values()) {
      for (const record of axis.mounted.values()) record.instances.delete(key);
    }
  }

  _acquire(handle, scope) {
    const record = this._stores.get(handle);
    if (record === undefined) {
      this._stores.set(handle, { scope, refs: 1, instances: new Map() });
      return;
    }
    record.refs += 1;
  }

  _release(handle) {
    const record = this._stores.get(handle);
    if (record === undefined) return;
    record.refs -= 1;
    if (record.refs !== 0) return;
    this._stores.delete(handle);
  }
}

SlotRegistryImpl.prototype.register = function register(rawOptions, component) {
  const options = rawOptions;
  return this.ctx.effect(() => this._register(options, component), 'slots.register()');
};
SlotRegistryImpl.prototype.registerFactory = function registerFactory(rawOptions, component) {
  const options = rawOptions;
  return this.ctx.effect(() => this._registerFactory(options, component), 'slots.registerFactory()');
};

export default SlotRegistryImpl;
export { SlotRegistryImpl as SlotRegistry };
