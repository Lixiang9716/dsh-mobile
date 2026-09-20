// dsh:logging-exempt (shim layer: part of the scripted-model boundary, logged as model.scripted)
/**
 * @deepseek-ai/dsh-llm shim — STAGED upstream-SHAPE value helpers (PR-A).
 *
 * The upstream agent spine imports VALUES from dsh-llm at module load (message
 * factories, error classes, stream plumbing), so no upstream turn can run
 * without this module existing. Ownership is split by design (D9 + W-PORT2
 * coordination): W-LLM owns the dsh-llm* VENDOR + the transport; this shim
 * carries only the pure value plumbing the spine links against, ported from
 * deepseek-harness packages/llm/llm/src (MIT) so behavior matches upstream
 * exactly. It contains NO transport, NO service, NO provider code.
 *
 * Covers (upstream usage → this module, import sites verified in vendor/):
 *   - createMessage/freezeMessage   (internal; message identity + deep freeze)
 *   - createUserMessage             — agent-loop, agent, cordis-host-runner, tools
 *   - createAssistantMessage        — agent-loop (assistant settlement)
 *   - createSystemMessage           — agent-loop (rendered system prompt)
 *   - createToolResultMessage       — agent-loop (tool results)
 *   - boundContextSummary           — agent (context notice binding)
 *   - HarnessError                  — fs, sandbox, tools (error base)
 *   - LlmError                      — agent-loop (request failures)
 *   - errorChain                    — agent-loop (diagnostic rendering)
 *   - callConfigEquals              — session (request-header folding)
 *   - markAgentLoopRequest/isAgentLoopRequest — agent-loop/invariant
 *   - LlmAttemptId                  — agent-loop (attempt identity brand)
 *
 * Streaming plumbing (BlockAssembler / AssistantStreamAccumulator) lives in
 * dsh-llm-stream.js; this entry re-exports it so the single specifier keeps
 * one module identity.
 *
 * Intentionally NOT here: LlmRuntime, adapters, retry policy, token metering,
 * api-key handling — the real dsh-llm transport lands with W-LLM's vendored
 * package; retiring this shim is a one-row loader-map change.
 */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto';
import { brandString } from '@deepseek-ai/dsh-brand';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';

export {
  AssistantStreamAccumulator,
  BlockAssembler,
} from 'upstream/shims/dsh-llm-stream.js';

/* ---- message value shapes (upstream message.ts) ------------------------- */

/** Bound for a `notice` summary carried by collapsed transcript rows. */
export const CONTEXT_SUMMARY_MAX_CHARS = 120;

/** Bound one `notice` summary to CONTEXT_SUMMARY_MAX_CHARS. */
export function boundContextSummary(summary) {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`;
}

/** Detach and deep-freeze a message whose identity already exists. */
export function freezeMessage(message) {
  return deepFreeze(structuredClone(message));
}

/** Create one identified message and freeze it before publication. */
export function createMessage(input) {
  return freezeMessage({
    ...input,
    id: brandString(randomUUID()),
  });
}

/** Create one identified user-role message and freeze it before publication. */
export function createUserMessage(input) {
  return createMessage({
    ...input,
    role: 'user',
  });
}

/** Create one identified model-produced assistant message, frozen. */
export function createAssistantMessage(input) {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: {
      kind: 'model',
      ...input.source,
    },
  });
}

/**
 * Create and freeze one identified system-role message holding a rendered
 * system prompt; empty text records "no system prompt" as empty content.
 */
export function createSystemMessage(text, plugin) {
  return createMessage({
    role: 'system',
    content: text.length === 0 ? [] : [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  });
}

/** Create and freeze one identified tool-result message. */
export function createToolResultMessage(input) {
  return createUserMessage({
    source: { kind: 'tool', callId: input.callId },
    content: [{
      type: 'tool-result',
      toolCallId: input.callId,
      content: input.content,
      isError: input.isError,
    }],
  });
}

/* ---- error base + typed llm error (upstream error.ts / index.ts) --------- */

/**
 * Harness error base with a stable machine-routable code and chained cause.
 * Route on `code`, never by parsing `message`.
 */
export class HarnessError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** Typed error for LLM-related failures; `failure` retains serializable facts. */
export class LlmError extends HarnessError {
  constructor(message, code, options) {
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('LlmError message must be a non-empty string');
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('LlmError code must be a non-empty string');
    }
    if (options?.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) {
      throw new Error('LlmError status must be an integer from 100 through 599');
    }
    if (options?.providerRetryAfterMs !== undefined
      && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) {
      throw new Error('LlmError providerRetryAfterMs must be a positive finite number');
    }
    if (options?.requestId !== undefined
      && (typeof options.requestId !== 'string' || options.requestId.length === 0)) {
      throw new Error('LlmError requestId must be a non-empty string');
    }
    super(message, code, options);
    this.name = 'LlmError';
    this.failure = Object.freeze({
      message,
      code,
      ...(options?.status === undefined ? {} : { status: options.status }),
      ...(options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs }),
      ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
      ...(options?.offloadImages === undefined ? {} : { offloadImages: options.offloadImages }),
    });
  }
}

/** Render a non-Error thrown value: structured `message` own-property when
 * present (module namespace objects etc.), else the String coercion. */
const renderNonError = (current) => {
  if (typeof current === 'object' && current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'message');
    if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
      return descriptor.value;
    }
  }
  return String(current);
};

/**
 * Render a thrown value with its full `cause` chain and AggregateError
 * members. Diagnostic-surface rendering only — route on HarnessError.code.
 */
export function errorChain(value) {
  const path = new Set();
  const render = (current) => {
    if (path.has(current)) return '<circular cause>';
    path.add(current);
    try {
      if (!(current instanceof Error)) {
        return renderNonError(current);
      }
      const message = current.message === '' ? current.name : current.message;
      const members = current instanceof AggregateError && current.errors.length > 0
        ? ` [${current.errors.map(render).join('; ')}]`
        : '';
      const causeText = current.cause === undefined || current.cause === null
        ? ''
        : render(current.cause);
      const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`;
      return `${message}${members}${cause}`;
    } catch {
      return '<unrenderable value>';
    } finally {
      path.delete(current);
    }
  };
  return render(value);
}

/* ---- call-config identity (upstream call-config.ts) ---------------------- */

const AGENT_LOOP_REQUESTS = new WeakSet();

/** Field-wise equality over one conversation's call configuration. */
export function callConfigEquals(a, b) {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens
  ) return false;
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop;
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i]);
}

/** Mark one exact request object as assembled by dsh-agent-loop. */
export function markAgentLoopRequest(request) {
  AGENT_LOOP_REQUESTS.add(request);
  return request;
}

/** Test whether the exact request object was assembled by dsh-agent-loop. */
export function isAgentLoopRequest(request) {
  return AGENT_LOOP_REQUESTS.has(request);
}

/* ---- brand factory (upstream brand.ts) ----------------------------------- */

/** LlmAttemptId — branded attempt identity; brands are compile-time, so the
 * runtime value is the plain string (upstream dsh-brand is identity at runtime). */
export function LlmAttemptId(id) {
  return brandString(id);
}
