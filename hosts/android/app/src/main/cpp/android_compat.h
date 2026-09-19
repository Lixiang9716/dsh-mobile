/*
 * android_compat.h — force-included by every C translation unit in this
 * build (see CMakeLists.txt -include). bionic hides arc4random_buf from the
 * headers below API 28, but the spike minSdk is 26, and
 * runtime/spike/host/dsh_spike_host.c's __ANDROID__ branch calls it. This
 * header restores the declaration; the definition lives in android_compat.c
 * and links into this .so only (never collides with bionic on API >= 28).
 *
 * Plain C declarations only, no __BEGIN_DECLS/extern "C" interleave: there
 * is no C++ embedder (same stance as dsh_spike_host.h), and the syntax
 * checker's tree-sitter C grammar misparses that preprocessor/brace shape.
 */
#ifndef DSH_ANDROID_COMPAT_H
#define DSH_ANDROID_COMPAT_H

#if defined(__ANDROID__) && defined(__ANDROID_API__) && __ANDROID_API__ < 28
#include <stddef.h>
void arc4random_buf(void *buf, size_t n);
#endif

#endif /* DSH_ANDROID_COMPAT_H */
