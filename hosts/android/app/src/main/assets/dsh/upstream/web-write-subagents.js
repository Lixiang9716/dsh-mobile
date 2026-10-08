// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-subagents.js — the SUBAGENT control-plane legs (T-0050
 * item 2): thin forwarders onto the REAL vendored @deepseek-ai/dsh-subagent
 * runtime boot.js mounts (ctx.subagents — the TypertRemoteService whose
 * Remote face answers subagents/list + /prompt + /interruptByParent). They
 * forward, they do not reimplement: the catalog reads the session
 * projections' child entries, prompt delivers through the live parent's
 * continuation manager, and interrupt authorizes against the live
 * Activation. This composition registers no delegation provider, so the
 * catalog answers the honest empty roster ({entries: [], parentAvailable})
 * and a prompt to an address with no live child refuses with the service's
 * own structured subagent/* code — never a fabricated row.
 */
import { remoteError } from 'upstream/web-write.js';

/** The caller lifetime the wire's cancellation parameter carries (the
 * web-write-catalog convention): the carrier delivers no signal, so every
 * forwarded call runs under a fresh live one. */
const liveSignal = () => new AbortController().signal;

/** The mounted runtime, or the structured gap when the bare compose-only
 * embed carries no boot (the catalog forwarders' convention). */
const subagents = (ctx) => {
  const service = ctx.get('subagents');
  if (service === undefined) {
    throw remoteError('gateway/unavailable',
      'subagents service is not mounted (boot with the matching option)', {});
  }
  return service;
};

/** The subagents/* handlers, keyed by wire name. The wire argument spellings
 * are the generated TypertRemoteMap's (dsh-api-remotes): list takes the
 * plain parentSessionId, prompt nests under `request`, interruptByParent
 * takes the three json fields. */
export const makeSubagentHandlers = (ctx) => ({
  'subagents/list': async (args) => {
    const request = args?.request ?? args ?? {};
    return subagents(ctx).remoteExportList(
      request.parentSessionId, liveSignal());
  },
  'subagents/prompt': async (args) => {
    return subagents(ctx).prompt(args?.request ?? args ?? {}, liveSignal());
  },
  'subagents/interruptByParent': async (args) => {
    return subagents(ctx).interruptByParent(
      args?.childSessionId, args?.parentSessionId, args?.mode);
  },
});
