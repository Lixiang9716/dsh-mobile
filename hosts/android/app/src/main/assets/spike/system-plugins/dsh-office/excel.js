// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * The Excel tools: excel_create, excel_read, excel_update — the .xlsx
 * surface. Ported from dsh-office-tools@1.0.4 (MIT, src/tools/excel.ts):
 * the same argument contract (structured sheets, formula strings, A1 cell
 * updates), the same caps, and the same update semantics — the workbook is
 * re-published as the minimal package, so binary-only extensions (charts,
 * embedded media) do not survive excel_update; prefer excel_create for new
 * workbooks and excel_read to verify.
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CELL_VALUE_SCHEMA, ROW_SCHEMA, FILE_RESULT_SCHEMA } from './shared.js';
import { buildOfficeZip } from './zip.js';
import { resolveOfficePath, readOfficeBytes, saveOfficeBytes, assertMayCreate } from './fschannel.js';
import {
  validateSheetSpecs, gridOf, gridAddresses, gridCellOf, sheetXml, xlsxEntries,
  parseWorkbook, parseCellAddress, worksheetRows,
} from './excel-core.js';

const log = createLogger('dsh.office.excel');

const SHEET_SPEC_PARAM = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true, description: 'Worksheet name (unique within this call).' },
      rows: {
        type: 'array',
        required: true,
        items: ROW_SCHEMA,
        description: 'Grid rows; the first row is typically a header row. String cells starting with = are written as formulas.',
      },
    },
  },
  description: 'Sheets to write, in tab order.',
};

const SHEET_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    rowCount: { type: 'integer', required: true },
    colCount: { type: 'integer', required: true },
  },
};

const READ_SHEET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    rows: { type: 'array', required: true, items: ROW_SCHEMA },
    truncated: { type: 'boolean', required: true },
  },
};

const CELL_UPDATE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sheet: { type: 'string', required: true },
    cell: { type: 'string', required: true },
  },
};

const presentCallFor = (verb) => (args) => ({
  card: 'generic',
  title: `${verb} ${args.path}`,
  kind: verb === 'Read' ? 'read' : 'edit',
  locations: [{ path: args.path }],
});

const modelOf = (spec, index, part) => {
  const grid = gridOf(spec.rows);
  const last = gridAddresses(grid).at(-1);
  return {
    name: spec.name,
    part: part ?? `worksheets/sheet${index + 1}.xml`,
    content: sheetXml(grid),
    grid,
    maxRow: last?.row ?? -1,
    maxColumn: last?.column ?? -1,
  };
};

/** Build the create result's models + summaries in one pass (the execute
 * body's loop, level with the tools so the caps stay readable). */
const createModels = (sheets) => {
  const summaries = [];
  const models = sheets.map((spec, index) => {
    summaries.push({
      name: spec.name,
      rowCount: spec.rows.length,
      colCount: spec.rows.length === 0 ? 0 : Math.max(...spec.rows.map((row) => row.length)),
    });
    return modelOf(spec, index);
  });
  return { models, summaries };
};

/** Cap one sheet's grid rows at the read budget: the row walk stops at
 * maxRows or the shared cell budget, reporting truncation either way. */
const capSheetRows = (rawRows, maxRows, budget) => {
  const rows = [];
  let truncated = false;
  for (const rawRow of rawRows) {
    if (budget.exhausted) break;
    budget.totalCells += rawRow.length;
    if (budget.totalCells > 2e5) {
      truncated = true;
      budget.exhausted = true;
      break;
    }
    rows.push(rawRow);
    if (rows.length >= maxRows) {
      truncated = rawRows.length > rows.length;
      break;
    }
  }
  if (rawRows.length > rows.length) truncated = true;
  return { rows, truncated };
};

/** Read the named sheets through the row/cell budget (excel_read's leg). */
const readSheets = (workbook, names, maxRows) => {
  const budget = { totalCells: 0, exhausted: false };
  const sheets = [];
  for (const name of names) {
    const model = workbook.sheets.get(name);
    if (model === undefined) continue;
    const capped = capSheetRows(worksheetRows(model.grid), maxRows, budget);
    sheets.push({ name, rows: capped.rows, truncated: capped.truncated });
  }
  return sheets;
};

/** Whole-sheet replacements: replace or append by name, keeping the
 * original part path of a sheet that already exists. */
