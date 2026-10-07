/* dsh_ish_verify.c — re-verify the staged Alpine userland at every guest boot.
 *
 * See dsh_ish_verify.h for the seam-level contract and docs/research/
 * upstream-capability-mounting.md (adoption decision #2) for where the
 * requirement comes from: a digest checked once at fetch/staging time leaves
 * every later boot trusting whatever the container now holds, and a partially
 * written or edited tree then fails somewhere deep inside the guest instead
 * of at the one place that can refuse it — here, before mount_root.
 *
 * Shape (the "staging-time digest file" variant, made full rather than
 * spot-check because the pinned image is small):
 *
 *   seal    dsh_ish_stage walks the published tree and writes
 *           <rootfs>.manifest — one line per entry, sha256 over file CONTENT
 *           (over the symlink TARGET for symlinks), plus a whole-tree digest
 *           over the sorted lines and the source tarball's own sha256.
 *   boot    dsh_ish_boot re-walks the tree and compares every manifest
 *           entry. A mismatch on a pinned entry refuses the boot with the
 *           entry, reason, and expected vs actual digest; one structured
 *           record is printed (the same stdout channel dsh_ish_stage uses).
 *
 * Cost, measured rather than guessed (Linux/WSL2 x86_64 dev machine, the
 * pinned Alpine 3.21.8 aarch64 minirootfs: 520 walked entries, 88 regular
 * files, 8.1 MB of file bytes): verify costs ~25 ms warm / ~45 ms with a cold
 * page cache, seal ~45 ms including the 3.8 MB tarball's own digest — one
 * digit percent of a boot that already takes seconds (the iOS primitive's
 * own comment says so), so the FULL-tree digest runs at every boot rather
 * than spot-checking binaries. Only pinned members are digested on re-walk:
 * guest-authored additions (apk/pip/npm installs, which the contract
 * promises persist) are counted, never hashed, so the per-boot cost stays
 * pinned to the sealed image's size no matter how much the guest installs.
 *
 * Mutability, because the contract promises installed packages persist:
 * entries the pinned userland's own tools legitimately rewrite are sealed
 * like everything else (their staging-time digest is on record) but a
 * mismatch on them is counted, not refused — apk's bookkeeping
 * (etc/apk/world, lib/apk/db/), the resolver config staging itself seeds, and
 * the guest's identity files. Everything else — busybox, musl, apk itself,
 * the TLS trust store, every /bin /sbin /usr/lib binary — is pinned: the
 * guest can install beside the userland, never silently replace it. The one
 * honest trade-off: `apk upgrade` that REPLACES a pinned member is refused at
 * the next boot with the member named; recovery is to delete the staged tree
 * and let it re-stage from the bundled tarball (which also resets installs —
 * recorded in the Agent Note, not hidden here).
 *
 * No subprocess, no thread: seal and verify run on the caller's thread
 * (verify inside dsh_ish_boot's boot lock; seal inside the staging path),
 * plain POSIX I/O plus the sha256 below. Nothing here needs the engine.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "dsh_ish_verify.h"

#ifndef PATH_MAX
#define PATH_MAX 1024
#endif

#define VLINE_MAX (PATH_MAX + 192)
#define VHEX_MAX 65

/* ------------------------------------------------------------------ sha256 */

static const uint32_t v_sha_k[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,
    0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,
    0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
    0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,
    0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
    0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
};

struct v_sha {
    uint32_t h[8];
    uint64_t total;
    uint8_t buf[64];
    size_t fill;
};

static uint32_t v_rotr(uint32_t x, int n) {
    return (x >> n) | (x << (32 - n));
}

static void v_sha_init(struct v_sha *s) {
    static const uint32_t iv[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372,
                                    0xa54ff53a, 0x510e527f, 0x9b05688c,
                                    0x1f83d9ab, 0x5be0cd19 };
    memcpy(s->h, iv, sizeof(iv));
    s->total = 0;
    s->fill = 0;
}

