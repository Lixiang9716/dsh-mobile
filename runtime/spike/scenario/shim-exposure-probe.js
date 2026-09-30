// dsh:logging-exempt (probe: its verdict output IS the product)
/**
 * shim-exposure-probe — the shim exposure survey's behavior legs (2026-09-30,
 * T-0078). The survey (DSH_MODULE_MANIFEST sweep + tools/shim-exposure.mjs)
 * found the 681-spec suite leaves exactly ONE of the 86 self-owned shims
 * module-unloaded (dsh-session-persistence.js — orphaned since the vendored
 * dsh-session-persistence package replaced its loader mapping) and a thin
 * tail the suite barely presses. This probe presses the five riskiest faces
 * by product path, per the survey's numbers:
 *
 *   dsh-session-persistence.js   0 spec runs — the resume-path error protocol
 *   node:sqlite                  3 spec runs — session search's real SQLite
 *   node:string_decoder          7 spec runs — every protocol stream's
 *                                chunk-boundary UTF-8
 *   partial-json + openai-client 5 spec runs — the LLM wire's truncated-JSON
 *                                and SSE faces
 *   slot-registry + renderer     5 spec runs — the UI mount's boot-once and
 *                                registration guard faces
 *
 * Run:
 *   cd runtime/spike && ./build/dsh-spike-cli . scenario/shim-exposure-probe.js
 * The captured log is verified one-to-one against
 * test/e2e/scenarios/shim-exposure-probe.json by
 * runtime/spike/ci/run-shim-exposure-probe.sh.
 */
import 'upstream/web-shims.js'; // Headers/ReadableStream/TextDecoder the wire faces drive
import 'upstream/shims/runtime-modules.js'; // self-registers node:string_decoder etc. (the harness fixed cost the suite leg pays)
import { createLogger } from 'logger.js';
import { Context } from '@deepseek-ai/cordis';
import SlotRegistry from 'upstream/shims/slot-registry.js';
import { DatabaseSync } from 'node:sqlite';
import { parse as parsePartialJson, Allow } from 'upstream/shims/partial-json.js';
import { OpenAI } from 'upstream/shims/openai-client.js';
import {
  SessionPersistenceNotFoundError,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionReadOnlyError,
} from 'upstream/shims/dsh-session-persistence.js';

const SCENARIO = 'shim.exposure-probe';
const log = createLogger('probe.shim-exposure');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });

let verdict = false;
const fail = (reason) => {
  if (!verdict) {
    verdict = true;
    log.debug('probe failed', { reason });
    emit('probe.failed', { reason: String(reason).slice(0, 300) });
    globalThis.__dshComplete(false, reason);
  }
};

/** One error-class leg: constructs, carries the session id, and is an Error
 * with the class's own name — the resume-path protocol the vendored agent
 * loop branches on. */
const assertPersistenceError = (Ctor, sessionId) => {
  const error = new Ctor(sessionId);
  return error instanceof Error
    && error.name === Ctor.name
    && error.sessionId === sessionId
    && typeof error.message === 'string'
    && error.message.includes(sessionId);
};

const probeSessionPersistence = () => {
  log.debug('session-persistence leg begin', {});
  const ok = [SessionPersistenceNotFoundError, SessionAlreadyExistsError,
    SessionAlreadyOwnedError, SessionReadOnlyError]
    .every((Ctor) => assertPersistenceError(Ctor, 'sess-probe-1'));
  emit('probe/session-persistence', {
    errorClasses: 4,
    verdict: ok ? 'carry name+sessionId+message' : 'BROKEN',
  });
  return ok;
};

const probeSqlite = () => {
  log.debug('sqlite leg begin', {});
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
  const insert = db.prepare('INSERT INTO t VALUES (?, ?)');
  const run = insert.run(7, 'seven');
  const row = db.prepare('SELECT a, b FROM t WHERE a = 7').get();
  const empty = db.prepare('SELECT a FROM t WHERE a = 99').get();
  const iteration = [...db.prepare('SELECT a FROM t ORDER BY a').iterate()];
  const ok = run.changes === 1
    && Number(run.lastInsertRowid) === 7
    && row?.a === 7 && row?.b === 'seven'
    && empty === undefined // node:sqlite's no-row face (the W6-V distinction)
    && iteration.length === 1 && iteration[0].a === 7;
  db.close();
  emit('probe/sqlite', {
    transport: ':memory:',
    roundtrip: ok ? 'insert+get+iterate ok' : 'BROKEN',
    noRowIsUndefined: empty === undefined,
  });
  return ok;
};

