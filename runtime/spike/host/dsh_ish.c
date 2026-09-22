/* dsh_ish.c — boot the emulated Linux userland and run one program in it.
 *
 * See dsh_ish.h for the seam and runtime/spike/host/ish/CMakeLists.txt for how
 * the engine is built. The three moves this file makes are the fork's own (its
 * agent shell in app/ISHShellExecutor.m and its JSON-RPC runner in
 * app/DebugServer.c): boot the kernel once, and per command create a child of
 * init, hand it pipes, exec into it and wait for the zombie.
 *
 * Why a child of init and not a whole new kernel per command: iSH's kernel is
 * process-global (one mount table, one pid table, one guest memory manager), so
 * a second `mount_root` in the same process is not a thing. One boot, many
 * commands is also what makes the guest feel like a shell rather than a series
 * of unrelated programs: /tmp and anything installed persist between calls for
 * as long as the host keeps the guest up.
 *
 * `current` is thread-local in iSH, so two host threads may run two guest
 * commands at once — each with its own pipes and its own guest process. The
 * boot itself is once per process and serialized.
 */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <dirent.h>
#include <netinet/in.h>
#include <resolv.h>
#include <sys/stat.h>
#include <zlib.h>

#include "kernel/calls.h"
#include "kernel/fs.h"
#include "kernel/init.h"
#include "kernel/signal.h"
#include "kernel/task.h"
#include "fs/dev.h"
#include "fs/devices.h"
#include "fs/fd.h"
#include "fs/path.h"
#include "fs/real.h"

#include "dsh_ish.h"
#include "dsh_ish_verify.h"

#define DSH_ISH_DEFAULT_MOUNT DSH_ISH_GUEST_MOUNT
#define DSH_ISH_INIT "/bin/sh"
/* Poll granularity while waiting for the guest: short enough that a fast
 * command's latency is one tick, long enough that a long one is not a spin. */
#define DSH_ISH_TICK_MS 20
/* After the deadline we SIGKILL the guest; this is how long its zombie may take
 * to appear before we give up on the exit status (the run still returns). */
#define DSH_ISH_REAP_MS 5000

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static int g_booted = 0;
static char g_workspace_mount[256] = "";

/* ------------------------------------------------------------------ messages */

static char *msgf(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char buf[512];
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    return strdup(buf);
}

/* --------------------------------------------------------------------- json */

static void json_escape_into(char *out, size_t cap, const char *bytes, size_t len) {
    size_t o = 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char) bytes[i];
        if (o + 8 >= cap) break;
        switch (c) {
            case '"':  out[o++] = '\\'; out[o++] = '"'; break;
            case '\\': out[o++] = '\\'; out[o++] = '\\'; break;
            case '\n': out[o++] = '\\'; out[o++] = 'n'; break;
            case '\r': out[o++] = '\\'; out[o++] = 'r'; break;
            case '\t': out[o++] = '\\'; out[o++] = 't'; break;
            default:
                /* Non-UTF-8 bytes come back escaped rather than transcoded: the
                 * caller asked for a byte stream and may be reading a binary. */
                if (c < 0x20) o += (size_t) snprintf(out + o, cap - o, "\\u%04x", c);
                else out[o++] = (char) c;
        }
    }
    out[o] = '\0';
}

/* ------------------------------------------------------------- guest task fds */

/* Wire one guest task's stdio. `stdin_host_fd` < 0 means /dev/null; `out_fd` and
 * `err_fd` are host fds the caller keeps (each is dup'd here). Returns 0 or a
 * negative errno. */
static int attach_fds(struct task *task, int stdin_host_fd,
                      int out_fd, int err_fd) {
    struct fd *in = adhoc_fd_create(&realfs_fdops);
    if (in == NULL) return _ENOMEM;
    in->real_fd = stdin_host_fd >= 0 ? dup(stdin_host_fd) : open("/dev/null", O_RDONLY);
    if (in->real_fd < 0) return _EIO;
    task->files->files[0] = in;

    struct fd *out = adhoc_fd_create(&realfs_fdops);
    if (out == NULL) return _ENOMEM;
    out->real_fd = dup(out_fd);
    if (out->real_fd < 0) return _EIO;
    task->files->files[1] = out;

    struct fd *err = adhoc_fd_create(&realfs_fdops);
    if (err == NULL) return _ENOMEM;
    err->real_fd = dup(err_fd < 0 ? out_fd : err_fd);
    if (err->real_fd < 0) return _EIO;
    task->files->files[2] = err;
    return 0;
}

/* Pack argv into the NUL-separated, double-NUL-terminated block iSH's do_execve
 * wants. Returns a malloc'd block or NULL. */
static char *pack_argv(const char *const *argv, size_t *out_count) {
    size_t count = 0, len = 1;
    for (; argv[count] != NULL; count++) len += strlen(argv[count]) + 1;
    if (count == 0) return NULL;
    char *block = malloc(len);
    if (block == NULL) return NULL;
    size_t p = 0;
    for (size_t i = 0; i < count; i++) {
        size_t n = strlen(argv[i]) + 1;
        memcpy(block + p, argv[i], n);
        p += n;
    }
    block[p] = '\0';
    *out_count = count;
    return block;
}

