// dsh:logging-exempt (shim layer: part of the scripted-model boundary, logged as model.scripted)
/**
 * dsh-llm shim, streaming half — BlockAssembler and AssistantStreamAccumulator,
 * ported from deepseek-harness packages/llm/llm/src (assembler.ts,
 * assistant-stream.ts). Split from dsh-llm.js only to respect the code-size
 * gate; the public specifier '@deepseek-ai/dsh-llm' re-exports both names, so
 * importers see one module identity's worth of symbols defined exactly once.
 *
 * Covers (upstream usage → this module):
 *   - BlockAssembler              — agent-loop (chunk stream → assistant message)
 *   - AssistantStreamAccumulator  — agent-loop (durable compact attempt stream)
 */
import { brandString } from '@deepseek-ai/dsh-brand';
import { assertNever, deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { createMessage } from 'upstream/shims/dsh-llm.js';

/* ---- BlockAssembler (upstream assembler.ts) ------------------------------ */

class PartialBlock {
  constructor(blockType) {
    this.blockType = blockType;
    this.text = '';
    this.toolCallArguments = '';
  }
}

/**
 * Incrementally assembles raw StreamChunks into complete ContentBlocks and a
 * final assistant Message. Tolerant of delta-only protocols; deltas arriving
 * for an index already closed by block-end are ignored (malformed stream).
 */
export class BlockAssembler {
  partials = new Map();
  order = [];
  _usage;
  _finish;
  _replayState;

  push(chunk) {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index);
          this.partials.set(chunk.index, new PartialBlock(chunk.blockType));
        }
        return;
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning');
        if (partial.block) return; // closed by block-end; ignore stragglers
        partial.text += chunk.text;
        return;
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call');
        if (partial.block) return; // closed by block-end; ignore stragglers
        partial.toolCallId = chunk.id;
        if (chunk.name) partial.toolCallName = chunk.name;
        partial.toolCallArguments += chunk.argumentsDelta;
        return;
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type);
        if (partial.block) return; // first close wins
        partial.block = chunk.block;
        return;
      }
      case 'usage': {
        this._usage = chunk.usage;
        return;
      }
      case 'finish': {
        this._finish = chunk.reason;
        this._replayState = chunk.replayState;
        return;
      }
      default:
        return assertNever(chunk, 'BlockAssembler.push');
    }
  }

  ensure(index, blockType) {
    let partial = this.partials.get(index);
    if (!partial) {
      partial = new PartialBlock(blockType);
      this.partials.set(index, partial);
      this.order.push(index);
    }
    return partial;
  }

  assemble(partial, index) {
    if (partial.block) return partial.block;
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text };
      case 'reasoning': return { type: 'reasoning', text: partial.text };
      case 'tool-call': return {
        type: 'tool-call',
        id: partial.toolCallId ?? brandString(`call-${index}`),
        name: partial.toolCallName ?? '',
        arguments: partial.toolCallArguments,
      };
      default:
        throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`);
    }
  }

  mustGet(index) {
    const partial = this.partials.get(index);
    if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`);
    return partial;
  }

  /** One keep/drop decision over all seen blocks: max-tokens drops tool calls. */
  assembled() {
    const all = this.order.map((index) => this.assemble(this.mustGet(index), index));
    const kept = this.finish.kind === 'max-tokens'
      ? all.map((block) => block.type !== 'tool-call')
      : undefined;
    const blocks = kept === undefined ? all : all.filter((_, position) => kept[position]);
    const envelope = this._replayState;
    if (envelope?.blocks === undefined) return { blocks, replay: envelope };
    if (envelope.blocks.length !== all.length) return { blocks, replay: undefined };
    return {
      blocks,
      replay: kept === undefined || blocks.length === all.length
        ? envelope
        : { response: envelope.response, blocks: envelope.blocks.filter((_, position) => kept[position]) },
    };
  }

  /** All blocks seen so far, in stream order (open blocks assemble from deltas). */
  blocks() {
    return this.assembled().blocks;
  }

  /** The prefix an interrupted stream can safely finalize (no tool calls). */
  interruptedBlocks() {
    return this.order
      .map((index) => {
        const partial = this.mustGet(index);
        const type = partial.block?.type ?? partial.blockType;
        if (type !== 'text' && type !== 'reasoning') return undefined;
        return this.assemble(partial, index);
      })
      .filter((block) =>
        (block?.type === 'text' || block?.type === 'reasoning') && block.text.trim() !== '');
  }

  /** Usage from the `usage` chunk; undefined until one arrives. */
  get usage() {
    return this._usage;
  }

  /** Finish reason; `{kind:'stop'}` when the stream ended without one. */
  get finish() {
    return this._finish ?? { kind: 'stop' };
  }

  /** Replay metadata pruned in step with blocks(); undefined on misalignment. */
  get replayState() {
    return this.assembled().replay;
  }

  /** The assembled assistant message with producer attribution. */
  message(source = { kind: 'plugin', plugin: 'dsh-llm/assembler' }) {
    return createMessage({ role: 'assistant', content: this.blocks(), source });
  }
}

