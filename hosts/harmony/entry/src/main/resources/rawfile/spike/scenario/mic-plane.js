/**
 * Mic-plane scenario `mic.plane` (the capability plane, v1.10.0 candidate)
 * — runs on iOS, Android and HarmonyOS where the privileged layers answer
 * the microphone face. Every expected event emits exactly one structured
 * log entry through the unified logger, in the order declared by
 * test/e2e/scenarios/{mic-plane,android-mic-plane,
 * harmony-mic-plane}.json (per-platform counts pin each host's
 * descriptor).
 *
 * Drives the surface in a FIXED call order so the flat audit stream
 * ({primitive,verdict,outcome} rows) is one-to-one too: descriptor
 * conformance, micStart armed (or the honest `null` refusal — a host whose
 * OS layer or mic service refuses resolves a VALUE, and the per-host
 * manifest pins which shape ran), the frame window over the mic.frame
 * channel (monotonic seq is the only continuity — drop-oldest under
 * pressure is legal), micStop's duration/bytes record, the exactly-once
 * end event, micStop idempotence, and the unknown-id leg.
 */
import { createLogger } from '../logger.js';
import { micFrames, micStart, micStop } from '../gateway.js';

const SCENARIO = 'mic.plane';
const log = createLogger('dsh.mic.plane');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

const FORMAT = 'pcm-s16le';
const SAMPLE_RATE = 16000;
const FRAME_MS = 100;
const WINDOW_MS = 5000;
const MIN_FRAMES = 4;

/** Bounded frame window: collect frames until MIN_FRAMES have arrived or
 * WINDOW_MS passed — stopping the stream ends the iteration with the
 * exactly-once end event, which is returned alongside (`end`, or null
 * when the window closed first). A mic that never delivers a frame and
 * never ends fails loud below with its own reason, not the watchdog's. */
const collectWindow = async (streamId) => {
  log.debug('frame window open', { streamId });
  const frames = [];
  let end = null;
  const deadline = Date.now() + WINDOW_MS;
  for await (const item of micFrames(streamId)) {
    if (item.kind === 'end') {
      end = item;
      break;
    }
    frames.push(item);
    if (frames.length >= MIN_FRAMES || Date.now() >= deadline) break;
  }
  return { frames, end };
};

/** Bounded wait for the end event when the frame window closed before it
 * (micStop publishes it once — it may land after the stop resolves). */
const awaitEnd = async (streamId, already) => {
  log.debug('awaiting the end event', { streamId, already: already !== null });
  if (already) return already;
  const it = micFrames(streamId)[Symbol.asyncIterator]();
  const deadline = Date.now() + WINDOW_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    // The losing timeout promise is orphaned on purpose: the host's
    // built-in setTimeout surface has no clearTimeout pairing on this
    // runtime build (the dsh-timeout shim's pairing loads with the
    // upstream modules, not for a bare scenario), and an orphan that
    // fires after the scenario completed is harmless.
    const res = await Promise.race([
      it.next(),
      new Promise((r) => setTimeout(() => r('timeout'), left)),
    ]);
    if (res === 'timeout' || res.done) return null;
    if (res.value.kind === 'end') return res.value;
  }
};

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });

  const descriptor = JSON.parse(globalThis.__dshGatewayDescriptor());
  const missing = ['micStart', 'micStop'].filter(
    (name) => !descriptor.available.includes(name));
  demand(missing.length === 0, `host descriptor lacks the mic plane: ${missing.join(',')}`);
  emit('descriptor.declared', {
    available: descriptor.available.length,
    unavailable: descriptor.unavailable.length,
    micPlane: 2,
  });

  // ---- micStart: armed, not flowing (the timerSchedule posture). A null
  // resolution is a VALUE (the OS layer refused), an `unavailable`
  // rejection is a capability gap (the emulator's mic service can be dead
  // — the haptic posture); both walk the refusal leg honestly (no content
  // assertions) and the per-host manifest pins which shape ran. ----
  let armed = null;
  let gap = false;
  try {
    armed = await micStart({
      format: FORMAT, sampleRate: SAMPLE_RATE, frameMs: FRAME_MS, tag: 'mic.plane',
    });
  } catch (err) {
    demand(err.code === 'unavailable', `micStart failed: ${err.code}`);
    gap = true;
  }
  if (armed === null || gap) {
    emit('mic.refused', { resolved: gap ? 'unavailable' : 'null' });
  } else {
    demand(typeof armed.streamId === 'string' && armed.streamId.length > 0,
      'micStart resolved no streamId');
    emit('mic.armed', { format: FORMAT });

    // ---- the mic.frame channel: drop-oldest makes seq GAPS legal under
    // pressure; monotonicity is the contract. Every frame carries
    // non-empty sample bytes. ----
    const { frames, end } = await collectWindow(armed.streamId);
    demand(frames.length >= 1, 'no mic frame arrived within the window');
    let monotonic = true;
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].seq <= frames[i - 1].seq) monotonic = false;
    }
    const samples = frames.every((f) => f.bytes instanceof Uint8Array && f.bytes.length > 0);
    demand(monotonic, `mic frame seq not monotonic: ${frames.map((f) => f.seq).join(',')}`);
    demand(samples, 'a mic frame carried empty sample bytes');
    emit('mic.frames', { consumed: true, monotonic: true, samples: true });

    // ---- micStop: the record that carries duration + bytes ----
    const stopped = await micStop(armed.streamId);
    demand(stopped !== null && stopped.stopped === true,
      'micStop live stream answered not-stopped');
    demand(Number.isFinite(stopped.durationMs) && stopped.durationMs > 0,
      `micStop durationMs not positive: ${stopped.durationMs}`);
    demand(Number.isFinite(stopped.bytes) && stopped.bytes > 0,
      `micStop bytes not positive: ${stopped.bytes}`);
    emit('mic.stopped', { stopped: true, duration: true, bytes: true });

    // ---- the end event: published exactly once, reason "stopped" ----
    const tail = await awaitEnd(armed.streamId, end);
    demand(tail !== null, 'mic end event never arrived');
    demand(tail.kind === 'end' && tail.reason === 'stopped',
      `mic end shape mismatch: ${tail.kind}/${tail.reason}`);
    emit('mic.end', { reason: 'stopped' });

    // ---- idempotence: the same id again answers { stopped: false } ----
    const again = await micStop(armed.streamId);
    demand(again !== null && again.stopped === false, 'micStop re-stop answered stopped');
    emit('mic.stop.idempotent', { stopped: false });
  }

  // ---- the unknown-id leg (the timerCancel shape) runs on BOTH paths ----
  const unknown = await micStop('mic:unknown');
  demand(unknown !== null && unknown.stopped === false, 'micStop unknown id answered stopped');
  emit('mic.stop.unknown', { stopped: false });

    emit('scenario.complete', { status: 'pass' });
    globalThis.__dshComplete(true, 'ok');
}
