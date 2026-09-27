// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * The Word tools: word_create, word_read, word_update — the .docx surface.
 *
 * Ported from dsh-office-tools@1.0.4 (MIT, src/tools/word.ts +
 * word-update.ts): the same minimal-but-valid OOXML part set (document,
 * styles with Title/ListParagraph/TableGrid, hybridMultilevel bullet
 * numbering, docProps), the same regex-based reader (styles → markdown
 * headings, numPr → bullets, tables → markdown tables), and the same
 * argument contract. One deliberate delta: word_update re-publishes through
 * the BYTES channel, so binary parts (embedded images/fonts) survive where
 * the desktop plugin's text channel had to refuse them.
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { encodeXmlText, encodeXmlAttribute, decodeXmlEntities, FILE_RESULT_SCHEMA } from './shared.js';
import { readOfficeZip, zipPartText, buildOfficeZip } from './zip.js';
import { resolveOfficePath, readOfficeBytes, saveOfficeBytes, assertMayCreate } from './fschannel.js';

const log = createLogger('dsh.office.word');

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const paragraphXml = (text, prelude) => {
  if (text === '' && prelude === '') return '<w:p/>';
  const run = text === '' ? '' : `<w:r><w:t xml:space="preserve">${encodeXmlText(text)}</w:t></w:r>`;
  return `<w:p>${prelude}${run}</w:p>`;
};

const BULLET_PRELUDE = '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>';
const TITLE_PRELUDE = '<w:pPr><w:pStyle w:val="Title"/></w:pPr>';

const cellXml = (text, bold, widthPercent) => {
  const run = text === '' ? '' : `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${encodeXmlText(text)}</w:t></w:r>`;
  return `<w:tc><w:tcPr><w:tcW w:w="${widthPercent * 50}" w:type="pct"/></w:tcPr><w:p>${run}</w:p></w:tc>`;
};

const tableXml = (table) => {
  const columns = Math.max(1, table.headers.length);
  const width = Math.max(1, Math.floor(100 / columns));
  const headerRow = `<w:tr>${table.headers.map((header) => cellXml(header, true, width)).join('')}</w:tr>`;
  const bodyRows = table.rows.map((row) => `<w:tr>${Array.from({ length: columns }, (_, index) => cellXml(row[index] ?? '', false, width)).join('')}</w:tr>`);
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${headerRow}${bodyRows.join('')}</w:tbl>`;
};

const documentBodyChildren = (args) => {
  const children = [];
  if (args.title !== undefined && args.title.trim() !== '') {
    children.push(paragraphXml(args.title, TITLE_PRELUDE));
  }
  for (const text of args.paragraphs ?? []) children.push(paragraphXml(text, ''));
  for (const item of args.bullets ?? []) children.push(paragraphXml(item, BULLET_PRELUDE));
  if (args.table !== undefined) children.push(tableXml(args.table));
  return children.join('');
};

const SECT_PR = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
const documentXml = (bodyChildren) => {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS} ${R_NS}><w:body>${bodyChildren}${SECT_PR}</w:body></w:document>`;
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="300"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>`;

const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>`
  + Array.from({ length: 3 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${encodeXmlAttribute('•')}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="${360}"/></w:pPr></w:lvl>`).join('')
  + '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';

const ROOT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';

const DOCUMENT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>';

const corePropsXml = (title) => {
  const escaped = title === undefined ? '' : encodeXmlText(title);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escaped}</dc:title></cp:coreProperties>`;
};

const APP_PROPS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>dsh-office</Application></Properties>';

const buildDocxBytes = (args) => {
  return buildOfficeZip([
    { name: '[Content_Types].xml', text: CONTENT_TYPES_XML },
    { name: '_rels/.rels', text: ROOT_RELS_XML },
    { name: 'word/document.xml', text: documentXml(documentBodyChildren(args)) },
    { name: 'word/styles.xml', text: STYLES_XML },
    { name: 'word/numbering.xml', text: NUMBERING_XML },
    { name: 'word/_rels/document.xml.rels', text: DOCUMENT_RELS_XML },
    { name: 'docProps/core.xml', text: corePropsXml(args.title) },
    { name: 'docProps/app.xml', text: APP_PROPS_XML },
  ]);
};

const wordCreateCounts = (args) => {
  const tableCells = args.table === undefined ? 0
    : (args.table.headers.length + args.table.rows.length) * Math.max(1, args.table.headers.length);
  return {
    paragraphs: (args.title === undefined ? 0 : 1) + (args.paragraphs?.length ?? 0)
      + (args.bullets?.length ?? 0) + (args.table === undefined ? 0 : 1 + args.table.rows.length),
    cells: tableCells,
  };
};

const W_RUN_PART = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:t\b[^>]*\/>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>|<w:noBreakHyphen\b[^>]*\/?>|<w:softHyphen\b[^>]*\/?>/g;
const W_PARAGRAPH = /<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;

const paragraphBodyText = (bodyXml) => {
  const parts = [];
  for (const match of bodyXml.matchAll(W_RUN_PART)) {
    if (match[1] !== undefined) parts.push(decodeXmlEntities(match[1]));
    else if (match[0].startsWith('<w:tab')) parts.push('\t');
    else if (match[0].startsWith('<w:noBreakHyphen')) parts.push('‑');
    else if (match[0].startsWith('<w:softHyphen')) parts.push('­');
  }
  return parts.join('');
};

const extractDocxText = (document) => {
  return [...document.matchAll(W_PARAGRAPH)]
    .map((match) => (match[1] === undefined ? '' : paragraphBodyText(match[1])) + '\n\n')
    .join('');
};

const W_BLOCK = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
const W_HEADING_LEVELS = { Title: 1, Heading1: 1, Heading2: 2, Heading3: 3, Heading4: 4, Heading5: 5, Heading6: 6 };
const W_P_STYLE = /<w:pStyle w:val="([^"]*)"/;
const W_NUM_PR = /<w:numPr>/;
const W_ILVL = /<w:ilvl w:val="(\d+)"/;
const W_TABLE_ROW = /<w:tr\b[\s\S]*?<\/w:tr>/g;
const W_TABLE_CELL = /<w:tc\b[\s\S]*?<\/w:tc>/g;

