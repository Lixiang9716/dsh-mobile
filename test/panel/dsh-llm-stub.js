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
        super(message, code, options);
        this.failure = Object.freeze({
            message,
            code,
            ...options?.status === undefined ? {} : { status: options.status },
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