static const char *guest_envp(void) {
    return "TERM=dumb\0"
           "HOME=/root\0"
           "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\0"
           "PYTHONMALLOC=malloc\0";
}

/* -------------------------------------------------------------------- booting */

/* The guest's own init: a shell with a stdin that never reaches EOF. It must not
 * exit — iSH halts the whole system when pid 1 dies — and it must not consume
 * anything we send it later, because commands run as its children on their own
 * pipes. `keepalive_rd` is the read end of a pipe whose write end the host holds
 * open for the life of the process; we never write to it. */
static int start_init(int keepalive_rd, char **error) {
    struct task *task = current;
    int err = attach_fds(task, keepalive_rd, STDERR_FILENO, STDERR_FILENO);
    if (err < 0) {
        *error = msgf("guest init: cannot wire stdio (%d)", -err);
        return -1;
    }
    /* argv[0] only: a busybox sh given a second word treats it as a script to
     * open, and an init that cannot start takes the whole guest down with it. */
    const char *argv = DSH_ISH_INIT "\0";
    err = do_execve(DSH_ISH_INIT, 1, argv, guest_envp());
    if (err < 0) {
        *error = msgf("guest init: cannot exec %s (%d) — is the rootfs an aarch64 "
                      "userland with that program?", DSH_ISH_INIT, -err);
        return -1;
    }
    if (task_start(task) < 0) {
        *error = msgf("guest init: cannot start the init thread");
        return -1;
    }
    return 0;
}

/* Mount the authorized workspace inside the guest. The mount point must exist in
 * the guest tree, so it is created first (a pre-existing one is fine). */
static int mount_workspace(const char *workspace, const char *guest_path, char **error) {
    char real[MAX_PATH + 1];
    if (realpath(workspace, real) == NULL) {
        *error = msgf("workspace %s: %s", workspace, strerror(errno));
        return -1;
    }
    generic_mkdirat(AT_PWD, guest_path, 0755);
    int err = do_mount(&realfs, real, guest_path, "", 0);
    if (err < 0) {
        *error = msgf("cannot mount %s at %s in the guest (%d)", real, guest_path, -err);
        return -1;
    }
    snprintf(g_workspace_mount, sizeof(g_workspace_mount), "%s", guest_path);
    return 0;
}

int dsh_ish_boot(const char *rootfs, const char *workspace,
                 const char *guest_path, char **error) {
    if (error != NULL) *error = NULL;
    pthread_mutex_lock(&g_lock);
    if (g_booted) {
        pthread_mutex_unlock(&g_lock);
        return 0;
    }
    if (rootfs == NULL || rootfs[0] == '\0' || access(rootfs, R_OK | X_OK) != 0) {
        if (error != NULL)
            *error = msgf("guest root %s: %s", rootfs == NULL ? "(none)" : rootfs,
                          rootfs == NULL ? "not given" : strerror(errno));
        pthread_mutex_unlock(&g_lock);
        return -1;
    }

    /* Integrity at every mount: the tarball's digest was checked when it was
     * fetched, and staging sealed the tree it became — but that says nothing
     * about the bytes on disk NOW. Re-verify the sealed manifest before the
     * tree becomes a guest root (still under the boot lock, still on this
     * thread; the walk is a one-shot read pass — see dsh_ish_verify.c for the
     * measured cost). A tampered or partially-written tree refuses the boot
     * instead of failing somewhere inside the guest. */
    char *verify_error = NULL;
    if (dsh_ish_rootfs_verify(rootfs, &verify_error) < 0) {
        if (error != NULL)
            *error = verify_error != NULL ? verify_error
                                          : msgf("guest root %s failed verification", rootfs);
        else
            free(verify_error);
        pthread_mutex_unlock(&g_lock);
        return -1;
    }

    int err = mount_root(&realfs, rootfs);
    if (err < 0) {
        if (error != NULL) *error = msgf("cannot mount %s as the guest root (%d)", rootfs, -err);
        pthread_mutex_unlock(&g_lock);
        return -1;
    }
    err = become_first_process();
    if (err < 0) {
        if (error != NULL) *error = msgf("cannot create the guest init task (%d)", -err);
        pthread_mutex_unlock(&g_lock);
        return -1;
    }

    /* /proc and /dev/pts are part of what a Linux userland expects to find; the
     * guest's own /dev nodes are synthesized by the real filesystem, so no mknod
     * is needed here (and none would be permitted inside an app sandbox). */
    do_mount(&procfs, "proc", "/proc", "", 0);
    do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);

    if (workspace != NULL && workspace[0] != '\0') {
        const char *point = (guest_path != NULL && guest_path[0] != '\0')
                          ? guest_path : DSH_ISH_DEFAULT_MOUNT;
        if (mount_workspace(workspace, point, error) < 0) {
            pthread_mutex_unlock(&g_lock);
            return -1;
        }
    }

    int keepalive[2];
    if (pipe(keepalive) < 0) {
        if (error != NULL) *error = msgf("guest init: pipe: %s", strerror(errno));
        pthread_mutex_unlock(&g_lock);
        return -1;
    }
    if (start_init(keepalive[0], error) < 0) {
        close(keepalive[0]);
        close(keepalive[1]);
        pthread_mutex_unlock(&g_lock);
        return -1;
    }
    /* The read end now belongs to the guest; the write end stays open here for
     * the life of the process (that is what keeps init's stdin from EOF). */
    close(keepalive[0]);
    g_booted = 1;
    pthread_mutex_unlock(&g_lock);
    return 0;
}

