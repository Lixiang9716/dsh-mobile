/*
 * main_cli.c — desktop CLI driver for the M1 spike (macOS/Linux proof run).
 * stdout carries ONLY the canonical E2E log lines (so `> logs.txt` feeds the
 * checker directly); diagnostics go to stderr; exit 0 = scenario completed
 * and passed.
 */
#include "dsh_spike_host.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void on_log(void *ud, const char *line) {
    (void)ud;
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static char *slurp(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) { fclose(f); return NULL; }
    char *buf = malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[got] = 0;
    return buf;
}

int main(int argc, char **argv) {
    const char *base = argc > 1 ? argv[1] : "..";
    const char *entry = argc > 2 ? argv[2] : "scenario/m1-spike-boot.js";
    char entry_path[1024];
    snprintf(entry_path, sizeof(entry_path), "%s/%s", base, entry);

    char *source = slurp(entry_path);
    if (!source) {
        fprintf(stderr, "spike: cannot read entry %s\n", entry_path);
        return 2;
    }

    dsh_spike_sink sink = { on_log, NULL };
    dsh_spike_t *s = dsh_spike_new(base, &sink);
    if (!s) {
        fprintf(stderr, "spike: runtime init failed\n");
        free(source);
        return 2;
    }

    int rc = dsh_spike_eval(s, entry, source);
    free(source);
    if (rc == 0) rc = dsh_spike_pump(s);

    int exit_code =
        (rc == 0 && dsh_spike_complete(s) && dsh_spike_pass(s)) ? 0 : 1;
    fprintf(stderr, "spike: %s (complete=%d pass=%d)\n",
            exit_code == 0 ? "PASS" : "FAIL",
            dsh_spike_complete(s), dsh_spike_pass(s));
    if (rc < 0 || exit_code != 0) {
        fprintf(stderr, "spike: error: %s\n", dsh_spike_error(s));
    }
    dsh_spike_free(s);
    return exit_code;
}