const markdownParagraph = (paragraph) => {
  const styleMatch = paragraph.match(W_P_STYLE);
  const styleId = styleMatch === null ? undefined : styleMatch[1];
  const body = paragraphBodyText(paragraph);
  if (styleId !== undefined && W_HEADING_LEVELS[styleId] !== undefined) {
    return `${'#'.repeat(W_HEADING_LEVELS[styleId])} ${body}`;
  }
  if (W_NUM_PR.test(paragraph)) {
    const levelMatch = paragraph.match(W_ILVL);
    const level = levelMatch === null ? 0 : Number.parseInt(levelMatch[1], 10);
    return `${'  '.repeat(Math.min(level, 8))}- ${body}`;
  }
  return body;
};

const markdownCellText = (cell) => {
  return [...cell.matchAll(W_PARAGRAPH)]
    .map((match) => paragraphBodyText(match[1] ?? '').trim())
    .filter((text) => text !== '')
    .join(' ');
};

const markdownTable = (table) => {
  const rows = [...table.matchAll(W_TABLE_ROW)]
    .map((rowMatch) => [...(rowMatch[0] ?? '').matchAll(W_TABLE_CELL)]
      .map((cellMatch) => markdownCellText(cellMatch[0] ?? '').replace(/\|/g, '\\|')));
  const columns = rows.reduce((width, row) => Math.max(width, row.length), 0);
  if (columns === 0) return '';
  const line = (cells) => `| ${[...cells, ...Array.from({ length: columns - cells.length }, () => '')].join(' | ')} |`;
  return [line(rows[0] ?? []), `| ${Array.from({ length: columns }, () => '---').join(' | ')}`, ...rows.slice(1).map(line)].join('\n');
};

const extractDocxMarkdown = (document) => {
  const blocks = [];
  for (const match of document.matchAll(W_BLOCK)) {
    const block = match[0] ?? '';
    if (block.startsWith('<w:tbl')) blocks.push(markdownTable(block));
    else blocks.push(markdownParagraph(match[1] ?? ''));
  }
  return blocks.join('\n\n');
};

const DOCUMENT_BODY = /<w:body>([\s\S]*)<\/w:body>/g;
const TRAILING_SECT_PR = /<w:sectPr[\s\S]*<\/w:sectPr>\s*$/;

/** The append fragment: everything buildDocx would put in a body, minus
 * the trailing sectPr (the target document keeps its own). */
const buildAppendFragment = (args) => {
  const document = documentXml(documentBodyChildren(args));
  const body = [...document.matchAll(DOCUMENT_BODY)][0]?.[1];
  if (body === undefined) throw new Error('internal error: the append document has no body');
  return body.replace(TRAILING_SECT_PR, '');
};

