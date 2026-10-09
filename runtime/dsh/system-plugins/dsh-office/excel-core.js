// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * The .xlsx engine under the excel tools: grid↔XML and the package
 * templates (ported from dsh-office-tools@1.0.4, MIT, src/tools/excel.ts).
 *
 * Cells are scalar (string / number / boolean / null); a string starting
 * with "=" is written as a formula. Written sheets carry inline strings (no
 * sharedStrings part on write) and the read path understands BOTH inline
 * strings and the sharedStrings table real-world workbooks use, plus cached
 * formula values. The reader is regex-based by design: OOXML worksheets are
 * machine-generated, so the row/cell/address grammars are stable.
 */
import { encodeXmlText, encodeXmlAttribute, decodeXmlEntities } from './shared.js';
import { readOfficeZip, zipPartText } from './zip.js';

export const XLSX_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';

export const XLSX_ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';

export const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>';

export const XLSX_APP_PROPS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>dsh-office</Application></Properties>';

export const XLSX_CORE_PROPS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Workbook</dc:title></cp:coreProperties>';

export const validateSheetSpecs = (sheets) => {
  if (sheets.length === 0) throw new Error('sheets must contain at least one sheet');
  const seen = new Set();
  let totalCells = 0;
  let totalRows = 0;
  for (const sheet of sheets) {
    if (sheet.name.trim() === '') throw new Error('sheet name must be a non-empty string');
    if (seen.has(sheet.name)) throw new Error(`duplicate sheet name "${sheet.name}" in one call`);
    seen.add(sheet.name);
    if (sheet.rows.length > 1e4) throw new Error(`sheet "${sheet.name}" has too many rows (maximum 10000)`);
    totalRows += sheet.rows.length;
    for (const row of sheet.rows) {
      totalCells += row.length;
      if (totalCells > 2e5) throw new Error('too many worksheet cells (maximum 200000)');
    }
  }
  if (totalRows === 0) throw new Error('at least one row is required across the sheets');
};

export const columnName = (index) => {
  let name = '';
  let value = index;
  do {
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
};

export const columnIndexOf = (name) => {
  let value = 0;
  for (const char of name.toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    value = value * 26 + (code - 64);
  }
  return value - 1;
};

export const parseCellAddress = (address) => {
  const match = address.match(/^([A-Za-z]+)([1-9][0-9]*)$/);
  if (match === null) return { row: -1, column: -1 };
  return { row: Number.parseInt(match[2], 10) - 1, column: columnIndexOf(match[1]) };
};

export const cellAddress = (row, column) => `${columnName(column)}${row + 1}`;

export const gridCellOf = (value) => {
  if (typeof value === 'string' && value.startsWith('=')) {
    return { kind: 'formula', formula: value.slice(1) };
  }
  return { kind: 'value', value };
};

export const gridOf = (rows) => {
  const grid = new Map();
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      grid.set(cellAddress(rowIndex, columnIndex), gridCellOf(value));
    });
  });
  return grid;
};

export const gridAddresses = (grid) => {
  const addresses = [...grid.keys()].map((address) => {
    const { row, column } = parseCellAddress(address);
    return { address, row, column };
  }).filter((item) => item.row >= 0 && item.column >= 0 && grid.get(item.address) !== undefined);
  addresses.sort((left, right) => left.row - right.row || left.column - right.column);
  return addresses;
};