int dsh_ish_is_booted(void) {
    return g_booted;
}

const char *dsh_ish_workspace_mount(void) {
    return g_workspace_mount;
}

/* -------------------------------------------------------------------- running */

/* One output stream of one run: a non-blocking pipe read end and the bytes it
 * has produced so far. */
struct dsh_sink {
    int fd;
    char *buf;
    size_t len;
    size_t cap;
    int truncated;
};

struct dsh_run {
    struct dsh_sink out;
    struct dsh_sink err;
    pid_t_ guest_pid;
};

/* Drain whatever a pipe holds right now. Over the cap we keep reading (so the
 * guest can never block on a full pipe) but stop storing. */
static void sink_drain(struct dsh_sink *s) {
    char chunk[4096];
    for (;;) {
        ssize_t n = read(s->fd, chunk, sizeof(chunk));
        if (n <= 0) return;
        if (s->len + (size_t) n > s->cap) {
            s->truncated = 1;
            continue;
        }
        memcpy(s->buf + s->len, chunk, (size_t) n);
        s->len += (size_t) n;
    }
}

static void run_drain(struct dsh_run *r) {
    sink_drain(&r->out);
    sink_drain(&r->err);
}

/* iSH keeps the kernel's wait-status word: a normal exit stores status << 8 and
 * a signal death sig << 8 | 0x7f. Handing that word to the caller would report
 * `exit 7` as 1792, so it is decoded here into the shell's own convention
 * (0-255 for an exit, 128+signal for a signal death). */
static int decode_wait_status(int status) {
    if (status < 0) return -1;
    if ((status & 0x7f) == 0) return (status >> 8) & 0xff;
    return 128 + ((status >> 8) & 0xff);
}

static int guest_zombie(struct dsh_run *r, int *exit_code) {
    int zombie = 0;
    lock(&pids_lock);
    struct task *task = pid_get_task_zombie((dword_t) r->guest_pid);
    if (task != NULL && task->zombie) {
        zombie = 1;
        *exit_code = decode_wait_status((int) task->exit_code);
    }
    unlock(&pids_lock);
    return zombie;
}

static void kill_guest(struct dsh_run *r) {
    lock(&pids_lock);
    struct task *task = pid_get_task((dword_t) r->guest_pid);
    if (task != NULL) send_signal(task, SIGKILL_, SIGINFO_NIL);
    unlock(&pids_lock);
}

static void poll_ticks(struct dsh_run *r, int tick_ms) {
    struct pollfd fds[2] = {
        { .fd = r->out.fd, .events = POLLIN },
        { .fd = r->err.fd, .events = POLLIN },
    };
    poll(fds, 2, tick_ms);
    if (fds[0].revents & (POLLIN | POLLHUP)) sink_drain(&r->out);
    if (fds[1].revents & (POLLIN | POLLHUP)) sink_drain(&r->err);
}

/* Wait for the guest to exit (or the deadline to fire), collecting output.
 * Returns 1 when the guest exited on its own, 0 when the deadline killed it. */
static int collect(struct dsh_run *r, int timeout_ms, int *exit_code) {
    struct timespec start, now;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;) {
        poll_ticks(r, DSH_ISH_TICK_MS);
        if (guest_zombie(r, exit_code)) {
            poll_ticks(r, 0);
            return 1;
        }
        clock_gettime(CLOCK_MONOTONIC, &now);
        long elapsed = (now.tv_sec - start.tv_sec) * 1000
                     + (now.tv_nsec - start.tv_nsec) / 1000000;
        if (elapsed >= timeout_ms) break;
    }
    kill_guest(r);
    for (long waited = 0; waited < DSH_ISH_REAP_MS; waited += DSH_ISH_TICK_MS) {
        poll_ticks(r, DSH_ISH_TICK_MS);
        if (guest_zombie(r, exit_code)) break;
    }
    return 0;
}

static int clamp_timeout(int timeout_ms) {
    if (timeout_ms <= 0) return DSH_ISH_TIMEOUT_DEFAULT;
    if (timeout_ms < DSH_ISH_TIMEOUT_MIN) return DSH_ISH_TIMEOUT_MIN;
    if (timeout_ms > DSH_ISH_TIMEOUT_MAX) return DSH_ISH_TIMEOUT_MAX;
    return timeout_ms;
}

static int enter_guest_task(const char *workdir, char **error) {
    int err = become_new_init_child();
    if (err < 0) {
        *error = msgf("cannot create a guest process (%d)", -err);
        return err;
    }
    if (workdir != NULL && workdir[0] != '\0') {
        struct fd *pwd = generic_open(workdir, O_RDONLY_, 0);
        if (IS_ERR(pwd)) {
            *error = msgf("working directory %s does not exist in the guest", workdir);
            return -1;
        }
        fs_chdir(current->fs, pwd);
    }
    return 0;
}