static void v_sha_schedule(uint32_t w[64], const uint8_t block[64]) {
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t) block[i * 4] << 24) | ((uint32_t) block[i * 4 + 1] << 16)
             | ((uint32_t) block[i * 4 + 2] << 8) | (uint32_t) block[i * 4 + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = v_rotr(w[i - 15], 7) ^ v_rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = v_rotr(w[i - 2], 17) ^ v_rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
}

static void v_sha_compress(uint32_t h[8], const uint8_t block[64]) {
    uint32_t w[64];
    v_sha_schedule(w, block);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
    uint32_t e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t s1 = v_rotr(e, 6) ^ v_rotr(e, 11) ^ v_rotr(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = hh + s1 + ch + v_sha_k[i] + w[i];
        uint32_t s0 = v_rotr(a, 2) ^ v_rotr(a, 13) ^ v_rotr(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = s0 + maj;
        hh = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
    h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

static void v_sha_update(struct v_sha *s, const void *data, size_t len) {
    const uint8_t *p = data;
    s->total += len;
    if (s->fill > 0) {
        size_t take = 64 - s->fill;
        if (take > len) take = len;
        memcpy(s->buf + s->fill, p, take);
        s->fill += take;
        p += take;
        len -= take;
        if (s->fill == 64) { v_sha_compress(s->h, s->buf); s->fill = 0; }
    }
    while (len >= 64) {
        v_sha_compress(s->h, p);
        p += 64;
        len -= 64;
    }
    if (len > 0) { memcpy(s->buf, p, len); s->fill = len; }
}

static void v_sha_final(struct v_sha *s, uint8_t out[32]) {
    uint64_t bits = s->total * 8;
    uint8_t pad[72];
    size_t padlen = (s->fill < 56) ? 56 - s->fill : 120 - s->fill;
    pad[0] = 0x80;
    memset(pad + 1, 0, padlen - 1);
    for (int i = 0; i < 8; i++) pad[padlen + i] = (uint8_t) (bits >> (56 - 8 * i));
    v_sha_update(s, pad, padlen + 8);
    for (int i = 0; i < 8; i++) {
        out[i * 4]     = (uint8_t) (s->h[i] >> 24);
        out[i * 4 + 1] = (uint8_t) (s->h[i] >> 16);
        out[i * 4 + 2] = (uint8_t) (s->h[i] >> 8);
        out[i * 4 + 3] = (uint8_t) s->h[i];
    }
}

static void v_sha_hex(const uint8_t digest[32], char out[VHEX_MAX]) {
    static const char hexd[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out[i * 2] = hexd[digest[i] >> 4];
        out[i * 2 + 1] = hexd[digest[i] & 0xf];
    }
    out[64] = '\0';
}

static void v_digest_buffer(const void *data, size_t len, char out[VHEX_MAX]) {
    struct v_sha s;
    uint8_t digest[32];
    v_sha_init(&s);
    v_sha_update(&s, data, len);
    v_sha_final(&s, digest);
    v_sha_hex(digest, out);
}

/* Digest a file's whole content. Size comes from what was READ, not from
 * fstat: the manifest must describe the bytes that were hashed. */
static int v_digest_fd(int fd, char out[VHEX_MAX], long long *size_out) {
    struct v_sha s;
    uint8_t digest[32];
    char buf[65536];
    long long total = 0;
    v_sha_init(&s);
    for (;;) {
        ssize_t n = read(fd, buf, sizeof(buf));
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) break;
        v_sha_update(&s, buf, (size_t) n);
        total += n;
    }
    v_sha_final(&s, digest);
    v_sha_hex(digest, out);
    *size_out = total;
    return 0;
}

static int v_digest_path(const char *path, char out[VHEX_MAX], long long *size_out) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    int status = v_digest_fd(fd, out, size_out);
    close(fd);
    return status;
}

/* -------------------------------------------------------------------- entry */

struct v_ent {
    char *path;            /* root-relative, no leading '/', no whitespace */
    char hex[VHEX_MAX];    /* content digest; "-" when the type carries none */
    long long size;        /* bytes read / link target length; -1 = none */
    int type;              /* 'f' regular, 'l' symlink, 'd' dir, 'o' other */
    int mode;              /* st_mode & 07777; -1 for symlinks */
    int is_mutable;        /* sealed-but-tolerated (see the file comment) */
};

struct v_list {
    struct v_ent *v;
    size_t n, cap;
};

/* Entries the pinned userland's own tools legitimately rewrite. Exact paths
 * and directory prefixes (a prefix also matches its own top directory, so a
 * chmod on /var is state, not tampering). Everything not listed is pinned: a
 * mismatch there refuses the boot. */
static const char *const V_MUTABLE_EXACT[] = {
    "etc/resolv.conf",   /* staging seeds it; host and guest may rewrite it */
    "etc/hosts", "etc/hostname", "etc/mtab",
    "etc/passwd", "etc/group", "etc/shadow", "etc/gshadow",
    "etc/subuid", "etc/subgid",
    "etc/apk/world",     /* apk rewrites it on every install */
};
static const char *const V_MUTABLE_PREFIX[] = {
    "lib/apk/db/",       /* apk's database: installed, scripts.tar, triggers */
    "tmp/", "var/", "root/", "home/", "run/", "media/",
};

static int v_is_mutable(const char *rel) {
    for (size_t i = 0; i < sizeof(V_MUTABLE_EXACT) / sizeof(*V_MUTABLE_EXACT); i++)
        if (strcmp(rel, V_MUTABLE_EXACT[i]) == 0) return 1;
    for (size_t i = 0; i < sizeof(V_MUTABLE_PREFIX) / sizeof(*V_MUTABLE_PREFIX); i++) {
        size_t n = strlen(V_MUTABLE_PREFIX[i]);
        if (strncmp(rel, V_MUTABLE_PREFIX[i], n) == 0) return 1;
        if (strncmp(rel, V_MUTABLE_PREFIX[i], n - 1) == 0 && rel[n - 1] == '\0') return 1;
    }
    return 0;
}

/* The manifest's line format is space-separated, so a path with whitespace
 * cannot be sealed or verified: refusing it here (both at seal and at parse)
 * is fail-loud rule 5, not a silent skip. The pinned image has none. */
static int v_path_sealable(const char *rel) {
    if (rel[0] == '\0' || rel[0] == '/') return 0;
    for (const char *at = rel; *at != '\0'; at++)
        if (*at == ' ' || *at == '\t' || *at == '\n' || *at == '\r') return 0;
    return 1;
}

static void v_ent_line(const struct v_ent *e, char *buf, size_t cap) {
    const char *flag = e->is_mutable ? "m" : "-";
    if (e->type == 'f')
        snprintf(buf, cap, "%s f %04o %lld %s %s", e->hex, e->mode, e->size, flag, e->path);
    else if (e->type == 'l')
        snprintf(buf, cap, "%s l - %lld %s %s", e->hex, e->size, flag, e->path);
    else
        snprintf(buf, cap, "- %c %04o - %s %s", (char) e->type, e->mode, flag, e->path);
}

static int v_list_push(struct v_list *l, const char *path, const char hex[VHEX_MAX],
                       long long size, int type, int mode) {
    if (l->n == l->cap) {
        size_t cap = l->cap > 0 ? l->cap * 2 : 256;
        struct v_ent *grown = realloc(l->v, cap * sizeof(*grown));
        if (grown == NULL) return -1;
        l->v = grown;
        l->cap = cap;
    }
    struct v_ent *e = &l->v[l->n];
    e->path = strdup(path);
    if (e->path == NULL) return -1;
    snprintf(e->hex, sizeof(e->hex), "%s", hex);
    e->size = size;
    e->type = type;
    e->mode = mode;
    /* Recomputed from THIS binary's policy, never trusted from the file: the
     * mutable set is a decision of the host, and a hand-edited flag column
     * must not widen what a boot tolerates. */
    e->is_mutable = v_is_mutable(path);
    l->n++;
    return 0;
}

static void v_list_free(struct v_list *l) {
    for (size_t i = 0; i < l->n; i++) free(l->v[i].path);
    free(l->v);
    l->v = NULL;
    l->n = l->cap = 0;
}

static int v_cmp(const void *a, const void *b) {
    return strcmp(((const struct v_ent *) a)->path, ((const struct v_ent *) b)->path);
}

static long long v_now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long) ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static char *v_msgf(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char buf[512];
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    return strdup(buf);
}