/* ---- AssistantStreamAccumulator (upstream assistant-stream.ts) ----------- */

const safeTime = (value) => {
  if (!Number.isSafeInteger(value)) throw new TypeError(`Assistant stream time must be a safe integer, got ${String(value)}`);
  return value;
};

const safeIndex = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} index must be a non-negative safe integer`);
  }
  return value;
};

const snapshotChunk = (chunk) => {
  const snapshot = snapshotJsonValue(chunk);
  if (snapshot === undefined) throw new TypeError('Assistant stream chunk must be losslessly JSON-serializable');
  return snapshot;
};

const safeGap = (previous, next) => {
  const gap = next - previous;
  return Number.isSafeInteger(gap) && previous + gap === next ? gap : undefined;
};

/**
 * Incrementally compacts one model-stream attempt into the lossless durable
 * record form (packed delta runs + raw chunk records).
 */
export class AssistantStreamAccumulator {
  records = [];

  push(value) {
    const time = safeTime(value.time);
    const chunk = snapshotChunk(value.chunk);
    const timed = deepFreeze({ time, chunk });
    const previous = this.records.at(-1);
    switch (chunk.type) {
      case 'text-delta':
      case 'reasoning-delta':
        return this.pushTextLikeRun(timed, chunk, previous, time);
      case 'tool-call-delta':
        return this.pushToolCallRun(timed, chunk, previous, time);
      case 'block-start':
      case 'block-end':
      case 'usage':
      case 'finish':
        return this.pushRaw(timed, chunk);
      default:
        return assertNever(chunk, 'AssistantStreamAccumulator.push');
    }
  }

  /** Pack one text/reasoning delta into (or start) its typed run record. */
  pushTextLikeRun(timed, chunk, previous, time) {
    safeIndex(chunk.index, chunk.type);
    if (typeof chunk.text !== 'string') throw new TypeError(`${chunk.type} text must be a string`);
    const type = chunk.type === 'text-delta' ? 'text-chunks' : 'reasoning-chunks';
    const gap = previous !== undefined && previous.type === type ? safeGap(previous.lastTime, time) : undefined;
    const sameRun = previous !== undefined && previous.type === type
      && previous.index === chunk.index
      && gap !== undefined;
    if (sameRun) {
      previous.dt.push(gap);
      previous.texts.push(chunk.text);
      previous.lastTime = time;
    } else {
      this.records.push({ type, time0: time, index: chunk.index, dt: [], texts: [chunk.text], lastTime: time });
    }
    return timed;
  }

  /** Pack one tool-call delta into (or start) its typed run record. */
  pushToolCallRun(timed, chunk, previous, time) {
    safeIndex(chunk.index, chunk.type);
    if (typeof chunk.id !== 'string') throw new TypeError('tool-call-delta id must be a string');
    if (Object.hasOwn(chunk, 'name') && typeof chunk.name !== 'string') {
      throw new TypeError('tool-call-delta name must be a string');
    }
    if (typeof chunk.argumentsDelta !== 'string') {
      throw new TypeError('tool-call-delta argumentsDelta must be a string');
    }
    // Empty-id and empty-name deltas are never packed.
    if (chunk.id.length === 0 || chunk.name === '') {
      return this.pushRaw(timed, chunk);
    }
    if (this.canPackInto(previous, chunk, time)) {
      previous.dt.push(safeGap(previous.lastTime, time));
      previous.args.push(chunk.argumentsDelta);
      previous.lastTime = time;
      return timed;
    }
    this.records.push({
      type: 'tool-call-chunks',
      time0: time,
      index: chunk.index,
      dt: [],
      id: chunk.id,
      ...Object.hasOwn(chunk, 'name') ? { name: chunk.name } : {},
      args: [chunk.argumentsDelta],
      lastTime: time,
    });
    return timed;
  }

  pushRaw(timed, chunk) {
    this.records.push({ type: 'chunk', time: timed.time, chunk });
    return timed;
  }

  canPackInto(previous, chunk, time) {
    if (previous?.type !== 'tool-call-chunks') return false;
    const sameName = Object.hasOwn(previous, 'name') === Object.hasOwn(chunk, 'name')
      && previous.name === chunk.name;
    return previous.index === chunk.index
      && previous.id === chunk.id
      && sameName
      && safeGap(previous.lastTime, time) !== undefined;
  }

  /** The current compact attempt stream (detached, frozen). */
  snapshot() {
    const records = this.records.map((record) => {
      if (record.type === 'chunk') return { ...record };
      const { lastTime: _lastTime, ...durable } = record;
      if (durable.type === 'tool-call-chunks') {
        return { ...durable, dt: [...durable.dt], args: [...durable.args] };
      }
      return { ...durable, dt: [...durable.dt], texts: [...durable.texts] };
    });
    return deepFreeze(records);
  }
}
