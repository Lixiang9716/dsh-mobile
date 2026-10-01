// dsh:logging-exempt (dev script: the log stream is the product)
/**
 * Scenario `security.jail` — the WASM jail's import surface and the loopback
 * socket boundary, attacked through the RAW gateway seam (threat model:
 * docs/security-threat-model.md, surfaces "QuickJS sandbox / wasm jail" and
 * "the socket seam's loopback boundary").
 *
 * The wasm face: a module runs interpreted IN-PROCESS (dsh_wasm.c + wasm3 —
 * the code path the iOS app ships) and its ONLY host callback is the
 * imported `dsh.emit(ptr, len)`. The battery writes crafted modules into the
 * app scope and runs them, demanding a structured rejection from each:
 *   - hostile-import-called  — imports env.evil and CALLS it: the host never
 *     links it, the call traps (there is nothing to call);
 *   - wrong-signature        — imports dsh.emit with the wrong signature:
 *     the link refuses it (the sanctioned name, the wrong shape);
 *   - emit-out-of-bounds     — honest import, emit(ptr=0x7fffffff): the
 *     host-side bounds check traps before any host byte is touched;
 *   - stack-exhaustion       — run() recurses forever: the interpreter's
 *     fixed stack overflows into a trap, not a crash;
 *   - missing-export / absent-module / path-escape / wrong-scope — the
 *     serve-layer's scope and resolution discipline.
 * The CONTROL rung proves the jail is not just a wall: the honest echo
 * module runs before AND after the battery (result 15, its input echoed
 * through dsh.emit) — the sanctioned surface works, the process survived.
 *
 * The socket face: raw dials to six targets outside the boundary (the IPv6
 * loopback ::1, the unspecified 0.0.0.0, the NAME localhost, the adjacent
 * 127.0.0.2, a mesh-scope listen, and a listen with no scope at all) — every
 * one `denied`, each leaving one audit record with a FIXED reason code on
 * the host's stderr (the runner greps them: 4 host-not-loopback + 2
 * scope-not-loopback; attacker-controlled text never enters the audit JSON).
 */
import { createLogger } from '../logger.js';
import { fsWrite } from '../gateway.js';

const SCENARIO = 'security.jail';
const log = createLogger('security.jail');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason: String(reason).slice(0, 200) });
  emit('scenario.failed', { reason: String(reason).slice(0, 300) });
  globalThis.__dshComplete(false, String(reason).slice(0, 300));
};

const raw = async (name, args) => {
  try {
    const res = await globalThis.__dshGatewayCall(name, JSON.stringify(args));
    return { ok: true, res };
  } catch (err) {
    return { ok: false, code: err?.code ?? null, message: err?.message ?? null };
  }
};

// ---- a minimal wasm assembler (readable, no magic bytes) -------------------
const uleb = (n) => {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};
const vec = (entries) => [...uleb(entries.length), ...entries.flat()];
const section = (id, payload) => [id, ...uleb(payload.length), ...payload];
const nameVec = (text) => [...uleb(text.length), ...[...text].map((c) => c.charCodeAt(0))];
const functype = (params, results) => [0x60, ...uleb(params.length), ...params,
  ...uleb(results.length), ...results];
const I32 = 0x7f;
const importFunc = (mod, field, typeIdx) => [...nameVec(mod), ...nameVec(field), 0x00, typeIdx];
const exportFunc = (name, idx) => [...nameVec(name), 0x00, idx];
const funcEntry = (body) => [...uleb(body.length), ...body];
const codeSection = (bodies) => section(10, vec(bodies.map(funcEntry)));

/** Build a module: imports first (their own types), then `run` — always
 * (i32,i32)->i32, the ABI dsh_wasm_run's m3_GetResultsV demands. */
const buildModule = ({ importTypes, imports, body }) => {
  const types = [...importTypes, II_TO_I32];
  const runTypeIdx = importTypes.length;
  return [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...(imports.length ? section(2, vec(imports)) : []),
    ...section(3, vec([runTypeIdx])),
    ...section(5, vec([[0x00, 0x01]])),
    ...section(7, vec([exportFunc('run', imports.length)])),
    ...codeSection([body]),
  ];
};

const VOID_II = functype([I32, I32], []);
const II_TO_I32 = functype([I32, I32], [I32]);
const EMIT_VOID = importFunc('dsh', 'emit', 0);