/* Give a dead-end failure a single shape: every early exit frees what it took. */
static char *fail(char *block, int *pipes, struct dsh_sink *a,
                  struct dsh_sink *b, char **error, const char *fmt, ...) {
    if (pipes != NULL) {
        if (pipes[0] >= 0) close(pipes[0]);
        if (pipes[1] >= 0) close(pipes[1]);
        if (pipes[2] >= 0) close(pipes[2]);
        if (pipes[3] >= 0) close(pipes[3]);
    }
    free(block);
    if (a != NULL) free(a->buf);
    if (b != NULL) free(b->buf);
    if (error != NULL) {
        va_list args;
        va_start(args, fmt);
        char buf[512];
        vsnprintf(buf, sizeof(buf), fmt, args);
        va_end(args);
        *error = strdup(buf);
    }
    return NULL;
}

static char *result_json(const struct dsh_run *r, int exit_code,
                         int finished, char **error) {
    size_t cap = (r->out.len + r->err.len) * 6 + 256;
    char *out = malloc(r->out.len * 6 + 8);
    char *err = malloc(r->err.len * 6 + 8);
    char *json = malloc(cap);
    if (out == NULL || err == NULL || json == NULL) {
        free(out); free(err); free(json);
        return fail(NULL, NULL, NULL, NULL, error, "out of memory");
    }
    json_escape_into(out, r->out.len * 6 + 8, r->out.buf, r->out.len);
    json_escape_into(err, r->err.len * 6 + 8, r->err.buf, r->err.len);
    snprintf(json, cap,
             "{\"exitCode\":%d,\"stdout\":\"%s\",\"stderr\":\"%s\","
             "\"timedOut\":%s,\"truncated\":%s}",
             exit_code, out, err,
             finished ? "false" : "true",
             (r->out.truncated || r->err.truncated) ? "true" : "false");
    free(out);
    free(err);
    return json;
}

char *dsh_ish_run(const char *workdir, const char *const *argv,
                  int timeout_ms, char **error) {
    if (error != NULL) *error = NULL;
    if (!g_booted) return fail(NULL, NULL, NULL, NULL, error, "the guest is not booted");
    if (argv == NULL || argv[0] == NULL)
        return fail(NULL, NULL, NULL, NULL, error, "no program given");

    size_t argc = 0;
    char *block = pack_argv(argv, &argc);
    if (block == NULL) return fail(NULL, NULL, NULL, NULL, error, "cannot pack argv");

    int pipes[4] = { -1, -1, -1, -1 };
    if (pipe(pipes) < 0 || pipe(pipes + 2) < 0)
        return fail(block, pipes, NULL, NULL, error, "pipe: %s", strerror(errno));
    fcntl(pipes[0], F_SETFL, O_NONBLOCK);
    fcntl(pipes[2], F_SETFL, O_NONBLOCK);

    struct dsh_run run = {
        .out = { .fd = pipes[0], .cap = DSH_ISH_OUTPUT_CAP },
        .err = { .fd = pipes[2], .cap = DSH_ISH_OUTPUT_CAP },
    };
    run.out.buf = malloc(run.out.cap);
    run.err.buf = malloc(run.err.cap);
    if (run.out.buf == NULL || run.err.buf == NULL)
        return fail(block, pipes, &run.out, &run.err, error, "out of memory");

    struct task *saved = current;
    if (enter_guest_task(workdir, error) < 0) {
        current = saved;
        return fail(block, pipes, &run.out, &run.err, NULL, "");
    }
    struct task *task = current;
    int err = attach_fds(task, -1, pipes[1], pipes[3]);
    if (err < 0) {
        current = saved;
        return fail(block, pipes, &run.out, &run.err, error,
                    "cannot wire the guest process's stdio (%d)", -err);
    }
    err = do_execve(argv[0], argc, block, guest_envp());
    if (err < 0) {
        current = saved;
        return fail(block, pipes, &run.out, &run.err, error,
                    "%s: cannot execute (%d) — is it in the guest userland?",
                    argv[0], -err);
    }
    run.guest_pid = task->pid;
    err = task_start(task);
    current = saved;
    /* The write ends live in the guest's fd table now; the host's copies must go
     * so the pipe reaches EOF when the guest (and any children) exit. */
    close(pipes[1]);
    close(pipes[3]);
    pipes[1] = pipes[3] = -1;
    if (err < 0)
        return fail(block, pipes, &run.out, &run.err, error,
                    "cannot start the guest process (%d)", -err);
    free(block);

    int exit_code = -1;
    int finished = collect(&run, clamp_timeout(timeout_ms), &exit_code);
    close(run.out.fd);
    close(run.err.fd);

    char *json = result_json(&run, exit_code, finished, error);
    free(run.out.buf);
    free(run.err.buf);
    return json;
}

/* ------------------------------------------------------------------ staging */

