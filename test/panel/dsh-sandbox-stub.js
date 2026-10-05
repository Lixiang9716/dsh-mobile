// dsh-sandbox-stub.js — the panel tool-face suites' @deepseek-ai/dsh-sandbox:
// only the module-level names the vendored tool-fs / tool-str-replace-editor
// imports pull (the sandbox policy faces are not the behavior under test —
// the runner's ctx exposes no sandboxMode, so MutationPolicy stays off and
// the escalation helpers never execute).
export const ESCALATION_TARGETS = [];
export const approveEscalation = async () => {
  throw new Error('dsh-sandbox-stub: approveEscalation is not part of the tool-face suites');
};
export const escalationHintMarker = () => '';
export const sandboxDenialMarker = (mode) => `sandbox-denied:${mode}`;
export const validateEscalationArgs = () => {};
