/* ish-smoke — the C-level gate for the in-process Linux userland seam.
 *
 * Boots the guest once and runs each `-c 'command line'` in it through the
 * guest's own /bin/sh, printing one JSON object per command and exiting 0 only
 * when every command exited 0. No JS runtime, no simulator, no network: this is
 * the cheapest honest answer to "does a real Linux userland run inside this
 * process, with an exit status and its files where we expect them".
 *
 * tools/e2e/run-ish-local.sh runs this FIRST and the JS scenario second, so a
 * red run says which layer broke instead of only that the end-to-end chain did.
 *
 *   ish-smoke --rootfs ~/dsh-verify/ish-rootfs --workspace /tmp/ws \
 *             -c 'echo hello' -c 'uname -m'
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dsh_ish.h"

struct smoke_args {
    const char *rootfs;
    const char *workspace;
    const char *guest_path;
    const char *workdir;
    const char *stage_tarball;
    const char *stage_dest;
    int timeout_ms;
    int commands;
    int failures;
};

static void usage(void) {
    fprintf(stderr,
            "usage: ish-smoke --rootfs DIR [--workspace DIR] [--guest-path P]\n"
            "                 [--workdir GUESTPATH] [--timeout MS] -c 'command' ...\n"
            "       ish-smoke --stage TARBALL DEST [--workspace DIR] [-c 'command' ...]\n"
            "                 (stage the pinned userland into DEST, then boot it —\n"
            "                  DEST becomes the rootfs when --rootfs is not given)\n");
}

/* One command line runs as `sh -c <text>` INSIDE the guest: parsing and every
 * builtin come from the emulated userland's own shell, not from this host. */
static int run_one(const struct smoke_args *args, const char *command) {
    const char *argv[] = { "/bin/sh", "-c", command, NULL };
    char *error = NULL;
    char *json = dsh_ish_run(args->workdir, argv, args->timeout_ms, &error);
    if (json == NULL) {
        fprintf(stdout, "{\"exitCode\":null,\"stdout\":\"\",\"stderr\":\"%s\"}\n",
                error != NULL ? error : "unknown failure");
        free(error);
        return 1;
    }
    fprintf(stdout, "%s\n", json);
    int ok = strstr(json, "\"exitCode\":0,") != NULL
          && strstr(json, "\"timedOut\":true") == NULL;
    free(json);
    return ok ? 0 : 1;
}

static int parse_args(int argc, char **argv, struct smoke_args *args) {
    memset(args, 0, sizeof(*args));
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        const char *value = (i + 1 < argc) ? argv[i + 1] : NULL;
        if (strcmp(a, "--rootfs") == 0 && value != NULL) args->rootfs = argv[++i];
        else if (strcmp(a, "--stage") == 0 && value != NULL && i + 2 < argc) {
            args->stage_tarball = argv[++i];
            args->stage_dest = argv[++i];
            if (args->rootfs == NULL) args->rootfs = args->stage_dest;
        }
        else if (strcmp(a, "--workspace") == 0 && value != NULL) args->workspace = argv[++i];
        else if (strcmp(a, "--guest-path") == 0 && value != NULL) args->guest_path = argv[++i];
        else if (strcmp(a, "--workdir") == 0 && value != NULL) args->workdir = argv[++i];
        else if (strcmp(a, "--timeout") == 0 && value != NULL) args->timeout_ms = atoi(argv[++i]);
        else if (strcmp(a, "-c") == 0 && value != NULL) { args->commands++; i++; }
        else if (a[0] == '-' && a[1] == 'c' && a[2] != '\0') args->commands++;
        else { usage(); fprintf(stderr, "ish-smoke: unknown argument '%s'\n", a); return -1; }
    }
    if (args->rootfs == NULL) {
        usage();
        fprintf(stderr, "ish-smoke: --rootfs (or --stage TARBALL DEST) is required\n");
        return -1;
    }
    /* A stage-only run is a legitimate mode: it is how CI prepares a userland
     * once and how the e2e proves the extractor before anything boots on it. */
    if (args->commands == 0 && args->stage_tarball == NULL) {
        usage();
        fprintf(stderr, "ish-smoke: at least one -c is required\n");
        return -1;
    }
    return 0;
}

int main(int argc, char **argv) {
    struct smoke_args args;
    if (parse_args(argc, argv, &args) < 0) return 2;

    char *error = NULL;
    if (args.stage_tarball != NULL) {
        if (dsh_ish_stage(args.stage_tarball, args.stage_dest, &error) < 0) {
            fprintf(stdout, "{\"stage\":\"failed\",\"error\":\"%s\"}\n",
                    error != NULL ? error : "unknown failure");
            free(error);
            return 1;
        }
    }
    if (args.commands == 0) return 0;   /* staged only */
    if (dsh_ish_boot(args.rootfs, args.workspace, args.guest_path, &error) < 0) {
        fprintf(stdout, "{\"boot\":\"failed\",\"error\":\"%s\"}\n",
                error != NULL ? error : "unknown failure");
        free(error);
        return 1;
    }

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-c") == 0 && i + 1 < argc) args.failures += run_one(&args, argv[i + 1]);
        else if (argv[i][0] == '-' && argv[i][1] == 'c' && argv[i][2] != '\0')
            args.failures += run_one(&args, argv[i] + 2);
    }
    return args.failures == 0 ? 0 : 1;
}