/* ------------------------------------------------------------------ walking */

struct v_ctx {
    struct v_list list;
    const struct v_list *sealed;   /* NULL at seal: digest everything */
    char path[PATH_MAX];
    size_t root_len;
    size_t path_len;
    int errors;                    /* unreadable/unsealable entries */
};

static int v_ctx_init(struct v_ctx *ctx, const char *root) {
    memset(ctx, 0, sizeof(*ctx));
    size_t len = strlen(root);
    while (len > 1 && root[len - 1] == '/') len--;
    if (len == 0 || len >= sizeof(ctx->path)) return -1;
    memcpy(ctx->path, root, len);
    ctx->path[len] = '\0';
    ctx->root_len = len;
    ctx->path_len = len;
    return 0;
}

/* Is `rel` among the sealed entries? The sealed list is sorted, so this is a
 * binary search — the walk consults it for every entry, and 521 entries do
 * not justify anything fancier. */
static int v_sealed_contains(const struct v_list *sealed, const char *rel) {
    size_t lo = 0, hi = sealed->n;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        int cmp = strcmp(sealed->v[mid].path, rel);
        if (cmp == 0) return 1;
        if (cmp < 0) lo = mid + 1;
        else hi = mid;
    }
    return 0;
}

/* Digest this entry only when a manifest will compare it: sealed paths at
 * verify, everything at seal. Additions are counted, never hashed — that is
 * what pins the per-boot cost to the sealed image's size. */