const wasmBytes = {
  // the sanctioned shape: run echoes its (ptr,len) input through dsh.emit
  // and returns len — the honest module the jail exists to protect.
  'echo.wasm': buildModule({
    importTypes: [VOID_II], imports: [EMIT_VOID],
    body: [0x00, 0x20, 0x00, 0x20, 0x01, 0x10, 0x00, 0x20, 0x01, 0x0b],
  }),
  // imports env.evil and CALLS it — the host never links it.
  'hostile-import-called.wasm': buildModule({
    importTypes: [VOID_II],
    imports: [importFunc('env', 'evil', 0)],
    body: [0x00, 0x41, 0x00, 0x41, 0x00, 0x10, 0x00, 0x41, 0x00, 0x0b],
  }),
  // the sanctioned NAME with the wrong signature: (i32)->i32, not (i32,i32)->()
  'wrong-signature.wasm': buildModule({
    importTypes: [functype([I32], [I32])],
    imports: [importFunc('dsh', 'emit', 0)],
    body: [0x00, 0x41, 0x00, 0x0b],
  }),
  // honest import, hostile pointer: emit(0x7fffffff, 1) — beyond the memory.
  'emit-out-of-bounds.wasm': buildModule({
    importTypes: [VOID_II], imports: [EMIT_VOID],
    body: [0x00, 0x41, 0xff, 0xff, 0xff, 0xff, 0x07, 0x41, 0x01, 0x10, 0x00,
      0x41, 0x00, 0x0b],
  }),
  // run() calls itself forever — the interpreter's fixed stack is the wall.
  'stack-exhaustion.wasm': buildModule({
    importTypes: [VOID_II], imports: [EMIT_VOID],
    body: [0x00, 0x10, 0x01, 0x0b],
  }),
};

const echoControl = async (label) => {
  const outcome = await raw('wasmRun', {
    scope: 'app', path: 'jail/echo.wasm', func: 'run', input: 'hello from jail',
  });
  if (!outcome.ok || outcome.res?.result !== 15
    || outcome.res?.output !== 'hello from jail') {
    fail(`${label}: the honest echo module did not run: ${JSON.stringify(outcome)}`);
    return false;
  }
  emit(label === 'before' ? 'jail.control' : 'jail.survived', {
    result: outcome.res.result, output: outcome.res.output,
  });
  return true;
};

const cases = [];

const wasmAttack = (name, file, expect) => cases.push({
  kind: 'wasm', name, primitive: 'wasmRun', expect,
  fn: () => raw('wasmRun', {
    scope: 'app', path: `jail/${file}`, func: 'run', input: 'hello from jail',
  }),
});
const wasmRaw = (name, args, expect) => cases.push({
  kind: 'wasm', name, primitive: 'wasmRun', expect, fn: () => raw('wasmRun', args),
});

wasmAttack('wasm.hostile-import-called', 'hostile-import-called.wasm', 'io');
wasmAttack('wasm.wrong-signature', 'wrong-signature.wasm', 'io');
wasmAttack('wasm.emit-out-of-bounds', 'emit-out-of-bounds.wasm', 'io');
wasmAttack('wasm.stack-exhaustion', 'stack-exhaustion.wasm', 'io');
wasmRaw('wasm.missing-export', {
  scope: 'app', path: 'jail/echo.wasm', func: 'nope', input: '',
}, 'io');
wasmAttack('wasm.absent-module', 'absent.wasm', 'io');
wasmRaw('wasm.path-escape', {
  scope: 'app', path: '../evil.wasm', func: 'run', input: '',
}, 'invalid');
wasmRaw('wasm.scope-unknown', {
  scope: 'system', path: 'jail/echo.wasm', func: 'run', input: '',
}, 'denied');

const socketAttack = (name, primitive, args) => cases.push({
  kind: 'socket', name, primitive, expect: 'denied', fn: () => raw(primitive, args),
});

socketAttack('socket.connect.ipv6-loopback', 'socketConnect',
  { scope: 'loopback', host: '::1', port: 1 });
socketAttack('socket.connect.unspecified', 'socketConnect',
  { scope: 'loopback', host: '0.0.0.0', port: 1 });
socketAttack('socket.connect.name-localhost', 'socketConnect',
  { scope: 'loopback', host: 'localhost', port: 1 });
socketAttack('socket.connect.adjacent', 'socketConnect',
  { scope: 'loopback', host: '127.0.0.2', port: 1 });
socketAttack('socket.listen.mesh', 'socketListen', { scope: 'mesh', port: 0 });
socketAttack('socket.listen.no-scope', 'socketListen', { port: 0 });

const main = async () => {
  if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
    fail('gateway negotiation failed');
    return;
  }
  for (const [file, bytes] of Object.entries(wasmBytes)) {
    await fsWrite('app', `jail/${file}`, Uint8Array.from(bytes));
  }
  if (!await echoControl('before')) return;
  emit('jail.started', { wasm: 8, socket: 6 });

  for (const { name, primitive, expect, fn } of cases) {
    const outcome = await fn();
    if (outcome.ok) {
      fail(`attack landed: ${name} (${primitive}) resolved instead of ${expect}`);
      return;
    }
    if (outcome.code !== expect) {
      fail(`${name}: expected ${expect}, got ${outcome.code}`);
      return;
    }
    emit('jail.case', { attack: name, primitive, expect, code: outcome.code });
  }
  emit('jail.battery.rejected', { wasm: 8, socket: 6 });

  if (!await echoControl('after')) return;
  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
};

await main();
