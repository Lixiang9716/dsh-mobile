// dsh:logging-exempt (shim layer; codec face, no logging surface)
/**
 * web-multipart — the multipart/form-data codec for the fetch-values faces,
 * split out of web-fetch-values.js so BOTH sides import it without a cycle
 * (web-fetch-values → node-http-loopback → here; the fetch-values classes
 * stay out of this module and are read off globalThis at CALL time — they
 * are installed before any request can run).
 *
 * The consumer is the Files API upload family (dsh-llm-deepseek builds a
 * FormData + Blob and POSTs it; the in-test mock parses the wire with
 * `new Request(...).formData()`): encode turns the W3C FormData into the
 * RFC 7578 byte stream (real fetch does this inside the engine), parse is
 * the matching decoder the Request/Response formData() faces serve.
 */

const CRLF = [13, 10]; // '\r\n'

const utf8 = (text) => new globalThis.TextEncoder().encode(text);

const concat = (chunks) => {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
};

const latin1 = (bytes) => {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return text;
};

/** One byte-sequence search (the boundary scan below works on BYTES so file
 * parts stay byte-faithful; indices/strings never round-trip binary data). */
const indexOfBytes = (haystack, needle, from = 0) => {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

/** Serialize a FormData into its multipart byte stream. File parts carry
 * their filename (quoted per RFC 2183/7578; `"` is percent-escaped like the
 * engines do) and content type; string parts are UTF-8. */
export const encodeFormData = async (form) => {
  const boundary = `----dsh-loopback-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const chunks = [];
  for (const [name, value] of form.entries()) {
    chunks.push(utf8(`--${boundary}${CRLF.map((c) => String.fromCharCode(c)).join('')}`));
    const isFile = value !== null && typeof value === 'object' && typeof value.arrayBuffer === 'function';
    if (isFile) {
      const filename = String(value.name ?? 'blob').replace(/"/g, '%22');
      chunks.push(utf8(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`));
      chunks.push(utf8(`Content-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`));
      chunks.push(new Uint8Array(await value.arrayBuffer()));
    } else {
      chunks.push(utf8(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
      chunks.push(utf8(String(value)));
    }
    chunks.push(utf8('\r\n'));
  }
  chunks.push(utf8(`--${boundary}--\r\n`));
  return { bytes: concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
};

/** Decode a multipart body into a FormData (the Request.formData() face).
 * Field values stay strings; file parts (a filename attribute) become File
 * instances with their declared Content-Type. A body without the boundary
 * parameter throws TypeError (the engines do). */
export const parseMultipart = (bytes, contentType) => {
  const type = String(contentType ?? '');
  const at = type.toLowerCase().indexOf('boundary=');
  if (at < 0) throw new TypeError('multipart: body is not a multipart/form-data with a boundary');
  let boundary = type.slice(at + 'boundary='.length).trim();
  if (boundary.startsWith('"') && boundary.endsWith('"') && boundary.length >= 2) {
    boundary = boundary.slice(1, -1);
  }
  const delimiter = utf8(`--${boundary}`);
  const crlf = new Uint8Array(CRLF);
  const parts = [];
  let cursor = indexOfBytes(bytes, delimiter);
  if (cursor < 0) throw new TypeError('multipart: boundary not found in body');
  for (;;) {
    cursor += delimiter.length;
    // Final delimiter: `--` right after the boundary closes the body.
    if (bytes[cursor] === 45 && bytes[cursor + 1] === 45) break;
    // Skip the CRLF that follows the opening delimiter, then the headers
    // block runs to the first blank line; the body runs to the next CRLF +
    // delimiter.
    if (bytes[cursor] === 13 && bytes[cursor + 1] === 10) cursor += 2;
    const headEnd = indexOfBytes(bytes, concat([crlf, crlf]), cursor);
    if (headEnd < 0) break;
    const head = latin1(bytes.subarray(cursor, headEnd));
    const nextDelimiter = indexOfBytes(bytes, concat([crlf, delimiter]), headEnd + 4);
    if (nextDelimiter < 0) break;
    const body = bytes.subarray(headEnd + 4, nextDelimiter);
    parts.push({ head, body });
    cursor = nextDelimiter;
  }
  const FormDataCtor = globalThis.FormData;
  const FileCtor = globalThis.File;
  if (typeof FormDataCtor !== 'function' || typeof FileCtor !== 'function') {
    throw new TypeError('multipart: FormData/File globals are not installed');
  }
  const form = new FormDataCtor();
  for (const part of parts) {
    const name = /name="([^"]*)"/i.exec(part.head)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(part.head)?.[1];
    const partType = (/content-type:\s*([^\r\n]+)/i.exec(part.head)?.[1] ?? '').trim();
    if (filename !== undefined) {
      form.set(name, new FileCtor([part.body], filename.replace(/%22/g, '"'), { type: partType || 'application/octet-stream' }));
    } else {
      form.set(name, new globalThis.TextDecoder().decode(part.body));
    }
  }
  return form;
};
