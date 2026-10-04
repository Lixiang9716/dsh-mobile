import { describe, it, expect, vi } from 'vitest';
import { makeProbeAwaiter } from 'scenario/probe-respond-await.js';
import { makePluginInventoryHandler } from 'upstream/web-write-inventory.js';

// loop-q: on the serving seats the settings probes' claimed handler for
// `pluginInventory/list` never answered — #334 gave the handler a GATEWAY
// await (the workspace registry tier), and on the device embedders the
// settle is queued behind the running native pump: it lands only when the
// JS job queue empties. The probe waiter spun pure microtasks (never empty
// the queue), so a correct handler starved, the scenario completed-fail,
// and every later bus frame re-reported the FAIL — 14,037 logcat lines on
// the battery seat. These cases pin the two halves: the waiter yields to
// host turns (a late respond is FOUND; a dead one fails loud at the
// deadline) and the claimed handler answers the frozen union shape.

const framesOf = (...frames) => frames;

describe('the probe respond waiter finds posted responds (loop-q)', () => {
  it('finds a respond frame that is already posted', async () => {
    const frames = framesOf({ type: 'api.respond', rpcId: 'probe/x-1', result: { ok: true, value: 7 } });
    const fail = vi.fn();
    const yieldTurn = vi.fn(async () => {});
    const awaitRespond = makeProbeAwaiter({ frames, fail, yieldTurn, timeoutMs: 200 });
    expect(await awaitRespond('probe/x-1')).toEqual({ ok: true, value: 7 });
    expect(fail).not.toHaveBeenCalled();
    expect(yieldTurn).not.toHaveBeenCalled();
  });
});

describe('the waiter yields to host turns before demanding (loop-q)', () => {
  it('finds a respond that lands only after host turns — the starvation regression', async () => {
    // The embedder shape: the settle cannot run until the waiter yields to
    // the host. Land it from the yieldTurn itself (a gateway ping's settle
    // queues the looper turn that also delivers the earlier fsRead settle) —
    // under the old pure-microtask spin this respond never appears before
    // the demand fires.
    const frames = [];
    const fail = vi.fn();
    const yieldTurn = async () => {
      frames.push({ type: 'api.respond', rpcId: 'probe/pluginInventory-list-1', result: { ok: true, value: { entries: [] } } });
    };
    const awaitRespond = makeProbeAwaiter({ frames, fail, yieldTurn, timeoutMs: 2000 });
    const result = await awaitRespond('probe/pluginInventory-list-1');
    expect(result.ok).toBe(true);
    expect(fail).not.toHaveBeenCalled();
  });

  it('fails loud naming the probe when the claimed handler never settles', async () => {
    const frames = [];
    const fail = vi.fn();
    const yieldTurn = vi.fn(async () => {});
    const awaitRespond = makeProbeAwaiter({ frames, fail, yieldTurn, timeoutMs: 20 });
    await expect(awaitRespond('probe/pluginManager-listPlugins-1')).rejects
      .toThrow(/no api.respond for the probe\/pluginManager-listPlugins-1 probe/);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][0]).toContain('the claimed handler never settled');
    expect(yieldTurn.mock.calls.length).toBeGreaterThan(0);
  });

  it('the gatewayless shape keeps the historical microtask budget and names it', async () => {
    const frames = framesOf({ type: 'api.respond', rpcId: 'probe/a-1', result: { ok: true } });
    const fail = vi.fn();
    const awaitRespond = makeProbeAwaiter({ frames, fail });
    expect(await awaitRespond('probe/a-1')).toEqual({ ok: true });
    const empty = makeProbeAwaiter({ frames: [], fail });
    await expect(empty('probe/absent-1')).rejects
      .toThrow(/no api.respond for the probe\/absent-1 probe/);
    expect(fail.mock.calls[0][0]).toContain('no gateway to yield the host with');
  });
});

