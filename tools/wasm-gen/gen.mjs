// gen.mjs — compile the .wat starter programs to the byte arrays the
// dsh-shell-wasm plugin ships, and verify each one against the ABI the C
// runner (runtime/spike/host/dsh_wasm.c) actually implements.
//
// The bytes land in system-plugins/dsh-shell-wasm/programs.js as committed
// Uint8Array literals (the STARTER_ECHO precedent: the artifact is data, the
// reviewable source is the .wat beside it). This script is the only thing
// that needs the wabt dependency — regenerate with:
//
//   cd tools/wasm-gen && npm install && node gen.mjs
//
// The verification half mirrors dsh_wasm.c EXACTLY (the input at
// mem_size-4096, the dsh.emit sink, the i32 result): a module that passes
// here behaves identically in the in-process interpreter on the device.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '../../system-plugins/dsh-shell-wasm');

const wabt = await import('wabt');
const factory = wabt.default ?? wabt;
const wabtInit = await factory();

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The dsh_wasm.c ABI, mirrored on Node's own WebAssembly: the input rides
 * the LAST 4096 bytes of the module's memory; the i32 return is the result;
 * dsh.emit(ptr, len) appends to the output. One faithful runner, shared by
 * generation (here) and the panel suite (mirrored there — see the test). */
export const runAbi = (bytes, input) => {
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {
    dsh: {
      emit: (ptr, len) => {
        const mem = new Uint8Array(instance.exports.memory.buffer);
        out.push(mem.slice(ptr, ptr + len));
      },
    },
  });
  const out = [];
  const mem = new Uint8Array(instance.exports.memory.buffer);
  const reserve = 4096;
  if (mem.length <= reserve) throw new Error('module memory too small for the ABI');
  const inPtr = mem.length - reserve;
  const text = new TextEncoder().encode(input);
  if (text.length > reserve - 1) throw new Error('input exceeds the ABI reserve');
  mem.set(text, inPtr);
  mem[inPtr + text.length] = 0;
  const result = instance.exports.run(inPtr, text.length);
  const total = out.reduce((n, chunk) => n + chunk.length, 0);
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of out) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  return { result, output: new TextDecoder().decode(merged) };
};

/** Every program carries a table of (input → {result, output}) facts the
 * bytes must reproduce before anything is written — a generator that emits
 * wrong bytes must fail HERE, not on a device. */
const CASES = {
  wc: [
    ['', { result: 0, output: '0 0 0\n' }],
    ['hello', { result: 0, output: '1 1 5\n' }],
    ['hello world', { result: 0, output: '1 2 11\n' }],
    ['one\ntwo\nthree\n', { result: 0, output: '3 3 14\n' }],
    ['one\ntwo\nthree', { result: 0, output: '3 3 13\n' }],
    ['  spaced   out  ', { result: 0, output: '1 2 16\n' }],
    ['\t\t', { result: 0, output: '1 0 2\n' }],
  ],
  grep: [
    // layout `<pattern><one ws><text>` — the first token IS the pattern
    ['', { result: 2, output: 'usage: grep <pattern> <text>\n' }],
    ['nomatchhere', { result: 1, output: '' }],           // no text at all
    ['zzz err one\nerr two\nok three\n', { result: 1, output: '' }],
    ['err one\nerr two\nok three\n', { result: 0, output: 'err two\n' }],
    ['two err one\nerr two\nok three\n', { result: 0, output: 'err two\n' }],
    ['three ok one\nerr two\nok three\n', { result: 0, output: 'ok three\n' }],
    ['err untail\nerr tail', { result: 0, output: 'err tail' }],
    ['needle hay\nstack\nneedle pin\n', { result: 0, output: 'needle pin\n' }],
    // an empty pattern matches every line (a substring of each)
    [' x\ny\n', { result: 0, output: 'x\ny\n' }],
    // the separator can be any whitespace byte; the rest is verbatim text
    ['pat\tone pat\ntwo pat\n', { result: 0, output: 'one pat\ntwo pat\n' }],
  ],
};

const programs = {};
for (const name of ['wc', 'grep']) {
  const wat = readFileSync(path.join(here, `${name}.wat`), 'utf8');
  const wasm = wabtInit.parseWat(`${name}.wat`, wat, {});
  wasm.resolveNames();
  wasm.validate();
  const { buffer } = wasm.toBinary({});
  const bytes = new Uint8Array(buffer);
  for (const [input, want] of CASES[name]) {
    const got = runAbi(bytes, input);
    if (got.result !== want.result || got.output !== want.output) {
      throw new Error(
        `${name}: ABI mismatch for ${JSON.stringify(input)}\n`
        + `  want ${JSON.stringify(want)}\n`
        + `  got  ${JSON.stringify(got)}`);
    }
  }
  programs[name] = { bytes, sha256: sha256(bytes) };
  console.error(`${name}.wat -> ${bytes.length} bytes, sha256 ${programs[name].sha256} (${CASES[name].length} ABI cases pass)`);
}

/** The committed artifact: one Uint8Array literal per program, its sha256 in
 * the header AND in the PINS table — the pin the panel suite re-checks, so
 * the committed bytes can never silently drift from the reviewed source. */
const body = Object.entries(programs).map(([name, { bytes, sha256: digest }]) => {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 20) {
    lines.push('  ' + [...bytes.slice(i, i + 20)].join(', ') + ',');
  }
  return (
    `/** ${name}.wat — generated bytes (wat2wasm via tools/wasm-gen, wabt`
    + ` 1.0.39).\n * sha256 ${digest} — the panel suite re-checks this pin;`
    + ` regenerate with\n * \`node tools/wasm-gen/gen.mjs\`, never hand-edit. */\n`
    + `export const ${name.toUpperCase()}_BYTES = Uint8Array.from([\n`
    + lines.join('\n') + '\n]);\n');
});

const pins = Object.entries(programs)
  .map(([name, { sha256: digest }]) => `  ${name}: '${digest}',`)
  .join('\n');
body.push(
  '/** sha256 of each program\'s bytes, the machine-checkable form of the\n'
  + ' * header pins. test/panel/shell-wasm.test.js recomputes both digests\n'
  + ' * over the arrays above and fails the suite on any drift. */\n'
  + `export const PINS = {\n${pins}\n};\n`,
);

writeFileSync(path.join(pluginDir, 'programs.js'), `// dsh:logging-exempt (pure data module)
/**
 * programs.js — the starter programs' WASM bytes, GENERATED from the .wat
 * sources in tools/wasm-gen/ (do not edit: regenerate instead). Each module
 * is verified against the dsh_wasm.c ABI at generation time and its sha256
 * is pinned in its header — test/panel/shell-wasm.test.js re-checks the pin
 * and re-executes the bytes, so drift fails the suite here, not on a device.
 */
${body.join('\n')}`);
console.error(`wrote ${path.join(pluginDir, 'programs.js')}`);
