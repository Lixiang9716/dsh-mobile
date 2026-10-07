import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * android-jni-surface — the Kotlin↔C JNI closure for the Android host.
 *
 * #338 shipped JsRuntime.nativeWasmLast (Kotlin) against a C export named
 * Java_..._nativeWasmLastError: the symbol only binds at the first call, so
 * the release seat booted fine in CI (debug scenarios never hit the failing
 * wasmRun branch) and died with UnsatisfiedLinkError on the first device boot
 * that read the wasm error slot — taking the whole serial runtime down with
 * it. A grep at review time is not a gate; this file is.
 *
 * Both directions are pinned: a Kotlin `external fun` with no C symbol is a
 * future UnsatisfiedLinkError (fail loud here, not on a device); a C export
 * with no Kotlin external is drift from the same rename family — dead weight
 * that hides which side moved.
 */

const CPP_DIR = fileURLToPath(
  new URL('../../hosts/android/app/src/main/cpp/', import.meta.url),
);
const RUNTIME_KT = fileURLToPath(
  new URL(
    '../../hosts/android/app/src/main/java/com/dshmobile/host/JsRuntime.kt',
    import.meta.url,
  ),
);

const JNI_PREFIX = 'Java_com_dshmobile_host_JsRuntime_';

/** The Kotlin `external fun` names on the runtime seam (JsRuntime.kt). */
const kotlinExternals = () => {
  const source = readFileSync(RUNTIME_KT, 'utf8');
  return new Set([...source.matchAll(/external fun\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]));
};

/** The JNI symbol names every C file under cpp/ exports for JsRuntime. */
const cExports = () => {
  const names = new Set();
  for (const entry of readdirSync(CPP_DIR)) {
    if (!entry.endsWith('.c')) continue;
    const source = readFileSync(join(CPP_DIR, entry), 'utf8');
    for (const match of source.matchAll(new RegExp(`${JNI_PREFIX}([A-Za-z0-9_]+)`, 'g'))) {
      names.add(match[1]);
    }
  }
  return names;
};

describe('android-jni-surface: every Kotlin external binds to a C symbol', () => {
  it('each external fun in JsRuntime.kt has its JNI export under cpp/', () => {
    const exported = cExports();
    const missing = [...kotlinExternals()].filter((name) => !exported.has(name));
    expect(missing, `externals with no Java_com_dshmobile_host_JsRuntime_<name> symbol: ${missing.join(', ')}`).toEqual([]);
  });

  it('each JsRuntime JNI export under cpp/ is declared by a Kotlin external', () => {
    const declared = kotlinExternals();
    const orphaned = [...cExports()].filter((name) => !declared.has(name));
    expect(orphaned, `C exports no Kotlin external declares: ${orphaned.join(', ')}`).toEqual([]);
  });
});
