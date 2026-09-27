// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * The PowerPoint write side: ppt_create and the deck builders it owns.
 * Ported from dsh-office-tools@1.0.4 (MIT, src/tools/ppt.ts + imgsize.ts).
 *
 * The deck is a complete minimal package — presentation, one slide master,
 * one blank layout, notes master, two theme references, per-slide parts —
 * so PowerPoint/Keynote/WPS open it without repair. Images are LINKED, not
 * embedded (`a:blip r:link` + external-TargetMode relationships): the file
 * stays in the workspace and the deck references it by relative path, which
 * keeps decks small and the workspace the single home of every asset.
 * Layout echoes come back in the tool result (element boxes + a text
 * wireframe sketch) so the model can verify the composition it authored.
 */
import { createLogger } from 'logger.js';
import { fsStat, fsRead } from 'gateway.js';
import { encodeXmlText, encodeXmlAttribute } from './shared.js';
import { resolveOfficePath } from './fschannel.js';

const log = createLogger('dsh.office.ppt');

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif'];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES_PER_SLIDE = 20;
const EMU_PER_INCH = 914400;
const EMU_PER_PIXEL = 9525;
export const SLIDE_WIDTH_INCHES = 40 / 3;
export const SLIDE_HEIGHT_INCHES = 7.5;
const SLIDE_WEMU = Math.round(SLIDE_WIDTH_INCHES * EMU_PER_INCH);
const SLIDE_HEMU = Math.round(SLIDE_HEIGHT_INCHES * EMU_PER_INCH);

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const CT_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/content-types"';

export const roundedInches = (emu) => Math.round(emu / EMU_PER_INCH * 100) / 100;

const relationshipXml = (id, type, target, external) => {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/${type}" Target="${encodeXmlAttribute(target)}"${external ? ' TargetMode="External"' : ''}/>`;
};

