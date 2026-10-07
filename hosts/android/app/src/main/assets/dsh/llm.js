/**
 * llm.js — the OpenAI-compatible STREAMING chat client. The transport is a
 * PARAMETER with the gateway `httpFetch` response shape — `{status, headers,
 * body: AsyncIterable<Uint8Array>, abort()}` — so the same code runs against
 * the real gateway primitive (device hosts) and a scripted SSE feed (the
 * CI-safe CLI leg; the llm-live-stream scenario negotiates the leg via the
 * RuntimeDescriptor, never via a hostType branch — D5).
 *
 * Wire: POST {baseUrl}/chat/completions with stream:true; the reply is SSE —
 * `data:` lines, each a JSON chunk whose choices[0].delta carries `content`
 * (assistant text) and/or `reasoning_content` (thinking trace; this backend
 * emits reasoning deltas BEFORE content deltas). `data: [DONE]` or
 * end-of-stream completes the call. The parser is tolerant to partial lines
 * and arbitrary chunk boundaries: bytes are incrementally UTF-8 decoded (the
 * spike host ships no TextDecoder) and folded line by line.
 *
 * Events ride the `on(name, fields)` callback as an event sequence (D8 —
 * never a blocking whole result), in the session-mock-llm vocabulary so downstream
 * consumers stay unchanged: content deltas are `llm.delta` {index, text};
 * reasoning deltas are `llm.reasoning.delta` {index, text} (same shape,
 * separate stream — the two index spaces are independent per-turn counters).
 * `open` {status, abort} fires at response headers (abort() cancels the
 * stream); `done` {deltas, reasoningDeltas, chars, finishReason, served}
 * fires once at the end. streamChat resolves with the aggregated assistant
 * text (content deltas only) and the stream facts.
 *
 * The API key NEVER enters a log line: log calls carry only the URL, byte
 * counts, and model names — headers and bodies are never logged. The
 * llm-live-stream scenario additionally audits every log-sink line for the key
 * string and fails loud on a leak (rule 5).
 */
import { createLogger } from 'logger.js';

const log = createLogger('dsh.llm');

/** Structured LLM-client failure (contract-style code + message). */
export class LlmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    log.debug('llm error', { code });
  }
}

// ---- UTF-8 (the spike host ships no TextEncoder/TextDecoder) ---------------

/** Encodes a JS string to UTF-8 bytes (code points beyond the BMP ride the
 * 4-byte form via their surrogate pair — `for…of` iterates code points). */
export const utf8Encode = (text) => {
  log.debug('utf8 encode', { chars: text.length });
  const out = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return Uint8Array.from(out);
};

/** Incremental UTF-8 decoder: `feed(bytes)` returns the text those bytes
 * decode to, holding an incomplete trailing sequence for the next feed;
 * `end()` flushes a dangling sequence as U+FFFD. Malformed bytes decode to
 * U+FFFD — the decoder never throws, whatever the wire sends. */
const makeUtf8 = () => {
  log.debug('utf8 decoder created');
  let pending = null; // { left, cp } — continuation state of a multi-byte sequence
  const feed = (bytes) => {
    log.debug('utf8 feed', { bytes: bytes.length });
    let text = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (!pending) {
        const need = b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2
          : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
        if (need === 0) { text += '\uFFFD'; continue; } // stray continuation / invalid lead
        if (need === 1) { text += String.fromCharCode(b); continue; }
        pending = { left: need - 1, cp: b & (0xff >> (need + 1)) };
        continue;
      }
      if ((b & 0xc0) !== 0x80) { text += '\uFFFD'; pending = null; i -= 1; continue; }
      pending.cp = (pending.cp << 6) | (b & 63);
      pending.left -= 1;
      if (pending.left === 0) {
        text += String.fromCodePoint(pending.cp);
        pending = null;
      }
    }
    return text;
  };
  const end = () => {
    log.debug('utf8 end', { dangling: pending !== null });
    const tail = pending ? '\uFFFD' : '';
    pending = null;
    return tail;
  };
  return { feed, end };
};

/** One-shot decode of a complete byte array (config files, error bodies). */
export const utf8Decode = (bytes) => {
  log.debug('utf8 decode', { bytes: bytes.length });
  const dec = makeUtf8();
  return dec.feed(bytes) + dec.end();
};

// ---- SSE framing -------------------------------------------------------------

/** Feeds decoded text, returns every COMPLETE line (\n-split, \r-trimmed);
 * a trailing partial line stays buffered until its newline arrives (or the
 * stream ends — drainSse flushes it). */
const makeLineSplitter = () => {
  log.debug('sse splitter created');
  let buf = '';
  const push = (text) => {
    log.debug('sse feed', { chars: text.length });
    buf += text;
    const lines = [];
    for (let at = buf.indexOf('\n'); at >= 0; at = buf.indexOf('\n')) {
      let line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
    }
    return lines;
  };
  const flush = () => {
    log.debug('sse flush', { buffered: buf.length });
    const rest = buf;
    buf = '';
    return rest;
  };
  return { push, flush };
};

