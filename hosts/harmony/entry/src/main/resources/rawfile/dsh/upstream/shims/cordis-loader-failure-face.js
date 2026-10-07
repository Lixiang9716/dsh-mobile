// dsh:logging-exempt (shim layer; prototype overlay, no logging surface)

/**
 * shims/cordis-loader-failure-face.js — the cordis-plugin-loader FAILURE FACE
 * aligned to the published 1.0.4 semantics, layered over the vendored 1.0.3
 * lib without touching a vendored byte (D6).
 *
 * WHY: the staged dsh-tests@dsh-v0.1.6-alpha.2 corpus was cut against the
 * deepseek-harness monorepo's vendor/loader at its 1.0.4 revision (npm
 * `latest` moved on to 1.0.5 with an IDENTICAL lib — diffed 2026-09-29,
 * registry.npmjs.org), while our vendor pin is 1.0.3. The 1.0.3 lib reports
 * failed loader entries by THROWING from `EntryGroup.update` — an
 * AggregateError "loader entries failed to apply" — after DELETING the failed
 * entries (rollback) and wrapping every cause in `updateError`. The 1.0.4
 * lib (and therefore the specs) reports them instead:
 *   - `EntryGroup.update` logs each row failure and resolves; the group's
 *     data becomes the requested composition either way (1.0.4 lib, lines
 *     88-104);
 *   - a failed create leaves the entry in the tree store (no rollback), with
 *     its options committed, so the inactive-row reporter can name it
 *     (`agent-presets` inactiveRows reads entry.options.id/name);
 *   - `Entry._init` assigns the RAW fiber WITHOUT awaiting it, so a throwing
 *     apply keeps the fiber attached to its entry and its RAW error (string
 *     or AggregateError) surfaces through `fiber.await()` — mountDetail
 *     renders the per-row detail lines; an import failure stays LOUD (1.0.3
 *     propagation — see the Entry._init comment below for the measured
 *     reason the 1.0.4 silent variant is not portable to this runtime);
 *   - `EntryTree.await` waits for pending tasks only; per-entry failures are
 *     the inactive-row surfaces' business, never an aggregate throw.
 *
 * The agent-presets mount.spec arms drive exactly this contract:
 * `ctx.loader.root.update([...])` must resolve and `inactiveRows(loader)`
 * must name every failed row ("reports import failures and arbitrary plugin
 * rejections after eager settlement", "names every failed row", "names the
 * rows inside a failed group").
 *
 * SCOPE (why this is a face transplant and not a re-pin): a full 1.0.4
 * `Entry.update` needs cosmokit's `volatileEntries`/`updateVolatile`, absent
 * from our pinned cosmokit@1.8.3 (exports diffed 2026-09-29), so the
 * running-fiber update path (volatile config commit) KEEPS the 1.0.3
 * machinery. Only the failure face is 1.0.4. Re-pinning the loader package
 * is a vendor operation owned outside this file (tarballs + pin tables +
 * three host embed lists).
 *
 * TRIGGER (this file is imported from the `@deepseek-ai/cordis` row in
 * runtime-modules.js): the patches must land before the first Loader
 * construction (plugin apply / spec bodies) but cannot run synchronously at
 * THIS module's evaluation — when the first cordis import arrives THROUGH
 * the loader lib itself (spec → npm-bridges loader row → vendored lib →
 * cordis → here), the lib's class bindings are still mid-evaluation (TDZ)
 * and a static patch would crash. A microtask runs only after the whole
 * import graph of the current evaluation job has settled — the classes are
 * live by then, no Loader instance exists yet (every construction site is
 * runtime code, not module scope), and the dynamic import re-imports the
 * same cached module the npm-bridges row subclasses. Patches are idempotent
 * assignments; the module evaluates once per runtime.
 *
 * Every patch below is transcribed from the published
 * @deepseek-ai/cordis-plugin-loader@1.0.4 lib/index.js (pulled from
 * registry.npmjs.org, 2026-09-29) and probe-verified against the vendored
 * 1.0.3 bytes on real node v24.14.0 (/tmp/mount-probe: the mount.spec
 * eager-settlement inputs, a two-refusing-rows composition, and a
 * nested-broken group composition all render the spec-expected lines).
 */

const LOADER_LIB = '/vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js';