const shapeTree = (children) => {
  return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${children}</p:spTree>`;
};

const textBoxPart = (id, x, y, w, h, fontSizePt, paragraphs, bold, centered) => {
  const runs = paragraphs.map((paragraph) => `<a:p>${centered ? '<a:pPr algn="ctr"/>' : ''}<a:r><a:rPr lang="en-US" sz="${fontSizePt * 100}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:rPr><a:t xml:space="preserve">${encodeXmlText(paragraph)}</a:t></a:r></a:p>`).join('');
  const xml = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x * EMU_PER_INCH)}" y="${Math.round(y * EMU_PER_INCH)}"/><a:ext cx="${Math.round(w * EMU_PER_INCH)}" cy="${Math.round(h * EMU_PER_INCH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${runs}</p:txBody></p:sp>`;
  const text = paragraphs.join(' | ');
  const box = {
    type: 'text',
    xIn: Math.round(x * 100) / 100,
    yIn: Math.round(y * 100) / 100,
    wIn: Math.round(w * 100) / 100,
    hIn: Math.round(h * 100) / 100,
    text: text.length > 120 ? `${text.slice(0, 117)}...` : text,
  };
  return { xml, box };
};

const bulletBoxPart = (id, x, y, w, h, items) => {
  const paragraphs = items.map((item) => `<a:p><a:pPr marL="228600" indent="-228600"><a:lnSpc><a:spcPct val="120000"/></a:lnSpc><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="${encodeXmlAttribute('•')}"/></a:pPr><a:r><a:rPr lang="en-US" sz="1800" dirty="0"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:rPr><a:t xml:space="preserve">${encodeXmlText(item)}</a:t></a:r></a:p>`).join('');
  const xml = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Bullets ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x * EMU_PER_INCH)}" y="${Math.round(y * EMU_PER_INCH)}"/><a:ext cx="${Math.round(w * EMU_PER_INCH)}" cy="${Math.round(h * EMU_PER_INCH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
  const box = {
    type: 'bullets',
    xIn: Math.round(x * 100) / 100,
    yIn: Math.round(y * 100) / 100,
    wIn: Math.round(w * 100) / 100,
    hIn: Math.round(h * 100) / 100,
    items,
  };
  return { xml, box };
};

const linkedPicturePart = (id, image, relId) => {
  const crop = image.crop === undefined ? '' : `<a:srcRect l="${image.crop.l}" t="${image.crop.t}" r="${image.crop.r}" b="${image.crop.b}"/>`;
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${encodeXmlAttribute(image.alt ?? '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="${relId}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(image.xIn * EMU_PER_INCH)}" y="${Math.round(image.yIn * EMU_PER_INCH)}"/><a:ext cx="${Math.round(image.wIn * EMU_PER_INCH)}" cy="${Math.round(image.hIn * EMU_PER_INCH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
};

const slideXml = (shapes) => {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${A_NS} ${R_NS} ${P_NS}><p:cSld>${shapeTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
};

const notesSlideXml = (notes) => {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${A_NS} ${R_NS} ${P_NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="5029200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t xml:space="preserve">${encodeXmlText(notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
};

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme ${A_NS} name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const SLIDE_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${A_NS} ${R_NS} ${P_NS}><p:cSld name="Office">${shapeTree('')}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const SLIDE_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${A_NS} ${R_NS} ${P_NS} type="blank" preserve="1"><p:cSld name="Blank">${shapeTree('')}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const NOTES_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notesMaster ${A_NS} ${R_NS} ${P_NS}><p:cSld name="Notes">${shapeTree('')}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>`;

const contentTypesXml = (slideCount, notesNumbers) => {
  const slides = Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  const notes = notesNumbers.map((number) => `<Override PartName="/ppt/notesSlides/notesSlide${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types ${CT_NS}><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides}${notes}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
};

const presentationXml = (slideCount) => {
  const slideIds = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('');
  const notesRid = slideCount + 2;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${A_NS} ${R_NS} ${P_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId id="2147483649" r:id="rId${notesRid}"/></p:notesMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${SLIDE_WEMU}" cy="${SLIDE_HEMU}"/><p:notesSz cx="${SLIDE_HEMU}" cy="9144000"/></p:presentation>`;
};

const presentationRelsXml = (slideCount) => {
  const slides = Array.from({ length: slideCount }, (_, index) => relationshipXml(`rId${index + 2}`, 'officeDocument/2006/relationships/slide', `slides/slide${index + 1}.xml`, false)).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>`
    + relationshipXml('rId1', 'officeDocument/2006/relationships/slideMaster', 'slideMasters/slideMaster1.xml', false)
    + slides
    + relationshipXml(`rId${slideCount + 2}`, 'officeDocument/2006/relationships/notesMaster', 'notesMasters/notesMaster1.xml', false)
    + '</Relationships>';
};

const corePropsXml = (title) => {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${encodeXmlText(title ?? 'Presentation')}</dc:title></cp:coreProperties>`;
};

const APP_PROPS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>dsh-office</Application><PresentationFormat>Widescreen</PresentationFormat></Properties>';

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>`
  + relationshipXml('rId1', 'officeDocument/2006/relationships/officeDocument', 'ppt/presentation.xml', false)
  + relationshipXml('rId2', 'package/2006/relationships/metadata/core-properties', 'docProps/core.xml', false)
  + relationshipXml('rId3', 'officeDocument/2006/relationships/extended-properties', 'docProps/app.xml', false)
  + '</Relationships>';

const MASTER_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>`
  + relationshipXml('rId1', 'officeDocument/2006/relationships/slideLayout', '../slideLayouts/slideLayout1.xml', false)
  + relationshipXml('rId2', 'officeDocument/2006/relationships/theme', '../theme/theme1.xml', false)
  + '</Relationships>';

const LAYOUT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>`
  + relationshipXml('rId1', 'officeDocument/2006/relationships/slideMaster', '../slideMasters/slideMaster1.xml', false)
  + '</Relationships>';

const NOTES_MASTER_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>`
  + relationshipXml('rId1', 'officeDocument/2006/relationships/theme', '../theme/theme2.xml', false)
  + '</Relationships>';

const slideRelsXml = (index, imageTargets, hasNotes) => {
  const images = imageTargets.map((target, offset) => relationshipXml(`rImg${offset + 1}`, 'officeDocument/2006/relationships/image', target, true)).join('');
  const notes = hasNotes ? relationshipXml('rNotes', 'officeDocument/2006/relationships/notesSlide', `../notesSlides/notesSlide${index}.xml`, false) : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>`
    + relationshipXml('rId1', 'officeDocument/2006/relationships/slideLayout', '../slideLayouts/slideLayout1.xml', false)
    + images + notes + '</Relationships>';
};

const notesRelsXml = (index) => {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>`
    + relationshipXml('rId1', 'officeDocument/2006/relationships/slide', `../slides/slide${index}.xml`, false)
    + relationshipXml('rId2', 'officeDocument/2006/relationships/notesMaster', '../notesMasters/notesMaster1.xml', false)
    + '</Relationships>';
};

export const validateSlideSpecs = (slides) => {
  if (slides.length === 0) throw new Error('slides must contain at least one slide');
  if (slides.length > 200) throw new Error('too many slides (maximum 200)');
  for (const [slideIndex, slide] of slides.entries()) {
    const hasContent = (slide.title?.trim().length ?? 0) > 0 || (slide.paragraphs?.length ?? 0) > 0
      || (slide.bullets?.length ?? 0) > 0 || (slide.images?.length ?? 0) > 0;
    if (!hasContent) throw new Error(`slide ${slideIndex + 1} is empty; give it a title, paragraphs, bullets, or images`);
    if ((slide.paragraphs?.length ?? 0) + (slide.bullets?.length ?? 0) > 500) {
      throw new Error(`slide ${slideIndex + 1} has too many text blocks (maximum 500)`);
    }
    const images = slide.images ?? [];
    if (images.length > MAX_IMAGES_PER_SLIDE) {
      throw new Error(`slide ${slideIndex + 1} has too many images (maximum ${MAX_IMAGES_PER_SLIDE})`);
    }
    for (const [imageIndex, image] of images.entries()) {
      for (const key of ['x', 'y', 'w', 'h']) {
        const value = image[key];
        if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 100)) {
          throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} ${key} must be a positive number of inches (0-100)`);
        }
      }
      if (image.sizing !== undefined && (image.w === undefined || image.h === undefined)) {
        throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} uses sizing; provide both w and h`);
      }
    }
  }
};

