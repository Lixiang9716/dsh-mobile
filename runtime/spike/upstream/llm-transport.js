// dsh:logging-exempt (adapter seam: all emission rides caller-provided hooks)
/**
 * llm-transport — the GATEWAY TRANSPORT SEAM for the vendored dsh-llm
 * (decision D9, the W-LLM leg).
 *
 * The vendored `LlmRuntime` is transport-agnostic: provider backends register
 * through `registerAdapter(providers, adapter)` and stream harness
 * `StreamChunk`s. On the desktop the direct-fetch adapters (dsh-llm-deepseek,
 * dsh-llm-pi-ai) own `fetch` + SSE. QuickJS has no fetch/sockets — the mobile
 * equivalent is the gateway `httpFetch` primitive (streaming AsyncIterable
 * body, base64 byte bridge, abortable). THIS module is that adapter: an
 * upstream-SHAPE OpenAI-compatible chat-completions adapter whose entire
 * transport is `gateway.httpFetch`, modeled on dsh-llm-deepseek's wire layer
 * (MIT) with the platform seam swapped:
 *
 *   upstream desktop                      this seam
 *   ------------------------------        ------------------------------
 *   fetch(url, {body, signal})     →     gateway httpFetch(url, {body})
 *   Response.body (Web stream)     →     httpFetch response.body (AsyncIterable
 *                                          of Uint8Array fed by http.body events)
 *   signal abort                    →     response.abort() → GatewayError
 *                                          'cancelled' → LlmError ABORTED
 *   EventSourceParserStream         →     incremental SSE byte parser (below;
 *                                          reads may split anywhere, including
 *                                          mid-UTF-8 — same contract)
 *   TextEncoder/TextDecoder         →     utf8Encode/utf8Decode (no Text* globals
 *                                          in the spike runtime)
 *
 * Zero vendored edits: the harness vocabulary (messages, StreamChunks,
 * LlmError taxonomy, attribution headers) all comes from the vendored
 * `@deepseek-ai/dsh-llm`; only the wire translation below is ours, kept
 * upstream-SHAPE (finish mapping, usage disambiguation, deferred
 * block-end/usage/finish until [DONE], EMPTY_RESPONSE degenerate check).
 */
import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
  isAgentLoopRequest,
} from '@deepseek-ai/dsh-llm';
import { httpFetch } from '../gateway.js';

/** Non-ASCII-safe UTF-8 bytes for one JSON string (the wire body). */
const utf8Encode = (text) => {
  const bytes = [];
  for (const point of text) {
    const value = point.codePointAt(0);
    if (value < 0x80) bytes.push(value);
    else if (value < 0x800) bytes.push(0xc0 | (value >> 6), 0x80 | (value & 63));
    else if (value < 0x10000) bytes.push(0xe0 | (value >> 12), 0x80 | ((value >> 6) & 63), 0x80 | (value & 63));
    else bytes.push(0xf0 | (value >> 18), 0x80 | ((value >> 12) & 63), 0x80 | ((value >> 6) & 63), 0x80 | (value & 63));
  }
  return Uint8Array.from(bytes);
};

/** Incremental UTF-8 decoder: carries a partial multi-byte sequence across
 * chunk boundaries (the SSE bytes may split anywhere). */
const utf8Decoder = () => {
  let pending = [];
  return (bytes) => {
    const values = [...pending, ...bytes];
    pending = [];
    const chars = [];
    for (let i = 0; i < values.length;) {
      const first = values[i];
      const need = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      if (i + need > values.length) {
        pending = values.slice(i);
        break;
      }
      if (need === 1) chars.push(first);
      else if (need === 2) chars.push(((first & 31) << 6) | (values[i + 1] & 63));
      else if (need === 3) chars.push(((first & 15) << 12) | ((values[i + 1] & 63) << 6) | (values[i + 2] & 63));
      else chars.push(((first & 7) << 18) | ((values[i + 1] & 63) << 12) | ((values[i + 2] & 63) << 6) | (values[i + 3] & 63));
      i += need;
    }
    return String.fromCodePoint(...chars);
  };
};

const flattenText = (blocks) => blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');

const wireToolCall = (block) => ({
  id: block.id,
  type: 'function',
  function: { name: block.name, arguments: block.arguments },
});

