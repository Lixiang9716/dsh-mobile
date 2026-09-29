// dsh:logging-exempt (hilog here is drive/progress evidence only; canonical
// E2E lines route through the HostPhase phase sink — ONE writer)
/**
 * The capability plane's microphone face (v1.10.0 candidate; grant family
 * `microphone`) — ArkTS sibling of hosts/ios Gateway/MicPrimitives.swift +
 * hosts/android MicPrimitives.kt: micStart/micStop control + the mic.frame
 * channel over the bridge event plumbing. Two consent layers, gateway
 * first — the manifest's family grant reached here means the caller is
 * approved at the gateway layer, so the OS prompt
 * (requestPermissionsFromUser on ohos.permission.MICROPHONE) is the second
 * and last one; an OS refusal settles `null` (a value, the
 * clipboard-decline posture). Frames are pcm-s16le mono chunks delivered
 * as bridge events (`mic.frame` / `mic.end`, payload bytes base64 — the
 * frozen bridge convention) through the HostPhase event hop. Pressure
 * discipline (D8): the readData callback enqueues into a bounded ring with
 * seq minted per captured chunk — a chunk dropped by a full ring leaves an
 * honest seq gap, never a growing queue — and the drain forwards FIFO.
 * The end event publishes exactly once, after the last forwarded frame.
 *
 * SDK mapping notes (verified against this SDK's d.ts): the capturer is
 * SOURCE_TYPE_MIC at the clamped rate, S16LE mono; readData hands
 * variable-size ArrayBuffers, so the accumulator emits at the caller's
 * frameMs only when a whole chunk has arrived, and the tail flushes at
 * stop — byte-counted, same as the other hosts. The per-event chunk is
 * capped at 4 KB raw: the hostEvent bridge buffer is 8 KB and the payload
 * travels base64 (the httpFetch CHUNK_LIMIT precedent), so this host's
 * effective chunk is min(frameMs bytes, 4 KB) — a host-declared clamp.
 *
 * Threading: every settle happens on an async completion (promise callback)
 * of the ArkTS main thread event loop — the ONE serial JS runtime thread
 * (ARCHITECTURE.md §6); never inside the dispatch call itself. The
 * readData callback rides the same ArkTS event loop as httpFetch's
 * dataReceive (the streaming leg's proven posture).
 */
import { audio } from '@kit.AudioKit';
import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import { SettleFn } from './PickerPrimitives';

const TAG: string = 'dsh.app';

const RING_CAP: number = 16;
const RATE_LO: number = 8000;
const RATE_HI: number = 48000;
const FRAME_MS_LO: number = 10;
const FRAME_MS_HI: number = 200;
/** Largest raw chunk per mic.frame event (the httpFetch CHUNK_LIMIT rule). */
const CHUNK_LIMIT: number = 4 * 1024;

interface MicArgs {
  format?: string;
  sampleRate?: number;
  channels?: number;
  frameMs?: number;
  tag?: string;
  streamId?: string;
}

/** The requestPermissionsFromUser result's consumed shape (the platform
 * type lives in a non-importable internal module). */
interface PermRequestResult {
  authResults: Array<number>;
}

/** One stop/idempotence answer (the contract micStop shape). */
interface StopAnswer {
  stopped: boolean;
  durationMs: number;
  bytes: number;
}

/** One ring entry: seq minted at capture, the pcm chunk's bytes. */
class MicChunk {
  seq: number;
  data: ArrayBuffer;

  constructor(seq: number, data: ArrayBuffer) {
    this.seq = seq;
    this.data = data;
  }
}

class MicStream {
  id: string;
  capturer: audio.AudioCapturer | null = null;
  startedAt: number = 0;
  seq: number = 0;
  bytes: number = 0;
  pending: MicChunk[] = [];
  frameBytes: number;
  accumulator: Uint8Array = new Uint8Array(0);
  stopped: boolean = false;
  endPublished: boolean = false;

  constructor(id: string, frameBytes: number) {
    this.id = id;
    this.frameBytes = frameBytes;
  }
}

function reject(callId: number, settle: SettleFn, code: string, primitive: string,
  message: string): void {
  settle(callId,
    '{"code":"' + code + '","primitive":"' + primitive + '","message":"' +
    message + '"}', false);
}

