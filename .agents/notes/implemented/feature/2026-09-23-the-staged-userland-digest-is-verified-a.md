# Agent Note: the staged userland digest is verified at every guest boot — integrity at every mount

Status: implemented
Related: D16

## Problem

The guest userland's integrity story stopped at fetch time. The pinned Alpine
minirootfs tarball was sha256-verified once by
`runtime/spike/vendor/ensure-ish-rootfs.sh` and once more by `dsh_ish_stage()`
extracting it — but the TREE those bytes become then sat in the app container
for the rest of the install's life, and every later boot mounted it on trust:

- a partially-written or bit-rotted tree would not fail at the boundary where
  refusing is cheap (before `mount_root`); it would fail somewhere deep inside
  the guest, as a mysterious exec fault or a busybox that segfaults;
- anything that edited the tree between boots — including a previous guest
  session's own commands — would silently become part of the next boot's
  userland with no record and no refusal.

This is adoption decision #2 of the upstream capability-mounting study
(docs/research/upstream-capability-mounting.md, "integrity at every mount",
the rish-app pattern): a digest checked at install leaves every later mount
trusting whatever the container now holds; the staged bytes must be
re-verified at each boot, and a tampered or partially-written staged tree must
fail loud, not boot.

## Decision

`dsh_ish_boot()` verifies the staged tree before mounting it, every boot
(`runtime/spike/host/dsh_ish_verify.{h,c}`, compiled into the same `dsh_ish`
library; no engine dependency, no subprocess, no new thread — it runs under
the existing boot lock):

- **Seal at staging.** `dsh_ish_stage()` walks the published tree and writes
  `<rootfs>.manifest` — a SIBLING of the root, so the guest can neither see
  nor rewrite its own seal — with one line per entry (sha256 over file
  content, over the symlink TARGET for links), a whole-tree digest over the
  sorted lines, and the source tarball's own sha256. A staging that cannot
  seal removes the tree it published: a userland we cannot seal is not one we
  can vouch for.
- **Verify at boot.** Every manifest entry is re-walked and compared (type,
  mode, size, digest). A mismatch on a pinned entry REFUSES the boot through
  the seam's existing error path (gateway `io`, message naming entry, reason,
  expected vs actual digest) and prints exactly one structured record
  (`dsh_ish_verify: verdict=refused rootfs=… entry=… reason=… expected=…
  actual=…`) on the same stdout channel `dsh_ish_stage` already reports on.
- **The pinned set is the full tree, not a spot-check** — because the pinned
  image is small: 520 walked entries, 8.1 MB of file bytes, measured ~25 ms
  warm / ~45 ms cold on the dev machine (seal ~45 ms including the 3.8 MB
  tarball digest), one-digit percent of a boot the iOS primitive already
  calls "seconds". Only sealed members are digested on re-walk, so the cost
  never grows with what the guest installs.
- **The contract's persistence promise is kept.** What a program installs
  (contract v1.3.0: "what a program installs persists") are ADDITIONS —
  counted and logged, never refused. A small sealed-but-mutable set is
  tolerated with a count: apk's own bookkeeping (`etc/apk/world`,
  `lib/apk/db/`), the resolver staging itself seeds (documented
  guest-mutable since the seam landed), and the guest's identity files
  (`passwd`/`group`/`shadow`/`hosts`/`hostname`). Everything else — busybox,
  musl, apk, the TLS trust store, `/etc/apk/repositories` — is pinned: the
  guest installs BESIDE the userland, never silently replaces it.
- **Trees without a manifest are sealed on first boot** (trust on first use,
  logged as `verdict=first-boot-sealed … note=first-boot-trust`): the desktop
  e2e extracts its override trees with its own tools, and installs upgraded
  from a build predating seals already hold a tree. A manifest that EXISTS
  but is malformed or truncated is refused, never re-sealed — a manifest this
  seam did not write is tampering until proven otherwise.

Proof on x86_64 Linux (the engine's host-aarch64 assembly cannot build there,
so the boot wiring is compile-proven and the verification logic was exercised
through the exact entry points `dsh_ish_boot`/`dsh_ish_stage` call): 34/34
harness checks — seal, clean verify, byte-append tamper (size-mismatch),
in-place byte flip (digest-mismatch), chmod (mode-changed), deleted file
(missing), repointed symlink, guest state tolerated with counts, TOFU,
garbled manifest refused, truncated manifest refused. `run-ish-local.sh` (the
existing ish e2e, arm64/macOS) gains the rejection case: it appends one byte
to the sealed busybox, demands the boot refuse it with the structured record,
and restores the byte for the gates below.

Honest residual: there is no key material on the device, so the anchor is
"the manifest staging wrote". The check detects corruption, partial writes
and unattributed edits; it cannot distinguish a guest-driven replacement of a
pinned member from tampering, and an actor who can rewrite both tree AND
manifest together defeats it. The one user-visible trade-off: an `apk upgrade`
that REPLACES a pinned member (busybox, musl) is refused at the next boot with
the member named — recovery is to delete the staged tree and let it re-stage
from the bundled tarball, which also resets installs.

## Alternatives considered

- **Verify only at fetch/staging time (the status quo).** Cheapest, and
  exactly the gap the study names: every mount after the first trusts
  whatever the container now holds. Rejected — that is the finding.
- **Per-boot spot-check of key binaries only (busybox, musl, apk).** Would
  catch the likeliest tamper targets at ~1/8 the read cost. Rejected because
  the full walk measured cheap enough (~25 ms) that spot-checking buys
  nothing measurable while leaving `/etc/apk/repositories`, the TLS trust
  store and every other pinned file unprotected.
- **Re-extract (or re-digest the tarball) at every boot and compare trees.**
  The strongest anchor on iOS (the tarball rides the signed bundle). Rejected:
  re-extracting costs a staging (~seconds) per boot and would erase guest
  state; re-digesting only re-verifies the SOURCE, not the staged tree the
  guest actually mutates. The manifest keeps the tarball's sha256 as a
  provenance line instead.
- **Strict verification of every sealed entry, no mutable set.** Simpler
  policy, but it breaks the contract's persistence promise on the first
  `apk add` (apk rewrites `etc/apk/world` and `/lib/apk/db/*` on every
  install) — the boot would refuse a userland the guest used correctly.
- **Refuse boot on ANY tree change including additions.** Same objection,
  worse: `pip`/`npm`/`apk` installs are additions by construction, and the
  workspace mount itself creates `mnt/workspace` inside the rootfs tree.
- **A keyed signature (HMAC/Ed2551) over the manifest.** Would close the
  tree+manifest rewrite residual, but there is no key to verify it with on an
  untrusted-but-uncontrolled device: embedding the key in the binary is
  exactly as strong as the manifest-in-the-binary it replaces. Rejected as
  security theater; named here so it is not re-proposed naively.
- **Seal inside the tree instead of a sibling.** One fewer file in the
  container; but then the guest — which runs as the container's user over its
  own root — can read and rewrite its own seal. The sibling stays outside the
  mount, out of the guest's reach.
