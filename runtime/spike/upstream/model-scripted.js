// dsh:logging-exempt (shim layer: the scripted-model boundary itself)
/**
 * model-scripted — the SCRIPTED MODEL SERVICE for the upstream E2E (W-PORT2).
 *
 * The upstream agent loop is transport-agnostic by design: `ctx.llm` exposes
 * `prepareCall(config, signal)` and `stream(request)`, and the loop stays
 * upstream while the driver stays swappable (the desktop equivalent swaps
 * llm-deepseek / llm-pi-ai adapters in via settings). PR-A has no upstream
 * llm transport — W-LLM lands it separately — so the mobile profile mounts
 * THIS service under the `llm` key: an upstream-SHAPE driver that streams a
 * fixed, deterministic turn. Every boot logs `model.scripted` naming the
 * boundary; nothing here talks to a network.
 *
 * Shape (verified against dsh-agent-loop call sites):
 *   - prepareCall(proposedConfig, signal) → { config, stream(request),
 *     adapterDefaults?, retryPolicy?, systemPromptUpdate? } — the loop falls
 *     back to ctx.llm.stream(request) when prepareCall throws NO_ADAPTER; we
 *     accept the config and hand back our scripted stream, mirroring an
 *     adapter that resolved the exact model.
 *   - stream(request) → AsyncIterable<StreamChunk>: block-start → text-delta*
 *     → block-end → finish. Chunk shapes match dsh-llm's StreamChunk union
 *     (assembled by the vendored BlockAssembler path in agent-loop).
 *
 * Intentionally NOT supported: tool-call chunks (PR-B exercises the tool path
 * through the subprocess Service), usage/replayState envelopes, provider
 * auth/retry — transport belongs to the real dsh-llm adapters.
 */

/**
 * Create the scripted `llm` service.
 * @param options.provider - provider name the agent config must carry.
 * @param options.model - model name the agent config must carry.
 * @param options.deltas - text delta fragments streamed in order.
 * @param [options.onStream] - observability hook: (info) => void, called once
 *   per stream start with the canonical request header fields. The scenario
 *   uses it to log the request-header evidence at the scripted boundary.
 */
export function createScriptedModelService(options) {
  const { provider, model, deltas, onStream } = options;
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new TypeError('model-scripted: provider is required');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('model-scripted: model is required');
  }
  if (!Array.isArray(deltas) || deltas.some((d) => typeof d !== 'string')) {
    throw new TypeError('model-scripted: deltas must be a string array');
  }

  const scriptedStream = async function* (request) {
    if (request?.provider !== provider || request?.model !== model) {
      throw new Error(
        `model-scripted: request routed to ${request?.provider}/${request?.model}, `
        + `scripted service owns ${provider}/${model}`);
    }
    onStream?.({
      provider: request.provider,
      model: request.model,
      tools: Array.isArray(request.tools) ? request.tools.length : 0,
      messages: Array.isArray(request.messages) ? request.messages.length : 0,
    });
    const text = deltas.join('');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (const delta of deltas) {
      yield { type: 'text-delta', index: 0, text: delta };
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };

  return {
    /** Upstream LlmRuntime shape: resolve the route, bind the scripted stream. */
    async prepareCall(proposedConfig, _signal) {
      return {
        config: proposedConfig,
        stream: scriptedStream,
      };
    },
    /** Direct streaming path (used when no adapter resolves). */
    stream: scriptedStream,
  };
}
