// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-presets.js — the PRESET adapters (split from
 * web-write.js at the code-size gate): the agentPresets/* forwarders and
 * the endpointPresets adapter, both read by the settings surfaces on every
 * boot.
 */
import { remoteError } from 'upstream/web-write.js';

/** The agentPresets/* handlers: thin forwarders onto the service boot.js
 * mounted from @deepseek-ai/dsh-agent-presets. Wire names, argument names,
 * and the IMPLEMENTATION each wire method maps to follow the package's own
 * @Remote descriptors (dsh-api-remotes): list→remoteExportList,
 * read→readDocument, copy→remoteExportCopy, deletePreset→remoteExportDelete,
 * select→select — and select's `agent` parameter arrives on the wire as an
 * agentId, which the host resolves to the LIVE agent before invoking (the
 * same resolution commands.prompt does). The panel's wire names are
 * agentPresets/list, /read, /copy, /deletePreset, /select. */
export const makeAgentPresetHandlers = (ctx) => {
  const call = async (method, args) => {
    const service = ctx.get('agentPresets');
    if (service === undefined) {
      throw remoteError('gateway/unavailable', 'agentPresets service is not mounted', {});
    }
    return service[method](...args);
  };
  return {
    'agentPresets/list': () => call('remoteExportList', []),
    'agentPresets/read': (args) => call('readDocument', [args?.agentPreset]),
    'agentPresets/copy': (args) => call('remoteExportCopy', [args?.from, args?.id, args?.name]),
    'agentPresets/deletePreset': (args) => call('remoteExportDelete', [args?.id]),
    'agentPresets/select': async (args) => {
      const agent = ctx.agents.get(args?.agent);
      if (agent === undefined) {
        throw remoteError('session/not-found',
          `session ${JSON.stringify(args?.agent ?? null)} is not attached to the mobile runtime`,
          { sessionId: args?.agent ?? null });
      }
      return call('select', [agent, args?.agentPreset]);
    },
  };
};

/** The endpointPresets adapter. The desktop keeps this service closed-source,
 * so there is nothing to port (D9 forbids inventing product behavior); what
 * THIS host knows is a platform fact: one model endpoint, the user's staged
 * credential. Reads project it (no key material); writes refuse honestly. */
export const makeEndpointPresetAdapter = (options) => {
  const one = {
    id: 'default',
    name: 'This device (staged credential)',
    baseUrl: options.llm?.baseURL ?? '',
    model: options.llm?.model ?? '',
    readonly: true,
  };
  return {
    'endpointPresets/list': async () => ({
      presets: [one],
      default: one.id,
      authorable: false,
    }),
    'endpointPresets/read': async (args) => {
      if (String(args?.id ?? '') === one.id) return one;
      throw remoteError('endpoint-preset/not-found', `no endpoint preset "${String(args?.id)}"`, {});
    },
    'endpointPresets/create': async () => {
      throw remoteError('gateway/unimplemented',
        'endpoint presets are read-only on this host (one staged credential)', {});
    },
    'endpointPresets/update': async () => {
      throw remoteError('gateway/unimplemented',
        'endpoint presets are read-only on this host (one staged credential)', {});
    },
    'endpointPresets/delete': async () => {
      throw remoteError('gateway/unimplemented',
        'endpoint presets are read-only on this host (one staged credential)', {});
    },
  };
};
