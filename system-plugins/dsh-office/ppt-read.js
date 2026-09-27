// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * The PowerPoint read side: ppt_read (ported from dsh-office-tools@1.0.4,
 * MIT, src/tools/ppt.ts). Per slide, in slide order: paragraphs, tables as
 * rows of cell texts, speaker notes, image count + alt texts, and every
 * shape's bounding box in inches — the layout language ppt_create speaks,
 * so a read deck can be re-authored or re-laid out.
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { decodeXmlEntities, FILE_RESULT_SCHEMA } from './shared.js';
import { readOfficeZip, zipPartText } from './zip.js';
import { resolveOfficePath, readOfficeBytes } from './fschannel.js';
import { roundedInches, sketchSlide, SLIDE_WIDTH_INCHES, SLIDE_HEIGHT_INCHES } from './ppt-write.js';

const log = createLogger('dsh.office.ppt.read');

const paragraphText = (paragraph) => {
  const runs = [];
  for (const match of paragraph.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)) runs.push(match[1] ?? '');
  return decodeXmlEntities(runs.join('').replace(/<a:br\b[^>]*\/>/g, '\n'));
};

const extractParagraphs = (xml, skipFields) => {
  const paragraphs = [];
  for (const match of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const paragraph = match[1] ?? '';
    if (skipFields && /<a:fld\b/.test(paragraph)) continue;
    const text = paragraphText(paragraph);
    if (text.trim() !== '') paragraphs.push(text);
  }
  return paragraphs;
};

const A_TABLE = /<a:tbl\b[\s\S]*?<\/a:tbl>/g;
const A_TABLE_ROW = /<a:tr\b[\s\S]*?<\/a:tr>/g;
const A_TABLE_CELL = /<a:tc\b[\s\S]*?<\/a:tc>/g;
const PICTURE = /<p:pic\b[\s\S]*?<\/p:pic>/g;
const PICTURE_DESCR = /<p:cNvPr\b[^>]*\bdescr="([^"]*)"/;
const SHAPE_WITH_GEOMETRY = /<p:sp\b[\s\S]*?<\/p:sp>|<p:pic\b[\s\S]*?<\/p:pic>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g;
const GEOMETRY = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/;

const extractTables = (slide) => {
  const tables = [];
  for (const tableMatch of slide.matchAll(A_TABLE)) {
    const rows = [...(tableMatch[0] ?? '').matchAll(A_TABLE_ROW)]
      .map((rowMatch) => [...(rowMatch[0] ?? '').matchAll(A_TABLE_CELL)]
        .map((cellMatch) => extractParagraphs(cellMatch[0] ?? '', false).join(' ')));
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
};

const stripTables = (slide) => slide.replace(A_TABLE, '');

const extractImageAlts = (slide) => {
  const alts = [];
  for (const pictureMatch of slide.matchAll(PICTURE)) {
    const descrMatch = (pictureMatch[0] ?? '').match(PICTURE_DESCR);
    const descr = descrMatch === null ? undefined : descrMatch[1];
    if (descr !== undefined && descr.trim() !== '') alts.push(decodeXmlEntities(descr));
  }
  return alts;
};

const extractElements = (slide) => {
  const elements = [];
  for (const match of slide.matchAll(SHAPE_WITH_GEOMETRY)) {
    const block = match[0] ?? '';
    const geometry = block.match(GEOMETRY);
    const base = geometry === null
      ? { xIn: 0, yIn: 0, wIn: 0, hIn: 0 }
      : {
          xIn: roundedInches(Number(geometry[1])),
          yIn: roundedInches(Number(geometry[2])),
          wIn: roundedInches(Number(geometry[3])),
          hIn: roundedInches(Number(geometry[4])),
        };
    if (block.startsWith('<p:pic')) {
      const descr = block.match(PICTURE_DESCR)?.[1];
      elements.push({ type: 'image', ...base, alt: descr === undefined ? undefined : decodeXmlEntities(descr) });
      continue;
    }
    if (block.startsWith('<p:graphicFrame')) {
      const table = extractTables(block)[0];
      elements.push({ type: 'table', ...base, text: table === undefined ? undefined : `${table.length}x${table[0]?.length ?? 0}` });
      continue;
    }
    const text = extractParagraphs(stripTables(block), false).join(' | ');
    elements.push({ type: 'text', ...base, text: text.length > 120 ? `${text.slice(0, 117)}...` : text });
  }
  return elements;
};

const decodeRelationshipTarget = (xml) => {
  const match = xml.match(/Target="([^"]*notesSlides\/notesSlide(\d+)\.xml)"/);
  if (match === null) return undefined;
  return `ppt/notesSlides/notesSlide${match[2]}.xml`;
};