static int v_ctx_needs_digest(const struct v_ctx *ctx, const char *rel) {
    if (ctx->sealed == NULL) return 1;
    return v_sealed_contains(ctx->sealed, rel);
}

static int v_ctx_append(struct v_ctx *ctx, const char *name) {
    size_t name_len = strlen(name);
    size_t len = ctx->path_len + 1 + name_len;
    if (len >= sizeof(ctx->path)) return -1;
    ctx->path[ctx->path_len] = '/';
    memcpy(ctx->path + ctx->path_len + 1, name, name_len + 1);
    ctx->path_len = len;
    return 0;
}

static void v_ctx_truncate(struct v_ctx *ctx, size_t mark) {
    ctx->path[mark] = '\0';
    ctx->path_len = mark;
}

static int v_collect_dir(struct v_ctx *ctx);

/* One walked entry: lstat decides the type, the digest covers what can
 * change (file content, symlink target), dirs record presence and mode. */
static int v_collect_entry(struct v_ctx *ctx) {
    struct stat st;
    if (lstat(ctx->path, &st) != 0) {
        ctx->errors++;
        return -1;
    }
    const char *rel = ctx->path + ctx->root_len + 1;
    if (!v_path_sealable(rel)) {
        ctx->errors++;
        return -1;
    }
    char hex[VHEX_MAX] = "-";
    long long size = -1;
    int mode = -1;
    int type = 'o';
    if (S_ISDIR(st.st_mode)) {
        type = 'd';
        mode = (int) (st.st_mode & 07777);
    } else if (S_ISREG(st.st_mode)) {
        type = 'f';
        mode = (int) (st.st_mode & 07777);
        if (v_ctx_needs_digest(ctx, rel)) {
            int fd = open(ctx->path, O_RDONLY);
            if (fd < 0 || v_digest_fd(fd, hex, &size) != 0) {
                if (fd >= 0) close(fd);
                ctx->errors++;
                return -1;
            }
            close(fd);
        }
    } else if (S_ISLNK(st.st_mode)) {
        type = 'l';
        char target[PATH_MAX];
        ssize_t n = readlink(ctx->path, target, sizeof(target) - 1);
        if (n < 0) {
            ctx->errors++;
            return -1;
        }
        target[n] = '\0';
        size = n;
        if (v_ctx_needs_digest(ctx, rel)) v_digest_buffer(target, (size_t) n, hex);
    }
    int status = v_list_push(&ctx->list, rel, hex, size, type, mode);
    if (status == 0 && type == 'd') status = v_collect_dir(ctx);
    return status;
}