/** Patch EntryGroup (create/update — 1.0.4 faces; module level for size):
 * create has no rollback (a failed create leaves the entry in the store for
 * the surfaces that report it — 1.0.4 lib, lines 30-37); update logs
 * per-row failures without aggregating or throwing — the group's data
 * becomes the requested composition either way. The duplicate-id TypeError
 * is 1.0.3's own (1.0.4 dropped it) and is kept: no staged spec drives the
 * case, and it fails loud on malformed input (gov rule 5). (1.0.4 lib,
 * lines 88-104.) */
const patchEntryGroup = ({ Entry, EntryGroup }) => {
  EntryGroup.prototype.create = async function (options) {
    const id = this.tree.ensureId(options);
    const entry = this.tree.store[id] ?? (this.tree.store[id] = new Entry(this.ctx.loader));
    entry.parent = this;
    await entry.update(options, true, true);
    return entry.id;
  };
  EntryGroup.prototype.update = async function (config) {
    const oldConfig = this.data;
    const seen = new Set();
    for (const options of config) {
      const id = this.tree.ensureId(options);
      if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`);
      seen.add(id);
    }
    this.data = config;
    const oldMap = Object.fromEntries(oldConfig.map((options) => [options.id, options]));
    const newMap = Object.fromEntries(config.map((options) => [options.id, options]));
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap });
    await Promise.all(ids.map(async (id) => {
      if (newMap[id]) await this.create(newMap[id]).catch((error) => {
        this.ctx.logger.error(error);
      });
      else await this.remove(id);
    }));
  };
};

/** Patch Entry (update/init/_init — 1.0.4 faces; module level for size):
 * update is surgical (on a FAILED fresh-row create the 1.0.3 lib restores
 * entry.options to the pre-create value; 1.0.4 leaves the requested options
 * committed — the inactive-row reporter reads options.id/name of rows that
 * never started; 1.0.4 lib, lines 355-372); init resolves once the import
 * task settles with the failure on the fiber (1.0.4 lib, lines 433-444);
 * _init assigns the RAW fiber without awaiting it so a throwing apply keeps
 * the fiber attached — import failures stay LOUD (1.0.3) because the 1.0.4
 * silent variant leaves fiber-less rows whose dependants then hang waiting
 * on fiber-driven events (typert-loader's flush — measured 2026-09-29). */
const patchEntry = ({ Entry }) => {
  const entryUpdate = Entry.prototype.update;
  Entry.prototype.update = async function (options, create = false, force = false) {
    if (!create || this.fiber?.uid) return entryUpdate.call(this, options, create, force);
    try {
      return await entryUpdate.call(this, options, create, force);
    } catch (error) {
      this.options = options;
      throw error;
    }
  };
  Entry.prototype.init = async function () {
    try {
      await (this._initTask ??= this._init());
    } finally {
      this._initTask = void 0;
    }
    const notify = () => {
      if (this.loader.getTasks().length) return;
      this.ctx.reflect.notify(["loader"]);
    };
    this.fiber?.await().then(notify, notify);
  };
  // Entry._init — 1.0.4 SUCCESS-path shape: the RAW fiber is assigned
  // WITHOUT awaiting it, so a throwing apply keeps the fiber attached to its
  // entry and its RAW error (string or AggregateError) surfaces through
  // fiber.await() — mountDetail renders the per-row detail lines. An import
  // failure keeps 1.0.3's LOUD propagation (1.0.4 itself logs-and-returns;
  // see the header for why the silent variant is not portable here): rows
  // whose import fails are still retained and reported through the group
  // update's catch, which is the face the mount.spec family reads.
  Entry.prototype._init = async function () {
    const exports = await this.parent.tree.import(this.options.name, this.getOuterStack);
    const plugin = this.loader.unwrapExports(exports);
    this._patchContext([]);
    this.loader.showLog(this, "apply");
    this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber;
  };
};

/** Patch EntryTree.await (1.0.4): wait for pending tasks only; per-entry
 * failures are the inactive-row surfaces' business, never an aggregate
 * throw. (1.0.4 lib, lines 151-157.) */
const patchEntryTree = ({ EntryTree }) => {
  EntryTree.prototype.await = async function () {
    while (true) {
      const tasks = this.getTasks();
      if (!tasks.length) return;
      await Promise.allSettled(tasks);
    }
  };
};

queueMicrotask(async () => {
  const loaderLib = await import(LOADER_LIB);
  patchEntryGroup(loaderLib);
  patchEntry(loaderLib);
  patchEntryTree(loaderLib);
});
