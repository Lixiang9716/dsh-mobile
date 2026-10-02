// upstream/model-selection-holder.js — the APPLY leg of the mobile seat's
// per-conversation model selection: PR #308's journal half got a body.
//
// The desktop commits a composer pick through dsh-api-session-controller's
// `selectForNextRequest`: it appends the `model/selection` journal event AND
// sets the agent-scoped holder's `current` (selectionFor, lib/index.js at the
// pin). The vendored `installModelSelection` (@deepseek-ai/dsh-agent,
// lib/types/model-selection.js, bundled into lib/index.js) couples that
// holder to the turn pipeline: the `system-prompt/assemble` waterfall
// snapshots `current` into `assembled`, the `agent/request` waterfall applies
// the snapshot's provider/model (+ effort) onto the resolved request config,
// and `agent/pre-step` inserts the durable model-switch notice when the route
// changed. #308 landed only the journal append — the pick reached the
// modelSelection projection's `pending`, but every turn kept serving the boot
// route. This module installs the SAME vendored holder at boot (one agent per
// seat) and hands the session/selectModel handler the `current` setter, so
// the next turn's `request/header.config` carries the selection and the
// projection's `lastUsed` follows it (the request/header fold also retires a
// matching `pending`).
//
// Holder shape = the controller's selectionFor at the pin, with the mobile
// fallback: `current` reads the picked selection, else the last request
// header (the controller's derive-from-logged shape, effort omitted when the
// adapter owns the default), else the boot route — which carries the loop's
// configured reasoningEffort so the FIRST request's config is reproduced
// byte-identically. `consume(provider, model, reasoningEffort)` returns true
// iff the picked selection equals the served route and clears it; the ctx's
// `session/event` request/header leg drives it exactly like the controller's,
// so the durable journal — never a stale slot — stays the source of truth.

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createLogger } from '../logger.js';

const log = createLogger('dsh.model-selection-holder');

/** The installed holders, keyed by the live SESSION object — the consume
 * listener's direct lookup (the controller keys its map by agent, and the
 * registry pins agent id === session id, so the keyings are one). WeakMap: a
 * holder lives and dies with its session. */
const holders = new WeakMap();

/** The boot contexts whose request/header consume leg is wired — once per
 * ctx (the controller registers one `session/event` listener on its ctx). */
const consumeWired = new WeakSet();

/** The header-derived fallback the controller's getter applies: the logged
 * config's provider/model, plus its effort unless the adapter owns the
 * default (dsh-api-session-controller selectionFor, verbatim shape). */
const loggedSelectionOf = (loggedHeader) => ({
  provider: loggedHeader.config.provider,
  model: loggedHeader.config.model,
  ...(loggedHeader.config.reasoningEffort === undefined
    || loggedHeader.adapterDefaults?.reasoningEffort === true
    ? {}
    : { reasoningEffort: loggedHeader.config.reasoningEffort }),
});

/** Install the holder for one live agent and wire the context's consume leg.
 * Idempotent per session (the controller's selectionFor precedent); returns
 * the installed holder. The literal IS the controller's selectionFor holder
 * — the exact mutable contract `installModelSelection` couples to assembly
 * and request routing (`picked` closes over the slot; `assembled` is the
 * assembly waterfall's snapshot field). */
export const installSessionModelSelection = (ctx, agent, bootRoute) => {
  log.debug('install model-selection holder', { sessionId: agent.session.id });
  const installed = holders.get(agent.session);
  if (installed !== undefined) return installed;
  let picked;
  const holder = {
    get current() {
      if (picked !== undefined) return picked;
      const loggedHeader = agent.session.requestHeader();
      if (loggedHeader === undefined) return bootRoute;
      return loggedSelectionOf(loggedHeader);
    },
    set current(next) {
      picked = next;
    },
    consume(provider, model, reasoningEffort) {
      if (picked?.provider !== provider || picked.model !== model
        || picked.reasoningEffort !== reasoningEffort) {
        return false;
      }
      picked = undefined;
      return true;
    },
    assembled: undefined,
  };
  installModelSelection(agent.ctx, holder);
  holders.set(agent.session, holder);
  if (!consumeWired.has(ctx)) {
    consumeWired.add(ctx);
    // The controller's request/header consume leg (pin lib/index.js): a
    // journaled header retires a picked selection equal to the served route.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'request/header') return;
      holders.get(session)
        ?.consume(
          event.data.header.config.provider,
          event.data.header.config.model,
          event.data.header.config.reasoningEffort,
        );
    });
  }
  return holder;
};

/** The holder one live agent carries, or undefined when its boot installed
 * none (the selectModel handler refuses such sessions — fail loud). */
export const sessionModelSelection = (agent) => holders.get(agent.session);

/** The boot mount: register the modelSelection projection unit (issue #306,
 * moved here verbatim so the plane has ONE home) and install the holder for
 * the configured agent. Agent creation is async past the AgentLoop mount, so
 * poll the registry bounded and fail loud (rule 8: wait on conditions, never
 * on clocks). */
export const mountModelSelectionHolder = async (ctx, bootRoute, sessionId) => {
  log.debug('mount model-selection plane', { sessionId });
  const Projection = await import('upstream/model-selection-projection.js');
  ctx.sessionProjections.register(Projection.modelSelectionUnit);
  let guard = 0;
  while (ctx.agents.get(sessionId) === undefined && guard++ < 10000) {
    await Promise.resolve();
  }
  const agent = ctx.agents.get(sessionId);
  if (agent === undefined) {
    throw new Error(`boot: the configured agent "${sessionId}" never appeared `
      + 'in the registry — cannot install the model-selection holder');
  }
  return installSessionModelSelection(ctx, agent, bootRoute);
};