const slideNumber = (name) => {
  const match = name.match(/slide(\d+)\.xml$/);
  return match === null ? 0 : Number.parseInt(match[1], 10);
};

const countSlideImages = (zip, number) => {
  const xml = zipPartText(zip, `ppt/slides/_rels/slide${number}.xml.rels`);
  if (xml === null) return 0;
  return [...xml.matchAll(/Type="[^"]*\/image"/g)].length;
};

const readSlideXml = (zip) => {
  const slideFiles = zip.names
    .filter((name) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  const xmls = slideFiles.map((name) => zipPartText(zip, name) ?? '');
  const presentation = zipPartText(zip, 'ppt/presentation.xml');
  const size = (presentation ?? '').match(/<p:sldSz cx="(\d+)" cy="(\d+)"\/>/);
  const widthInches = size === null ? SLIDE_WIDTH_INCHES : roundedInches(Number(size[1]));
  const heightInches = size === null ? SLIDE_HEIGHT_INCHES : roundedInches(Number(size[2]));
  const notes = xmls.map((_, index) => {
    const number = slideNumber(slideFiles[index]) || index + 1;
    const relationship = zipPartText(zip, `ppt/slides/_rels/slide${number}.xml.rels`);
    let notesName = `ppt/notesSlides/notesSlide${number}.xml`;
    if (relationship !== null) {
      const target = decodeRelationshipTarget(relationship);
      if (target !== undefined) notesName = target;
    }
    const noteFile = zipPartText(zip, notesName);
    if (noteFile === null) return undefined;
    const paragraphs = extractParagraphs(noteFile, true);
    return paragraphs.length === 0 ? undefined : paragraphs.join('\n');
  });
  const imageCounts = xmls.map((_, index) => {
    const number = slideNumber(slideFiles[index]) || index + 1;
    return countSlideImages(zip, number);
  });
  return { xmls, notes, imageCounts, widthInches, heightInches };
};

const ELEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', required: true, description: 'Element kind: text, bullets, image, or table.' },
    xIn: { type: 'number', required: true, description: 'Left edge in inches from the slide origin.' },
    yIn: { type: 'number', required: true, description: 'Top edge in inches from the slide origin.' },
    wIn: { type: 'number', required: true, description: 'Width in inches.' },
    hIn: { type: 'number', required: true, description: 'Height in inches.' },
    text: { type: 'string', description: 'Text content (short); tables report rows x columns.' },
    items: { type: 'array', items: { type: 'string' }, description: 'Bullet items, for bullets boxes this plugin wrote.' },
    alt: { type: 'string', description: 'Image alt text.' },
    sizing: { type: 'string', enum: ['contain', 'cover'], description: 'Fit mode used for the placement.' },
  },
};