static int v_collect_dir(struct v_ctx *ctx) {
    DIR *dir = opendir(ctx->path);
    if (dir == NULL) {
        ctx->errors++;
        return -1;
    }
    struct dirent *de;
    int status = 0;
    while ((de = readdir(dir)) != NULL) {
        if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
        size_t mark = ctx->path_len;
        if (v_ctx_append(ctx, de->d_name) != 0) {
            ctx->errors++;
            status = -1;
            break;
        }
        if (v_collect_entry(ctx) != 0) status = -1;
        v_ctx_truncate(ctx, mark);
    }
    closedir(dir);
    return status;
}

/* Walk the whole tree under ctx->path (the root). Returns 0 when every entry
 * was read; ctx->errors carries the ones that were not. */
static int v_collect_tree(struct v_ctx *ctx) {
    struct stat st;
    if (lstat(ctx->path, &st) != 0 || !S_ISDIR(st.st_mode)) return -1;
    return v_collect_dir(ctx);
}

/* -------------------------------------------------------------------- seal */

/* The whole-tree digest: sha256 over the sorted entry lines, newline
 * terminated. The sort order is the comparator both seal and verify use, so
 * the number is reproducible from either side. */
static void v_tree_digest(const struct v_list *l, char out[VHEX_MAX]) {
    struct v_sha s;
    uint8_t digest[32];
    char line[VLINE_MAX];
    v_sha_init(&s);
    for (size_t i = 0; i < l->n; i++) {
        v_ent_line(&l->v[i], line, sizeof(line));
        v_sha_update(&s, line, strlen(line));
        v_sha_update(&s, "\n", 1);
    }
    v_sha_final(&s, digest);
    v_sha_hex(digest, out);
}

/* Write the manifest via a temp file + rename, so a crash mid-write never
 * leaves a half manifest behind (a partial manifest is a REFUSAL at boot,
 * not something to be re-sealed over). Returns 0 or -1 with `*error`. */
static int v_manifest_publish(const char *root, const struct v_list *l,
                              const char *tree, const char *tar_hex, char **error) {
    char mpath[PATH_MAX], tmp[PATH_MAX];
    if (snprintf(mpath, sizeof(mpath), "%s.manifest", root) >= (int) sizeof(mpath)
        || snprintf(tmp, sizeof(tmp), "%s.manifest.tmp", root) >= (int) sizeof(tmp)) {
        if (error != NULL) *error = v_msgf("verify: manifest path for %s is too long", root);
        return -1;
    }
    FILE *out = fopen(tmp, "w");
    if (out == NULL) {
        if (error != NULL) *error = v_msgf("verify: cannot write %s: %s", tmp, strerror(errno));
        return -1;
    }
    fprintf(out, "# dsh-ish-manifest 1\n");
    fprintf(out, "# tarball-sha256 %s\n", tar_hex);
    fprintf(out, "# entries %zu\n", l->n);
    fprintf(out, "# tree-sha256 %s\n", tree);
    char line[VLINE_MAX];
    for (size_t i = 0; i < l->n; i++) {
        v_ent_line(&l->v[i], line, sizeof(line));
        fprintf(out, "%s\n", line);
    }
    int broken = (fflush(out) != 0 || fsync(fileno(out)) != 0 || fclose(out) != 0);
    if (!broken && rename(tmp, mpath) != 0) broken = 1;
    if (broken) {
        if (error != NULL)
            *error = v_msgf("verify: cannot publish %s: %s", mpath, strerror(errno));
        unlink(tmp);
        return -1;
    }
    return 0;
}

