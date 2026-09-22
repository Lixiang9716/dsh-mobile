/* dsh_ish.h — the in-process Linux userland seam (contract v1.3.0 `ishRun`).
 *
 * One boot, many commands. `dsh_ish_boot` mounts the guest root (the staged
 * Alpine userland) as `/` and the authorized workspace as a second real mount,
 * then starts the guest's init process. `dsh_ish_run` runs ONE program in that
 * guest — the caller supplies argv, the guest's own /bin/sh interprets a command
 * line if that is what the caller wants — and returns its stdout, stderr and
 * exit status.
 *
 * The engine is iSH-arm64, vendored and sha256-pinned by
 * runtime/spike/vendor/ensure-ish.sh: a userspace AArch64 emulator with a
 * threaded-code interpreter. Nothing here spawns a process and nothing here
 * creates a second OS: the guest's tasks are emulated, its "shell" is an
 * ELF binary interpreted in this process. The gateway dispatches onto the
 * runtime's serial queue, so the emulator never touches the JS runtime's
 * thread (D2).
 *
 * Threading: boot is once per process and serialized. Each `run` may be called
 * from any host thread (the emulator gives the guest task its own host thread,
 * exactly as the fork's own agent shell does); `run` itself blocks its caller
 * until the guest exits or the deadline fires.
 */
#ifndef DSH_ISH_H
#define DSH_ISH_H

#include <stddef.h>

/* Boot the guest. `rootfs` is a host directory that becomes the guest's `/`
 * (the staged Alpine userland); `workspace` is a host directory mounted inside
 * the guest at `guest_path` (NULL to mount none); `guest_path` may be NULL, then
 * the default mount point is used. Returns 0 on success, -1 on failure with a
 * malloc'd `*error` message (caller frees). Booting twice is a no-op that
 * returns 0 and keeps the first configuration.
 *
 * Before the tree is mounted, its bytes are re-verified against the manifest
 * `dsh_ish_stage` sealed next to it (`<rootfs>.manifest`, dsh_ish_verify.h):
 * integrity at every mount, not only at fetch/staging time. A tampered or
 * partially-written tree refuses the boot with the offending entry and the
 * expected vs actual digest; a tree with no manifest yet is sealed on first
 * boot (trust on first use — the only anchor for trees this seam did not
 * stage). Guest-authored additions and the mutable set (apk's bookkeeping,
 * the resolver, identity files) are tolerated and counted. */
int dsh_ish_boot(const char *rootfs, const char *workspace,
                 const char *guest_path, char **error);

/* 1 once the guest is up. */
int dsh_ish_is_booted(void);

/* The guest path the workspace is mounted at ("" when none was mounted). */
const char *dsh_ish_workspace_mount(void);

/* Run one program in the booted guest.
 *
 * `workdir` is a GUEST path used as the working directory (NULL = the guest's
 * current directory, i.e. the root). `argv` is a NULL-terminated argument
 * vector: argv[0] is the guest program, resolved inside the guest userland.
 * `timeout_ms` <= 0 means the default; the value is clipped to
 * [DSH_ISH_TIMEOUT_MIN, DSH_ISH_TIMEOUT_MAX].
 *
 * Returns a malloc'd JSON object (caller frees)
 *   {"exitCode":<int>,"stdout":"...","stderr":"...","timedOut":<bool>,"truncated":<bool>}
 * or NULL with a malloc'd `*error` message when the run could not be started at
 * all (not booted, unknown program, out of resources). A guest that exits
 * non-zero is NOT an error: its status is in `exitCode`. `timedOut` means the
 * deadline fired and the guest process was killed; `truncated` means the command
 * produced more than the host's output cap and the streams were cut. */
char *dsh_ish_run(const char *workdir, const char *const *argv,
                  int timeout_ms, char **error);

/* Stage a guest userland from a pinned tarball into `dest`.
 *
 * On iOS the guest root cannot ride in the app bundle as a TREE: the Alpine
 * userland carries 335 symlinks, many absolute (`/usr/bin/top -> /bin/busybox`),
 * and installd rejects the app (`invalid symlink at …`). A `.tar.gz` is a data
 * file, so the pinned tarball ships in the bundle and this materializes it into
 * the app container at first launch, where symlinks are ordinary filesystem
 * entries again. The archive is extracted into `<dest>.staging` and renamed onto
 * `dest` only when every member landed, so an interrupted staging never becomes
 * a directory a later boot would mistake for a userland. Member paths that are
 * absolute or escape the root are refused; device nodes and FIFOs are skipped
 * (the engine synthesizes /dev itself). Returns 0 on success, -1 with a malloc'd
 * `*error` message, and prints a one-line member summary on success. */
int dsh_ish_stage(const char *tarball, const char *dest, char **error);

/* Where the workspace is mounted inside the guest. Callers compute a guest
 * working directory as <mount>/<scope-relative path>. */
#define DSH_ISH_GUEST_MOUNT "/mnt/workspace"

#define DSH_ISH_TIMEOUT_DEFAULT 60000
#define DSH_ISH_TIMEOUT_MIN 1000
#define DSH_ISH_TIMEOUT_MAX 600000
/* Total bytes of stdout+stderr kept per run; beyond this the streams are cut
 * and `truncated` is set (the guest keeps running — its writes are drained and
 * discarded, so it can never block on a full pipe). */
#define DSH_ISH_OUTPUT_CAP (512 * 1024)

#endif /* DSH_ISH_H */
