// upstream/model-selection-projection.js — the mobile composition's
// modelSelection projection unit (issue #306).
//
// The desktop composition registers this unit through
// dsh-api-session-controller (lib/types/model-selection-projection.js at the
// pin, applied via `installModelSelectionProjection`); the Phase-B seat does
// not apply that controller, so without a registration the journal's
// `projections` map stays empty and dsh-client-ui-model-selection's
// projected store never leaves "loading" — the composer model dialog hangs
// on "Loading models…" even though `session/modelCatalog` answers. This
// unit rides the session-projection registry's designed extension seam with
// the SAME key, state fold, and client view as the vendored definition, so
// the client reads `projections.modelSelection.next` unchanged.
//
// State fold (mirrors the pin exactly):
//   - `model/selection` event → the intent becomes `pending`;
//   - `request/header` event  → `lastUsed` adopts the served request's
//     {provider, model, reasoningEffort?}; a pending intent equal to the
//     served selection clears (it has been honored).
// View: `{lastUsed, next: pending ?? lastUsed}`.

const sameSelection = (left, right) =>
  left === right || (left !== null && right !== null &&
    left.provider === right.provider && left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort);

export const modelSelectionUnit = {
  key: 'modelSelection',
  init: () => ({ lastUsed: null, pending: null }),
  apply: (state, event) => {
    if (event.type === 'model/selection') {
      return sameSelection(state.pending, event.data) ? state : {
        lastUsed: state.lastUsed,
        pending: event.data,
      };
    }
    if (event.type !== 'request/header') return state;
    const lastUsed = {
      provider: event.data.header.config.provider,
      model: event.data.header.config.model,
      ...(event.data.header.config.reasoningEffort === undefined ? {} : { reasoningEffort: String(event.data.header.config.reasoningEffort) }),
    };
    const pending = sameSelection(state.pending, lastUsed) ? null : state.pending;
    return sameSelection(state.lastUsed, lastUsed) && pending === state.pending ? state : {
      lastUsed,
      pending,
    };
  },
  wire: {
    view: (state) => ({
      lastUsed: state.lastUsed,
      next: state.pending ?? state.lastUsed,
    }),
  },
  stateVersion: 2,
};
