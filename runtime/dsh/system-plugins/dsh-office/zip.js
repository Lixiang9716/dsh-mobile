// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * The office container: zip read/write over vendored fflate, with the
 * decompression guards the OOXML readers rely on.
 *
 * dsh-office-tools carried its own zip writer (store-only) and read inflates
 * through node:zlib; this runtime has neither seam, so the container is
 * fflate's zipSync/unzipSync (deflate both ways — files come out smaller
 * than the desktop writer's store-only packages). The guards are the port
 * of asciizip.ts's caps: an office file is untrusted input, and a pure-JS
 * reader declares its budget before inflating, not after.
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { createLogger } from 'logger.js';
import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_TOTAL_BYTES,
} from './shared.js';

const log = createLogger('dsh.office.zip');

/** One office package as a name → Uint8Array map. The factory form keeps
 * unzipSync's result object itself; the guards walk it once. */
export const readOfficeZip = (bytes) => {
  log.debug('office zip open', { bytes: bytes.byteLength });
  const parts = unzipSync(bytes);
  const names = Object.keys(parts);
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new Error(`the package holds ${names.length} zip entries; office tools accept at most ${MAX_ZIP_ENTRIES}`);
  }
  let total = 0;
  for (const name of names) {
    const size = parts[name].byteLength;
    total += size;
    if (size > MAX_ZIP_ENTRY_BYTES) {
      throw new Error(`zip entry "${name}" inflates to ${size} bytes; office tools accept at most ${MAX_ZIP_ENTRY_BYTES}`);
    }
    if (total > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(`the package inflates to more than ${MAX_ZIP_TOTAL_BYTES} bytes; office tools refuse it`);
    }
  }
  return { parts, names };
};

/** One part's bytes, or null when the package does not carry it. */
export const zipPartBytes = (zip, name) => zip.parts[name] ?? null;

/** One part as UTF-8 text, or null when the package does not carry it. */
export const zipPartText = (zip, name) => {
  const bytes = zip.parts[name];
  return bytes === undefined ? null : strFromU8(bytes);
};

/** Build one office package: {name: text|Uint8Array} entries in insertion
 * order (the OOXML readers list [Content_Types].xml first; zip order is
 * not semantic, but deterministic order keeps output byte-stable). Text
 * entries are UTF-8 encoded here — zipSync takes bytes only. */
export const buildOfficeZip = (entries) => {
  const input = {};
  for (const entry of entries) {
    input[entry.name] = entry.bytes ?? strToU8(entry.text);
  }
  const bytes = zipSync(input);
  log.debug('office zip built', { entries: entries.length, bytes: bytes.byteLength });
  return bytes;
};
