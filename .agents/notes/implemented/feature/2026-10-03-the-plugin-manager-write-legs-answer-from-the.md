# Agent Note: the pluginManager write legs answer from the real backend; the dynamicCordisRunner legs answer runtime-side

Status: implemented
Related: issue #335 (A1 + B3, the audit's two wiring-gap items); builds on
the workspace registry tier (#334) and the marketplace face it reused

## Problem

The release seat reported two structured `gateway/unimplemented` errors on
EVERY official-page load: `dynamicCordisRunner/inventory` (the ui-cordis
panel's refresh) and `dynamicCordisRunner/syncInspectManifest` (the
cordis-client-runner's inspect sync). Separately, the pluginManager face
claimed only its two LIST legs — all six write verbs
(installBundle/removeBundle/setBundleEnabled/setPluginEnabled/inspect/
cancelInstall) answered the carrier's structured unimplemented, even though
the real backend EXISTS in the same closure: the §4 install pipeline
(install-fetch.js + install-pipeline.js), the append-only receipts journal,
and the marketplace resolver the marketplace face already runs on. The
Creator composition's `tool-plugin-manager` tool (enabled since #334) could
list plugins but could not install one.

## Decision

- **Six write legs, one state pair** (upstream/web-write-plugin-manager.js):
  every verb operates on exactly the two planes the marketplace face
  already proved — the receipts journal (the §4 install record of truth)
  and the workspace `dsh.plugins/1` registry (`plugins/registry.json`).
  installBundle adopts BARE registry names resolved from the staged
  marketplace index through the REAL installFromFetch with the verified
  index's trust record, then upserts the registry row; removeBundle drops
  the committed tree, appends the §4 remove receipt, drops the row;
  setBundleEnabled/setPluginEnabled flip the registry row's enabled flag;
  inspect reads the installed tree's manifest.json (re-validated) or the
  staged index entry; cancelInstall answers `not-running` (v1 runs no
  cancellable background install). Idempotent re-adoption answers
  `changed: false`.
- **The workspace scope is the v1 security boundary.** No host processes,
  no pnpm, no path/git/tarball specs — those refuse in-band
  (`invalid-spec`/`unaddressable`) because their honest execution needs the
  subprocess-class seams the mobile D-rules forbid. What installs is only
  what a signature-verified catalog vouches for, into the sandboxed
  workspace scope.
- **Refusals are in-band; handlers never throw.** The ChangeResult legs
  answer `application: 'failed'` with the vendor ManagementError vocabulary
  (catalog miss → `unknown-plugin`, unstaged source → `unaddressable`,
  everything else → `operation-error` with the real message as diagnostic);
  inspect answers the `refused` problem vocabulary. A thrown exception
  would ride the resident dispatcher's rejection path and kill the whole
  drive (the #312 lesson). The ONE throw is syncInspectManifest's
  malformed-args rejection — a null-only result has no in-band failure
  member, so the gateway RemoteError envelope is that call's designed
  error channel.
- **The workspace tier of the LIST legs becomes the manageable one**: its
  rows carry `patchId: 'plugins/registry.json'` (the union's manageable
  member — the registry IS the persistent patch target) instead of
  `readOnlyReason`, and the workspace bundle reports
  `removable === installed`. The spine and staged tiers stay read-only.
  `managementAvailable` stays FALSE: it gates the desktop plugin-manager
  SIDEBAR panel whose machinery (profile bundles, pnpm, restart-required)
  this host still does not offer; the settings 内置插件 section reads the
  legs without that gate.
- **The two dynamicCordisRunner legs answer from real runtime state**
  (upstream/web-write-cordis.js): inventory returns `[]` when the runner
  service is not mounted — the mobile spine mounts no dynamic-package
  runner and nothing defines dynamic cordis packages, so the empty roster
  IS the true state (and forwards to the service's own inventory() if a
  future boot mounts one); syncInspectManifest validates the manifest and
  records it as runtime state (the last synced client provider directory).
  Filling spine services into the dynamic-package row shape was rejected —
  the panel would render static mounts as retractable dynamic plugins.
- **tool-cordis stays disabled** (evidence over appetite): its tools need
  the `cordisInspect` HOST service, which only the vendored
  cordis-host-runner provides (its HostInspectRegistry,
  vendor/dsh/cordis-host-runner@0.1.6-alpha.2/lib/index.js:723), plus the
  `resolveInspectQuery` leg and the cordis/inspect-query event loop the
  runner owns — the two B3 legs are necessary but not sufficient. The row
  would park forever on its inject. Recorded as the #335 B follow-up.
- **Where things live**: web-write.js stays a router — the 插件 api
  entries (snapshot + LIST + WRITE + cordis legs) assemble in
  web-write-inventory.js (makePluginInventoryApiEntries), the write legs
  live in web-write-plugin-manager.js, the cordis legs in
  web-write-cordis.js. The two device scenarios' manager-leg probes are ONE
  shared module (scenario/manager-legs-probe.js) asserting the three-tier
  truth (two read-only bundles, the manageable workspace tier, the
  patchId/read-only row split) — their frozen manifests
  (composer-live-write.json, settings-surfaces.json) need re-freezing from
  the next device drive. Staging: the three new files registered in the
  harmony closure list (vendor-official.sh SPINE_OURS + Index.ets
  BUNDLE_FILES), the iOS embed list (gen_bundle_header.py) and the android
  scenario list.

## Alternatives considered

- **Claim installBundle as a full pnpm path** (the desktop semantics):
  rejected — it needs host process execution, which the mobile D-rules
  forbid; a scripted pretend-install would be exactly the mock surface
  issue #335 exists to retire.
- **Mount the vendored cordis-host-runner to answer dynamicCordisRunner
  properly**: rejected for this round — the runner brings the whole dynamic
  package lifecycle (runHostHalf, sandbox guards, timers, the web fetch
  seam); mounting it is the #335 B carrier work, and shipping the two
  honest legs now stops the per-load unimplemented noise without faking
  the rest.
- **Keep the workspace LIST rows read-only while claiming the write legs**:
  rejected — self-contradictory on the wire; the page would render controls
  as locked while the verbs answer. The per-row disposition must match what
  the manager actually handles.
- **Flip `managementAvailable` to true** so the desktop panel opens:
  rejected — the panel's install dialog sends arbitrary specs (paths, git
  URLs) that this host can only refuse; a wall of honest failures is worse
  UX than the panel staying closed. Owner decision, recorded as follow-up.
- **Throw remoteError triples from the write legs** (the settings legs'
  pattern): rejected — the ChangeResult/inspection vocabularies ARE the
  wire's designed in-band failure shapes for these verbs; using them keeps
  the #312 wedge class structurally impossible on these legs.

## Consequences

- The pluginManager face is fully claimed (8/8 legs): the Creator
  composition's plugin-manager tool can now install a catalog-vouched
  package end-to-end through the product's own §4 pipeline, and the
  插件 settings panel can enable/disable/remove workspace-scope plugins.
- Page loads stop reporting the dynamicCordisRunner unimplemented pair;
  the ui-cordis panel renders its real (empty) roster.
- The panel suite drives the REAL install transaction under node (the
  gateway shim's in-memory fs + routed http): 24 new cases across the six
  write legs (in-band success and refusal per leg), the strict registry
  read, and the two cordis legs.
- Known follow-ups: re-freeze the two device manifests from a real drive;
  the `cordisInspect` host-service mount for tool-cordis (#335 B); the
  managementAvailable product decision.