const applySheetReplacements = (workbook, sheetSpecs) => {
  const names = [...workbook.names];
  const models = new Map(workbook.sheets);
  const updatedSheets = [];
  for (const spec of sheetSpecs) {
    const existing = models.get(spec.name);
    if (!names.includes(spec.name)) names.push(spec.name);
    models.set(spec.name, modelOf(spec, names.length, existing?.part));
    updatedSheets.push(spec.name);
  }
  return { names, models, updatedSheets };
};

/** Individual cell writes into the (possibly replaced) sheet models. */
const applyCellUpdates = (models, names, updates) => {
  const cellUpdates = [];
  for (const update of updates) {
    const model = models.get(update.sheet);
    if (model === undefined) {
      throw new Error(`sheet "${update.sheet}" not found for cell update; available sheets: ${names.join(', ')}`);
    }
    const { row, column } = parseCellAddress(update.cell);
    if (row < 0 || column < 0 || row >= 1048576) {
      throw new Error(`invalid cell address "${update.cell}"; use A1 notation such as "B2"`);
    }
    model.grid.set(update.cell.toUpperCase(), gridCellOf(update.value));
    model.maxRow = Math.max(model.maxRow, row);
    model.maxColumn = Math.max(model.maxColumn, column);
    model.content = sheetXml(model.grid);
    cellUpdates.push({ sheet: update.sheet, cell: update.cell });
  }
  return cellUpdates;
};

const EXCEL_READ_PARAMS = {
  path: {
    type: 'string', required: true,
    description: 'Path to the .xlsx file, relative to the session workspace or absolute inside it.',
  },
  sheet: {
    type: 'string',
    description: 'Read only this worksheet by exact name. Omit to read every sheet.',
  },
  max_rows: {
    type: 'integer',
    description: 'Maximum rows returned per sheet. Defaults to 5000.',
  },
};

const EXCEL_READ_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', required: true },
      sheets: { type: 'array', required: true, items: READ_SHEET_SCHEMA },
      sizeBytes: { type: 'integer', required: true },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: value.sheets.map((sheet) => `${sheet.name} (${sheet.rows.length} row(s)`
      + `${sheet.truncated ? ', truncated' : ''}):\n` + JSON.stringify(sheet.rows)).join('\n\n'),
  }],
};

const EXCEL_UPDATE_PARAMS = {
  path: {
    type: 'string', required: true,
    description: 'Path to the existing .xlsx file.',
  },
  sheets: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', required: true, description: 'Worksheet to replace; created when absent.' },
        rows: {
          type: 'array',
          required: true,
          items: ROW_SCHEMA,
          description: 'Replacement grid rows.',
        },
      },
    },
    description: 'Whole-sheet replacements (optional).',
  },
  cell_updates: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sheet: { type: 'string', required: true, description: 'Worksheet name.' },
        cell: { type: 'string', required: true, description: 'Cell address in A1 notation, e.g. "B2".' },
        value: {
          ...CELL_VALUE_SCHEMA,
          required: true,
          description: 'Scalar value to write into the cell. A string starting with = is written as a formula.',
        },
      },
    },
    description: 'Individual cell writes (optional).',
  },
};

const EXCEL_UPDATE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...FILE_RESULT_SCHEMA.properties,
      sheetNames: { type: 'array', required: true, items: { type: 'string' } },
      updatedSheets: { type: 'array', required: true, items: { type: 'string' } },
      cellUpdates: { type: 'array', required: true, items: CELL_UPDATE_RESULT_SCHEMA },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: `Updated Excel workbook ${value.path} (${value.sizeBytes} bytes). `
      + `Sheets now: ${value.sheetNames.join(', ')}. `
      + `Replaced/created sheets: ${value.updatedSheets.length === 0 ? '(none)' : value.updatedSheets.join(', ')}. `
      + `Cell writes: ${value.cellUpdates.length}.`,
  }],
};