/* Stage a guest userland from a pinned tarball into `dest`.
 *
 * Why this exists: on iOS the guest root cannot ride in the app bundle as a
 * tree. The Alpine userland carries 335 symlinks, many of them ABSOLUTE
 * (`/usr/bin/top -> /bin/busybox`), and installd refuses the whole app with
 * `invalid symlink at …/usr/bin/top`. A tarball is a plain data file, so the
 * pinned `.tar.gz` can ship in the bundle and be materialized into the app
 * container at first launch — the same shape the reference iOS projects use.
 *
 * Why gzip + a reader here rather than a shell-out: iOS has no `tar`, the
 * gateway's file primitives write BYTES (they cannot create a symlink, which is
 * what most of this userland IS), and zlib is on every Apple platform. So the
 * extractor belongs in this seam, next to the boot it feeds.
 *
 * Discipline (fail loud, never half-stage): a member path that is absolute or
 * carries a `..` segment is refused, as are truncated archives and members that
 * cannot be written. Staging happens in `<dest>.staging`, which is renamed onto
 * `dest` only when every member landed — so a killed staging leaves no
 * directory that a later boot would mistake for a userland, and a completed one
 * is never partially overwritten. `dsh_ish_boot` on a missing root is the
 * caller's error to report, not this function's.
 *
 * Handled member types: regular files, directories, symlinks, hardlinks, and the
 * GNU long-name / pax extensions (Alpine's own tarball uses pax headers).
 * Character/block devices and FIFOs are SKIPPED on purpose: iSH synthesizes
 * /dev itself and an unprivileged app cannot create device nodes anyway. */
#define TAR_BLOCK 512
#define TAR_NAME_MAX 1024

enum stage_kind { STAGE_KIND_NONE = 0, STAGE_KIND_PAX, STAGE_KIND_LONGNAME, STAGE_KIND_LONGLINK };

/* Octal field, possibly space/NUL terminated and possibly empty. */
static long long tar_octal(const char *field, size_t len) {
    long long value = 0;
    for (size_t i = 0; i < len; i++) {
        char c = field[i];
        if (c == '\0' || c == ' ') break;
        if (c < '0' || c > '7') break;
        value = value * 8 + (c - '0');
    }
    return value;
}

/* Read exactly `want` bytes, or report a short read (a truncated archive is a
 * failure, not an end-of-archive signal). */
static long long g_tar_pos;
static int tar_read_exact(gzFile in, void *buf, size_t want) {
    size_t got = 0;
    while (got < want) {
        int n = gzread(in, (char *) buf + got, (unsigned) (want - got));
        if (n <= 0) return -1;
        got += (size_t) n;
    }
    g_tar_pos += (long long) want;
    return 0;
}

/* Every member's data is padded to a block boundary; a reader that forgets the
 * padding reads NULs as the next header and derails (the first symptom is a
 * member with an empty name). */
static int tar_skip_padding(gzFile in, long long size) {
    size_t pad = (size_t) ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
    if (pad == 0) return 0;
    char buf[TAR_BLOCK];
    return tar_read_exact(in, buf, pad);
}

/* Remove a tree this function created. `system("rm -rf")` would be shorter and is
 * not available: iOS has no `system`, and a subprocess is what this architecture
 * refuses anyway (D2). Plain traversal, depth first. */
static int stage_remove_tree(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return 0;                 /* absent: nothing to do */
    if (!S_ISDIR(st.st_mode)) return unlink(path);
    DIR *dir = opendir(path);
    if (dir == NULL) return -1;
    struct dirent *entry;
    int status = 0;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        char child[TAR_NAME_MAX];
        snprintf(child, sizeof(child), "%s/%s", path, entry->d_name);
        if (stage_remove_tree(child) != 0) { status = -1; break; }
    }
    closedir(dir);
    return status != 0 ? status : rmdir(path);
}

/* Drain a member's data (used by the types that carry none in practice) and its
 * padding. Exactly one place must consume each member's bytes — a reader that
 * both streams a file's data and then also "skips the data" walks 412 bytes past
 * the next header on a 100-byte file, which is what the first version of this
 * function did. */
static int tar_discard(gzFile in, long long size) {
    char buf[8192];
    long long left = size;
    while (left > 0) {
        size_t chunk = left < (long long) sizeof(buf) ? (size_t) left : sizeof(buf);
        if (tar_read_exact(in, buf, chunk) != 0) return -1;
        left -= (long long) chunk;
    }
    return tar_skip_padding(in, size);
}

/* mkdir -p for host paths we are about to write into. */
static int stage_mkdir_p(const char *path, int fail_if_exists) {
    char buf[TAR_NAME_MAX];
    size_t len = strlen(path);
    if (len == 0 || len >= sizeof(buf)) return -1;
    memcpy(buf, path, len + 1);
    for (size_t i = 1; i < len; i++) {
        if (buf[i] != '/') continue;
        buf[i] = '\0';
        if (mkdir(buf, 0755) != 0 && errno != EEXIST) return -1;
        buf[i] = '/';
    }
    if (mkdir(buf, 0755) != 0) {
        if (errno == EEXIST) return fail_if_exists ? -1 : 0;
        return -1;
    }
    return 0;
}

/* Refuse a member path that would escape the destination. Absolute members are
 * rejected because the userland's own absolute symlinks are created by the
 * SYMLINK members, never by member paths. */
static int stage_path_is_safe(const char *rel) {
    if (rel[0] == '/' || rel[0] == '\0') return 0;
    const char *at = rel;
    while (*at != '\0') {
        const char *slash = strchr(at, '/');
        size_t seg = slash != NULL ? (size_t) (slash - at) : strlen(at);
        if (seg == 2 && at[0] == '.' && at[1] == '.') return 0;   /* .. */
        at = slash != NULL ? slash + 1 : at + seg;
        if (slash == NULL) break;
    }
    return 1;
}