/** Wire assistant message: text content plus tool calls (identity only). */
const wireAssistant = (message) => {
  const toolCalls = message.content.filter((block) => block.type === 'tool-call');
  return {
    role: 'assistant',
    content: flattenText(message.content),
    ...toolCalls.length > 0 ? { tool_calls: toolCalls.map(wireToolCall) } : {},
  };
};

/** Wire user/tool messages: text first, then each tool result as its own
 * `{role: 'tool'}` entry (upstream serializeMessages semantics). */
const wireUserAndToolResults = (message, messages) => {
  for (const block of message.content) {
    if (block.type !== 'text' && block.type !== 'tool-result') {
      throw new LlmError(`gateway adapter: "${block.type}" content is not supported by this transport`, 'UNSUPPORTED_CONTENT');
    }
  }
  const toolResults = message.content.filter((block) => block.type === 'tool-result');
  const text = flattenText(message.content);
  if (text.length > 0 || toolResults.length === 0) messages.push({ role: 'user', content: text });
  for (const result of toolResults) {
    messages.push({
      role: 'tool',
      tool_call_id: result.toolCallId,
      content: flattenText(result.content) || '(no output)',
    });
  }
};

/** Wire request body for the conversation: the harness message vocabulary
 * into the OpenAI-compatible chat-completions shape (upstream-SHAPE,
 * llm-deepseek's serializeRequest with the DeepSeek-specifics dropped). */
const serializeWireRequest = (options) => {
  const messages = [];
  for (const message of options.messages) {
    if (message.role === 'system') messages.push({ role: 'system', content: flattenText(message.content) });
    else if (message.role === 'assistant') messages.push(wireAssistant(message));
    else wireUserAndToolResults(message, messages);
  }
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
    ...options.stop !== undefined ? { stop: options.stop } : {},
  };
};

/** Wire finish_reason → harness FinishReason (upstream mapping). */
const mapFinishReason = (reason) => {
  if (reason === 'stop') return { kind: 'stop' };
  if (reason === 'tool_calls') return { kind: 'tool-calls' };
  if (reason === 'length') return { kind: 'max-tokens' };
  return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
};

/** Wire usage → the harness DISJOINT TokenUsage convention (upstream mapping;
 * the mock's prompt_tokens carries no cache split, so input = prompt). */
const mapUsage = (usage) => {
  const combined = usage.prompt_tokens + usage.completion_tokens;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...Number.isSafeInteger(combined) && (usage.total_tokens === undefined || usage.total_tokens === combined)
      ? { totalTokens: combined } : {},
  };
};

/** Provider error → the harness provider-neutral code (upstream mapping). */
const httpErrorCode = (status, error) => {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 413) return 'INVALID_REQUEST';
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
  if (/insufficient[\s_-]+quota/i.test(detail)) return 'QUOTA';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) {
    if (/context[\s_-]*(length|window)/i.test(detail)) return 'CONTEXT_WINDOW_EXCEEDED';
    return 'INVALID_REQUEST';
  }
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
};

const collectBody = async (response) => {
  const decode = utf8Decoder();
  let text = '';
  for await (const chunk of response.body) text += decode(chunk);
  return text;
};

/** Diagnose a non-2xx response into the provider-neutral LlmError taxonomy
 * (upstream mapping: JSON error body first, status-class fallback). */
const demandStreamResponse = async (response) => {
  if (response.status >= 200 && response.status < 300) return;
  const raw = await collectBody(response);
  let providerError;
  try { providerError = JSON.parse(raw).error; } catch { /* non-JSON body */ }
  throw new LlmError(
    providerError?.message ?? `provider error (HTTP ${response.status})`,
    httpErrorCode(response.status, providerError),
    { status: response.status, cause: new Error(raw || `HTTP ${response.status}`) },
  );
};

/** The transport call itself: one gateway httpFetch with the wire headers
 * (attribution headers come from the VENDORED package) and the UTF-8 body. */
