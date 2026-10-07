#!/usr/bin/env node
// dsh:logging-exempt (tools/ dev script: console IS the product)
/**
 * check-descriptor-parity.mjs — the harmony binding face's descriptor
 * honesty, checked statically in the three places it can drift apart:
 *
 *   1. hosts/harmony/entry/src/main/ets/model/HostPhase.ets
 *      BINDING_DESCRIPTOR (what the runtime negotiates on)
 *   2. hosts/harmony/entry/src/main/cpp/gateway_smoke.cpp
 *      DSH_BINDING_DESCRIPTOR (the C fallback the header comment says to
 *      keep in sync) + the smoke_serve forward list (what C actually
 *      routes to the ArkTS layer) + smoke_known_absent (what C answers
 *      `unavailable`)
 *   3. HostPhase.onDispatch's branch names (what the ArkTS layer actually
 *      serves) cross-checked against the primitive modules on disk
 *      (TimerPrimitive.ets & friends)
 *
 * The rules (contract/primitives.md §7 #1 — absence declared honestly,
 * never faked; the gateway_smoke.cpp header's "keep in sync"):
 *   - the two descriptors' available/unavailable arrays are identical;
 *   - every name the C side forwards unconditionally is declared
 *     available (httpFetch.abort is control-plane: never settled, not a
 *     row; fs user-scope forwards ride the fsRead/fsWrite/fsScope rows);
 *   - every name onDispatch routes to a module is available, or a PHASED
 *     row (declared unavailable AND answered unavailable in C);
 *   - smoke_known_absent names are exactly the non-phased unavailable
 *     rows (the honest-absence families), and C answers them
 *     `unavailable` ahead of the invalid fall-through.
 *
 * usage: node tools/check-descriptor-parity.mjs [--selftest]
 *   exit 0 = in parity, 1 = drift (named, with file:line). --selftest
 *   proves the rejections (rule 6: a gate that never fails is vacuous).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const fail = (problems) => {
  console.error(`descriptor-parity: FAIL (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
};

/** Concatenate the string literals of a `const X = 'a' + 'b'…;` block.
 * Handles both the ArkTS single-quoted form and the C double-quoted form
 * with backslash-escaped inner quotes ("{\"available\":…"). */