const probeStringDecoder = async () => {
  log.debug('string-decoder leg begin', {});
  // Dynamic import ON PURPOSE: `node:string_decoder` exists only after
  // runtime-modules.js's body registers it (the __dshModuleDefine seam) — a
  // static import would resolve before any body runs. The suite's specs see
  // it because the leg imports THEM dynamically.
  const { StringDecoder } = await import('node:string_decoder');
  // The byte-boundary buffer: a 3-byte char split 2/1 across writes must
  // hold its head until the tail arrives — no U+FFFD for a merely-split char.
  const decoder = new StringDecoder('utf8');
  const head = decoder.write(Uint8Array.from([0xe4, 0xbd]));
  const tail = decoder.write(Uint8Array.from([0xa0])); // 你, split mid-sequence
  const end = decoder.end();
  // A stray continuation byte decodes to U+FFFD (the invalid-lead face).
  const lone = new StringDecoder().write(Uint8Array.from([0x80]));
  // A non-utf8 label fails loud (rule 5) — the wall util.js's TextDecoder has.
  let labelError = '';
  try {
    new StringDecoder('latin1');
  } catch (error) {
    labelError = String(error?.message ?? error);
  }
  const ok = `${head}${tail}${end}` === '你'
    && head === ''
    && lone === '\uFFFD'
    && labelError.includes('utf8');
  emit('probe/string-decoder', {
    splitChar: `${head}${tail}${end}`,
    headHeld: head === '',
    invalidByte: JSON.stringify(lone),
    labelWall: labelError.includes('utf8') ? 'non-utf8 rejected' : `BROKEN: ${labelError.slice(0, 60)}`,
  });
  return ok;
};

const probePartialJson = () => {
  log.debug('partial-json leg begin', {});
  const truncatedObject = parsePartialJson('{"text":"he');
  const truncatedArray = parsePartialJson('{"items":[1,2');
  const escapedQuote = parsePartialJson('{"text":"he\\"llo'); // → he"llo (the quote is escaped data)
  const danglingEscape = parsePartialJson('{"text":"he\\'); // the escape swallows (shim doc: bases drop it)
  const literal = parsePartialJson('true');
  const whole = parsePartialJson('{"text":"full"}');
  const ok = truncatedObject?.text === 'he'
    && truncatedArray?.items?.length === 2 && truncatedArray.items[1] === 2
    && escapedQuote?.text === 'he"llo'
    && danglingEscape?.text === 'he'
    && literal === true
    && whole?.text === 'full'
    && typeof Allow === 'object';
  emit('probe/partial-json', {
    truncatedObject: JSON.stringify(truncatedObject),
    truncatedArray: JSON.stringify(truncatedArray),
    escapedQuote: JSON.stringify(escapedQuote),
    danglingEscape: JSON.stringify(danglingEscape),
    literalPassThrough: literal === true,
    wholePassThrough: whole?.text === 'full',
  });
  return ok;
};

/** The SSE wire face: a stubbed fetch answers 200 with a streamed body of
 * three data frames + [DONE]; the shim must reassemble them (split anywhere)
 * into parsed payloads and stop at [DONE] — then the non-2xx leg must throw
 * the SDK's status/error shape. */
const sseBody = (frames) => new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const frame of frames) controller.enqueue(encoder.encode(frame));
    controller.close();
  },
});

