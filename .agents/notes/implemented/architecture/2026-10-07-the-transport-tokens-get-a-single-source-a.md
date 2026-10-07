# Agent Note: the transport tokens get a single source and a fail-able checker

Status: implemented

## Problem

The 2026-10 semantic rename (PR #402) surfaced a structural gap: the
"fact contract" strings that cross four layers — the C sink, the
ArkTS/Kotlin/Swift emitters, the Node drivers, the shell runners — had no
single owner. Each layer spelled them independently, and the repo carried
the consequences: three concurrent verdict spellings (dsh.rt.verdict vs
dsh.dsh.verdict vs dsh.runtime.verdict), a dsh.rt.result tag, and a
dsh.dsh.scenario manifest caller id — four recorded drift incidents, each
only noticed at E2E time. Nothing could go red when a layer re-spelled a
token; the rename proved greps-after-the-fact is not a gate.

## Decision

The tokens now live in ONE frozen table — runtime/dsh/transport-tokens.mjs
(log-line prefix, verdict marker, logcat/hilog tag, result/audit/ui tags,
audit line prefix, scenario module id, app id, caller id) — inside the
canonical closure, so the JS side imports it instead of spelling literals
(three representative scenarios converted: boot-verification,
gateway-bridge-smoke, session-mock-llm — the latter keeping its
bundle-root-relative bare-specifier style). Non-JS layers keep their
literals by design: the C sink must stay a freestanding translation unit
and the platform emitters have no JS module graph; a code generator would
couple three build systems to a fourth for no additional protection. What
pins them instead is tools/check-transport-tokens.mjs (the
transport-tokens gate): (a) any pre-rename spelling (dsh.spike., dsh.rt.,
dsh.dsh., com.dshmobile.spike, m1.spike, m2.spike) anywhere in the product
surfaces fails naming file:line; (b) every token must still be spelled ≥1
time in each consuming layer (a token×layer map lives in the checker), so
a layer silently renaming or dropping a token goes red even when the new
spelling is not in the forbidden family. The proof it can fail is
.gov/rejections/case-transport-tokens.sh: inject dsh.spike.log into
logger.js → red naming the file → restore → green. Historical governance
assets (.agents notes, .gov tasks/surprises, the docs/e2e-matrix evidence
pair) keep old spellings by the rename's owner ruling — they are excluded
by name in the checker, never by pattern silence. This is the repo's own
transport convention, not the frozen gateway contract (contract/, D5):
changing a value is a cross-host rename, and the gate exists to make its
missed spots loud.

## Alternatives considered

- Code-generate the C/ArkTS/Kotlin/Swift constants from the table:
  rejected — four build systems would gain a generator dependency and a
  build-order edge, while the defect class is spelling drift, which the
  presence check catches exactly as well.
- Put the table in contract/: rejected — contract/ is the frozen gateway
  surface (D5); these tokens are the repo's transport/E2E conventions and
  must be maintainable without a contract proposal.
- Extend the rename's grep one-off into CI only (assertion (a) alone):
  rejected — a checker that only bans old spellings goes green the day a
  layer invents a NEW wrong spelling; assertion (b) closes that hole by
  demanding every consuming layer still spell the canonical token.
- Convert all twelve canonical scenario files at once: deferred — three
  representative files (one per specifier style) prove the import path on
  all three platform embeds; the rest convert opportunistically as they
  are touched, keeping this change's mirror blast radius reviewable.
