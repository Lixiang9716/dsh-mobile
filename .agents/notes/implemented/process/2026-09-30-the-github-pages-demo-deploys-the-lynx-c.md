# Agent Note: the GitHub Pages demo deploys the lynx-client web render as a static recipe

Status: implemented
Related: D5

## Problem

The lynx-client pilot (#248) proved the ReactLynx bundle renders on the
@lynx-js/web-core platform, but the proof lived in an ad-hoc probe: the
web-target build output (`dist-web/`) and the screenshots are gitignored, no
committed script stages the page, and nobody outside the pilot worktree could
see what the product looks like. Early reviewers (P2 pulled forward, owner's
call) need a URL, not a build recipe. The gap: no reproducible path from
`presentation/lynx-client/` sources to a publicly reachable render of the
bundle — and, until the owner flips Settings → Pages → Source: "GitHub
Actions", no Pages target exists at all (the deploy workflow fails on first
run by design, which had to be stated up front rather than silently retried).

## Decision

`.github/workflows/pages.yml` deploys the demo: on `workflow_dispatch` and on
main-pushes touching `presentation/lynx-client/**` it runs the pinned install
(committed `bundle/package-lock.json` via `npm ci`, npmmirror registry as the
fallback), builds the web target (`npm run build:web` → `dist-web/main.web.bundle`),
pins `@lynx-js/web-core@0.26.2` into a scratch prefix (`.pages-runtime/`,
build-time only — the product dependency set is unchanged), and stages
`demo/index.html` + the generated `theme/web.tokens.css` (dark face, light
media block mechanically dropped — the bundle is a dark-fixed pilot face) +
the bundle + the web-core static client into the Pages artifact via
`demo/stage-pages.sh` — the same script verified locally and in CI. The page
is the official static recipe (client.js + client.css + `<lynx-view
url="./main.web.bundle">`, all paths relative for subpath hosting), carries
zero palette of its own (every color is a token custom property from the
generated web face), and states honestly in-page that it is a static shell
with no session backend. Permissions follow the official Pages pattern
(`pages: write` + `id-token: write`, concurrency group "pages", github-pages
environment). Zero `contract/` or gateway surface is touched (D5 boundary
holds — the pilot's constraint carries to its deployment).

## Alternatives considered

- **CDN runtime (unpkg/jsdelivr) referenced from index.html**: rejected — a
  third-party runtime dependency on the page's critical path, unpkg reach
  from the likely reviewer region is unreliable, and the deployed page would
  drift from any pinned audit. Self-hosting the pinned 1.4 MB static client
  keeps the artifact self-contained and the version named in the workflow.
- **Committing the web-core runtime into the repo**: rejected — 1.4 MB of
  minified dist under version control duplicating a pinned npm package; the
  workflow pin (`@lynx-js/web-core@0.26.2`) plus verbatim staging gives the
  same reproducibility without the blob.
- **Adding `@lynx-js/web-core` to `bundle/package.json`**: rejected — it is
  the deployment vehicle, not product machinery; the ask forbids new product
  dependencies and the scratch-prefix install keeps `npm ci` output
  byte-identical for the product build.
- **Inlining a copy of the dark tokens in the page**: rejected — drifts from
  the token single source (`theme/tokens.json`); instead the page consumes the
  generated `web.tokens.css` with one mechanical transform (drop the
  light-scheme media block), so values still flow from tokens.json alone.
- **Fixing the inner layout fidelity in the bundle**: rejected for this PR —
  the bundle is the product payload verified on native legs; the web probe's
  row-direction gap (x-views render stacked on web-core 0.26.2 static recipe —
  the bundle's `--flex-direction` inline vars are not consumed by the
  element's stylesheet, container-style-query rules for `--lynx-*` are not
  injected in script-tag mode) is demo-side documented, and belongs upstream.

## Consequences

- First Pages run fails at configure-pages/deploy-pages until the owner
  enables Pages — expected, stated in the workflow header and the PR.
- The demo's web render fidelity is shell-level (chrome + composer present;
  inner rows stack): reviewers see the product's face, not device pixels —
  device parity remains the LynxExplorer/on-device round, as the pilot
  recorded.
- Every main-push touching `presentation/lynx-client/**` redeploys; the
  committed lockfile pins the product install, the workflow pins the runtime.