export const registerPptRead = () => {
  return defineTool({
    name: 'ppt_read',
    description: 'Extract the content and layout of an existing .pptx presentation. Per slide, '
      + 'in slide order: paragraphs, tables (rows of cell texts), speaker notes, '
      + 'linked/embedded image count, image alt texts — plus an `elements` array giving every '
      + 'shape\'s bounding box in inches (x/y/w/h) and the deck canvas size, with a text '
      + 'wireframe sketch of each slide. Table cell text is reported under `tables`, not '
      + 'duplicated into `paragraphs`. Use it to understand, summarize, or re-layout a deck: '
      + 'the element boxes tell you exactly where everything sits on the canvas.',
    parameters: {
      path: {
        type: 'string', required: true,
        description: 'Path to the .pptx file, relative to the session workspace or absolute inside it.',
      },
      max_chars: {
        type: 'integer',
        description: 'Maximum characters returned across the deck. Defaults to 200000.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...FILE_RESULT_SCHEMA.properties,
          slideCount: { type: 'integer', required: true },
          slideWidthInches: { type: 'number', required: true },
          slideHeightInches: { type: 'number', required: true },
          slides: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                title: { type: 'string' },
                paragraphs: { type: 'array', required: true, items: { type: 'string' } },
                notes: { type: 'array', items: { type: 'string' } },
                tables: {
                  type: 'array',
                  items: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                  description: 'Tables as rows of cell texts; present only when the slide has tables.',
                },
                imageAlts: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Alt text (descr) of the slide\'s pictures in order; present only when at least one is non-empty.',
                },
                imageCount: { type: 'integer', required: true },
                elements: {
                  type: 'array',
                  items: ELEMENT_SCHEMA,
                  description: 'Every placed shape with its bounding box in inches, in z-order.',
                },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Canvas ${value.slideWidthInches}x${value.slideHeightInches} in.\n`
          + value.slides.map((slide) => `Slide ${slide.index}${slide.title !== undefined ? ` — ${slide.title}` : ''} `
            + `(images: ${slide.imageCount}${slide.imageAlts !== undefined ? `; alts: ${slide.imageAlts.join(' | ')}` : ''}):\n`
            + slide.paragraphs.map((paragraph) => `- ${paragraph}`).join('\n')
            + (slide.tables !== undefined ? `\nTables:\n${slide.tables.map((table) => table.map((row) => row.join(' | ')).join('\n')).join('\n\n')}` : '')
            + (slide.notes !== undefined ? `\nNotes: ${slide.notes.join(' | ')}` : '')
            + (slide.elements !== undefined && slide.elements.length > 0
              ? `\n${sketchSlide(value.slideWidthInches, value.slideHeightInches, slide.elements)}` : '')).join('\n\n')
          + (value.truncated ? '\n[text truncated]' : ''),
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Read ${args.path}`,
      kind: 'read',
      locations: [{ path: args.path }],
    }),
    async execute(args) {
      log.debug('ppt_read', { path: args.path });
      const target = await resolveOfficePath(args.path, ['.pptx'], true);
      const { bytes, sizeBytes } = await readOfficeBytes(target);
      const zip = readOfficeZip(bytes);
      const { xmls, notes, imageCounts, widthInches, heightInches } = readSlideXml(zip);
      if (xmls.length === 0) throw new Error('the .pptx contains no slides');
      const maxChars = Math.min(Math.max(args.max_chars ?? 2e5, 1), 2e5);
      const slides = [];
      let totalChars = 0;
      let truncated = false;
      for (let index = 0; index < xmls.length; index += 1) {
        const bounded = readSlideBudget(xmls[index], notes[index], maxChars - totalChars);
        totalChars += bounded.chars;
        if (bounded.truncated) truncated = true;
        const slideXmlText = xmls[index];
        const slide = {
          index: index + 1,
          paragraphs: bounded.paragraphs.filter((paragraph) => paragraph !== ''),
          imageCount: imageCounts[index] ?? 0,
          elements: extractElements(slideXmlText),
        };
        if (bounded.notes !== undefined) slide.notes = bounded.notes;
        if (bounded.tablesFit && bounded.tables.length > 0) slide.tables = bounded.tables;
        if (bounded.tables.length > 0 && !bounded.tablesFit) truncated = true;
        const alts = extractImageAlts(slideXmlText);
        if (alts.length > 0) slide.imageAlts = alts;
        slides.push(slide);
      }
      return {
        path: args.path,
        slideCount: slides.length,
        slideWidthInches: widthInches,
        slideHeightInches: heightInches,
        slides,
        truncated,
        sizeBytes,
      };
    },
  });
};

/** One slide's text through the character budget: bounded paragraphs, the
 * note, and the fit decision for the (uncounted-against-budget-until-fit)
 * tables. Returns the pieces plus the charge against the deck budget. */
const readSlideBudget = (slideXmlText, noteText, remainingChars) => {
  const paragraphs = extractParagraphs(stripTables(slideXmlText), false);
  const noteParagraphs = noteText === undefined || noteText.trim() === '' ? undefined : [noteText];
  let slideChars = 0;
  const bounded = paragraphs.map((paragraph) => {
    if (slideChars >= Math.max(0, remainingChars)) return '';
    const retained = paragraph.slice(0, Math.max(0, remainingChars) - slideChars);
    slideChars += retained.length;
    return retained;
  });
  const noteBounded = noteParagraphs === undefined ? undefined
    : [noteParagraphs[0].slice(0, Math.max(0, remainingChars - slideChars))];
  const tables = extractTables(slideXmlText);
  const bodyChars = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
  const noteChars = noteParagraphs?.[0]?.length ?? 0;
  const tablesChars = tables.reduce((sum, table) => sum + table.reduce((rowSum, row) => rowSum + row.join('').length, 0), 0);
  const charge = slideChars + (noteBounded?.[0]?.length ?? 0);
  const tablesFit = charge + tablesChars <= Math.max(0, remainingChars);
  return {
    paragraphs: bounded,
    notes: noteBounded,
    tables,
    tablesFit,
    chars: charge,
    truncated: bodyChars + noteChars > charge,
  };
};
