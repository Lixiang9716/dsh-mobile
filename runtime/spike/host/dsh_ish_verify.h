/* dsh_ish_verify.h — integrity at every mount (internal to the dsh_ish seam).
 *
 * The guest rootfs tarball is sha256-pinned at FETCH time
 * (runtime/spike/vendor/ensure-ish-rootfs.sh) and the tree it becomes is
 * sealed at STAGING time; this module re-verifies the staged bytes at EVERY
 * boot, so a tampered or partially-written tree refuses the boot instead of
 * becoming the guest root. The pattern (and the argument for it) is adoption
 * decision #2 of docs/research/upstream-capability-mounting.md — the
 * rish-app finding that a digest checked once at install leaves every later
 * mount trusting whatever the container now holds.
 *
 * The seal is a manifest SIBLING of the root (`<rootfs>.manifest`, never
 * inside it: the guest cannot see or touch its own seal). Boot compares the
 * tree against the manifest entry by entry; a mismatch on a pinned entry is
 * a loud refusal through the seam's existing error path, and one structured
 * record (expected vs actual digest) is printed on the seam's stdout channel,
 * the same channel dsh_ish_stage already reports on.
 *
 * What this CAN and CANNOT catch, stated honestly: there is no key material
 * on the device, so the anchor is "the manifest staging wrote". It detects
 * corruption, partial writes and unattributed edits to the pinned userland;
 * it cannot distinguish a guest-driven edit from tampering where both tree
 * and manifest are rewritten together — that residual is documented in the
 * Agent Note for this change.
 */
#ifndef DSH_ISH_VERIFY_H
#define DSH_ISH_VERIFY_H

/* Seal `root` into `<root>.manifest`: one line per tree entry (path, type,
 * mode, size, sha256 of the content — of the symlink TARGET for links),
 * plus a header recording the source tarball's own sha256 (when `tarball`
 * is non-NULL) and a whole-tree digest over the sorted entry lines. Called
 * by dsh_ish_stage once the tree is published, and by dsh_ish_rootfs_verify
 * when a boot finds a tree with no manifest yet (trust on first use — the
 * only honest anchor for trees this seam did not stage). Returns 0, or -1
 * with a malloc'd `*error` (caller frees). */
int dsh_ish_manifest_write(const char *root, const char *tarball, char **error);

/* Verify the staged tree at `root` against `<root>.manifest`, BEFORE it is
 * mounted as the guest root. Returns 0 when the pinned entries all match
 * (guest-authored ADDITIONS are tolerated and counted — the contract
 * promises installed packages persist; entries on the mutable list may
 * differ and are counted too), or -1 with a malloc'd `*error` naming the
 * entry, the reason, and the expected vs actual digest. A missing manifest
 * is not an error: the tree is sealed on the spot (see above). */
int dsh_ish_rootfs_verify(const char *root, char **error);

#endif /* DSH_ISH_VERIFY_H */
