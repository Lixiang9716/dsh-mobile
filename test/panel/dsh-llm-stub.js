// dsh:logging-exempt (test double: the panel suite's @deepseek-ai/dsh-llm)
/**
 * dsh-llm-stub.js — the panel suite's @deepseek-ai/dsh-llm double (the
 * dsh-tools-stub precedent): only the two message utilities the turn-recovery
 * supervisor uses, with the vendored shapes it relies on. The vendored
 * package itself needs zod + schemastery, which the suite's provisioned
 * node_modules does not carry — the alias in vitest.config.js maps here.
 */

/** The vendored createSystemMessage shape (llm@lib createMessage, role
 * system): text content blocks + the plugin source tag. */
export const createSystemMessage = (text, plugin) => ({
    role: 'system',
    content: text.length === 0 ? [] : [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
});

/** The vendored errorChain projection the supervisor names in the note:
 * the message with its error-class prefix chain. */
export const errorChain = (error) => {
    if (error === undefined || error === null) return String(error);
    const message = error instanceof Error ? error.message : String(error);
    return error.cause !== undefined ? `${message} (caused by: ${errorChain(error.cause)})` : message;
};

// ---- the adapter-seam faces (loop-u2): the four names upstream/
// llm-transport.js imports, mirroring the vendored shapes (llm@lib/types:
// HarnessError, LlmError, LlmAdapter, attribution, call-config).

/** The vendored HarnessError base: `code` beside the message, standard
 * ErrorOptions cause chaining, name = the concrete class. Exported since
 * loop-v2: the vendored @deepseek-ai/dsh-fs extends it (its FsError:
 * `super(message, code, options)` then `this.code = code`) — the tool-face
 * suite drives the vendored fs-local, whose module graph loads dsh-fs at
 * import time, and this stand-in keeps that graph loadable without the full
 * dsh-llm package (zod + schemastery). */
export class HarnessError extends Error {
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
        this.name = new.target.name;
    }
}

/** The vendored LlmError: non-empty message + code, frozen serializable
 * failure facts beside the live error (llm@lib/types LlmError). */
export class LlmError extends HarnessError {
    constructor(message, code, options) {
        if (typeof message !== 'string' || message.length === 0) {
            throw new Error('LlmError message must be a non-empty string');
        }
        if (typeof code !== 'string' || code.length === 0) {
            throw new Error('LlmError code must be a non-empty string');
        }
        if (options?.providerRetryAfterMs !== undefined
            && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) {
            throw new Error('LlmError providerRetryAfterMs must be a positive finite number');
        }
        super(message, code, options);
        this.failure = Object.freeze({
            message,
            code,
            ...options?.status === undefined ? {} : { status: options.status },
            ...options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
        });
    }
}

/** The vendored LlmAdapter base: the seam subclasses it; the panel suite
 * never calls the base's own faces. */
export class LlmAdapter {}

/** The vendored attribution headers (llm@lib attribution): plain static
 * fields here — the suite asserts transport behavior, not header values. */
export const attributionHeaders = () => ({ 'user-agent': 'dsh-panel-stub' });

/** The vendored call-config marker check: the suite's requests are never
 * marked. */
export const isAgentLoopRequest = () => false;

// ---- the retry-policy face (loop-c2): resolveRetryPolicy, mirroring the
// vendored normal-shape resolution (llm@lib retry-policy: key validation,
// the 500/10000/0.1/5 defaults, DEFAULT_RETRYABLE_CODES, fail-loud, freeze).
// The suite asserts the seam's resolved values against these vendored
// numbers; the mobile route's only override is backoff.maxDelayMs.

const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];
const BACKOFF_KEYS = new Set(['initialDelayMs', 'maxDelayMs', 'jitterRatio']);
const NORMAL_POLICY_KEYS = new Set(['mode', 'maxRetries', 'retryableCodes', 'backoff']);

const resolveBackoff = (config, path) => {
    if (config !== undefined) {
        for (const key of Object.keys(config)) {
            if (!BACKOFF_KEYS.has(key)) throw new Error(`${path}: unknown key "${key}"`);
        }
    }
    const initialDelayMs = config?.initialDelayMs ?? 500;
    const maxDelayMs = config?.maxDelayMs ?? 10_000;
    const jitterRatio = config?.jitterRatio ?? 0.1;
    if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) throw new Error(`${path}.initialDelayMs must be a positive finite number`);
    if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) throw new Error(`${path}.maxDelayMs must be a positive finite number`);
    if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`);
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new Error(`${path}.jitterRatio must be between 0 and 1`);
    return Object.freeze({ initialDelayMs, maxDelayMs, jitterRatio });
};

/** The vendored resolveRetryPolicy for the `normal` shape the gateway route
 * declares (llm@lib resolveRetryPolicy:309). */
export const resolveRetryPolicy = (config, path) => {
    if (config === undefined) {
        return Object.freeze({ mode: 'normal', maxRetries: 5, retryableCodes: DEFAULT_RETRYABLE_CODES, ...resolveBackoff(undefined, `${path}.backoff`) });
    }
    if (config.mode !== 'normal') throw new Error(`${path}: the stub resolves only the normal policy shape`);
    for (const key of Object.keys(config)) {
        if (!NORMAL_POLICY_KEYS.has(key)) throw new Error(`${path}: unknown key "${key}"`);
    }
    const maxRetries = config.maxRetries ?? 5;
    const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES];
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${path}.maxRetries must be a non-negative safe integer`);
    return Object.freeze({
        mode: 'normal',
        maxRetries,
        retryableCodes: Object.freeze([...retryableCodes]),
        ...resolveBackoff(config.backoff, `${path}.backoff`),
    });
};