/* One pax record block: "<len> <key>=<value>\n". Returns the value for `key`
 * into `out` (or leaves it untouched). */
static void stage_pax_take(const char *data, size_t len, const char *key, char *out, size_t cap) {
    size_t at = 0;
    size_t keylen = strlen(key);
    while (at < len) {
        size_t record = (size_t) strtoul(data + at, NULL, 10);
        if (record == 0 || at + record > len) break;
        const char *body = data + at;
        const char *space = memchr(body, ' ', record);
        if (space != NULL) {
            size_t bodylen = record - (size_t) (space + 1 - body);
            if (bodylen > keylen + 1 && strncmp(space + 1, key, keylen) == 0
                && space[1 + keylen] == '=') {
                size_t vlen = bodylen - keylen - 1;
                if (vlen < cap) {
                    memcpy(out, space + 2 + keylen, vlen);
                    out[vlen] = '\0';
                }
            }
        }
        at += record;
    }
}

/* A Linux userland with no resolver is a userland whose package manager is dead
 * on arrival: `apk`, `pip` and `npm` all resolve a name before they fetch
 * anything, and every one of them reports it as a generic network failure. No
 * container image ships /etc/resolv.conf — the runtime is expected to provide it
 * — so staging writes one when the archive carried none, and says so. It stays
 * an ordinary guest file: a host that wants its own resolver (or the guest
 * itself) may overwrite it. */
static int stage_seed_resolver(const char *dest) {
    char etc[TAR_NAME_MAX], path[TAR_NAME_MAX];
    struct stat st;
    snprintf(etc, sizeof(etc), "%s/etc", dest);
    if (stat(etc, &st) != 0 || !S_ISDIR(st.st_mode)) return 0;   /* not a Linux root: leave it be */
    snprintf(path, sizeof(path), "%s/resolv.conf", etc);
    if (access(path, F_OK) == 0) return 0;                      /* the archive had one */
    FILE *f = fopen(path, "w");
    if (f == NULL) return -1;

    /* The HOST's own resolvers first — the emulated sockets are the host's
     * sockets (fs/sock.c), so the host's DNS is the one that actually answers
     * on this network. A hardcoded public resolver is not a safe default: a
     * build that shipped 1.1.1.1/8.8.8.8 made every name lookup fail on a
     * network that blocks them, which the guest reports as "network down" and
     * which reads as a broken tool rather than a broken resolver. (This is also
     * what the engine's own iOS app does: it bind-mounts the system resolver.) */
    int written = 0;
    struct __res_state state;
    if (res_ninit(&state) == 0) {
        for (int i = 0; i < (int) state.nscount && written < 4; i++) {
            char buf[64];
            if (inet_ntop(AF_INET, &state.nsaddr_list[i].sin_addr, buf, sizeof(buf)) == NULL) continue;
            fprintf(f, "nameserver %s\n", buf);
            written++;
        }
        res_nclose(&state);
    }
    if (written == 0) {
        /* No host resolvers visible (sandboxed, or an odd network): well-known
         * public resolvers, global AND China-mainland, because a list that only
         * covers one region is the failure mode above. */
        fputs("nameserver 223.5.5.5\nnameserver 119.29.29.29\n"
              "nameserver 1.1.1.1\nnameserver 8.8.8.8\n", f);
        written = 4;
        printf("dsh_ish_stage: the host exposed no resolver; seeded public ones\n");
    }
    if (fclose(f) != 0) return -1;
    printf("dsh_ish_stage: wrote /etc/resolv.conf with %d resolver(s) (the archive carried none)\n",
           written);
    return 0;
}

