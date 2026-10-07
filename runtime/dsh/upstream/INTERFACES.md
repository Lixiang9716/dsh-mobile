# The internal interface manifests — program against these, not against files

D5 extended inward. The frozen `contract/` governs what plugins see; the four
manifests below govern what the runtime's internal layers see. **Every worker
depends on a manifest, never on a file**: files may be split, refactored or
rewritten freely as long as the manifests hold — that is the whole defense
against the wave-3..6 collision chaos (the fs.js race, the 75-minute boot-torn
window, the npm-bridges whole-suite red).

## The four manifests

| Manifest | File | Governs |
| --- | --- | --- |
| shim faces | `upstream/interfaces/shim-faces.json` | what each `node:*` / npm face must export, with semantic contracts |
| harness API | `upstream/interfaces/harness-api.json` | the vitest subset this runtime commits to (`expect` matchers, `vi.*`, hooks forms) |
| bare map | `upstream/interfaces/bare-map.json` | specifier → provider (vendored package / shim face / inline row) |
| host intrinsics | `upstream/interfaces/host-intrinsics.json` | the C-provided `__dsh*` function signatures and semantics |

## The freeze rules

1. **Manifest first.** Any change a worker needs to a shared surface starts as
   a manifest delta (write the entry, mark it `proposed`), never as a file
   edit. Two workers whose deltas do not overlap can implement in parallel
   against the same frozen manifest; where they overlap, the deltas are the
   merge unit.
2. **Refactors preserve manifests.** Splitting `node-http-loopback.js` into
   `client/dispatch` is legal iff the manifest entries still resolve. A
   refactor that changes semantics is an interface change and follows rule 1.
3. **The conformance gate.** `tools/check-interfaces.py` (follow-up) diffs the
   actual export table / bare map / intrinsic registrations against the
   manifests and fails on undocumented drift — the cheap "shims parse-clean +
   no silent face loss" check the parallel workers asked for three times.
4. **Ledgers stay.** Per-spec attempt ledgers remain the attempt record; the
   manifests are the standing contract those attempts converge on.

## Status

- `shim-faces.json` / `bare-map.json`: extracted from the code as shipped at
  wave-6 close (de facto → de jure); entries carry `since` (the wave that
  introduced them) and `semantics` (the behavior contract).
- `harness-api.json`: the vitest subset list, with the wave that added each
  matcher.
- `host-intrinsics.json`: the `__dsh*` C faces with signatures.