/** Folds one parsed SSE chunk into `st` and fires the stream events. The
 * served model is reported once (servers may substitute a different model
 * name than requested — logged honestly, never assumed). */
const foldChunk = (st, data) => {
  log.debug('sse chunk fold', { hasChoices: Array.isArray(data.choices) });
  if (typeof data.model === 'string' && data.model && data.model !== st.served) {
    st.served = data.model;
    st.on('model', { served: st.served });
  }
  const choice = data.choices?.[0];
  if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
    st.finishReason = choice.finish_reason;
  }
  const delta = choice?.delta ?? {};
  const thinking = delta.reasoning_content;
  if (typeof thinking === 'string' && thinking.length > 0) {
    st.reasoning += thinking;
    st.on('reasoning', { index: st.reasoningDeltas++, text: thinking });
  }
  const piece = delta.content;
  if (typeof piece === 'string' && piece.length > 0) {
    st.text += piece;
    st.on('delta', { index: st.deltas++, text: piece });
  }
};

/** Processes one SSE line against `st`; returns false at the [DONE]
 * terminator. Non-data lines (comments, event:/id:/retry:) are ignored. */
const foldLine = (st, line) => {
  log.debug('sse line', { chars: line.length });
  if (line.indexOf('data:') !== 0) return true;
  const payload = line.slice(5).replace(/^ /, '');
  if (payload === '[DONE]') return false;
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    throw new LlmError('invalid', `unparsable SSE data line (${payload.length} chars)`);
  }
  foldChunk(st, data);
  return true;
};

/** Drains the streaming body through the SSE parser (D8: one callback per
 * delta as its bytes arrive, never a blocking whole-result). A caller
 * abort surfaces as finishReason 'aborted' (gateway code `cancelled`);
 * anything else rejects. A trailing partial line is flushed at EOF. */
const drainSse = async (st, res) => {
  log.debug('sse drain begin');
  const dec = makeUtf8();
  const splitter = makeLineSplitter();
  try {
    for await (const chunk of res.body) {
      let done = false;
      for (const line of splitter.push(dec.feed(chunk))) {
        if (!foldLine(st, line)) { done = true; break; }
      }
      if (done) return;
    }
  } catch (err) {
    if (!(st.aborted && err?.code === 'cancelled')) throw err;
    st.finishReason = 'aborted';
    log.debug('sse drain aborted by caller');
  }
  for (const line of splitter.push(splitter.flush() + dec.end())) {
    if (!foldLine(st, line)) return;
  }
};

/** Non-200: drains the error body (bounded) into the failure message so the
 * log names what the server said — without ever logging request headers. */
const statusError = async (res) => {
  log.debug('status error drain', { status: res.status });
  const dec = makeUtf8();
  let detail = '';
  try {
    for await (const chunk of res.body) {
      detail += dec.feed(chunk);
      if (detail.length >= 200) { detail = detail.slice(0, 200); break; }
    }
  } catch (err) {
    log.debug('error body drain failed', { code: err?.code ?? 'unknown' });
  }
  return new LlmError('network', `chat/completions status ${res.status}: ${detail.trim()}`);
};

/** One streaming chat completion. Args: {fetchImpl, baseUrl, apiKey, model,
 * messages, maxTokens, on}. The fetchImpl gets (url, {method, headers,
 * body}) with body as UTF-8 bytes (the gateway httpFetch signature).
 * Resolves {text, reasoning, deltas, reasoningDeltas, finishReason, served};
 * rejects with LlmError (invalid/network) or whatever the transport threw. */
export const streamChat = async ({ fetchImpl, baseUrl, apiKey, model, messages, maxTokens, on = () => {} }) => {
  log.debug('streamChat begin', { model, messages: messages.length, maxTokens });
  if (typeof fetchImpl !== 'function') {
    throw new LlmError('invalid', 'streamChat needs a fetchImpl');
  }
  if (!baseUrl || !apiKey || !model || !Array.isArray(messages) || messages.length === 0) {
    throw new LlmError('invalid', 'streamChat needs baseUrl, apiKey, model, messages');
  }
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const body = utf8Encode(JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens }));
  log.debug('llm request', { url, bytes: body.length });
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${apiKey}`, // NEVER logged (see module docs)
    },
    body,
  });
  log.debug('llm response', { status: res.status });
  if (res.status !== 200) throw await statusError(res);
  const st = {
    on, text: '', reasoning: '', deltas: 0, reasoningDeltas: 0,
    served: null, finishReason: null, aborted: false,
  };
  on('open', {
    status: res.status,
    abort: () => {
      st.aborted = true;
      log.debug('llm abort requested');
      res.abort?.();
    },
  });
  await drainSse(st, res);
  on('done', {
    deltas: st.deltas, reasoningDeltas: st.reasoningDeltas, chars: st.text.length,
    finishReason: st.finishReason, served: st.served,
  });
  log.debug('streamChat done', { deltas: st.deltas, chars: st.text.length });
  return {
    text: st.text, reasoning: st.reasoning, deltas: st.deltas,
    reasoningDeltas: st.reasoningDeltas, finishReason: st.finishReason, served: st.served,
  };
};