int dsh_ish_stage(const char *tarball, const char *dest, char **error) {
    if (error != NULL) *error = NULL;
    if (tarball == NULL || dest == NULL || strlen(dest) >= TAR_NAME_MAX - 16) {
        if (error != NULL) *error = strdup("stage: tarball and destination are required");
        return -1;
    }
    char staging[TAR_NAME_MAX];
    snprintf(staging, sizeof(staging), "%s.staging", dest);
    /* A previous run that died mid-stage leaves `<dest>.staging`; remove it so
     * this attempt starts from nothing rather than merging two half-userslands. */
    (void) stage_remove_tree(staging);
    if (stage_mkdir_p(staging, 0) != 0) {
        if (error != NULL) *error = msgf("stage: cannot create %s: %s", staging, strerror(errno));
        return -1;
    }

    gzFile in = gzopen(tarball, "rb");
    if (in == NULL) {
        if (error != NULL) *error = msgf("stage: cannot open %s", tarball);
        return -1;
    }

    char name[TAR_NAME_MAX];        /* pending member path (pax/long name override) */
    char linkname[TAR_NAME_MAX];    /* pending link target */
    enum stage_kind pending = STAGE_KIND_NONE;
    long long files = 0, dirs = 0, links = 0, skipped = 0;
    char header[TAR_BLOCK];
    int failed = 0;

    for (;;) {
        if (tar_read_exact(in, header, TAR_BLOCK) != 0) {
            if (error != NULL) *error = msgf("stage: %s ends before the archive does (truncated)", tarball);
            failed = 1;
            break;
        }
        int all_zero = 1;
        for (size_t i = 0; i < TAR_BLOCK; i++) if (header[i] != '\0') { all_zero = 0; break; }
        if (all_zero) break;   /* end-of-archive marker */

        if (getenv("DSH_ISH_STAGE_DEBUG") != NULL) {
            char dbg[101];
            memcpy(dbg, header + 0, 100); dbg[100] = '\0';
            fprintf(stderr, "stage-trace: pos=%lld pad=%lld type='%c' size=%lld name='%s'\n",
                    g_tar_pos - TAR_BLOCK,
                    (long long) ((TAR_BLOCK - (tar_octal(header + 124, 12) % TAR_BLOCK)) % TAR_BLOCK),
                    header[156] != '\0' ? header[156] : '0', tar_octal(header + 124, 12), dbg);
        }
        char raw_name[101], raw_link[101];
        memcpy(raw_name, header + 0, 100); raw_name[100] = '\0';
        memcpy(raw_link, header + 157, 100); raw_link[100] = '\0';
        long long size = tar_octal(header + 124, 12);
        long long mode = tar_octal(header + 100, 8);
        char type = header[156];
        const char *prefix = header + 345;   /* ustar prefix */
        char prefixbuf[156];
        memcpy(prefixbuf, prefix, 155); prefixbuf[155] = '\0';
        int has_prefix = prefixbuf[0] != '\0';

        /* An extension block only OVERRIDES the name when it actually carried
         * one: a pax header is emitted for `mtime=` alone just as often, and
         * treating that as "the name is empty now" refuses the whole archive on
         * its first real member. */
        char member[TAR_NAME_MAX];
        const char *override = ((pending == STAGE_KIND_PAX || pending == STAGE_KIND_LONGNAME)
                                && name[0] != '\0') ? name : NULL;
        if (override != NULL) {
            snprintf(member, sizeof(member), "%s", override);
        } else if (has_prefix) {
            snprintf(member, sizeof(member), "%s/%s", prefixbuf, raw_name);
        } else {
            snprintf(member, sizeof(member), "%s", raw_name);
        }

        /* The data blocks always follow the header, whatever the type is. */
        size_t blocks = (size_t) ((size + TAR_BLOCK - 1) / TAR_BLOCK);
        if (type == 'x' || type == 'g') {
            /* pax extended header: parse path=/linkpath= and apply to the NEXT
             * member. Any other key is metadata we do not need. */
            char *data = malloc((size_t) size + 1);
            if (data == NULL || tar_read_exact(in, data, (size_t) size) != 0) {
                free(data);
                if (error != NULL) *error = msgf("stage: cannot read a pax header in %s", tarball);
                failed = 1;
                break;
            }
            data[size] = '\0';
            if (type == 'x') {
                stage_pax_take(data, (size_t) size, "path", name, sizeof(name));
                stage_pax_take(data, (size_t) size, "linkpath", linkname, sizeof(linkname));
            }
            free(data);
            if (tar_skip_padding(in, size) != 0) {
                if (error != NULL) *error = msgf("stage: %s is truncated after a pax header", tarball);
                failed = 1; break;
            }
            pending = STAGE_KIND_PAX;
            continue;
        }
        if (type == 'L' || type == 'K') {
            /* GNU long name / long link: the data IS the value. */
            char *data = malloc((size_t) size + 1);
            if (data == NULL || tar_read_exact(in, data, (size_t) size) != 0) {
                free(data);
                if (error != NULL) *error = msgf("stage: cannot read a long-name block in %s", tarball);
                failed = 1;
                break;
            }
            data[size] = '\0';
            if (type == 'L') snprintf(member, sizeof(member), "%s", data);
            else snprintf(linkname, sizeof(linkname), "%s", data);
            free(data);
            if (tar_skip_padding(in, size) != 0) {
                if (error != NULL) *error = msgf("stage: %s is truncated after a long-name block", tarball);
                failed = 1; break;
            }
            pending = (type == 'L') ? STAGE_KIND_LONGNAME : STAGE_KIND_LONGLINK;
            continue;
        }
        if (linkname[0] == '\0') snprintf(linkname, sizeof(linkname), "%s", raw_link);

        char target[TAR_NAME_MAX];
        snprintf(target, sizeof(target), "%s/%s", staging, member);
        if (!stage_path_is_safe(member)) {
            if (error != NULL)
                *error = msgf("stage: refusing member '%s' (absolute or escapes the root; "
                              "type '%c', %lld bytes, raw '%s', prefix '%s')",
                              member, type != '\0' ? type : '0', size, raw_name,
                              has_prefix ? prefixbuf : "");
            failed = 1;
            break;
        }

        if (type == '0' || type == '\0') {
            char *slash = strrchr(target, '/');
            if (slash != NULL) { *slash = '\0'; if (stage_mkdir_p(target, 0) != 0) { if (error != NULL) *error = msgf("stage: cannot create %s", target); failed = 1; break; } *slash = '/'; }
            FILE *out = fopen(target, "wb");
            if (out == NULL) { if (error != NULL) *error = msgf("stage: cannot write %s: %s", target, strerror(errno)); failed = 1; break; }
            char buf[16384];
            long long left = size;
            while (left > 0) {
                size_t chunk = left < (long long) sizeof(buf) ? (size_t) left : sizeof(buf);
                if (tar_read_exact(in, buf, chunk) != 0) { fclose(out); if (error != NULL) *error = msgf("stage: %s is truncated inside %s", tarball, member); failed = 1; break; }
                if (fwrite(buf, 1, chunk, out) != chunk) { fclose(out); if (error != NULL) *error = msgf("stage: short write on %s", target); failed = 1; break; }
                left -= (long long) chunk;
            }
            if (failed) break;
            fclose(out);
            chmod(target, (mode_t) (mode & 0777));
            if (tar_skip_padding(in, size) != 0) {
                if (error != NULL) *error = msgf("stage: %s is truncated after %s", tarball, member);
                failed = 1; break;
            }
            files++;
            if (getenv("DSH_ISH_STAGE_DEBUG") != NULL)
                fprintf(stderr, "stage-trace-file: %s size=%lld pad=%lld\n", member, size,
                        (long long) ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK));
        } else if (type == '5') {
            if (stage_mkdir_p(target, 0) != 0) { if (error != NULL) *error = msgf("stage: cannot create directory %s: %s", target, strerror(errno)); failed = 1; break; }
            if (tar_discard(in, size) != 0) { if (error != NULL) *error = msgf("stage: %s is truncated after %s", tarball, member); failed = 1; break; }
            dirs++;
        } else if (type == '2') {
            char *slash = strrchr(target, '/');
            if (slash != NULL) { *slash = '\0'; if (stage_mkdir_p(target, 0) != 0) { if (error != NULL) *error = msgf("stage: cannot create %s", target); failed = 1; break; } *slash = '/'; }
            unlink(target);
            if (symlink(linkname, target) != 0) { if (error != NULL) *error = msgf("stage: cannot symlink %s -> %s: %s", target, linkname, strerror(errno)); failed = 1; break; }
            if (tar_discard(in, size) != 0) { if (error != NULL) *error = msgf("stage: %s is truncated after %s", tarball, member); failed = 1; break; }
            links++;
        } else if (type == '1') {
            char source[TAR_NAME_MAX];
            snprintf(source, sizeof(source), "%s/%s", staging, linkname);
            char *slash = strrchr(target, '/');
            if (slash != NULL) { *slash = '\0'; if (stage_mkdir_p(target, 0) != 0) { if (error != NULL) *error = msgf("stage: cannot create %s", target); failed = 1; break; } *slash = '/'; }
            unlink(target);
            if (link(source, target) != 0) { if (error != NULL) *error = msgf("stage: cannot hardlink %s -> %s: %s", target, source, strerror(errno)); failed = 1; break; }
            if (tar_discard(in, size) != 0) { if (error != NULL) *error = msgf("stage: %s is truncated after %s", tarball, member); failed = 1; break; }
            links++;
        } else {
            /* Devices, FIFOs, and anything else: skip the data, keep the archive. */
            long long left = size;
            char buf[8192];
            int dropped = 0;
            while (left > 0) {
                size_t chunk = left < (long long) sizeof(buf) ? (size_t) left : sizeof(buf);
                if (tar_read_exact(in, buf, chunk) != 0) { dropped = 1; break; }
                left -= (long long) chunk;
            }
            if (dropped) { if (error != NULL) *error = msgf("stage: %s ends inside a skipped member", tarball); failed = 1; break; }
            if (tar_skip_padding(in, size) != 0) {
                if (error != NULL) *error = msgf("stage: %s is truncated after a skipped member", tarball);
                failed = 1; break;
            }
            skipped++;
            name[0] = '\0'; linkname[0] = '\0'; pending = STAGE_KIND_NONE;
            continue;
        }
        /* Regular members consumed their own data above; everything else that
         * reaches here (dirs, links) carries none. */
        name[0] = '\0'; linkname[0] = '\0'; pending = STAGE_KIND_NONE;
    }
    gzclose(in);

    if (failed) {
        (void) stage_remove_tree(staging);
        return -1;
    }

    /* Publish: only a COMPLETE staging becomes the guest root. */
    if (rename(staging, dest) != 0) {
        if (error != NULL) *error = msgf("stage: cannot publish %s -> %s: %s", staging, dest, strerror(errno));
        (void) stage_remove_tree(staging);
        return -1;
    }
    if (stage_seed_resolver(dest) != 0) {
        if (error != NULL) *error = msgf("stage: cannot write a resolver into %s", dest);
        return -1;
    }
    /* Seal what was just published: this manifest is what every later boot
     * verifies the tree against (integrity at every mount, dsh_ish_verify.c).
     * A userland this seam cannot seal is not one it can vouch for — remove
     * it rather than leave a tree a later boot would trust on first use. */
    char *verify_error = NULL;
    if (dsh_ish_manifest_write(dest, tarball, &verify_error) != 0) {
        if (error != NULL)
            *error = verify_error != NULL ? verify_error
                                          : msgf("stage: cannot seal %s", dest);
        else
            free(verify_error);
        (void) stage_remove_tree(dest);
        return -1;
    }
    printf("dsh_ish_stage: %lld files, %lld dirs, %lld links, %lld skipped -> %s\n",
           files, dirs, links, skipped, dest);
    return 0;
}
