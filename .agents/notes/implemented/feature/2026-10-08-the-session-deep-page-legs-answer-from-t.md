# Agent Note: the session deep-page legs answer from the spine — page/search/rename/updateQueue + the opener gate + the honest preset catalog

Status: implemented
Related: D9, T-0049 (item 3, the tail), T-0050 (item 1)

## Problem

The official page's transcript face drives five session-controller legs the
seat never claimed — `session/page` (the deep history pager),
`session/search` (cross-session text search), `session/rename` (the user
title), `session/updateQueue` (edit/remove/steer on the pending inbox), and
the `session/canOpenWorkspacePath` opener gate — so every one of those
interactions ended in the carrier's `gateway/unimplemented` envelope. The
wire contracts already exist in the composed `dsh-api-remotes` descriptors
and the upstream controller sources are readable in the dsh-tests tree at
the same pin, so the answers were derivable from the spine; the coverage
probe still pinned the five as must-stay-unclaimed, a stale pin against
wire the page already speaks (the same stale-pin shape the fork round
fixed).

## Decision

`upstream/web-write-session.js` (a new adapter beside web-write-catalog,
spread into the HISTORICAL claim set — these ride ctx.sessions/ctx.agents,
which every boot has) mirrors the upstream session-controller semantics at
the pin, narrowed to the attached-store subset:

- `session/page` (history.ts commands.page): the cursor validation and
  message-aligned BACKWARD pagination math verbatim — `throughSeq: -1` is
  the empty below-log page, the cut lands on the maxMessages-th message's
  whole source group, records are the same SessionEventEntry projection
  the follow snapshot serves (`wireEvent`), and the unknown-address
  rejections keep the upstream split (session kind → `session/not-found`,
  subagent kind → `subagent/not-found`; the origin checks stay because
  they are cheap and unreachable here).
- `session/search` (list.ts commands.search): the query normalization and
  the 20-row/240-code-point bounds; the cold sqlite corpus
  (dsh-session-query) is not mounted, so the attached logs are scanned
  directly — case-insensitive literal substring over append-origin
  user/assistant message text, one snippet per session, newest-first.
- `session/rename` (commands.rename → SessionTitleService.rename): the
  session-title normalization (OSC/CSI/ESC/control strips, whitespace
  collapse, the 40-byte UTF-8 budget — the deployment value the
  controller's rename spec pins), the `session/title-invalid` refusal,
  and the durable `session/title` append (`{title, messageSeqs: [],
  source: {kind: 'user'}}`). No automatic title generation exists here,
  so the rename only pins.
- `session/updateQueue` (commands.updateQueue): the text-only edit rule
  (`session/attachment-invalid`/QUEUE_EDIT_NON_TEXT), the locate-in-
  nextTurn-then-nextStep walk, `session/queue-item-not-found` for
  unknown items AND unknown sessions (the controller's own cold-resolve
  mapping), `session/steer-unavailable` unless the item sits in next-turn
  of a RUNNING agent, edit via `inbox.replace` with `freezeMessage`
  (identity preserved), remove, and steer = remove + `agent.steer`. The
  desktop's subagent-ownership guard stays absent (this profile attaches
  no subagent-owned sessions, the cancel precedent).
- `session/canOpenWorkspacePath` answers `false` (no native desktop
  opener) so the page hides the asker and `session/openWorkspacePath`
  stays honestly unclaimed.
- `permissionPresets/catalog` answers `{options: []}`: the catalog IS the
  deployment's configured preset table, this composition configures
  none, and an empty table is the truthful answer — the popup renders an
  empty picker instead of firing an unimplemented toast.

The `sessionReferenceResolver/candidates` residue is now a DOCUMENTED pin,
not an oversight: the discovery half is derivable, but the resolver's
context-preparation half (the vendored dsh-session-reference pre-step that
turns a mention into model context) is not mounted, so claiming discovery
alone would let the page insert mentions that never resolve. Vendoring the
package (D6) is its own change. `session/attachment` stays unclaimed with
its reason named: the desktop leg reads bytes from the attachment store
this host does not mount, and no image can enter (fileUploads/upload is
unimplemented), so there are no bytes to serve.

The composer E2E manifests (android + harmony) grow the six new claim rows
in the same change — the drive asserts the emitted claim list one-to-one.

Verification: the handlers are asserted directly against a fake ctx
(rename normalization including terminated/unterminated OSC, the page
cursor/pagination math including the source-group cut and the empty
below-log page, search hit/miss/refusals, the full queue action matrix,
the opener gate) — all green. The api-coverage probe's gap list and a new
sessionLegsPhase pin the same shapes; the probe's own harness (the
macOS/Linux dsh-cli) does not build on this Windows host, so its run lands
with the next POSIX/emulator drive.

## Alternatives considered

- Serving `session/attachment` from the journal: lost — the desktop leg
  authorizes from the journal but reads BYTES from the attachment store;
  this host mounts no store and no image can enter, so a claimed row would
  be a guaranteed-refusal lie. Stays unclaimed, reason pinned.
- Claiming `sessionReferenceResolver/candidates` (the discovery half is a
  derivable store read): lost for honesty — without the vendored
  session-reference package the mention a user picks never reaches the
  model as context, so the row would teach the page to lie silently.
  Pinned residue until the D6 vendoring round.
- Backing `permissionPresets/catalog` with a fabricated preset roster:
  lost — D9 forbids inventing product behavior; the empty configured
  table is the fact.
- Forwarding rename to a mounted session-title service: lost — the
  package is not vendored; the normalization + append semantics are
  mirrored at the pin instead (the established narrowed-controller
  pattern), and the LLM auto-title machinery is deliberately out (no
  provider configured).