const appendBeforeSectPr = (document, addition) => {
  const sectStart = document.lastIndexOf('<w:sectPr');
  const closeStart = sectStart !== -1 ? -1 : document.lastIndexOf('</w:body>');
  const splitAt = sectStart !== -1 ? sectStart : closeStart;
  if (splitAt === -1) throw new Error('word/document.xml has no </w:body>; refusing to modify it');
  return document.slice(0, splitAt) + addition + document.slice(splitAt);
};

const demandDocumentPart = (zip) => {
  const document = zipPartText(zip, 'word/document.xml');
  if (document === null) {
    throw new Error('the .docx has no word/document.xml part; is this a valid Word file?');
  }
  return document;
};

const WORD_TABLE_PARAM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headers: {
      type: 'array', items: { type: 'string' }, required: true,
      description: 'Table column headers (bold).',
    },
    rows: {
      type: 'array', items: { type: 'array', items: { type: 'string' } }, required: true,
      description: 'Table body rows; each row should match the header column count.',
    },
  },
  description: 'One optional table appended after the text content.',
};

const presentCallFor = (verb) => (args) => ({
  card: 'generic',
  title: `${verb} ${args.path}`,
  kind: verb === 'Read' ? 'read' : 'edit',
  locations: [{ path: args.path }],
});