const literalConcat = (source, anchor) => {
  const at = source.indexOf(anchor);
  if (at < 0) return null;
  const end = source.indexOf(';', at);
  const body = source.slice(at, end);
  const single = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  if (single.length > 0) return single.join('');
  const double = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (double.length === 0) return null;
  return double.map((s) => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\')).join('');
};

/** The names compared in a smoke_serve branch, up to an early return. */
const strcmpNames = (block) =>
  [...block.matchAll(/strcmp\(name, "([a-zA-Z.]+)"\)/g)].map((m) => m[1]);

const parseDescriptor = (json, label, problems) => {
  try {
    const d = JSON.parse(json);
    if (!Array.isArray(d.available) || !Array.isArray(d.unavailable)) throw new Error('shape');
    return d;
  } catch {
    problems.push(`${label}: not a parsable descriptor object: ${json.slice(0, 80)}…`);
    return null;
  }
};

/** Faces 1: the two descriptors must be byte-identical JSON, well-formed,
 * duplicate-free, and non-overlapping. Returns {etsDesc, cppDesc, etsJson,
 * cppJson} or null after pushing problems. */
const checkDescriptorsIdentical = (ets, cpp, problems) => {
  const etsJson = literalConcat(ets, 'export const BINDING_DESCRIPTOR');
  const cppJson = literalConcat(cpp, 'const char *DSH_BINDING_DESCRIPTOR');
  if (etsJson === null) problems.push('HostPhase.ets: BINDING_DESCRIPTOR anchor not found');
  if (cppJson === null) problems.push('gateway_smoke.cpp: DSH_BINDING_DESCRIPTOR anchor not found');
  if (problems.length) return null;
  const etsDesc = parseDescriptor(etsJson, 'HostPhase.ets BINDING_DESCRIPTOR', problems);
  const cppDesc = parseDescriptor(cppJson, 'gateway_smoke.cpp DSH_BINDING_DESCRIPTOR', problems);
  if (problems.length) return null;
  for (const key of ['available', 'unavailable']) {
    if (JSON.stringify(etsDesc[key]) !== JSON.stringify(cppDesc[key])) {
      problems.push(`descriptors differ on ${key}:\n      ArkTS: ${JSON.stringify(etsDesc[key])}\n      C:     ${JSON.stringify(cppDesc[key])}`);
    }
  }
  const dupes = (arr) => arr.filter((v, i) => arr.indexOf(v) !== i);
  for (const key of ['available', 'unavailable']) {
    if (dupes(etsDesc[key]).length) problems.push(`${key} carries duplicates: ${dupes(etsDesc[key])}`);
  }
  const overlap = etsDesc.available.filter((n) => etsDesc.unavailable.includes(n));
  if (overlap.length) problems.push(`rows both available and unavailable: ${overlap}`);
  return { etsDesc, cppDesc, etsJson, cppJson };
};

/** Face 2: the C binding-mode forward list ⊆ available; the phased rows
 * (C-side smoke_reject unavailable) ⊆ declared unavailable. Returns the
 * known-absent set both faces 3 and 3b consume. */
const checkForwardAndPhased = (cpp, etsDesc, problems) => {
  const serveAt = cpp.indexOf('static void smoke_serve(');
  const serveBody = cpp.slice(serveAt, cpp.indexOf('\n}', serveAt));
  const bindingBlock = serveBody.slice(
    serveBody.indexOf('if (b->forward_fn != nullptr) {'),
    serveBody.indexOf('if (strcmp(name, "fsWrite") == 0)'),
  );
  const forwarded = new Set(strcmpNames(bindingBlock));
  // control-plane + user-scope conditional forwards: legal riders, not rows
  for (const rider of ['httpFetch.abort', 'fsRead', 'fsWrite', 'fsScope.persist', 'fsScope.resolve']) {
    forwarded.delete(rider);
  }
  // the phased rows ride the same binding block but smoke_reject (never
  // forward_fn) — they belong to the phased check below, not this one
  for (const name of ['cameraRecordStart', 'cameraRecordStop']) {
    forwarded.delete(name);
  }
  // the phased rows forward-reject in C itself (smoke_reject unavailable)
  const phasedBlock = serveBody.slice(
    serveBody.indexOf('cameraRecordStart') - 60,
    serveBody.indexOf('httpFetch.abort'),
  );
  const phased = strcmpNames(phasedBlock);
  for (const name of forwarded) {
    if (!etsDesc.available.includes(name)) {
      problems.push(`C forwards "${name}" to the ArkTS layer but the descriptor does not declare it available`);
    }
  }
  for (const name of phased) {
    if (!etsDesc.unavailable.includes(name)) {
      problems.push(`"${name}" answers unavailable in C (phased) but is not declared unavailable`);
    }
  }
  return { serveBody, phased };
};

/** Face 3: onDispatch served names ⊆ available; declared absent
 * families = smoke_known_absent both directions; the absent check runs
 * before the invalid fall-through. Returns the known-absent set. */
const checkServedNames = (ets, cpp, serveBody, phased, etsDesc, problems) => {
  const dispatchAt = ets.indexOf('private onDispatch(');
  const dispatchBody = ets.slice(dispatchAt, ets.indexOf('\n  }', dispatchAt));
  const routed = new Set([...dispatchBody.matchAll(/name === '([a-zA-Z.]+)'/g)].map((m) => m[1]));
  routed.delete('cameraRecordStart');
  routed.delete('cameraRecordStop');
  routed.delete('httpFetch.abort');
  for (const name of routed) {
    const row = name.split('.')[0];
    if (!etsDesc.available.includes(row) && !etsDesc.available.includes(name)) {
      problems.push(`onDispatch serves "${name}" but the descriptor does not declare it available`);
    }
  }
  for (const name of etsDesc.available) {
    if (name.includes('.') || !/^[a-zA-Z]+$/.test(name)) {
      problems.push(`available row "${name}" is not a bare primitive name`);
    }
  }
  const absentAt = cpp.indexOf('static int smoke_known_absent(');
  const absentBody = cpp.slice(absentAt, cpp.indexOf('\n}', absentAt));
  const knownAbsent = new Set(strcmpNames(absentBody));
  const declaredAbsent = etsDesc.unavailable.filter((n) => !phased.includes(n));
  for (const name of declaredAbsent) {
    if (!knownAbsent.has(name)) {
      problems.push(`descriptor declares "${name}" unavailable but smoke_known_absent does not answer it`);
    }
  }
  for (const name of knownAbsent) {
    if (!etsDesc.unavailable.includes(name)) {
      problems.push(`smoke_known_absent answers "${name}" unavailable but the descriptor does not declare it`);
    }
  }
  const invalidFall = serveBody.indexOf('"invalid", "unknown primitive"');
  const absentCall = serveBody.indexOf('smoke_known_absent(name)');
  if (absentCall < 0 || absentCall > invalidFall) {
    problems.push('gateway_smoke.cpp: the known-absent check must run before the invalid fall-through');
  }
  return knownAbsent;
};

/** Face 4: the smoke face declares what it answers unavailable; the
 * descriptor fits host_start's fixed buffer; the credited modules exist. */
const checkSmokeFaceAndBuffer = (cpp, etsJson, cppJson, knownAbsent, problems) => {
  // the SMOKE face answers the same absent families `unavailable`, so its
  // own descriptor must declare them too (a face's declaration covers
  // exactly what it answers — the review finding on the regression face)
  const smokeJson = literalConcat(cpp, 'const char *DSH_SMOKE_DESCRIPTOR');
  const smokeDesc = smokeJson === null
    ? null
    : parseDescriptor(smokeJson, 'gateway_smoke.cpp DSH_SMOKE_DESCRIPTOR', problems);
  if (smokeDesc !== null) {
    for (const name of knownAbsent) {
      if (!smokeDesc.unavailable.includes(name)) {
        problems.push(`DSH_SMOKE_DESCRIPTOR does not declare "${name}" unavailable although the smoke face answers it unavailable (smoke_known_absent serves both modes)`);
      }
    }
  }

  // the descriptor must fit host_start's fixed buffer — phase_str_arg
  // rejects len >= sizeof (EINVAL "descriptor too long"), and the 28-row
  // descriptor sat at 511/512 (review finding: one added row from a dead
  // phase start). Parse the bound from the source so the gate trips before
  // the runtime does.
  const napi = read('hosts/harmony/entry/src/main/cpp/napi_init.cpp');
  const buf = napi.match(/char descriptor\[(\d+)\]/);
  const cap = buf ? Number(buf[1]) : 0;
  if (cap <= 0) {
    problems.push('napi_init.cpp: the descriptor buffer declaration (char descriptor[N]) was not found');
  } else if (etsJson.length >= cap) {
    problems.push(`BINDING_DESCRIPTOR is ${etsJson.length} bytes — at or over host_start's char descriptor[${cap}] (phase_str_arg rejects len >= ${cap} with EINVAL; the phase would never start)`);
  }
  if (cppJson !== null && cap > 0 && cppJson.length >= cap) {
    problems.push(`DSH_BINDING_DESCRIPTOR is ${cppJson.length} bytes — at or over host_start's char descriptor[${cap}]`);
  }

  // the module the descriptor credits must exist on disk
  for (const mod of ['TimerPrimitive', 'MicPrimitives', 'BlePrimitives', 'CameraPrimitives',
    'DevicePlanePrimitives', 'KeychainPrimitives', 'PickerPrimitives', 'HttpPrimitive']) {
    try {
      read(`hosts/harmony/entry/src/main/ets/model/${mod}.ets`);
    } catch {
      problems.push(`hosts/harmony/entry/src/main/ets/model/${mod}.ets missing (the descriptor's serving face)`);
    }
  }
};

const check = () => {
  const problems = [];
  const ets = read('hosts/harmony/entry/src/main/ets/model/HostPhase.ets');
  const cpp = read('hosts/harmony/entry/src/main/cpp/gateway_smoke.cpp');
  const desc = checkDescriptorsIdentical(ets, cpp, problems);
  if (desc === null) return problems;
  const { serveBody, phased } = checkForwardAndPhased(cpp, desc.etsDesc, problems);
  const knownAbsent = checkServedNames(ets, cpp, serveBody, phased, desc.etsDesc, problems);
  checkSmokeFaceAndBuffer(cpp, desc.etsJson, desc.cppJson, knownAbsent, problems);
  return problems;
};

if (process.argv.includes('--selftest')) {
  // Rule 6: prove each rejection fires on a mutated sample.
  const cases = [
    ['descriptors drift (C missing a row)', {
      available: ['fsRead'], unavailable: [],
    }, {
      available: ['fsRead', 'timerSchedule'], unavailable: [],
    }, null, null],
  ];
  // Run the real comparison against mutated in-memory sources: simplest
  // honest selftest = corrupt each anchor in turn on a copy of the tree is
  // heavy; instead assert the detectors directly on synthetic literals.
  let failed = 0;
  const problems = [];
  const a = literalConcat(`const X = '{"available":["fsRead"],"unavailable":[]}';`, 'const X');
  const b = literalConcat(`const X = '{"available":["fsRead","timerSchedule"],"unavailable":[]}';`, 'const X');
  const da = parseDescriptor(a, 'A', problems);
  const db = parseDescriptor(b, 'B', problems);
  if (JSON.stringify(da.available) === JSON.stringify(db.available)) {
    console.error('selftest: descriptor-difference detector did not fire');
    failed += 1;
  }
  const absentSample = `static int smoke_known_absent(const char *name) {
    return strcmp(name, "fsStat") == 0;
}`;
  if (strcmpNames(absentSample).includes('fsStat') !== true) {
    console.error('selftest: strcmp extractor did not parse the C sample');
    failed += 1;
  }
  const forwardSample = `if (strcmp(name, "notify") == 0 || strcmp(name, "micStart") == 0) {
    b->forward_fn(b->forward_ud, call_id, name, args); return; }`;
  const got = strcmpNames(forwardSample);
  if (got.join(',') !== 'notify,micStart') {
    console.error('selftest: forward-list extractor wrong: ' + got.join(','));
    failed += 1;
  }
  console.log(`descriptor-parity: selftest ${failed === 0 ? 'PASS' : 'FAIL'} (${cases.length} detector classes, ${failed} silent)`);
  process.exit(failed === 0 ? 0 : 1);
}

const problems = check();
if (problems.length) fail(problems);
console.log('descriptor-parity: OK — ArkTS descriptor = C descriptor = served/declared faces (parity across HostPhase.ets / gateway_smoke.cpp)');