const probeOpenAiClient = async () => {
  log.debug('openai-client leg begin', {});
  const frames = [
    'data: {"id":"1","choices":[{"delta":{"content":"he"}}]}\n\n',
    'data: {"id":"2","choices":[{"delta":{"content":"',
    'llo"}}]}\n\n', // one frame split mid-JSON across the stream boundary
    'data: [DONE]\n\n',
  ];
  let calls = 0;
  const client = new OpenAI({
    apiKey: 'probe-key',
    baseURL: 'https://probe.invalid/v1',
    defaultHeaders: { 'x-probe': '1' },
    fetch: async (url, init) => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { entries: () => [['content-type', 'text/event-stream']] },
        body: sseBody(frames),
        text: async () => '',
      };
    },
  });
  const settled = client.chat.completions.create(
    { model: 'probe', stream: true },
    { maxRetries: 0 },
  );
  const { data, response } = await settled.withResponse();
  const chunks = [];
  for await (const payload of data) chunks.push(payload);
  const streamed = chunks.length === 2
    && chunks[0]?.choices?.[0]?.delta?.content === 'he'
    && chunks[1]?.choices?.[0]?.delta?.content === 'llo'
    && response.status === 200;
  // The non-2xx leg: the SDK's error-field shapes (status + parsed body).
  const failing = new OpenAI({
    apiKey: 'probe-key',
    fetch: async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ error: { message: 'bad key' } }),
    }),
  });
  let wireError;
  try {
    await failing.chat.completions.create({ model: 'probe' });
  } catch (error) {
    wireError = error;
  }
  const errored = wireError?.status === 401
    && wireError?.error?.error?.message === 'bad key'
    && wireError?.message === 'bad key';
  emit('probe/openai-client', {
    sseChunks: chunks.length,
    midFrameSplitJoined: streamed,
    withResponseStatus: response.status,
    errorStatus: wireError?.status ?? null,
    errorBodyCarried: errored,
  });
  return streamed && errored && calls === 1;
};

const probeSlotRegistry = () => {
  log.debug('slot-registry leg begin', {});
  const ctx = new Context();
  const slots = new SlotRegistry(ctx); // Service(ctx, 'slots') → ctx.slots
  const viaCtx = typeof ctx.slots?.install === 'function' && typeof ctx.slots?.renderSlot === 'function';
  // boot-once guards (the vendored boot's contract faces)
  slots.install({ renderRoot: () => 'root-render' });
  let duplicate = '';
  try {
    slots.install({});
  } catch (error) {
    duplicate = String(error?.message ?? error);
  }
  // the ctx-level renderSlot faces
  let childKey = '';
  try {
    slots.renderSlot('child', {});
  } catch (error) {
    childKey = String(error?.message ?? error);
  }
  let unregistered = '';
  try {
    slots.renderSlot('root', {});
  } catch (error) {
    unregistered = String(error?.message ?? error);
  }
  const ok = viaCtx
    && duplicate.includes('boot-once')
    && childKey.includes("only renders 'root'")
    && unregistered.includes("no registration");
  emit('probe/slots', {
    serviceProvided: viaCtx ? 'ctx.slots live' : 'BROKEN',
    installBootOnce: duplicate.includes('boot-once') ? 'second install rejected' : `BROKEN: ${duplicate.slice(0, 60)}`,
    ctxLevelOnly: childKey.includes("only renders 'root'") ? 'child key rejected' : `BROKEN: ${childKey.slice(0, 60)}`,
    registrationGuard: unregistered.includes('no registration') ? 'unregistered root rejected' : `BROKEN: ${unregistered.slice(0, 60)}`,
  });
  return ok;
};

const main = async () => {
  log.debug('main begin', { legs: 5 });
  emit('probe/start', { legs: 5, survey: 'DSH_MODULE_MANIFEST + tools/shim-exposure.mjs' });
  // Verdict-collecting on purpose: an async leg's false must fail the probe —
  // the falsification run (broken string-decoder tail-hold) proved a
  // fire-and-forget .then() swallows exactly that.
  let failed = '';
  const leg = async (name, fn) => {
    if (failed !== '') return;
    try {
      const ok = await fn();
      if (ok !== true) fail(`${name} verdict false`);
    } catch (error) {
      fail(`${name} threw: ${error?.message ?? error}`);
    }
    if (verdict) failed = name;
  };
  await leg('session-persistence', probeSessionPersistence);
  await leg('sqlite', probeSqlite);
  await leg('string-decoder', probeStringDecoder);
  await leg('partial-json', probePartialJson);
  await leg('openai-client', probeOpenAiClient);
  await leg('slot-registry', probeSlotRegistry);
  if (verdict) return; // a leg already failed and closed the probe
  emit('probe/complete', { status: 'pass', legs: 5 });
  globalThis.__dshComplete(true, 'shim exposure probe: 5 legs verified');
};

main().catch(fail);