int dsh_ish_manifest_write(const char *root, const char *tarball, char **error) {
    if (error != NULL) *error = NULL;
    long long started = v_now_ms();
    struct v_ctx ctx;
    if (v_ctx_init(&ctx, root) != 0) {
        if (error != NULL) *error = v_msgf("verify: cannot walk %s", root);
        return -1;
    }
    if (v_collect_tree(&ctx) != 0 || ctx.errors > 0) {
        if (error != NULL)
            *error = v_msgf("verify: cannot seal %s (%d unreadable/unsealable entr%s)",
                            root, ctx.errors, ctx.errors == 1 ? "y" : "ies");
        v_list_free(&ctx.list);
        return -1;
    }
    qsort(ctx.list.v, ctx.list.n, sizeof(*ctx.list.v), v_cmp);

    char tree[VHEX_MAX];
    char tar_hex[VHEX_MAX];
    long long tar_size = 0;
    v_tree_digest(&ctx.list, tree);
    snprintf(tar_hex, sizeof(tar_hex), "unsealed");
    if (tarball != NULL && v_digest_path(tarball, tar_hex, &tar_size) != 0) {
        if (error != NULL) *error = v_msgf("verify: cannot digest the tarball %s", tarball);
        v_list_free(&ctx.list);
        return -1;
    }
    if (v_manifest_publish(root, &ctx.list, tree, tar_hex, error) != 0) {
        v_list_free(&ctx.list);
        return -1;
    }
    printf("dsh_ish_verify: verdict=%s rootfs=%s entries=%zu tree-sha256=%s%s elapsed-ms=%lld\n",
           tarball != NULL ? "stage-sealed" : "first-boot-sealed",
           root, ctx.list.n, tree,
           tarball != NULL ? "" : " note=first-boot-trust",
           v_now_ms() - started);
    v_list_free(&ctx.list);
    return 0;
}

/* ------------------------------------------------------------------- verify */

struct v_header {
    char tarball[VHEX_MAX];
    char tree[VHEX_MAX];
    long long entries;
    int saw_tree;
};

static int v_header_take(struct v_header *h, const char *line) {
    if (sscanf(line, "# tarball-sha256 %64s", h->tarball) == 1) return 1;
    if (sscanf(line, "# entries %lld", &h->entries) == 1) return 1;
    if (sscanf(line, "# tree-sha256 %64s", h->tree) == 1) {
        h->saw_tree = 1;
        return 1;
    }
    return 0;
}

/* Parse one sealed entry line. Paths are whitespace-free (enforced at seal),
 * so plain %s fields carry them. Anything else is a malformed manifest.
 * path[] is 4096 because the %4095s below is spelled for it — smaller (e.g.
 * darwin's 1024 PATH_MAX) trips -Wfortify-source, and the manifest is
 * machine-written by our own stager, never longer than a guest path. */
static int v_parse_entry(const char *line, struct v_ent *e) {
    char type[8], mode[16], size[32], flag[8], path[4096];
    if (sscanf(line, "%64s %7s %15s %31s %7s %4095s",
               e->hex, type, mode, size, flag, path) != 6)
        return -1;
    if (path[0] == '\0' || strlen(type) != 1 || strlen(flag) != 1) return -1;
    if (!v_path_sealable(path)) return -1;
    e->path = strdup(path);
    if (e->path == NULL) return -1;
    e->type = type[0];
    e->mode = strcmp(mode, "-") == 0 ? -1 : (int) strtoul(mode, NULL, 8);
    e->size = strcmp(size, "-") == 0 ? -1 : strtoll(size, NULL, 10);
    e->is_mutable = flag[0] == 'm';
    return 0;
}

/* The manifest's entry lines (headers land in `h`). One pass, fail loud. */
static int v_manifest_read_lines(FILE *in, const char *mpath, struct v_list *sealed,
                                 struct v_header *h, char **error) {
    char line[VLINE_MAX];
    long long linenr = 0;
    int broken = 0;
    while (!broken && fgets(line, sizeof(line), in) != NULL) {
        linenr++;
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = '\0';
        if (line[0] == '#' || line[0] == '\0') {
            v_header_take(h, line);
            continue;
        }
        struct v_ent e;
        if (v_parse_entry(line, &e) != 0) {
            if (error != NULL)
                *error = v_msgf("verify: %s line %lld is not a sealed entry — "
                                "refusing rather than re-sealing", mpath, linenr);
            broken = 1;
            break;
        }
        broken = v_list_push(sealed, e.path, e.hex, e.size, e.type, e.mode) != 0;
        free(e.path);
    }
    if (!broken && ferror(in)) broken = 1;
    return broken ? -1 : 0;
}

