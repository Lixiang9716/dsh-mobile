# Agent Note: the marketplace catalog carries every system plugin — the publish pipeline unblocks

Status: implemented
Related: tools/gen-marketplace-index.mjs, the #283 publish pipeline;
found by the 2026-10-08 device-verification round (T-0172 four proofs +
T-0177 device confirmation)

## Problem

`tools/gen-marketplace-index.mjs` aborted at HEAD for every caller:

    gen-marketplace-index: deploy/marketplace/summaries.json has no
    {en,zh} summary for dsh-plugin-manager-tools

`dsh-plugin-manager-tools` joined `system-plugins/` on 2026-10-04 (issue
#346 item 3, the session toolset's plugin pipeline) but never got a catalog
summary row, and the generator correctly fails loud (rule 5) on the gap —
so the CI publish job (#283) has been unable to cut a signed catalog since
that plugin landed. The device round hit it first: staging a marketplace
opt-in for the release seat's `pluginManager/installBundle` cycle requires
a generated catalog, and the generator refused.

## Decision

Two pieces:

1. `deploy/marketplace/summaries.json` gains the missing
   `dsh-plugin-manager-tools` row ({en, zh}) — the catalog now covers all
   ten system plugins and the generator packs the full tree again
   (verified: a full run packs 10 packages + index).
2. `tools/gen-marketplace-index.test.mjs` — a data-level regression net in
   the tools-face suite (`tools/test/run-tools-tests.sh`): every
   `system-plugins/<pkg>` with a `manifest.json` must have a summaries row
   with non-empty `en` and `zh`, and every row must be exactly `{en, zh}`.
   Falsified per rule 6: with the row stashed the suite goes red naming
   `dsh-plugin-manager-tools`, green with it. The next plugin lands with
   its row or CI says so — the generator's own fail-loud stays as the
   publish-time backstop.

## Alternatives considered

- **Weaken the generator to warn-and-skip plugins without summaries**:
  rejected — a signed catalog missing an installed-by-default plugin would
  ship a silent gap into every deployment's 内置插件 browse face; fail-loud
  at publish time is the honest posture (rule 5), the fix is the data.
- **Generate the summary from the manifest description**: rejected — the
  manifest schema is frozen with additionalProperties: false precisely so
  display data stays out; the summaries file IS the display-data home, the
  row just has to be written.
- **Hand-check only, no test**: rejected — this is the third
  plugin-since-last-publish gap waiting to happen; a data-level suite in
  the tools net costs nothing and catches it at PR time.
