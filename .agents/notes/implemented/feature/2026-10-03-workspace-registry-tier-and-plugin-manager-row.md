# Agent Note: the workspace registry tier answers in the plugin manager LIST legs — and Creator mode keeps its plugin-management row

Status: implemented
Related: T-0170, #321-adjacent (the one-sentence-creation path), #330

## Problem

The one-sentence-creation turn (T-0170: "install it through the plugin
pipeline") produced a complete, self-checked plugin (`countdown10`, registry
`dsh.plugins/1` v1) that was **invisible to the product**: the plugin-manager
panel's LIST legs answered only the runtime spine and the staged client
tiers, and the Creator composition's `tool-plugin-manager` row was force-
disabled at seed by `preset-mobile-rows.js`'s MOBILE_ABSENT_ROW_IDS — a
2026-09-24 decision ("no vendored package, nothing to port — D9") whose
premise is now false: `@deepseek-ai/dsh-plugin-manager` and
`@deepseek-ai/dsh-tool-cordis` are both staged and embedded in the release
APK, and the plugin-manager wire face carries the full verb set
(installBundle/removeBundle/inspect/set*Enabled) — the install verb the
standard-mode agent was measured lacking.

## Decision

Two changes, deliberately read-only:

1. `preset-mobile-rows.js` removes `tool-plugin-manager` from the absent set
   (the package is staged; its LIST legs answer from the inventory). The row's
   write verbs still refuse honestly — the seat does not claim
   `pluginManager/installBundle`/`removeBundle`/`set*Enabled` yet; that is the
   named follow-up, backed by the same install-pipeline the marketplace face
   uses. `tool-cordis` stays absent: its `dynamicCordisRunner/*` legs are
   unimplemented by the Phase-B carrier, so the row would only ever error.
2. `web-write-inventory.js` grows a **workspace registry tier** in the
   pluginManager LIST legs: `deps.workspaceRegistry` (optional provider —
   wired in composer-web-live.js over `gateway.fsRead('app',
   'plugins/registry.json')`) answers the agent-authored `dsh.plugins/1`
   entries as read-only rows (`fiberPhase: null`,
   `readOnlyReason: 'management-required'`), and listBundles gains a
   `workspace-registry` bundle (installed iff entries exist). Absent registry
   → empty tier (the normal pre-creation state, err.code 'io'); malformed
   registry → reject loud (rule 5); no provider → rows absent, the
   historical shape. The pluginInventory/list snapshot is untouched.

## Alternatives considered

- Also enabling `tool-cordis`: lost — without the carrier's
  dynamicCordisRunner legs the tool can only error; the row returns to the
  absent set when the carrier grows the legs.
- Adopting workspace entries into the host receipt journal (the marketplace
  install ledger): lost for now — it would blur the trust story (workspace-
  sandbox files vs profile-wide installs, the preset yml's own TRUST header);
  the read-only tier says honestly what runs where. The adopt seam remains
  the follow-up if the panel needs write actions.
- A new agent tool `plugin_install` (contract proposal): still the right end
  state for the install verb; not this change — this change is the
  visibility half the panel needs first.

## Consequences

Verification: panel 97/97 (the new workspace-registry-tier suite covers the
tier, the empty state, the no-provider shape, and the loud rejection); the
#325 preset-health suite stays green with `tool-plugin-manager` resolvable
(the package is staged). Device proof lands as a PR comment: the Plugins
panel's LIST legs answer the `countdown10` entry authored by the T-0170
Creator turn.