const cellXml = (address, cell) => {
  if (cell.kind === 'formula') {
    return `<c r="${address}" t="e"><f>${encodeXmlText(cell.formula)}</f></c>`;
  }
  const value = cell.value;
  if (value === null) return `<c r="${address}" t="inlineStr"><is><t/></is></c>`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cell ${address} holds a non-finite number; excel tools refuse it`);
    return `<c r="${address}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') return `<c r="${address}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (value === '') return `<c r="${address}" t="inlineStr"><is><t/></is></c>`;
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${encodeXmlText(value)}</t></is></c>`;
};

export const sheetXml = (grid) => {
  const addresses = gridAddresses(grid);
  const rows = new Map();
  for (const item of addresses) {
    const cells = rows.get(item.row) ?? [];
    cells.push(cellXml(item.address, grid.get(item.address)));
    rows.set(item.row, cells);
  }
  const last = addresses.at(-1);
  const dimension = last === undefined ? 'A1' : `A1:${last.address}`;
  const body = [...rows.entries()].sort((left, right) => left[0] - right[0])
    .map(([rowIndex, cells]) => `<row r="${rowIndex + 1}">${cells.join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetData>${body}</sheetData></worksheet>`;
};

/** The whole workbook package as zip entries, from ordered sheet models
 * ({name, part, content}). Deliberately minimal — the same part set the
 * desktop plugin writes (no sharedStrings, no per-sheet content-type
 * overrides; readers key on the workbook rels). */
export const xlsxEntries = (models) => {
  const workbookSheets = models
    .map((model, index) => `<sheet name="${encodeXmlAttribute(model.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`;
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + models.map((model, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${encodeXmlAttribute(model.part)}"/>`).join('')
    + '</Relationships>';
  const entries = [
    { name: '[Content_Types].xml', text: XLSX_CONTENT_TYPES },
    { name: '_rels/.rels', text: XLSX_ROOT_RELS },
    { name: 'xl/workbook.xml', text: workbook },
    { name: 'xl/_rels/workbook.xml.rels', text: workbookRels },
    { name: 'xl/styles.xml', text: XLSX_STYLES },
    { name: 'docProps/core.xml', text: XLSX_CORE_PROPS },
    { name: 'docProps/app.xml', text: XLSX_APP_PROPS },
  ];
  for (const model of models) entries.push({ name: `xl/${model.part}`, text: model.content });
  return entries;
};

const SHARED_STRING_ITEM = /<si>([\s\S]*?)<\/si>/g;
const SHARED_STRING_TEXT = /<t\b[^>]*>([\s\S]*?)<\/t>/g;

export const parseSharedStrings = (xml) => {
  const values = [];
  for (const item of xml.matchAll(SHARED_STRING_ITEM)) {
    let text = '';
    for (const run of (item[1] ?? '').matchAll(SHARED_STRING_TEXT)) {
      text += decodeXmlEntities(run[1] ?? '');
    }
    values.push(text);
  }
  return values;
};

const WORKBOOK_SHEET = /<sheet\b[^>]*?name="([^"]*)"[^>]*?(?:r:id="([^"]*)")?[^>]*?\/>/g;
const RELATIONSHIP = /<Relationship\b[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?\/>/g;
const SHEET_ROW = /<row\b[^>]*?r="(\d+)"[^>]*?>([\s\S]*?)<\/row>/g;
const SHEET_CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const CELL_REF = /\br="([A-Za-z]+)(\d+)"/;
const CELL_TYPE = /\bt="([^"]*)"/;
const CELL_VALUE = /<v\b[^>]*>([\s\S]*?)<\/v>/;
const CELL_FORMULA = /<f\b[^>]*>([\s\S]*?)<\/f>/;
const CELL_INLINE_TEXT = /<t\b[^>]*>([\s\S]*?)<\/t>/;

export const gridCellToValue = (cell) => {
  if (cell === undefined) return null;
  if (cell.kind === 'formula') return `=${cell.formula}`;
  if (typeof cell.value === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  if (typeof cell.value === 'number') return String(cell.value);
  return cell.value;
};

export const worksheetRows = (grid) => {
  const addresses = gridAddresses(grid);
  if (addresses.length === 0) return [];
  const lastRow = addresses[addresses.length - 1].row;
  const lastColumn = addresses.reduce((width, item) => Math.max(width, item.column), 0);
  const rows = [];
  for (let rowIndex = 0; rowIndex <= lastRow; rowIndex += 1) {
    const row = [];
    let hasValue = false;
    for (let columnIndex = 0; columnIndex <= lastColumn; columnIndex += 1) {
      const value = gridCellToValue(grid.get(cellAddress(rowIndex, columnIndex)));
      if (value !== null) hasValue = true;
      row.push(value);
    }
    if (hasValue) rows.push(row);
  }
  return rows;
};

const parseSheetXml = (xml, sharedStrings) => {
  const grid = new Map();
  for (const rowMatch of xml.matchAll(SHEET_ROW)) {
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(SHEET_CELL)) {
      const attributes = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = attributes.match(CELL_REF);
      if (ref === null) continue;
      const type = attributes.match(CELL_TYPE)?.[1];
      const rawValue = body.match(CELL_VALUE)?.[1];
      const formula = body.match(CELL_FORMULA)?.[1];
      const inlineText = body.match(CELL_INLINE_TEXT)?.[1];
      let cell;
      if (formula !== undefined) {
        cell = rawValue !== undefined && type !== 'e'
          ? { kind: 'value', value: decodeXmlEntities(rawValue) }
          : { kind: 'formula', formula: decodeXmlEntities(formula) };
      } else if (type === 's') {
        const index = rawValue === undefined ? -1 : Number.parseInt(rawValue, 10);
        cell = { kind: 'value', value: sharedStrings[index] ?? '' };
      } else if (type === 'inlineStr') {
        cell = { kind: 'value', value: inlineText === undefined ? '' : decodeXmlEntities(inlineText) };
      } else if (type === 'b') {
        cell = { kind: 'value', value: rawValue === '1' ? 'TRUE' : 'FALSE' };
      } else if (type === 'str' || rawValue !== undefined) {
        cell = { kind: 'value', value: rawValue === undefined ? '' : decodeXmlEntities(rawValue) };
      } else {
        cell = { kind: 'value', value: '' };
      }
      grid.set(`${ref[1]}${ref[2]}`, cell);
    }
  }
  return grid;
};

/** Parse one package into ordered sheet models: names, part paths, sheet
 * XML, value grids, and the occupied bounding box per sheet. */
export const parseWorkbook = (bytes) => {
  const zip = readOfficeZip(bytes);
  const workbookXml = zipPartText(zip, 'xl/workbook.xml');
  if (workbookXml === null) throw new Error('the .xlsx has no xl/workbook.xml part; is this a valid Excel file?');
  const relsXml = zipPartText(zip, 'xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map();
  for (const rel of relsXml.matchAll(RELATIONSHIP)) targets.set(rel[1], rel[2]);
  const sharedStringsXml = zipPartText(zip, 'xl/sharedStrings.xml');
  const sharedStrings = sharedStringsXml === null ? [] : parseSharedStrings(sharedStringsXml);
  const sheets = new Map();
  const names = [];
  for (const sheetMatch of workbookXml.matchAll(WORKBOOK_SHEET)) {
    const name = decodeXmlEntities(sheetMatch[1]);
    const id = sheetMatch[2];
    const target = id === undefined ? undefined : targets.get(id);
    const part = target === undefined
      ? `worksheets/sheet${names.length + 1}.xml`
      : target.replace(/^\//, '').replace(/^xl\//, '');
    const content = zipPartText(zip, `xl/${part}`);
    if (content === null) continue;
    const grid = parseSheetXml(content, sharedStrings);
    const addresses = gridAddresses(grid);
    const last = addresses.at(-1);
    sheets.set(name, { name, part, content, grid, maxRow: last?.row ?? -1, maxColumn: last?.column ?? -1 });
    names.push(name);
  }
  return { names, sheets, zip };
};