/* Read `<root>.manifest`. Returns 0 (read), 1 (absent — caller seals), or
 * -1 with `*error` (unreadable or malformed: refuse, never re-seal over a
 * manifest this seam did not write). */
static int v_manifest_read(const char *root, struct v_list *sealed,
                           struct v_header *h, char **error) {
    char mpath[PATH_MAX];
    if (snprintf(mpath, sizeof(mpath), "%s.manifest", root) >= (int) sizeof(mpath)) {
        if (error != NULL) *error = v_msgf("verify: manifest path for %s is too long", root);
        return -1;
    }
    FILE *in = fopen(mpath, "r");
    if (in == NULL) {
        if (errno == ENOENT) return 1;
        if (error != NULL)
            *error = v_msgf("verify: cannot read %s: %s", mpath, strerror(errno));
        return -1;
    }
    memset(h, 0, sizeof(*h));
    snprintf(h->tarball, sizeof(h->tarball), "unsealed");
    int broken = v_manifest_read_lines(in, mpath, sealed, h, error) != 0;
    if (fclose(in) != 0) broken = 1;
    if (!broken && !h->saw_tree) {
        if (error != NULL)
            *error = v_msgf("verify: %s carries no tree digest — refusing", mpath);
        broken = 1;
    }
    if (!broken && (sealed->n == 0 || (long long) sealed->n != h->entries)) {
        if (error != NULL)
            *error = v_msgf("verify: %s declares %lld entries but %zu parsed — "
                            "truncated manifest, refusing", mpath, h->entries, sealed->n);
        broken = 1;
    }
    return broken ? -1 : 0;
}

/* What differs between the sealed entry and the tree as it stands. NULL
 * when they agree. */
static const char *v_entry_differs(const struct v_ent *sealed, const struct v_ent *now) {
    if (sealed->type != now->type) return "type-changed";
    if (sealed->type != 'l' && sealed->mode != now->mode) return "mode-changed";
    if (sealed->type != 'd' && sealed->size != now->size) return "size-mismatch";
    if (sealed->type != 'd' && strcmp(sealed->hex, now->hex) != 0) return "digest-mismatch";
    return NULL;
}

struct v_verdict {
    struct v_sha tree_now;        /* whole-tree digest over the current state */
    char tree_hex[VHEX_MAX];
    const struct v_ent *bad;      /* first refusing entry (sealed side) */
    struct v_ent bad_now;         /* ...and its current state */
    const char *reason;           /* NULL = nothing refused the boot */
    char expected[160];
    char actual[160];
    size_t additions;
    size_t mutable_changed;
};

static void v_field(char out[160], const struct v_ent *e) {
    if (e->type == 'f')
        snprintf(out, 160, "sha256=%s size=%lld mode=%04o", e->hex, e->size, e->mode);
    else if (e->type == 'l')
        snprintf(out, 160, "target-sha256=%s target-bytes=%lld", e->hex, e->size);
    else
        snprintf(out, 160, "type=%c mode=%04o", (char) e->type, e->mode);
}

/* The merged walk: both lists are sorted by path, so one pass decides for
 * every sealed entry whether it still matches, and counts everything else.
 * The running tree digest covers the sealed member set as it stands NOW
 * (additions are not part of it — they were never sealed). */
static void v_merge(struct v_verdict *v, const struct v_list *sealed,
                    const struct v_list *now) {
    char line[VLINE_MAX];
    size_t i = 0, j = 0;
    while (i < sealed->n || j < now->n) {
        int cmp = 0;
        if (i >= sealed->n) cmp = 1;
        else if (j >= now->n) cmp = -1;
        else cmp = strcmp(sealed->v[i].path, now->v[j].path);
        if (cmp == 0) {
            const char *reason = v_entry_differs(&sealed->v[i], &now->v[j]);
            if (reason == NULL) {
                /* unchanged */
            } else if (sealed->v[i].is_mutable) {
                v->mutable_changed++;
            } else if (v->reason == NULL) {
                v->bad = &sealed->v[i];
                v->bad_now = now->v[j];
                v->reason = reason;
            }
            v_ent_line(&now->v[j], line, sizeof(line));
            v_sha_update(&v->tree_now, line, strlen(line));
            v_sha_update(&v->tree_now, "\n", 1);
            i++;
            j++;
        } else if (cmp < 0) {
            if (sealed->v[i].is_mutable) v->mutable_changed++;
            else if (v->reason == NULL) {
                v->bad = &sealed->v[i];
                v->reason = "missing";
            }
            v_ent_line(&sealed->v[i], line, sizeof(line));
            v_sha_update(&v->tree_now, line, strlen(line));
            v_sha_update(&v->tree_now, "\n", 1);
            i++;
        } else {
            v->additions++;
            j++;
        }
    }
}