export class MicPrimitives {
  private ctx: common.UIAbilityContext;
  private emit: ((eventJson: string) => void) | null = null;
  private stream: MicStream | null = null;

  constructor(ctx: common.UIAbilityContext) {
    this.ctx = ctx;
  }

  setEmitter(emit: (eventJson: string) => void): void {
    this.emit = emit;
  }

  // ---- micStart (armed, not flowing — the timerSchedule posture) -----------

  micStart(callId: number, argsText: string, settle: SettleFn): void {
    let args: MicArgs = {};
    try {
      args = JSON.parse(argsText) as MicArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'micStart', 'bad args');
      return;
    }
    const format = args.format ?? 'pcm-s16le';
    if (format !== 'pcm-s16le') {
      reject(callId, settle, 'invalid', 'micStart',
        'unsupported format ' + format + ' (v0 carries pcm-s16le only)');
      return;
    }
    let rate = args.sampleRate ?? 16000;
    if (rate < RATE_LO) {
      rate = RATE_LO;
    }
    if (rate > RATE_HI) {
      rate = RATE_HI;
    }
    const channels = (args.channels ?? 1) < 1 ? 1 : (args.channels ?? 1);
    if (channels !== 1) {
      reject(callId, settle, 'invalid', 'micStart',
        'channels ' + channels + ' unsupported (v0 is mono)');
      return;
    }
    let frameMs = args.frameMs ?? 100;
    if (frameMs < FRAME_MS_LO) {
      frameMs = FRAME_MS_LO;
    }
    if (frameMs > FRAME_MS_HI) {
      frameMs = FRAME_MS_HI;
    }
    this.requestGrantThenArm(callId, rate, frameMs, settle);
  }

  /** The OS prompt (the second consent layer): request MICROPHONE, then arm
   * or settle the honest `null` (a refusal is a value). */
  private requestGrantThenArm(callId: number, rate: number, frameMs: number,
    settle: SettleFn): void {
    hilog.info(0x0000, TAG, 'ui-wait microphone-permission');
    let request: Promise<PermRequestResult>;
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      request = atManager.requestPermissionsFromUser(this.ctx,
        ['ohos.permission.MICROPHONE']);
    } catch (e) {
      const be = e as BusinessError;
      hilog.info(0x0000, TAG, 'ui-done microphone-permission refused');
      reject(callId, settle, 'unavailable', 'micStart', be.message ?? 'permission refused');
      return;
    }
    request.then((result: PermRequestResult): void => {
      const granted = result.authResults.length > 0
        && result.authResults[0] === 0;
      hilog.info(0x0000, TAG, 'ui-done microphone-permission granted=%{public}s',
        String(granted));
      if (!granted) {
        settle(callId, 'null', true); // the OS layer refused — a value
        return;
      }
      this.arm(callId, rate, frameMs, settle);
    }).catch((err: BusinessError): void => {
      hilog.info(0x0000, TAG, 'ui-done microphone-permission error');
      reject(callId, settle, 'unavailable', 'micStart', err.message ?? 'permission refused');
    });
  }

  /** Creates the capturer (S16LE mono at the clamped rate, SOURCE_TYPE_MIC)
   * and resolves { streamId } once ARMED. */
  private arm(callId: number, rate: number, frameMs: number, settle: SettleFn): void {
    // this host's chunk: frameMs bytes, capped at the bridge's 4 KB rule
    let frameBytes = Math.floor(rate * 2 * frameMs / 1000);
    if (frameBytes > CHUNK_LIMIT) {
      frameBytes = CHUNK_LIMIT;
    }
    if (frameBytes < 2) {
      frameBytes = 2;
    }
    const options: audio.AudioCapturerOptions = {
      streamInfo: {
        samplingRate: rate,
        channels: 1,
        sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
      },
      capturerInfo: {
        source: audio.SourceType.SOURCE_TYPE_MIC,
        capturerFlags: 0,
      },
    };
    const id = 'mic:' + Date.now().toString(16) + '-'
      + Math.floor(Math.random() * 0x100000000).toString(16);
    const s = new MicStream(id, frameBytes);
    audio.createAudioCapturer(options).then((capturer: audio.AudioCapturer): void => {
      s.capturer = capturer;
      return capturer.start();
    }).then((): void => {
      s.startedAt = Date.now();
      this.stream = s;
      // settle FIRST, then install readData: the hostSettle enters the
      // runtime queue ahead of any frame event, so the consumer's
      // micStart promise (which registers the channel state) always
      // resolves before the first frame lands.
      settle(callId, '{"streamId":"' + id + '"}', true);
      capturer.on('readData', (buffer: ArrayBuffer): void => {
        this.capture(s, buffer);
      });
    }).catch((err: BusinessError): void => {
      reject(callId, settle, 'unavailable', 'micStart',
        'capturer refused: ' + (err.message ?? 'unknown'));
    });
  }

  /** One readData buffer -> the accumulator; every full chunk enters the
   * ring (drop-oldest on overflow — its seq never reaches the consumer,
   * the honest gap). */
  private capture(s: MicStream, buffer: ArrayBuffer): void {
    if (s.stopped) {
      return;
    }
    const tail = new Uint8Array(buffer);
    const merged = new Uint8Array(s.accumulator.length + tail.length);
    merged.set(s.accumulator, 0);
    merged.set(tail, s.accumulator.length);
    let offset = 0;
    while (merged.length - offset >= s.frameBytes) {
      s.seq += 1;
      s.pending.push(new MicChunk(s.seq, merged.slice(offset, offset + s.frameBytes).buffer));
      offset += s.frameBytes;
      if (s.pending.length > RING_CAP) {
        s.pending.shift();
      }
    }
    s.accumulator = merged.slice(offset);
    this.drain(s);
  }

  /** Forwards the ring FIFO. Each forwarded chunk's bytes join the stop
   * record's count — the audit carries what the consumer received. */
  private drain(s: MicStream): void {
    while (s.pending.length > 0 && !s.stopped) {
      const item = s.pending.shift();
      if (item === undefined) {
        break;
      }
      s.bytes += item.data.byteLength;
      const b64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(item.data));
      this.emit?.('{"event":"mic.frame","streamId":"' + s.id + '","seq":'
        + item.seq + ',"bytesB64":"' + b64 + '"}');
    }
  }

  // ---- micStop (idempotent, the record that carries duration + bytes) ------

  micStop(callId: number, argsText: string, settle: SettleFn): void {
    let args: MicArgs = {};
    try {
      args = JSON.parse(argsText) as MicArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'micStop', 'bad args');
      return;
    }
    const id = args.streamId ?? '';
    const s = this.stream;
    if (s === null || s.id !== id || s.stopped) {
      // unknown or already-stopped id: the timerCancel shape
      const answer: StopAnswer = { stopped: false, durationMs: 0, bytes: 0 };
      settle(callId, JSON.stringify(answer), true);
      return;
    }
    // The later-tick posture (the dispatch must never re-enter the runtime
    // synchronously): halt's drain emits bridge events, so the stop settles
    // from an independent event-loop tick.
    setTimeout((): void => {
      this.halt(s, 'stopped');
      const durationMs = Date.now() - s.startedAt;
      const answer: StopAnswer = {
        stopped: true, durationMs: durationMs, bytes: s.bytes,
      };
      settle(callId, JSON.stringify(answer), true);
    }, 0);
  }

  /** Stops the capturer, flushes the accumulator tail + ring IN ORDER, then
   * publishes the end event exactly once. */
  private halt(s: MicStream, reason: string): void {
    s.stopped = true;
    const capturer = s.capturer;
    s.capturer = null;
    if (capturer !== null) {
      capturer.off('readData');
      capturer.stop().catch((err: BusinessError): void => {
        hilog.warn(0x0000, TAG, 'mic capturer stop refused: %{public}s',
          err.message ?? '');
      });
      capturer.release().catch((err: BusinessError): void => {
        hilog.warn(0x0000, TAG, 'mic capturer release refused: %{public}s',
          err.message ?? '');
      });
    }
    // the accumulator's tail (< frameBytes) flushes as a final chunk
    if (s.accumulator.length > 0) {
      s.seq += 1;
      s.pending.push(new MicChunk(s.seq, s.accumulator.slice().buffer));
      if (s.pending.length > RING_CAP) {
        s.pending.shift();
      }
      s.accumulator = new Uint8Array(0);
    }
    this.drain(s);
    if (s.endPublished) {
      return;
    }
    s.endPublished = true;
    this.emit?.('{"event":"mic.end","streamId":"' + s.id + '","reason":"'
      + reason + '"}');
  }
}