const registerExcelCreate = () => {
  return defineTool({
    name: 'excel_create',
    description: 'Create a new .xlsx Excel workbook in the session workspace from structured '
      + 'sheets. Each sheet has a name and an array of rows; each row is an array of scalar '
      + 'cells (string, number, boolean, or null). Use excel_update to change an existing '
      + 'workbook without recreating it.',
    parameters: {
      path: {
        type: 'string', required: true,
        description: 'Output path. Relative paths resolve against the session workspace; the extension must be .xlsx.',
      },
      sheets: SHEET_SPEC_PARAM,
      overwrite: {
        type: 'boolean',
        description: 'Replace the file when it already exists. Defaults to false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...FILE_RESULT_SCHEMA.properties,
          sheets: { type: 'array', required: true, items: SHEET_RESULT_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Created Excel workbook ${value.path} (${value.sizeBytes} bytes; `
          + `${value.sheets.length} sheet(s): `
          + `${value.sheets.map((sheet) => `${sheet.name} ${sheet.rowCount}x${sheet.colCount}`).join(', ')}).`,
      }],
    },
    presentCall: presentCallFor('Create'),
    async execute(args) {
      log.debug('excel_create', { path: args.path, sheets: args.sheets?.length });
      const target = await resolveOfficePath(args.path, ['.xlsx'], false);
      await assertMayCreate(target, args.overwrite ?? false);
      validateSheetSpecs(args.sheets);
      const { models, summaries } = createModels(args.sheets);
      const sizeBytes = await saveOfficeBytes(target, buildOfficeZip(xlsxEntries(models)));
      return { path: args.path, sizeBytes, sheets: summaries };
    },
  });
};

const registerExcelRead = () => {
  return defineTool({
    name: 'excel_read',
    description: 'Read one or all sheets of an existing .xlsx workbook and return each sheet '
      + 'as rows of scalar values (formatted strings). Formula cells return their cached value '
      + 'when one exists; formulas without a cached value return the formula as an "=SUM(…)" '
      + 'string. Rows are capped; the per-sheet `truncated` flag reports when more rows were '
      + 'not returned. Pass `sheet` to read a single named sheet.',
    parameters: EXCEL_READ_PARAMS,
    output: EXCEL_READ_OUTPUT,
    presentCall: presentCallFor('Read'),
    async execute(args) {
      log.debug('excel_read', { path: args.path, sheet: args.sheet ?? '(all)' });
      const target = await resolveOfficePath(args.path, ['.xlsx'], true);
      const { bytes, sizeBytes } = await readOfficeBytes(target);
      const workbook = parseWorkbook(bytes);
      if (args.sheet !== undefined && !workbook.names.includes(args.sheet)) {
        throw new Error(`sheet "${args.sheet}" not found; available sheets: ${workbook.names.join(', ')}`);
      }
      const names = args.sheet === undefined ? workbook.names : [args.sheet];
      const maxRows = Math.min(Math.max(args.max_rows ?? 5e3, 1), 1e4);
      const sheets = readSheets(workbook, names, maxRows);
      return { path: args.path, sheets, sizeBytes };
    },
  });
};

const registerExcelUpdate = () => {
  return defineTool({
    name: 'excel_update',
    description: 'Update an existing .xlsx workbook in place: replace or create whole sheets '
      + 'by name (`sheets`) and/or write individual scalar values into cells (`cell_updates`, '
      + 'e.g. "B2"). The workbook is re-published as the minimal package, so binary-only '
      + 'extensions cannot survive; prefer excel_create for new workbooks. Provide at least '
      + 'one sheet or cell update.',
    parameters: EXCEL_UPDATE_PARAMS,
    output: EXCEL_UPDATE_OUTPUT,
    presentCall: presentCallFor('Update'),
    async execute(args) {
      log.debug('excel_update', { path: args.path });
      const target = await resolveOfficePath(args.path, ['.xlsx'], true);
      const sheetSpecs = args.sheets ?? [];
      if (sheetSpecs.length === 0 && (args.cell_updates?.length ?? 0) === 0) {
        throw new Error('excel_update needs at least one entry in sheets or cell_updates');
      }
      if (sheetSpecs.length > 0) validateSheetSpecs(sheetSpecs);
      const { bytes } = await readOfficeBytes(target);
      const workbook = parseWorkbook(bytes);
      const { names, models, updatedSheets } = applySheetReplacements(workbook, sheetSpecs);
      const cellUpdates = applyCellUpdates(models, names, args.cell_updates ?? []);
      const orderedModels = names.map((name) => models.get(name))
        .filter((model) => model !== undefined)
        .map((model, index) => ({ ...model, part: `worksheets/sheet${index + 1}.xml` }));
      const sizeBytes = await saveOfficeBytes(target, buildOfficeZip(xlsxEntries(orderedModels)));
      return { path: args.path, sizeBytes, sheetNames: names, updatedSheets, cellUpdates };
    },
  });
};

export const registerExcelTools = () => {
  log.debug('excel tools registering', {});
  return [registerExcelCreate(), registerExcelRead(), registerExcelUpdate()];
};
