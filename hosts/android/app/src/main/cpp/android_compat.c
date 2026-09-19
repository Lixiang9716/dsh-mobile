/*
 * android_compat.c — arc4random_buf for Android API levels where bionic does
 * not yet ship it (minSdk 26; bionic introduced it in 28). Fills the buffer
 * from the kernel CSPRNG: getrandom(2) when the syscall works, /dev/urandom
 * otherwise. Same contract as bionic: the buffer is filled fully or the
 * process aborts — the spike never runs on a fake entropy source.
 */
#include "android_compat.h"

#if defined(__ANDROID__) && defined(__ANDROID_API__) && __ANDROID_API__ < 28

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

void arc4random_buf(void *buf, size_t n) {
    unsigned char *out = buf;
    size_t filled = 0;
    while (filled < n) {
        ssize_t got = syscall(SYS_getrandom, out + filled, n - filled, 0);
        if (got > 0) {
            filled += (size_t)got;
            continue;
        }
        if (got < 0 && (errno == EINTR || errno == EAGAIN)) {
            continue;
        }
        break; /* getrandom unusable here — fall through to the device */
    }
    if (filled >= n) {
        return;
    }
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) {
        abort(); /* no kernel RNG available: refuse to fake entropy */
    }
    while (filled < n) {
        ssize_t got = read(fd, out + filled, n - filled);
        if (got > 0) {
            filled += (size_t)got;
            continue;
        }
        if (got < 0 && errno == EINTR) {
            continue;
        }
        abort();
    }
    close(fd);
}

#endif /* __ANDROID__ && __ANDROID_API__ < 28 */