/* Report and (on refusal) build the gateway error. Exactly one structured
 * record per verification, naming expected vs actual. */
static int v_report(struct v_verdict *v, const char *root, size_t entries,
                    long long elapsed, char **error) {
    if (v->reason == NULL) {
        /* tree-sha256 here is the digest of the sealed member set AS IT
         * STANDS NOW (equal to the manifest's header value when nothing
         * changed; drifting only through the tolerated mutable set). */
        printf("dsh_ish_verify: verdict=ok rootfs=%s entries=%zu additions=%zu "
               "mutable-changed=%zu tree-sha256=%s elapsed-ms=%lld\n",
               root, entries, v->additions, v->mutable_changed, v->tree_hex, elapsed);
        return 0;
    }
    v_field(v->expected, v->bad);
    if (strcmp(v->reason, "missing") == 0)
        snprintf(v->actual, sizeof(v->actual), "missing");
    else
        v_field(v->actual, &v->bad_now);
    printf("dsh_ish_verify: verdict=refused rootfs=%s entry=%s reason=%s "
           "expected=%s actual=%s tree-sha256=%s elapsed-ms=%lld\n",
           root, v->bad->path, v->reason, v->expected, v->actual,
           v->tree_hex, elapsed);
    if (error != NULL)
        *error = v_msgf("guest root %s failed verification: %s %s (expected %s, "
                        "actual %s) — the staged userland is not what was sealed; "
                        "refusing to boot. Re-stage the userland to recover.",
                        root, v->bad->path, v->reason, v->expected, v->actual);
    return -1;
}

int dsh_ish_rootfs_verify(const char *root, char **error) {
    if (error != NULL) *error = NULL;
    long long started = v_now_ms();
    struct v_list sealed = { 0 };
    struct v_header header;
    int have = v_manifest_read(root, &sealed, &header, error);
    if (have < 0) {
        v_list_free(&sealed);
        return -1;
    }
    if (have == 1) {
        /* No manifest: a tree this seam did not stage (the desktop e2e
         * extracts one with its own tools) or an install predating seals.
         * Trust on first use is the only honest anchor available in-process;
         * from this boot on, the tree is pinned. */
        v_list_free(&sealed);
        return dsh_ish_manifest_write(root, NULL, error);
    }

    struct v_ctx ctx;
    if (v_ctx_init(&ctx, root) != 0) {
        if (error != NULL) *error = v_msgf("verify: cannot walk %s", root);
        v_list_free(&sealed);
        return -1;
    }
    ctx.sealed = &sealed;
    if (v_collect_tree(&ctx) != 0 || ctx.errors > 0) {
        if (error != NULL)
            *error = v_msgf("verify: %s cannot be walked (%d unreadable entr%s) — "
                            "the staged userland is not intact", root, ctx.errors,
                            ctx.errors == 1 ? "y" : "ies");
        v_list_free(&ctx.list);
        v_list_free(&sealed);
        return -1;
    }
    qsort(ctx.list.v, ctx.list.n, sizeof(*ctx.list.v), v_cmp);

    struct v_verdict verdict;
    memset(&verdict, 0, sizeof(verdict));
    v_sha_init(&verdict.tree_now);
    v_merge(&verdict, &sealed, &ctx.list);
    uint8_t digest[32];
    v_sha_final(&verdict.tree_now, digest);
    v_sha_hex(digest, verdict.tree_hex);

    int status = v_report(&verdict, root, sealed.n, v_now_ms() - started, error);
    v_list_free(&ctx.list);
    v_list_free(&sealed);
    return status;
}
