// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * composer-web-live.js — the ON-DEVICE SESSION-WRITE runtime half behind
 * composer.live-write (decision D9, the W-RPC leg): the upstream spine answers
 * the official app's WRITE surface. The composer send is `POST
 * /api/session/prompt` (frozen envelope, args.request {requestId, sessionId,
 * mode, content}); the reply streams back over the mux `session/follow` journal
 * (snapshot opening frame → live event entries → assistant-stream notification
 * frames with monotonic revisions). This scenario boots the FULL spine, mounts
 * the web-boot producer COMPOSED WITH THE WRITE SURFACE (upstream/web-write.js —
 * real session/create + prompt admission + the follow streams + the settings
 * describe + the workspace feed over the profile container), and then goes
 * RESIDENT: the page's own composer message drives a REAL upstream agent-loop
 * turn — nothing here pre-plays it.
 * LLM boundary (determinism): the transport is the REAL gateway adapter over
 * gateway httpFetch, pointed at the carrier's loopback SCRIPTED
 * chat-completions endpoint (real HTTP + SSE, scripted model output) — same
 * boundary as b3.
 *
 * bus (all dispatches onto the one serial runtime queue):
 *   host → runtime : runtime.config {mockLlmUrl, apiKey, containerRoot},
 *                    web.plugins, api.request, mux.open, mux.cancel
 *   runtime → host : web.boot, api.claim, mux.claim, api.respond,
 *                    mux.item | mux.error | mux.end
 */
import { createLogger } from 'logger.js';
import { bootUpstream, spineInventory } from 'upstream/boot.js';
import { createWebBootRuntime } from 'upstream/web-boot.js';
import { WRITE_ENDPOINTS, WRITE_STREAMS, errorOf } from 'upstream/web-write.js';
import { resolveLlmRoute as sharedResolveLlmRoute, bootRouteOf, registerBootRouteFactory } from 'upstream/llm-route.js';
import { writeSurfaceOptions } from 'scenario/write-surface-options.js';
import { probeManagerLegs as probeManagerLegsShared } from 'scenario/manager-legs-probe.js';
import { makeProbeAwaiter } from 'scenario/probe-respond-await.js';

const SCENARIO = 'composer.live-write';
const AGENT_ID = 'main';
const SESSION_ID = 's-b4-ondevice-0001'; // the configured agent; the page creates its own session
const EXPECTED_TEXT = 'Hello from upstream'; // the scripted endpoint's successText

/** The llm route for this boot — upstream/llm-route.js's shared resolver,
 * ONE home for staged → byok → mock (the BYOK onboarding round reads the
 * keychain through the gateway here). The shape contract is unchanged:
 *
 *   llmBaseUrl present → a REAL user-supplied OpenAI-compatible endpoint (the
 *     user-facing serving boot). The turn is a genuine model call, so its text
 *     is nondeterministic and NOT asserted — the settled event carries whatever
 *     the model said (the llm.live-stream leg's honesty: a served turn is reported, not
 *     predicted).
 *   byok keychain credential present (and nothing staged) → the user's own
 *     endpoint, saved through the onboarding panel — same nondeterminism rule.
 *   otherwise → the carrier's scripted loopback endpoint (the E2E determinism
 *     boundary composer.live-write pins). The loopback demand is what keeps a drive
 *     from silently reaching the network, so it stays fail-loud.
 *
 * The key never reaches a record: it rides apiKey only, and the transport
 * labels name the endpoint's HOST, never the credential. */
const resolveLlmRoute = (cfg) => sharedResolveLlmRoute(cfg);

const log = createLogger('b4.web');



const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
/** One verdict per scenario: the completion is terminal, and the embedder
 * re-reports a completed-fail on every later bus crossing (dsh_spike_m4.c
 * m4_status reads the sticky completed flag) — a second __dshComplete only
 * multiplies the FAIL lines, never the facts (loop-q: the demand throw rode
 * main().catch(fail) into a second emission, doubling the storm). */
let scenarioFailed = false;
const fail = (reason) => {
  if (scenarioFailed) return;
  scenarioFailed = true;
  const error = reason instanceof Error ? reason : null;
  const message = error ? error.message : String(reason);
  const withStack = error?.stack
    ? `${message} | ${error.stack.split('\n').slice(0, 4).join(' / ')}`
    : message;
  log.debug('scenario failed', { reason: withStack });
  emit('scenario.failed', { reason: withStack });
  globalThis.__dshComplete(false, withStack);
};
const demand = (cond, reason) => { if (cond) return; fail(reason); throw new Error(reason); };

/** Bus deliveries may arrive before the awaiting half exists (the drive
 * injects right after eval), so the subscription is module-scope, buffers,
 * and wakes pending `take()` waiters — never a poll. Once `dispatch` is
 * installed, deliveries go straight to it. */
const queue = [];
let wake = null;
let dispatch = null;
globalThis.__dshBusOnMessage = (line) => {
  const msg = JSON.parse(line);
  if (dispatch !== null) return dispatch(msg);
  queue.push(msg);
  wake?.();
};
/** All posted bus frames, in order — the settings-surface probes assert on
 * the api.respond frames (the exact wire the carrier hands the page). */
const posted = [];
const post = (msg) => {
  posted.push(msg);
  globalThis.__dshBusPost?.(JSON.stringify(msg));
};

/** Wait for (and remove) the next delivery of one type. */
const take = async (type) => {
  for (;;) {
    const at = queue.findIndex((msg) => msg.type === type);
    if (at >= 0) return queue.splice(at, 1)[0];
    await new Promise((resolve) => { wake = resolve; });
    wake = null;
  }
};

/** Wait (bounded, microtask-granular — no timers) for the configured agent
 * and its session to appear in the registries (async past the mount). */
const awaitAgent = async (ctx) => {
  let guard = 0;
  while ((ctx.agents.get(SESSION_ID) === undefined || ctx.sessions.get(SESSION_ID) === undefined)
    && guard++ < 100000) {
    await Promise.resolve();
  }
  demand(ctx.agents.get(SESSION_ID) !== undefined, `agent "${SESSION_ID}" never appeared in the registry`);
  demand(ctx.sessions.get(SESSION_ID) !== undefined, `session "${SESSION_ID}" never appeared in the store`);
  return ctx.agents.get(SESSION_ID);
};

/** Boot the spine: the profile container is the host-granted root from the
 * runtime.config delivery (the seeded workspace's REAL directory), the llm
 * route the carrier's scripted endpoint. */
const bootPhase = async (cfg, route) => {
  const root = cfg.containerRoot;
  demand(typeof root === 'string' && root.startsWith('/'),
    `profile container not granted by the host: ${JSON.stringify(root)}`);
  const { ctx } = await bootUpstream({
    scenario: SCENARIO,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    cwd: root,
    onEvent: emit,
    // The interactive surfaces ("/" menu): rows delivered only by the
    // user-facing seat (SessionServe's interactive flag). The evidence drive
    // delivers neither row, so its boot stays byte-identical to the manifest.
    commands: cfg.commands === true,
    skills: cfg.skills,
    goals: cfg.goals === true,
    fileReferences: cfg.fileReferences === true,
    // The CREATION row (the creation-mode plugin): the present tool, under
    // the user-facing seat's interactive flag like the rows above.
    creation: cfg.creation === true,
    container: {
      cwd: root,
      tmpdir: `${root}/tmp`,
      home: `${root}/home`,
      // The granted scope's root: the fs shims map absolute paths onto
      // (scope, scope-relative path) through it. Absent on a host that grants
      // no scope, in which case the shims refuse rather than guess.
      scopeRoot: cfg.fsScopeRoot,
      env: { DSH_MOCK_LLM_URL: route.baseURL, DSH_MOCK_LLM_KEY: route.apiKey },
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: route.baseURL,
      apiKey: route.apiKey,
      provider: route.provider,
      model: route.model,
      userEndpoint: route.userEndpoint,
      adapterName: route.adapterName,
      transportLabel: route.transportLabel,
      onWire: (info) => emit('llm/request/built', info),
      onSse: (info) => emit('llm/sse', info),
    },
  });
  return ctx;
};

/** The assistant text of one assistant/message event (upstream message shape:
 * data.message.content blocks; text blocks joined). */
const assistantTextOf = (event) => (event?.data?.message?.content ?? [])
  .filter((block) => block?.type === 'text').map((block) => block.text).join('');

/** Turn evidence for the PAGE-driven session: the runtime never prompts —
 * the user/message event can only come from the composer's admitted prompt.
 * On turn/end the assistant text is asserted against the scripted stream —
 * ONLY on the scripted route: a real endpoint's turn is nondeterministic, so
 * it is reported verbatim and never predicted (asserting it would turn every
 * honest answer into a drive failure). */
const installTurnEvidence = (ctx, route, cfg) => {
  const turns = new Map(); // sessionId → {prompt, events, text, settled}
  ctx.on('session/event', (session, event) => {
    if (session?.id === undefined || event === undefined) return;
    let turn = turns.get(session.id);
    if (turn === undefined) {
      turn = { prompt: false, events: 0, text: '', settled: false };
      turns.set(session.id, turn);
    }
    turn.events++;
    if (event.type === 'user/message' && !turn.prompt) {
      turn.prompt = true;
      emit('write.prompt.observed', { sessionId: session.id, seq: event.seq });
    }
    if (event.type === 'assistant/message') turn.text = assistantTextOf(event);
    if (event.type === 'turn/end' && !turn.settled) {
      turn.settled = true;
      // CREATION mode (the creation-mode plugin's drive) runs extra turns —
      // a cancelled drip turn and a tool-call-only create turn — whose text
      // is deliberately not the scripted reply; the strict text demand is
      // for the single-turn composer.live-write leg only.
      if (route.scripted && cfg.creation !== true) {
        demand(turn.text === EXPECTED_TEXT,
          `page session "${session.id}" assistant text is "${turn.text}"`);
      }
      emit('write.turn.settled', {
        sessionId: session.id, events: turn.events, text: turn.text,
      });
    }
  });
};

/** The resident runtime half: claims + api.request + the follow streams all
 * answer from the spine, WITH the write surface composed. Evidence is
 * fail-loud: a claimed endpoint failing is a defect and kills the drive. */
const installRuntimeHalf = (ctx, cfg, route) => {
  const onHandler = (msg, outcome) => {
    outcome.run().then(
      (value) => post({ type: 'api.respond', rpcId: msg.rpcId, result: { ok: true, value } }),
      (error) => {
        // A claimed-endpoint failure is a real defect, never a structured
        // shrug: kill the drive naming the wire error triple (fail loud).
        const wire = errorOf(error);
        fail(`claimed endpoint ${msg.endpoint} failed: ${wire.code}: ${wire.message}`);
      },
    ).catch(fail);
  };
  const runtime = createWebBootRuntime({
    ctx, post,
    write: writeSurfaceOptions(cfg, ctx, route),
  });
  const busHandler = (msg) => {
    const outcome = runtime.deliver(msg);
    if (outcome.kind === 'booted') {
      emit('runtime.booted', {
        entries: outcome.entries.length,
        source: 'vendored @deepseek-ai/dsh-client-modules composed in-runtime',
      });
      emit('write.surface.claimed', {
        endpoints: WRITE_ENDPOINTS, streams: WRITE_STREAMS,
        source: 'the on-device spine (ctx.sessions/agents/settings)',
      });
    } else if (outcome.kind === 'handler') {
      onHandler(msg, outcome);
    }
  };
  // `dispatch` installs BEFORE the buffer drains: a delivery racing the swap
  // goes direct or is still in the queue — never stranded, never doubled.
  dispatch = busHandler;
  for (const msg of queue.splice(0)) busHandler(msg);
};

/** The settings-surface probes (预设 roster + 插件 inventory), driven at the
 * same wire boundary the page uses: a synthesized `api.request` answered by
 * the resident runtime half, the api.respond asserted on the bus frames.
 * Runs BEFORE the page loads — the record order is deterministic (page
 * traffic cannot interleave). The 插件 snapshot's managementAvailable stays
 * false (the desktop panel's machinery); the pluginManager LIST legs answer
 * the honest per-tier disposition (read-only spine/staged, patchId
 * workspace rows). */
const SETTINGS_PROBES = [
  { rpcId: 'probe/agentPresets-list-1', endpoint: 'agentPresets/list' },
  { rpcId: 'probe/pluginInventory-list-1', endpoint: 'pluginInventory/list' },
  { rpcId: 'probe/pluginManager-listBundles-1', endpoint: 'pluginManager/listBundles' },
  // The manager-legs probe (scenario/manager-legs-probe.js) awaits this one
  // — a probe that is awaited but never dispatched waits for a respond no
  // handler will ever post (loop-q: the deadline named it on the first
  // honest re-drive).
  { rpcId: 'probe/pluginManager-listPlugins-1', endpoint: 'pluginManager/listPlugins' },
];

/** The probe legs' shared response waiter (scenario/probe-respond-await.js,
 * loop-q): each poll tick is a minimal gateway call whose settle queues on
 * the runtime looper right behind the settles being awaited — awaiting it
 * hands the looper its turn, so a claimed handler whose answer rides the
 * gateway (the 插件 inventory's workspace tier since #334) settles instead
 * of starving; the deadline keeps a genuinely dead handler fail-loud. */
const yieldToHostLooper = async () => {
  const gw = await import('gateway.js');
  try {
    await gw.fsStat('app', 'probe.txt');
  } catch {
    // denied/unavailable IS a settle — the looper turn is the point.
  }
};
const awaitRespond = makeProbeAwaiter({ frames: posted, fail, yieldTurn: yieldToHostLooper });

const probeSettingsRoster = async () => {
  log.debug('settings probes begin', {});
  for (const { rpcId, endpoint } of SETTINGS_PROBES) {
    dispatch({ type: 'api.request', rpcId, endpoint, payload: { args: {} } });
  }
  // 预设 roster: the REAL vendored service's answer over the wire.
  const roster = (await awaitRespond('probe/agentPresets-list-1'));
  demand(roster.ok === true,
    `agentPresets/list did not answer ok: ${JSON.stringify(roster.error ?? roster)}`);
  const presets = roster.value.presets ?? [];
  const ids = presets.map((p) => p.id);
  demand(ids.length >= 1, 'the preset roster is empty');
  emit('settings.preset.roster', {
    presets: ids,
    default: presets.find((p) => p.isDefault === true)?.id ?? null,
    authorable: roster.value.authorable === true,
    modeSelectionEnabled: roster.value.modeSelectionEnabled === true,
    healthy: presets.filter((p) => p.broken === undefined).length,
  });
};

/** The 插件 inventory + manager-legs probes and the probe-done bus line
 * (split from probeSettingsSurfaces at the file-size gate). */

/** The manager LIST-legs probe: the shared two-tier demand + record
 * (scenario/manager-legs-probe.js, #335 A1). */
const probeManagerLegs = () =>
  probeManagerLegsShared({ awaitRespond, emit });

const probeSettingsPlugins = async () => {
  // 插件 inventory: the honest read-only snapshot (spine + staged bundles +
  // the 预设 compositions).
  const inventory = await awaitRespond('probe/pluginInventory-list-1');
  demand(inventory.ok === true,
    `pluginInventory/list did not answer ok: ${JSON.stringify(inventory.error ?? inventory)}`);
  const snapshot = inventory.value;
  demand(snapshot.managementAvailable === false,
    'the plugin inventory must be a read-only snapshot (managementAvailable false)');
  demand(Array.isArray(snapshot.entries) && snapshot.entries.length > 0,
    'the plugin inventory answered no entries');
  demand(Array.isArray(snapshot.agentPresets) && snapshot.agentPresets.length > 0,
    'the plugin inventory answered no agentPresets plane');
  const everyRowWired = snapshot.entries.every((e) => typeof e.entryId === 'string'
    && typeof e.moduleName === 'string' && typeof e.enabled === 'boolean'
    && e.fiberPhase !== undefined);
  demand(everyRowWired, 'an inventory entry is missing its wire fields');
  const stagedIds = snapshot.entries.map((e) => e.entryId)
    .filter((id) => id.startsWith('@deepseek-ai/dsh-client-'));
  demand(stagedIds.length > 0,
    'the plugin inventory does not cover the staged client bundles');
  emit('settings.plugin.inventory', {
    managementAvailable: false,
    entries: snapshot.entries.length,
    clientEntries: stagedIds.length,
    presets: snapshot.agentPresets.length,
    presetRows: snapshot.agentPresets.reduce((sum, p) => sum + (p.rows?.length ?? 0), 0),
    // toolRows — the T-0048 mount proof (a row exists only if its preset composed).
    toolRows: [...new Set(snapshot.agentPresets.flatMap((p) => p.rows ?? []).map(
      (r) => `${r.moduleName ?? r.name ?? r.id}`)
      .filter((n) => n.startsWith('@deepseek-ai/dsh-tool-')))].sort(),
    spineSample: snapshot.entries
      .filter((e) => ['agent-loop', 'llm', 'shell-wasm', 'shell-ish'].includes(e.entryId))
      .map((e) => ({ id: e.entryId, enabled: e.enabled, fiberPhase: e.fiberPhase })),
  });
  await probeManagerLegs();
  // Tell the carrier seat the probes are done: it gates the page open on
  // this line, so the settings.* records are always on the log BEFORE the
  // page-serve records — the manifest order is deterministic, never a race
  // (measured 2026-09-22; a3e35d72 dropped this post in the split and the
  // official seat's page never opened again on a passing boot — loop-t).
  // The fail arm needs no line: a probe failure rides __dshComplete into
  // the host's fail-open.
  post({ type: 'settings.probes.done' });
  log.debug('settings probes done', {});
};

const probeSettingsSurfaces = async () => {
  await probeSettingsRoster();
  await probeSettingsPlugins();
};



/** TEMPORARY DIAGNOSTIC (removed before landing): exercise the five contract
 * v1.1.0 filesystem primitives on the device and print what came back. Uses
 * log.debug so no canonical record is added and the manifest's one-to-one
 * match is untouched. */
const probeFsPrimitives = async () => {
  const gw = await import('gateway.js');
  const { encodeUtf8, decodeUtf8 } = await import('node:buffer');
  const out = { stage: 'start' };
  const check = async (label, fn) => {
    try {
      out[label] = await fn();
    } catch (error) {
      out[label] = `ERR ${error?.code ?? '?'}: ${error?.message ?? error}`;
    }
  };
  await check('mkdir', async () => { await gw.fsMkdir('app', 'probe/sub'); return 'ok'; });
  await check('write', async () => {
    const r = await gw.fsWrite('app', 'probe/sub/hello.txt', encodeUtf8('hello primitives'));
    return `written=${r.written}`;
  });
  await check('read', async () => {
    const r = await gw.fsRead('app', 'probe/sub/hello.txt');
    return decodeUtf8(r.bytes);
  });
  await check('stat', async () => {
    const r = await gw.fsStat('app', 'probe/sub/hello.txt');
    return `${r.kind} size=${r.size}`;
  });
  await check('list', async () => {
    const r = await gw.fsList('app', 'probe/sub');
    return r.entries.map((e) => `${e.name}:${e.kind}`).join(',');
  });
  await check('rename', async () => {
    await gw.fsRename('app', 'probe/sub/hello.txt', 'probe/sub/moved.txt');
    const r = await gw.fsList('app', 'probe/sub');
    return r.entries.map((e) => e.name).join(',');
  });
  await check('statDir', async () => {
    const r = await gw.fsStat('app', 'probe/sub');
    return r.kind;
  });
  await check('remove', async () => {
    await gw.fsRemove('app', 'probe/sub', { recursive: true });
    return 'removed';
  });
  await check('statAfterRemove', async () => {
    const r = await gw.fsStat('app', 'probe/sub');
    return `still there: ${r.kind}`;
  });
  out.stage = 'done';
  log.debug('fs primitives probe', out);
};


/** The wasmRun probe (contract v1.2.0): a real WebAssembly module written into
 * the app scope, executed in-process, output through the host-linked `dsh.emit`.
 * log.debug, so no canonical record is added. */
const WASM_PROBE_MODULE = [0,97,115,109,1,0,0,0,1,12,2,96,2,127,127,0,96,2,127,127,1,127,2,12,1,3,100,115,104,4,101,109,105,116,0,0,3,2,1,1,5,3,1,0,1,7,16,2,6,109,101,109,111,114,121,2,0,3,114,117,110,0,1,10,12,1,10,0,32,0,32,1,16,0,32,1,11];

const probeWasmRun = async () => {
  const gw = await import('gateway.js');
  const out = { stage: 'start' };
  try {
    await gw.fsMkdir('app', 'probe/wasm');
    await gw.fsWrite('app', 'probe/wasm/echo.wasm',
      Uint8Array.from(WASM_PROBE_MODULE));
    out.module = 'written ' + WASM_PROBE_MODULE.length + ' bytes';
    const run = await gw.wasmRun('app', 'probe/wasm/echo.wasm', 'run',
      'hello from wasm');
    out.run = 'result=' + run.result + ' output=' + JSON.stringify(run.output);
    out.missingExport = await gw
      .wasmRun('app', 'probe/wasm/echo.wasm', 'nope', '')
      .then(() => 'no error', (error) => error.code + ': ' + error.message);
    out.noModule = await gw
      .wasmRun('app', 'probe/wasm/absent.wasm', 'run', '')
      .then(() => 'no error', (error) => error.code + ': ' + error.message);
  } catch (error) {
    out.ok = false;
    out.error = (error && error.code ? error.code : '?') + ': ' +
      (error && error.message ? error.message : String(error));
  }
  out.stage = 'done';
  log.debug('wasm probe', out);
};

/** The in-process Linux guest (contract v1.3.0 `ishRun`): one REAL `/bin/sh -c`
 * line in the emulated aarch64 Alpine userland. log.debug only, like the fs/
 * wasm probes; a host without the userland records the honest `unavailable`.
 * The EMPTY path is the scope root (IshPrimitive's deliberate difference). */
const probeIshRun = async () => {
  const gw = await import('gateway.js');
  const out = { stage: 'start' };
  try {
    const run = await gw.ishRun('app', '', ['/bin/sh', '-c', 'echo hello-from-guest']);
    out.run = `exit=${run.exitCode} stdout=${JSON.stringify(run.stdout)} timedOut=${run.timedOut} truncated=${run.truncated}`;
  } catch (error) {
    out.unavailable = (error && error.code ? error.code : '?') + ': ' +
      (error && error.message ? error.message : String(error));
  }
  out.stage = 'done';
  log.debug('ish probe', out);
};

const main = async () => {
  log.debug('main begin', {});
  const cfg = await take('runtime.config');
  const route = await resolveLlmRoute(cfg);

  const ctx = await bootPhase(cfg, route);
  // The unbind seam's factory: the boot route re-derived from the SAME cfg
  // this boot resolved its route from (onboarding/clear's restore leg).
  registerBootRouteFactory(ctx, () => bootRouteOf(cfg));
  await probeFsPrimitives();
  await probeWasmRun();
  await probeIshRun();
  await awaitAgent(ctx);
  installTurnEvidence(ctx, route, cfg);
  installRuntimeHalf(ctx, cfg, route);
  await probeSettingsSurfaces();
  log.debug('b4 runtime resident (write surface live; awaiting the page)', {});
};

main().catch(fail);
