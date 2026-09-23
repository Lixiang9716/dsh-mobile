// dsh:logging-exempt (pure projector: the parity harness logs through its drivers)
/**
 * parity-projector — the SHARED normalizer of the upstream parity check.
 *
 * Both legs of the differential — the Node reference leg
 * (runtime/spike/ci/parity-reference.mjs) and the quickjs port leg
 * (runtime/spike/scenario/upstream-parity.js) — run THIS module over the
 * authoritative upstream session log (`session.snapshotEvents()`), and the
 * comparator (ci/parity-compare.mjs) diffs the two projections line by line.
 * Sharing the projector is what makes the diff meaningful: any difference the
 * comparator reports is a difference the SAME vendored packages produced
 * under two hosts, not a difference of measurement.
 *
 * Projection rules (the parity boundary, stated as code):
 *   - KEEP everything deterministic: turn/step numbering, user input text,
 *     assistant content blocks (text/tool-call identity + arguments), tool
 *     call arguments, tool result payloads, finish reasons, projection state
 *     (turnBoundary, the todo list written by the tool round).
 *   - MASK environment-dependent fields to their shape: the rendered system
 *     prompt (embeds the container cwd and the mounted tool roster, which
 *     legitimately differ between the full mobile profile and the reference
 *     spine) keeps only its section plugin; `request/context` (env + cwd
 *     facts) keeps only its identity. A field is masked by REPLACEMENT, never
 *     by omission — the seq/type skeleton stays comparable.
 *   - Every record projects to `{ seq, type, ...fields }`; unknown record
 *     types project to their skeleton (a new upstream vocabulary element
 *     shows up as a skeleton diff on both legs, never silently).
 */
export const PARITY_PROJECTOR_VERSION = 1;

/** Deterministic block projection for assistant content. */
const blockFields = (block) => {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'reasoning') return { type: 'reasoning', text: block.text };
  if (block.type === 'tool-call') {
    return { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments };
  }
  if (block.type === 'tool-result') {
    return {
      type: 'tool-result',
      toolCallId: block.toolCallId,
      text: (block.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
    };
  }
  return { type: block.type };
};

/** Flatten a message to its deterministic projection. */
const messageFields = (message) => ({
  role: message.role,
  blocks: (message.content ?? []).map(blockFields),
});

/** Per-type field projectors (the parity boundary table). */
const PROJECTORS = {
  'turn/start': (d) => ({ turn: d.turn }),
  'step/start': (d) => ({ turn: d.turn, step: d.step }),
  'step/end': (d) => ({ turn: d.turn, step: d.step }),
  'system/message': (d) => ({ plugin: d.message?.source?.plugin ?? null }),
  'user/message': (d) => ({ blocks: (d.content ?? []).map(blockFields), source: d.source?.kind ?? null }),
  'assistant/message': (d) => ({
    ...messageFields(d.message ?? {}),
    provider: d.message?.source?.provider ?? null,
    model: d.message?.source?.model ?? null,
  }),
  'assistant/attempt': (d) => ({ code: d.failure?.code ?? d.code ?? null }),
  'tool/call': (d) => ({ tool: d.tool ?? d.name ?? null, arguments: d.arguments ?? null }),
  'tool/result': (d) => messageFields(d.message ?? {}),
  'todo/write': (d) => ({ todos: d.todos ?? null }),
  'request/header': (d) => ({ reason: d.reason ?? null }),
  'request/context': (d) => ({}),
  'turn/end': (d) => ({ turn: d.turn, reason: d.reason?.kind ?? null }),
};

/** Project the whole session log (ordered) into comparable records. */
export const projectSessionEvents = (events) => {
  const out = [];
  for (const record of events) {
    const type = record.type;
    const fields = (PROJECTORS[type] ?? (() => ({})))(record.data ?? {});
    out.push({ seq: record.seq, type, ...fields });
  }
  return out;
};

/** Project the projection-plane state the parity check asserts alongside the
 * log: turn boundary count + the todo list the tool round wrote (both
 * deterministic). Extra keys are the caller's. */
export const projectProjectionState = (state) => state;