const openWireStream = async (endpoint, apiKey, wire, signal) => {
  const headers = {
    'authorization': `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    ...attributionHeaders(),
  };
  try {
    return await httpFetch(endpoint, { method: 'POST', headers, body: utf8Encode(JSON.stringify(wire)) });
  } catch (error) {
    if (signal?.aborted) {
      throw new LlmError('gateway request aborted by caller', 'ABORTED', { cause: error });
    }
    throw new LlmError(`gateway transport to ${endpoint} failed: ${error?.message ?? error}`, 'TRANSPORT', { cause: error });
  }
};

/** Build one adapter bound to one route. Observability rides hooks:
 * onWire(info) fires once per wire request (the scenario logs the request
 * evidence); onSse(info) once per decoded SSE data payload (the parse
 * evidence). Hooks receive plain deterministic fields only (no port, no
 * key material).
 *
 * The LOOPBACK demand is the determinism boundary: an E2E drive may only
 * ever talk to the carrier's scripted endpoint, so a non-loopback baseURL
 * there is a defect, not a configuration. A USER-SUPPLIED endpoint is the
 * one legitimate exception — the user-facing serving boot reads it from the
 * app's own credential file — and it must SAY SO with `userEndpoint: true`,
 * so the exception is a named decision at the call site instead of a guard
 * quietly weakened for every caller. */
export function createGatewayLlmAdapter(options) {
  const { baseURL, apiKey, provider, name, onWire, onSse, userEndpoint = false } = options;
  if (userEndpoint === true) {
    if (typeof baseURL !== 'string' || !/^https?:\/\/[^\s]+$/.test(baseURL)) {
      throw new TypeError(`llm-transport: user endpoint baseURL is not an http(s) URL, got ${String(baseURL)}`);
    }
  } else if (typeof baseURL !== 'string' || !baseURL.startsWith('http://127.0.0.1:')) {
    throw new TypeError(
      'llm-transport: baseURL must be a loopback http://127.0.0.1:PORT URL, got '
      + `${String(baseURL)} — an E2E drive only talks to the carrier's scripted endpoint; `
      + 'a user-supplied endpoint must declare itself with userEndpoint: true');
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new TypeError('llm-transport: apiKey is required');
  if (typeof provider !== 'string' || provider.length === 0) throw new TypeError('llm-transport: provider is required');
  const endpoint = `${baseURL.replace(/\/+$/, '')}/chat/completions`;

  const adapter = new class extends LlmAdapter {
    providerInfo(route) {
      return { id: route, name: name ?? route };
    }

    async resolveModel(route, model, _signal) {
      // The mock route declares exactly the effort the mobile profile pins
      // ('off'); anything else fails upstream as UNSUPPORTED_REASONING_EFFORT.
      return { provider: route, id: model, name: model, reasoning: { efforts: [{ id: 'off', name: 'off' }] } };
    }

    async *stream(requestOptions) {
      const wire = serializeWireRequest(requestOptions);
      onWire?.({
        provider: requestOptions.provider,
        model: requestOptions.model,
        messages: Array.isArray(requestOptions.messages) ? requestOptions.messages.length : 0,
        tools: Array.isArray(requestOptions.tools) ? requestOptions.tools.length : 0,
        path: '/chat/completions',
        method: 'POST',
        agentLoopMarked: isAgentLoopRequest(requestOptions),
        stream: true,
      });
      const response = await openWireStream(endpoint, apiKey, wire, requestOptions.signal);
      await demandStreamResponse(response);
      yield* translate(parseSse(response, requestOptions.signal), onSse);
    }
  }();
  return adapter;
}

/** Parse one SSE byte stream into data payloads (the '[DONE]' sentinel
 * included, yielded as received — never synthesized). Events split on a
 * blank line; only `data:` fields carry payload. Reads may split anywhere —
 * the line buffer reassembles them. Throws LlmError STREAM_CLOSED when the
 * body ends without the sentinel (upstream contract: a truncated stream
 * cannot be trusted) and maps caller aborts to ABORTED. */
const parseSse = async function* (response, signal) {
  const decode = utf8Decoder();
  let buffer = '';
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      buffer += decode(chunk);
      let at = buffer.indexOf('\n\n');
      while (at >= 0) {
        const event = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = event.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data.length > 0) {
          yield data;
          if (data === '[DONE]') return;
        }
        at = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    response.abort?.();
    if (signal?.aborted) throw new LlmError('gateway request aborted by caller', 'ABORTED', { cause: error });
    throw new LlmError(`gateway SSE stream failed: ${error?.message ?? error}`, 'TRANSPORT', { cause: error });
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED');
};

