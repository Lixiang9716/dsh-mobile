// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * dsh-office shared pieces: the scalar caps, the reused schema fragments,
 * and the XML text codecs.
 *
 * Ported from dsh-office-tools@1.0.4 (MIT, src/tools/shared.ts) — the
 * model-facing tool surface (word_* / excel_* / ppt_*) and the OOXML part
 * templates are that package's, re-licensed MIT; this tree adapts them to
 * the QuickJS runtime (no node:path / node:zlib / ctx.fs service — fflate
 * and the gateway fs primitives instead). See the feature Agent Note.
 */

/** Whole-office caps: file size, text volume, grid volume, zip volume. The
 * zip caps guard decompression bombs (an office file is a zip; declaring the
 * caps before inflating is the only defense a pure-JS reader has). */
export const MAX_OFFICE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2e5;
export const MAX_READ_CELLS = 2e5;
export const MAX_WRITE_CELLS = 2e5;
export const MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 1e5;

/** A spreadsheet cell is a scalar: string, number, boolean, or null. */
export const CELL_VALUE_SCHEMA = {
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
  ],
};

/** One grid row: an array of scalar cells. */
export const ROW_SCHEMA = {
  type: 'array',
  items: CELL_VALUE_SCHEMA,
};

/** Every create/update tool answers with the written file's path + size. */
export const FILE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    sizeBytes: { type: 'integer', required: true },
  },
};

/** Encode one text run's body: XML-special characters escaped, control
 * characters (except tab/newline/carriage return) dropped, everything above
 * ASCII carried as a numeric reference so the part stays UTF-8-safe. */
const encodeXmlChar = (code) => {
  if (code > 127) return `&#${code};`;
  if (code < 32 && code !== 9 && code !== 10 && code !== 13) return '';
  return String.fromCharCode(code);
};

export const encodeXmlText = (value) => {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else out += encodeXmlChar(code);
  }
  return out;
};

export const encodeXmlAttribute = (value) => {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else if (char === '"') out += '&quot;';
    else out += encodeXmlChar(code);
  }
  return out;
};

/** The reader's counterpart: the five named entities plus numeric
 * references. An unknown entity passes through untouched. */
export const decodeXmlEntities = (value) => {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity, code) => {
    if (code === 'amp') return '&';
    if (code === 'lt') return '<';
    if (code === 'gt') return '>';
    if (code === 'quot') return '"';
    if (code === 'apos') return "'";
    const number = code.startsWith('#x')
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
  });
};