describe('the settings yield shape survives a rejecting gateway ping (loop-y)', () => {
  it('keeps polling across a caught fsStat rejection and finds the late respond', async () => {
    // settings-surfaces' migrated yieldTurn (loop-y) is a fsStat ping on a
    // path that need not exist: its rejection is caught IN the yield and the
    // await still hands the looper its turn. The honest shape: the first ping
    // settles as a rejection, the answer lands with the second — a yield
    // that propagated its rejection would kill the wait before the respond
    // is ever found.
    const frames = [];
    let pings = 0;
    const fail = vi.fn();
    const yieldTurn = async () => {
      pings += 1;
      try {
        await Promise.reject(Object.assign(new Error('not-found'), { code: 'gateway/not-found' }));
      } catch {
        // denied/unavailable IS a settle — the looper turn is the point.
      }
      if (pings >= 2) {
        frames.push({ type: 'api.respond', rpcId: 'probe/pluginInventory-list-1',
          result: { ok: true, value: { entries: [] } } });
      }
    };
    const awaitRespond = makeProbeAwaiter({ frames, fail, yieldTurn, timeoutMs: 2000 });
    const result = await awaitRespond('probe/pluginInventory-list-1');
    expect(result.ok).toBe(true);
    expect(fail).not.toHaveBeenCalled();
    expect(pings).toBe(2);
  });
});

const bootedCtx = {
  get: (name) => name === 'agentPresets' ? {
    compositionInventory: async () => [
      {
        id: 'mobile', trust: 'trusted', isDefault: true,
        // A file-composition row: fiberState ABSENT (a null state is an
        // unknown cordis state — the mapper refuses it, rule 5).
        rows: [{ entryId: null, moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true }],
      },
      {
        id: 'standard', trust: 'trusted',
        rows: [{ entryId: 'agent-loop', moduleName: '@deepseek-ai/dsh-agent-loop', enabled: true, fiberState: 2 }],
      },
    ],
  } : undefined,
};
const handlerDeps = () => ({
  // The spine provider answers WIRE rows (boot.js spineInventory: the
  // fiberPhase is already the cordis state's wire word).
  spine: () => [
    { entryId: 'agent-loop', moduleName: '@deepseek-ai/dsh-agent-loop', enabled: true, fiberPhase: 'active' },
    { entryId: 'llm', moduleName: '@deepseek-ai/dsh-llm', enabled: true, fiberPhase: 'active' },
  ],
  stagedPlugins: () => [
    { loaderName: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory' },
  ],
  workspaceRegistry: async () => [
    { id: 'greeting', name: 'Greeting', enabled: true },
  ],
});

describe('the claimed pluginInventory/list handler answers (loop-q)', () => {
  it('answers the three-tier union with the wire-required fields', async () => {
    const snapshot = await makePluginInventoryHandler(bootedCtx, handlerDeps())({});
    expect(snapshot.managementAvailable).toBe(false);
    const ids = snapshot.entries.map((e) => e.entryId);
    expect(ids).toContain('agent-loop');
    expect(ids).toContain('@deepseek-ai/dsh-client-ui-settings-plugin-inventory');
    expect(ids).toContain('greeting');
    for (const entry of snapshot.entries) {
      expect(typeof entry.entryId).toBe('string');
      expect(typeof entry.moduleName).toBe('string');
      expect(typeof entry.enabled).toBe('boolean');
      expect(entry.fiberPhase).toBeDefined();
    }
  });

  it('normalizes the agentPresets plane onto the wire vocabulary', async () => {
    const snapshot = await makePluginInventoryHandler(bootedCtx, handlerDeps())({});
    // A file composition has no live fiber: fiberPhase null.
    const mobile = snapshot.agentPresets.find((p) => p.id === 'mobile');
    expect(mobile.isDefault).toBe(true);
    expect(mobile.rows[0].fiberPhase).toBeNull();
    // A mounted cordis row maps its fiber state onto the wire vocabulary.
    const standard = snapshot.agentPresets.find((p) => p.id === 'standard');
    expect(standard.rows[0].fiberPhase).toBe('active');
  });

  it('refuses loud when a wired provider breaks its contract', async () => {
    await expect(makePluginInventoryHandler(bootedCtx, { ...handlerDeps(), spine: () => 'not-an-array' })({}))
      .rejects.toThrow(/did not answer an array/);
    await expect(makePluginInventoryHandler(bootedCtx, { ...handlerDeps(), workspaceRegistry: async () => 42 })({}))
      .rejects.toThrow(/workspace registry provider did not answer an array/);
  });
});
