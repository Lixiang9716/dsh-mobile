# Agent Note: the BYOK adapter carries a contextWindow (compaction capacity)

Status: implemented
Related: T-0209 (the P4 task card this landed under)

## Problem

Long conversations on a BYOK-configured endpoint hard-failed once step
compaction triggered, with the field evidence: warn "step compaction failed:
compaction-basic: no context capacity for openai-compatible/glm-5.3-flash;
configure contextWindow on that adapter model; continuing the turn". The
consumption chain (vendored, pinned): dsh-compaction-basic sizes its pressure
budget from `ctx.llm.resolveModelInfo(provider, model).context.contextWindow`
(`vendor/.../dsh-compaction-basic/lib/index.js:903-907` — `context === void 0`
throws exactly the observed message); the vendored dsh-llm registry sources
that `context` from the registered adapter's own `resolveModel()` and demands
a positive integer when present (`vendor/.../dsh-llm/lib/index.js:2071-2080`,
INVALID_MODEL_CONTEXT). Our `GatewayLlmAdapter.resolveModel` answered only
`{provider, id, name, reasoning}` — never a context — so EVERY gateway-transport
route (BYOK, staged, mock-by-shape) was capacity-less and every long
conversation died at the compaction threshold. The BYOK credential grammar had
no field to even express a model's capacity.

## Decision

The context capacity is threaded end to end as an optional, validated
`contextWindow` (tokens):

- `BYOK_PROVIDERS` rows carry defaults (deepseek 131072 = deepseek-chat's
  documented 128K; openai-compatible 131072 as the configurable reasonable
  default), plus `DEFAULT_CONTEXT_WINDOW` (custom provider ids) and
  `CONTEXT_WINDOW_MAX` = 4,000,000 (above every known model context, below
  absurd garbage — an over-sized window recreates the hard fail this field
  exists to prevent). Page mirror `onboarding-core.js` carries the same
  constants and grammar; `llm-route.js`'s header documents the deliberate
  mirror relationship (the page never imports runtime code).
- `validateCredential` accepts an OPTIONAL `contextWindow`: absent = the
  provider default applies downstream; present must be a safe integer in
  1..CONTEXT_WINDOW_MAX (checked on the page too, via `validateDraft`).
- Persistence: `encodeCredential` rides the field only when present, so older
  stored credentials stay valid; `byokRoute` resolves the effective window
  (override → row default → fallback) — never absent; `rebindLlmRoute` /
  `restoreBootRoute` / boot.js `mountLlm` pass it to the adapter factory;
  `createGatewayLlmAdapter` fail-louds on a non-positive-integer at
  construction (defense in depth; the registry would reject it later anyway).
- The adapter's `resolveModel` answers `context: {contextWindow}` when the
  route configures one, and no context otherwise — the mock route keeps its
  byte-identical windowless shape (E2E determinism boundary untouched).
- Staged routes opt in via a new `runtime.config llmContextWindow`
  (fail-loud when malformed, like every staged field); the onboarding form
  pre-fills each row's default and the user may override (empty = default);
  `draftFingerprint` covers the window so a probe on one window cannot save
  another.

## Alternatives considered

- Hard-code the capacity inside `GatewayLlmAdapter.resolveModel` (e.g. always
  answer 131072): rejected — the number is a per-credential/per-model fact,
  not a transport fact; a one-size answer silently mis-sizes compaction for
  smaller endpoints and cannot honor 1M-era models. Rejected also because the
  mock route must stay windowless (the scripted boundary pins that shape).
- Extend the vendored compaction/llm packages with a fallback constant:
  rejected — D6 upstream discipline; vendored trees are pinned and unedited,
  adaptations live in our outboard layers.
- Answer the capacity from a models-directory catalog lookup instead of the
  credential: rejected for this round — the BYOK surface has no catalog rows
  (one credential, one model); the optional override + documented defaults
  solves the reported failure without inventing a catalog seam. If a
  multi-model BYOK surface arrives, the route's `contextWindow` field is the
  natural place for a per-model map to grow from.
