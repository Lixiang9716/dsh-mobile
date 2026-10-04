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