const registerWordCreate = () => {
  return defineTool({
    name: 'word_create',
    description: 'Create a Microsoft Word .docx document inside the session workspace from '
      + 'structured content. Supply paragraphs as plain text, optional bullet points, and one '
      + 'optional table (headers + string rows). Pass overwrite: true to replace an existing '
      + 'file. Use word_read afterwards to verify the extracted text.',
    parameters: {
      path: {
        type: 'string', required: true,
        description: 'Output path. Relative paths resolve against the session workspace; the extension must be .docx.',
      },
      title: { type: 'string', description: 'Document title rendered as the title heading. Optional.' },
      paragraphs: {
        type: 'array', items: { type: 'string' },
        description: 'Body paragraphs in document order. Empty strings create blank paragraphs. Optional.',
      },
      bullets: {
        type: 'array', items: { type: 'string' },
        description: 'Bullet list items rendered after the paragraphs. Optional.',
      },
      table: WORD_TABLE_PARAM,
      overwrite: {
        type: 'boolean',
        description: 'Replace the file when it already exists. Defaults to false (existing files are refused).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...FILE_RESULT_SCHEMA.properties,
          title: { type: 'string' },
          paragraphCount: { type: 'integer', required: true },
          bulletCount: { type: 'integer', required: true },
          tableRows: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Created Word document ${value.path} (${value.sizeBytes} bytes; `
          + `${value.paragraphCount} paragraphs, ${value.bulletCount} bullets, ${value.tableRows} table body rows).`,
      }],
    },
    presentCall: presentCallFor('Create'),
    async execute(args) {
      log.debug('word_create', { path: args.path });
      const target = await resolveOfficePath(args.path, ['.docx'], false);
      await assertMayCreate(target, args.overwrite ?? false);
      const { paragraphs: paragraphCount, cells } = wordCreateCounts(args);
      if (paragraphCount > 1e4) throw new Error('too many paragraphs/bullets/table rows (maximum 10000)');
      if (cells > 2e5) throw new Error('too many table cells (maximum 200000)');
      if (args.title === undefined && (args.paragraphs?.length ?? 0) === 0
          && (args.bullets?.length ?? 0) === 0 && args.table === undefined) {
        throw new Error('word_create needs at least one of title, paragraphs, bullets, or table');
      }
      const sizeBytes = await saveOfficeBytes(target, buildDocxBytes(args));
      const result = {
        path: args.path,
        sizeBytes,
        paragraphCount: (args.title === undefined || args.title.trim() === '' ? 0 : 1)
          + (args.paragraphs?.length ?? 0),
        bulletCount: args.bullets?.length ?? 0,
        tableRows: args.table?.rows.length ?? 0,
      };
      if (args.title !== undefined && args.title.trim() !== '') result.title = args.title;
      return result;
    },
  });
};

const registerWordRead = () => {
  return defineTool({
    name: 'word_read',
    description: 'Extract text from an existing .docx Word document in the session workspace. '
      + 'Default plain-text mode returns the document text up to the character limit with a '
      + 'truncated flag. Pass format: "markdown" for structured markdown instead: '
      + 'Title/Heading1-6 become # .. ###### headings, bullet/numbered paragraphs become "- " '
      + 'items (indented by level), and tables become markdown tables.',
    parameters: {
      path: {
        type: 'string', required: true,
        description: 'Path to the .docx file, relative to the session workspace or absolute inside it.',
      },
      max_chars: {
        type: 'integer',
        description: 'Maximum characters to return. Defaults to 200000.',
      },
      format: {
        type: 'string',
        enum: ['text', 'markdown'],
        description: 'Output mode: plain text (default) or structured markdown.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
          totalChars: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          sizeBytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.text + (value.truncated ? `\n[text truncated; total ${value.totalChars} characters]` : ''),
      }],
    },
    presentCall: presentCallFor('Read'),
    async execute(args) {
      log.debug('word_read', { path: args.path, format: args.format ?? 'text' });
      const target = await resolveOfficePath(args.path, ['.docx'], true);
      const { bytes, sizeBytes } = await readOfficeBytes(target);
      const document = demandDocumentPart(readOfficeZip(bytes));
      const fullText = args.format === 'markdown' ? extractDocxMarkdown(document) : extractDocxText(document);
      const totalChars = fullText.length;
      const maxChars = Math.min(Math.max(args.max_chars ?? 2e5, 1), 2e5);
      const truncated = totalChars > maxChars;
      return { path: args.path, text: truncated ? fullText.slice(0, maxChars) : fullText, totalChars, truncated, sizeBytes };
    },
  });
};

const registerWordUpdate = () => {
  return defineTool({
    name: 'word_update',
    description: 'Append content to an existing .docx Word document in the session workspace: '
      + 'paragraphs, bullet points, and/or one table are added at the end of the body (in that '
      + 'order), leaving everything already in the file untouched. Bullets reuse the list '
      + 'numbering the document already defines, so they render as bullets in files that have '
      + 'them (files created by word_create always do); documents without list numbering show '
      + 'appended bullets as plain paragraphs. Use word_read afterwards to verify.',
    parameters: {
      path: {
        type: 'string', required: true,
        description: 'Path to the existing .docx file, relative to the session workspace or absolute inside it.',
      },
      paragraphs: {
        type: 'array', items: { type: 'string' },
        description: 'Paragraphs to append in document order. Optional.',
      },
      bullets: {
        type: 'array', items: { type: 'string' },
        description: 'Bullet list items appended after the paragraphs. Optional.',
      },
      table: WORD_TABLE_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...FILE_RESULT_SCHEMA.properties,
          appendedParagraphs: { type: 'integer', required: true },
          appendedBullets: { type: 'integer', required: true },
          appendedTableRows: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Appended to Word document ${value.path} (${value.sizeBytes} bytes; `
          + `${value.appendedParagraphs} paragraph(s), ${value.appendedBullets} bullet(s), `
          + `${value.appendedTableRows} table body row(s) appended).`,
      }],
    },
    presentCall: presentCallFor('Update'),
    async execute(args) {
      log.debug('word_update', { path: args.path });
      const target = await resolveOfficePath(args.path, ['.docx'], true);
      const { paragraphs: paragraphCount, cells } = wordCreateCounts(args);
      if ((args.paragraphs?.length ?? 0) === 0 && (args.bullets?.length ?? 0) === 0 && args.table === undefined) {
        throw new Error('word_update needs at least one of paragraphs, bullets, or table');
      }
      if (paragraphCount > 1e4) throw new Error('too many paragraphs/bullets/table rows (maximum 10000)');
      if (cells > 2e5) throw new Error('too many table cells (maximum 200000)');
      const { bytes } = await readOfficeBytes(target);
      const zip = readOfficeZip(bytes);
      const fragment = buildAppendFragment(args);
      const updated = appendBeforeSectPr(demandDocumentPart(zip), fragment);
      const entries = zip.names.map((name) => name === 'word/document.xml'
        ? { name, text: updated }
        : { name, bytes: zip.parts[name] });
      const sizeBytes = await saveOfficeBytes(target, buildOfficeZip(entries));
      return {
        path: args.path,
        sizeBytes,
        appendedParagraphs: args.paragraphs?.length ?? 0,
        appendedBullets: args.bullets?.length ?? 0,
        appendedTableRows: args.table?.rows.length ?? 0,
      };
    },
  });
};

export const registerWordTools = () => {
  log.debug('word tools registering', {});
  return [registerWordCreate(), registerWordRead(), registerWordUpdate()];
};