/** One stateful block per content kind (upstream translate semantics). */
const openBlockState = () => {
  const state = { nextIndex: 0, order: [] };
  state.open = (kind) => {
    const block = { index: state.nextIndex++, kind, text: '' };
    state.order.push(block);
    return block;
  };
  return state;
};

const closeBlock = (block) => block.kind === 'text'
  ? { type: 'text', text: block.text }
  : block.kind === 'reasoning'
    ? { type: 'reasoning', text: block.text }
    : { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text };

/** Delta processing for one wire chunk: opens blocks on first sight and
 * accumulates identity/arguments (identity is sent once on a call's first
 * delta; an empty or null re-send means "no update", never "clear"). */
const absorbWireChunk = (chunk, blocks) => {
  const out = [];
  for (const choice of chunk.choices ?? []) {
    const reasoning = choice.delta?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      if (!blocks.reasoning) {
        blocks.reasoning = blocks.state.open('reasoning');
        out.push({ type: 'block-start', index: blocks.reasoning.index, blockType: 'reasoning' });
      }
      blocks.reasoning.text += reasoning;
      out.push({ type: 'reasoning-delta', index: blocks.reasoning.index, text: reasoning });
    }
    const content = choice.delta?.content;
    if (typeof content === 'string' && content.length > 0) {
      if (!blocks.text) {
        blocks.text = blocks.state.open('text');
        out.push({ type: 'block-start', index: blocks.text.index, blockType: 'text' });
      }
      blocks.text.text += content;
      out.push({ type: 'text-delta', index: blocks.text.index, text: content });
    }
    for (const call of choice.delta?.tool_calls ?? []) {
      let block = blocks.tools.get(call.index);
      if (!block) {
        block = blocks.state.open('tool-call');
        blocks.tools.set(call.index, block);
        out.push({ type: 'block-start', index: block.index, blockType: 'tool-call' });
      }
      if (typeof call.id === 'string' && call.id.length > 0) block.callId = call.id;
      if (typeof call.function?.name === 'string' && call.function.name.length > 0) block.name = call.function.name;
      const fragment = call.function?.arguments ?? '';
      block.text += fragment;
      out.push({
        type: 'tool-call-delta',
        index: block.index,
        id: block.callId ?? '',
        ...block.name !== undefined ? { name: block.name } : {},
        argumentsDelta: fragment,
      });
    }
    if (typeof choice.finish_reason === 'string') blocks.finish = mapFinishReason(choice.finish_reason);
  }
  if (chunk.usage) blocks.usage = mapUsage(chunk.usage);
  return out;
};

/** Consume SSE data payloads and yield harness StreamChunks (upstream-SHAPE
 * translate: block-end, usage, and finish deferred to [DONE]; a stop with
 * no opened blocks is the degenerate EMPTY_RESPONSE completion). onSse fires
 * once per payload, before its chunks. */
const translate = async function* (payloads, onSse) {
  const blocks = {
    state: openBlockState(),
    text: undefined,
    reasoning: undefined,
    tools: new Map(),
    finish: undefined,
    usage: undefined,
  };
  for await (const payload of payloads) {
    onSse?.(sseEvidence(payload));
    if (payload === '[DONE]') {
      for (const block of blocks.state.order) yield { type: 'block-end', index: block.index, block: closeBlock(block) };
      if (blocks.usage) yield { type: 'usage', usage: blocks.usage };
      const reason = blocks.finish ?? { kind: 'stop' };
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && blocks.state.order.length === 0 ? {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
        } : reason,
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE');
    }
    for (const out of absorbWireChunk(chunk, blocks)) yield out;
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED');
};

/** Deterministic per-payload evidence for the scenario log (the mock's
 * success stream: content deltas, one terminal chunk, [DONE]). */
const sseEvidence = (payload) => {
  if (payload === '[DONE]') return { done: true };
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return { malformed: payload.slice(0, 40) };
  }
  const choice = chunk.choices?.[0];
  const content = choice?.delta?.content;
  if (typeof content === 'string' && content.length > 0) return { delta: content };
  if (typeof choice?.finish_reason === 'string' && chunk.usage) {
    return { finish: choice.finish_reason, usage: mapUsage(chunk.usage) };
  }
  return { fields: Object.keys(chunk) };
};
