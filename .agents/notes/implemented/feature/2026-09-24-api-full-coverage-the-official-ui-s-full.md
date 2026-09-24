# Agent Note: api-full-coverage: the official UI's full endpoint surface rides the vendored spine behind the fullCoverage gate

Status: implemented
Related: D9

## Problem

The Phase-B iOS carrier forwards only the endpoints the RUNTIME claimed —
everything else answers `gateway/unimplemented`, and at 11a6701 the claim set
was 17 rows (the write surface's session/settings/presets/inventory legs).
The official web UI calls far more: the workspace sidebar, the file preview,
the @-mention lexicon, the "/" skill and command candidates, the goal panel,
the directory browser, the archive set. Every one of those features sat dead
in the official page on the device, showing the gap — architecturally honest,
but the owner ordered the gap CLOSED wherever a real vendored spine service
exists to back it. The constraint that made this non-trivial: the delivered
E2E manifests (e.g. composer-live-write.json) pin the exact claim row set, so
an unconditional claim expansion would go red on every existing leg.

## Decision

The write surface grows a COVERAGE plane, claimed only when the write options
carry `fullCoverage: true` (default OFF — every existing leg boots
byte-identically, pinned manifests untouched):

- 26 new unary endpoints, each backed by a real vendored service:
  workspaceFiles/{stat,list,read,readAll,readBytes,readRelated} over
  dsh-fs-local (semantics ported from packages/api/workspace-files: same
  caps, same workspace-file/* error vocabulary, page cutting over streamText);
  workspace/{create,rename,delete,insertBefore,insertSessionBefore,
  archiveSession,unarchiveSession} over the in-memory registry the
  workspace/follow baseline already serves, each mutation publishing its
  follow increment; directoryPicker/{list,createDirectory} (browse
  capability; `pick` stays off — native OS chooser); skills/list over
  ctx.skills (the upstream user-invocable filter + wire projection);
  fileReferences/list over the newly mounted dsh-file-reference-local;
  goals/{get,create,edit,pause,resume,complete,clear} over the newly mounted
  dsh-goal GoalService; commands/{list,execute} over the dsh-commands
  registry. One new stream: workspaceFiles/changes (the fs/observed change
  feed, mux-shaped, with cancel).
- boot.js grows two gated rows mirroring the skills/commands pattern:
  `options.goals` mounts dsh-goal (injects agents+sessionProjections, both
  present), `options.fileReferences` mounts dsh-file-reference-local.
- New adapters: upstream/web-write-{files,picker,workspace,catalog,coverage}.js
  (the last splits the composition off web-write.js at the code-size gate);
  web-write.js re-exports COVERAGE_ENDPOINTS/COVERAGE_STREAMS so its public
  face stays one module. The iOS embed (gen_bundle_header.py) carries the new
  adapters plus the three vendored package trees the gated mounts need.
- Still honestly unclaimed (documented in web-write-coverage.js): terminal/*
  (a persistent PTY needs a process seam the wasmRun/ishRun one-shot gateway
  primitives do not offer — a contract proposal, not an adapter),
  credentials/set|unset (the staged profile credential is not writable
  through the wire), directoryPicker/pick, settings' desktop OS/document
  surfaces, and the session/* legs the mobile profile does not serve.
- Evidence: scenario/api-coverage-probe.js drives every new handler AND the
  honest gaps on the spike CLI (PASS); upstream parity stays EXIT 0 with
  identical records; code-size clean.

## Alternatives considered

- Claim expansion unconditional (grow WRITE_ENDPOINTS): simplest diff, but it
  changes the api.claim row set every delivered manifest pins — composer-
  live-write.json would fail on untouched legs. Lost to the gated shape.
- Claiming terminal/* over wasmRun/ishRun: the wire's terminal surface is a
  persistent PTY (spawn/write/resize/close + output follow); the mobile shell
  primitives are one-shot tool runs with no process continuity, so any
  handler would be a fake terminal wearing the wire's clothes (D9 forbids
  inventing product behavior). Left unclaimed; the gap names the missing
  gateway primitive instead.
- Mounting dsh-credentials-local to answer credentials/set: the write would
  land in a store the booted LLM route never re-reads (the transport adapter
  binds the staged credential at boot), so the UI would report a credential
  change that changes nothing. Unclaimed beats dishonestly writable.
- Porting the upstream WorkspaceFiles service verbatim: it injects
  sandboxPolicy + typert, neither mounted on the mobile spine. The adapter
  ports its semantics (caps, error codes, page cutting) over ctx.fs and the
  container root instead — narrower, but every wire answer matches the pin.