/** Relative path from the deck's directory to the image (the external
 * link target PowerPoint resolves when the deck stays beside its asset). */
export const imageLinkTarget = (deckPath, imagePath) => {
  const deck = deckPath.replace(/\\/g, '/').split('/').filter(Boolean).slice(0, -1);
  const image = imagePath.replace(/\\/g, '/').split('/').filter(Boolean);
  let common = 0;
  while (common < deck.length && common < image.length - 1 && deck[common] === image[common]) common += 1;
  const relative = [...Array.from({ length: deck.length - common }, () => '..'), ...image.slice(common)].join('/');
  return relative.startsWith('../') || relative === '' ? imagePath : relative;
};

const pngSize = (bytes) => {
  if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return undefined;
  const width = (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0;
  const height = (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0;
  return width > 0 && height > 0 ? { width, height } : undefined;
};

const jpegSize = (bytes) => {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return undefined;
  let cursor = 2;
  while (cursor + 9 < bytes.length) {
    if (bytes[cursor] !== 255) return undefined;
    const marker = bytes[cursor + 1];
    if (marker === 216 || (marker >= 208 && marker <= 217)) {
      cursor += 2;
      continue;
    }
    const length = bytes[cursor + 2] << 8 | bytes[cursor + 3];
    const isStartOfFrame = (marker >= 192 && marker <= 195) || (marker >= 197 && marker <= 199)
      || (marker >= 201 && marker <= 203) || (marker >= 205 && marker <= 207);
    if (isStartOfFrame) {
      const height = bytes[cursor + 5] << 8 | bytes[cursor + 6];
      const width = bytes[cursor + 7] << 8 | bytes[cursor + 8];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (marker === 218) return undefined;
    cursor += 2 + length;
  }
  return undefined;
};

const gifSize = (bytes) => {
  if (bytes.length < 10 || bytes[0] !== 71 || bytes[1] !== 73 || bytes[2] !== 70) return undefined;
  const width = bytes[6] | bytes[7] << 8;
  const height = bytes[8] | bytes[9] << 8;
  return width > 0 && height > 0 ? { width, height } : undefined;
};

const sniffImageSize = (bytes) => pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes);

/** Resolve, size, and place one image spec: intrinsic size sniffed from the
 * file head (PNG/JPEG/GIF), aspect-preserving scaling, contain/cover crop. */
const placeImage = async (deckPath, image, slideIndex, imageIndex) => {
  log.debug('place image', { slideIndex, imageIndex, path: image.path });
  const resolved = await resolveOfficePath(image.path, IMAGE_EXTENSIONS, true);
  const info = await fsStat(resolved.scope, resolved.path);
  if ((info.size ?? 0) > MAX_IMAGE_BYTES) {
    throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} "${image.path}" is ${info.size} bytes; maximum linked image size is ${MAX_IMAGE_BYTES} bytes`);
  }
  const head = await fsRead(resolved.scope, resolved.path);
  const intrinsic = sniffImageSize(head.bytes.subarray(0, Math.min(head.bytes.byteLength, 1024)));
  const target = imageLinkTarget(deckPath, resolved.path);
  const naturalW = intrinsic === undefined ? undefined : intrinsic.width * EMU_PER_PIXEL / EMU_PER_INCH;
  const naturalH = intrinsic === undefined ? undefined : intrinsic.height * EMU_PER_PIXEL / EMU_PER_INCH;
  let w = image.w;
  let h = image.h;
  if ((w === undefined || h === undefined) && naturalW !== undefined && naturalH !== undefined) {
    if (w === undefined && h === undefined) {
      w = naturalW;
      h = naturalH;
    } else if (w === undefined) {
      w = (h ?? naturalH) / naturalH * naturalW;
    } else {
      h = w / naturalW * naturalH;
    }
  }
  if (w === undefined || h === undefined) {
    throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} "${image.path}" is not a recognizable PNG/JPEG/GIF (no intrinsic size); provide explicit w and h in inches`);
  }
  if (w <= 0 || h <= 0) {
    throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} resolves to a non-positive size`);
  }
  const placed = {
    type: 'image',
    xIn: 0,
    yIn: 0,
    wIn: Math.round(w * 100) / 100,
    hIn: Math.round(h * 100) / 100,
    alt: image.alt ?? image.path,
    target,
    sizing: image.sizing,
    pixelWidth: intrinsic?.width,
    pixelHeight: intrinsic?.height,
  };
  if (image.sizing === 'contain' || image.sizing === 'cover') {
    const boxAspect = w / h;
    const imageAspect = naturalW !== undefined && naturalH !== undefined && naturalH !== 0 ? naturalW / naturalH : boxAspect;
    if (image.sizing === 'contain') {
      placed.wIn = Math.round(Math.min(w, h * imageAspect) * 100) / 100;
      placed.hIn = Math.round(Math.min(h, w / imageAspect) * 100) / 100;
    } else if (imageAspect > boxAspect && imageAspect > 0) {
      const visible = Math.round(boxAspect / imageAspect * 1e5 / 2);
      placed.crop = { l: visible, t: 0, r: visible, b: 0 };
    } else if (imageAspect > 0) {
      const visible = Math.round(imageAspect / boxAspect * 1e5 / 2);
      placed.crop = { l: 0, t: visible, r: 0, b: visible };
    }
  }
  return placed;
};

/** One slide's shape XML + the layout echo (every placed box, in inches).
 * Shape ids share one counter across the whole slide, z-order = add order. */
const slideParts = (build) => {
  const { spec, first } = build;
  const shapes = [];
  const elements = [];
  let id = 2;
  const hasTitle = spec.title !== undefined && spec.title.trim() !== '';
  if (first && hasTitle) {
    const part = textBoxPart(id++, 0.9, 1.2, 11.53, 1.2, 32, [spec.title], true, true);
    shapes.push(part.xml);
    elements.push(part.box);
  } else if (hasTitle) {
    const part = textBoxPart(id++, 0.9, 0.35, 11.53, 0.9, 26, [spec.title], true, false);
    shapes.push(part.xml);
    elements.push(part.box);
  }
  const top = first && hasTitle ? 2.7 : hasTitle ? 1.5 : 0.8;
  let y = top;
  if ((spec.paragraphs?.length ?? 0) > 0) {
    for (const paragraph of spec.paragraphs) {
      if (y > 6.4) break;
      const part = textBoxPart(id++, 0.9, y, 11.53, 0.7, 18, [paragraph], false, false);
      shapes.push(part.xml);
      elements.push(part.box);
      y += 0.8;
    }
    y += 0.2;
  }
  if ((spec.bullets?.length ?? 0) > 0) {
    const height = Math.min(4.5, Math.max(1, spec.bullets.length * 0.6));
    const part = bulletBoxPart(id++, 0.9, y, 11.53, height, spec.bullets);
    shapes.push(part.xml);
    elements.push(part.box);
  }
  placePlacedImages(build, shapes, elements, y, () => id++);
  return { xml: shapes.join(''), elements };
};

const placePlacedImages = (build, shapes, elements, y, nextId) => {
  const images = build.images;
  if (images.length === 0) return;
  const explicitAt = (index) => {
    const explicit = build.spec.images?.[index];
    return explicit !== undefined && (explicit.x !== undefined || explicit.y !== undefined);
  };
  const automaticCount = images.filter((_, index) => !explicitAt(index)).length;
  const automaticHeight = Math.max(0.6, Math.min(3.2, (6.6 - Math.min(y, 6.4)) / Math.max(1, automaticCount)));
  let imageY = Math.min(y + 0.25, 6.5);
  images.forEach((image, imageIndex) => {
    const explicit = build.spec.images?.[imageIndex];
    if (explicitAt(imageIndex)) {
      image.xIn = explicit?.x ?? 0;
      image.yIn = explicit?.y ?? 0;
    } else {
      image.xIn = 0.9;
      image.yIn = Math.round(imageY * 100) / 100;
      if (explicit?.w === undefined && explicit?.h === undefined) {
        image.wIn = Math.round(11.53 * 100) / 100;
        image.hIn = Math.round(automaticHeight * 100) / 100;
      }
      imageY += image.hIn + 0.15;
    }
    shapes.push(linkedPicturePart(nextId(), image, `rImg${imageIndex + 1}`));
    const { target: _t, pixelWidth: _w, pixelHeight: _h, crop: _c, ...box } = image;
    elements.push({ ...box, sizing: image.sizing ?? (explicit?.sizing ?? 'contain') });
  });
};

/** The deck package: standard parts + per-slide/notes parts + layout echo. */
export const buildPptx = async (args, deckPath) => {
  const builds = [];
  if (args.title !== undefined && args.title.trim() !== '') {
    builds.push({ spec: { title: args.title }, first: true, images: [] });
  }
  let first = args.title === undefined || args.title.trim() === '';
  for (const spec of args.slides ?? []) {
    builds.push({ spec, first, images: [] });
    first = false;
  }
  for (const [slideIndex, build] of builds.entries()) {
    const images = build.spec.images ?? [];
    for (const [imageIndex, image] of images.entries()) {
      build.images.push(await placeImage(deckPath, image, slideIndex, imageIndex));
    }
  }
  const notesNumbers = builds
    .map((build, index) => build.spec.notes !== undefined && build.spec.notes.trim() !== '' ? index + 1 : 0)
    .filter((number) => number > 0);
  const layout = [];
  const entries = [
    { name: '[Content_Types].xml', text: contentTypesXml(builds.length, notesNumbers) },
    { name: '_rels/.rels', text: ROOT_RELS_XML },
    { name: 'ppt/presentation.xml', text: presentationXml(builds.length) },
    { name: 'ppt/_rels/presentation.xml.rels', text: presentationRelsXml(builds.length) },
    { name: 'ppt/slideMasters/slideMaster1.xml', text: SLIDE_MASTER_XML },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', text: MASTER_RELS_XML },
    { name: 'ppt/slideLayouts/slideLayout1.xml', text: SLIDE_LAYOUT_XML },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', text: LAYOUT_RELS_XML },
    { name: 'ppt/notesMasters/notesMaster1.xml', text: NOTES_MASTER_XML },
    { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', text: NOTES_MASTER_RELS_XML },
    { name: 'ppt/theme/theme1.xml', text: THEME_XML },
    { name: 'ppt/theme/theme2.xml', text: THEME_XML },
    { name: 'docProps/core.xml', text: corePropsXml(args.title) },
    { name: 'docProps/app.xml', text: APP_PROPS_XML },
  ];
  builds.forEach((build, index) => {
    const number = index + 1;
    const { xml, elements } = slideParts(build);
    layout.push({ index: number, elements });
    const hasNotes = build.spec.notes !== undefined && build.spec.notes.trim() !== '';
    entries.push({ name: `ppt/slides/slide${number}.xml`, text: slideXml(xml) });
    entries.push({
      name: `ppt/slides/_rels/slide${number}.xml.rels`,
      text: slideRelsXml(number, build.images.map((image) => image.target), hasNotes),
    });
    if (hasNotes) {
      entries.push({ name: `ppt/notesSlides/notesSlide${number}.xml`, text: notesSlideXml(build.spec.notes) });
      entries.push({ name: `ppt/notesSlides/_rels/notesSlide${number}.xml.rels`, text: notesRelsXml(number) });
    }
  });
  return { entries, layout };
};

/** The text wireframe sketch (64x18 grid) shared by ppt_create and ppt_read
 * renders: every element becomes a labeled box on the slide canvas. */
export const sketchSlide = (widthIn, heightIn, elements) => {
  const columns = 64;
  const rows = 18;
  const grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '));
  const scaleX = columns / widthIn;
  const scaleY = rows / heightIn;
  const drawRect = (x, y, w, h, label) => {
    const left = Math.max(1, Math.min(columns - 2, Math.round(x * scaleX)));
    const right = Math.max(left + 1, Math.min(columns - 2, Math.round((x + w) * scaleX)));
    const topRow = Math.max(1, Math.min(rows - 2, Math.round(y * scaleY)));
    const bottom = Math.max(topRow + 1, Math.min(rows - 2, Math.round((y + h) * scaleY)));
    for (let column = left; column <= right; column += 1) {
      grid[topRow][column] = '-';
      grid[bottom][column] = '-';
    }
    for (let row = topRow; row <= bottom; row += 1) {
      grid[row][left] = '|';
      grid[row][right] = '|';
    }
    grid[topRow][left] = '+';
    grid[topRow][right] = '+';
    grid[bottom][left] = '+';
    grid[bottom][right] = '+';
    const inner = right - left - 1;
    if (inner > 2 && bottom - topRow >= 2) {
      const text = label.slice(0, Math.min(label.length, inner));
      for (let offset = 0; offset < text.length; offset += 1) {
        grid[topRow + 1][left + 1 + Math.floor((inner - text.length) / 2) + offset] = text[offset];
      }
    }
  };
  for (const element of elements) {
    const label = element.type === 'image' ? 'IMG' : (element.text ?? element.type).split(/\s+/)[0]?.slice(0, 10) || element.type;
    drawRect(element.xIn, element.yIn, element.wIn, element.hIn, label);
  }
  const border = ['+' + '-'.repeat(columns) + '+'];
  for (const row of grid) border.push('|' + row.join('') + '|');
  border.push('+' + '-'.repeat(columns) + '+');
  return border.join('\n');
};
