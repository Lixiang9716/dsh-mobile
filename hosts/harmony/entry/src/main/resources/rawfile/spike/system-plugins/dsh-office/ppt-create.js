// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * The ppt_create tool (ported from dsh-office-tools@1.0.4, MIT,
 * src/tools/ppt.ts): author a widescreen deck from structured slides —
 * title slide, paragraphs, bullets, speaker notes, linked PNG/JPG/GIF
 * images — and echo every element's landing position plus a text wireframe
 * so the model can verify the composition it authored.
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FILE_RESULT_SCHEMA } from './shared.js';
import { buildOfficeZip } from './zip.js';
import { resolveOfficePath, saveOfficeBytes, assertMayCreate } from './fschannel.js';
import {
  buildPptx, sketchSlide, validateSlideSpecs, SLIDE_WIDTH_INCHES, SLIDE_HEIGHT_INCHES,
} from './ppt-write.js';

const log = createLogger('dsh.office.ppt.create');

const IMAGE_PARAM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'string', required: true,
      description: 'Image file inside the session workspace: .png, .jpg, .jpeg, or .gif. '
        + 'The deck links to it, so keep the file in place.',
    },
    x: { type: 'number', description: 'Left position in inches on the 13.33x7.5 slide. Omit for automatic placement below the text.' },
    y: { type: 'number', description: 'Top position in inches. Omit for automatic placement.' },
    w: { type: 'number', description: 'Display width in inches. Omit to use the intrinsic size (PNG/JPG/GIF headers are sniffed).' },
    h: { type: 'number', description: 'Display height in inches. Omit to use the intrinsic size; a single dimension scales by aspect.' },
    sizing: {
      type: 'string',
      enum: ['contain', 'cover'],
      description: 'Fit mode inside the w x h box: contain fits whole (default), cover fills and crops. Requires w and h.',
    },
    alt: { type: 'string', description: 'Alt text; defaults to the image path.' },
  },
};

export const registerPptCreate = () => {
  return defineTool({
    name: 'ppt_create',
    description: 'Create a PowerPoint .pptx presentation in the session workspace (16:9 '
      + 'widescreen, 13.33 x 7.5 in). Optionally start with a title slide, then add slides '
      + 'with a title, body paragraphs, bullet points, speaker notes, and linked PNG/JPG/GIF '
      + 'images. Images are linked, not embedded: give x/y/w/h in inches for explicit '
      + 'placement (sizing: contain fits inside the box, cover fills it and crops), or omit '
      + 'them for automatic placement below the text at natural size. The result echoes every '
      + 'element\'s landing position (inches) and a text wireframe sketch of each slide, so '
      + 'you can verify the composition you authored.',
    parameters: {
      path: {
        type: 'string', required: true,
        description: 'Output path. Relative paths resolve against the session workspace; the extension must be .pptx.',
      },
      title: {
        type: 'string',
        description: 'Deck title. When provided, a title slide is inserted before the explicit slides.',
      },
      slides: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Slide title.' },
            paragraphs: {
              type: 'array', items: { type: 'string' },
              description: 'Body paragraphs rendered as plain text boxes.',
            },
            bullets: {
              type: 'array', items: { type: 'string' },
              description: 'Bullet list items rendered after the paragraphs.',
            },
            notes: { type: 'string', description: 'Speaker notes for this slide.' },
            images: {
              type: 'array', items: IMAGE_PARAM,
              description: 'Images linked on this slide, drawn after the text content.',
            },
          },
        },
        description: 'Slides in presentation order. Optional when a title is provided.',
      },
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
          title: { type: 'string' },
          slideCount: { type: 'integer', required: true },
          slideWidthInches: { type: 'number', required: true, description: 'Canvas width (13.33 in widescreen).' },
          slideHeightInches: { type: 'number', required: true, description: 'Canvas height (7.5 in widescreen).' },
          slides: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                elements: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      type: { type: 'string', required: true },
                      xIn: { type: 'number', required: true },
                      yIn: { type: 'number', required: true },
                      wIn: { type: 'number', required: true },
                      hIn: { type: 'number', required: true },
                      text: { type: 'string' },
                      items: { type: 'array', items: { type: 'string' } },
                      alt: { type: 'string' },
                      sizing: { type: 'string', enum: ['contain', 'cover'] },
                    },
                  },
                },
              },
            },
            description: 'Per-slide element layout echo: where every text box, bullet list, '
              + 'and linked image landed, in inches.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Created PowerPoint ${value.path} (${value.sizeBytes} bytes; ${value.slideCount} slide(s), `
          + `canvas ${value.slideWidthInches}x${value.slideHeightInches} in).\n`
          + value.slides.map((slide) => `Slide ${slide.index} layout:\n`
            + `${sketchSlide(value.slideWidthInches, value.slideHeightInches, slide.elements)}`).join('\n\n'),
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Create ${args.path}`,
      kind: 'edit',
      locations: [{ path: args.path }],
    }),
    async execute(args) {
      log.debug('ppt_create', { path: args.path, slides: args.slides?.length ?? 0 });
      const target = await resolveOfficePath(args.path, ['.pptx'], false);
      await assertMayCreate(target, args.overwrite ?? false);
      if ((args.slides?.length ?? 0) > 0) validateSlideSpecs(args.slides);
      if (args.title === undefined && (args.slides?.length ?? 0) === 0) {
        throw new Error('ppt_create needs a title or at least one slide');
      }
      const { entries, layout } = await buildPptx(args, target.path);
      const sizeBytes = await saveOfficeBytes(target, buildOfficeZip(entries));
      const result = {
        path: args.path,
        sizeBytes,
        slideCount: layout.length,
        slideWidthInches: Math.round(SLIDE_WIDTH_INCHES * 100) / 100,
        slideHeightInches: SLIDE_HEIGHT_INCHES,
        slides: layout,
      };
      if (args.title !== undefined && args.title.trim() !== '') result.title = args.title;
      return result;
    },
  });
};
