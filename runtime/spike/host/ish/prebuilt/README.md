# prebuilt/libvdso.so.elf

The guest aarch64 vdso, built ONCE from the pinned vendored iSH sources
(`runtime/spike/vendor/ensure-ish.sh`'s commit + tarball sha256; source
`vendor/ish/vdso/arm64/vdso.c`) with an lld-equipped clang
(`-target aarch64-linux-gnu -fuse-ld=lld -nostdlib -shared`).

Why committed: the iOS/Android/HarmonyOS app builds are CROSS compiles —
Apple clang has no ELF linker, so a host configure on a machine without
Homebrew LLVM writes the zero-byte placeholder the kernel refuses (a zeroed
vdso makes vdso_symbol() abort the host on the first guest signal). The
vdso is a GUEST artifact, identical on every platform, so one pinned build
serves every host (the same shape as the pinned rootfs tarball).

Pin: sha256 fecafc2e93f23624cb2e8dc3dc57b1254d4c8bc115013d23985985ee936ae0b9
Regenerate: `cmake -S runtime/spike/host/ish -B runtime/spike/build/ish &&
cmake --build runtime/spike/build/ish --target ish-vdso` on a machine with
Homebrew LLVM, then copy `runtime/spike/build/ish/vdso/libvdso.so.elf`
here and update this pin.
