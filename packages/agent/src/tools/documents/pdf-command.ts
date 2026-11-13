import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import fontkit, { type Font } from '@pdf-lib/fontkit';
import {
  degrees,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  type PDFFont,
  PDFOptionList,
  PDFTextField,
} from 'pdf-lib';
import { documentTemporaryRoot, exportDocument, readBoundedDocument } from './document-export';
import { verifyOfficeRuntimeAssets } from './office-runtime';

// The locked variable TTF needs a concrete instance before subsetting: fontkit
// 1.1.0 otherwise truncates odd glyph offsets when choosing short loca entries.
// Instancing re-encodes aligned outlines; our pinned package patch also flushes
// the encoder's final repeated flag. Text extraction cannot detect either fault.
// getVariation is a supported fontkit API omitted from its bundled declarations.
const pdfFontkit = {
  create(bytes: Uint8Array) {
    const face = fontkit.create(bytes) as Font & {
      getVariation(settings: { wght: number }): Font;
    };
    return face.getVariation({ wght: 400 });
  },
};

const fail = (code = 'pdf_input_invalid'): never => {
  throw Error(code);
};
const number = (value: unknown, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fail();
const array = (value: unknown, max: number): unknown[] =>
  Array.isArray(value) && value.length <= max ? value : fail();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const text = (value: unknown): string =>
  typeof value === 'string' && value.length <= 200000 ? value : fail();
async function bytes(path: unknown, max = 256 * 1024 * 1024) {
  if (typeof path !== 'string') return fail();
  return readBoundedDocument(path, max);
}
function lines(value: string, font: PDFFont, size: number, width: number) {
  const result: string[] = [];
  const characters = new Set(font.getCharacterSet());
  for (const paragraph of value.split('\n')) {
    let line = '';
    for (const char of paragraph) {
      if (!characters.has(char.codePointAt(0)!)) fail('pdf_glyph_unsupported');
      if (font.widthOfTextAtSize(char, size) > width) fail('layout_overflow');
      if (line && font.widthOfTextAtSize(line + char, size) > width) {
        result.push(line);
        line = '';
      }
      line += char;
    }
    result.push(line);
  }
  return result;
}
async function image(document: PDFDocument, block: Record<string, unknown>) {
  const content = await bytes(block.path, 16 * 1024 * 1024);
  if (content.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
    return document.embedPng(content);
  if (content[0] === 255 && content[1] === 216) return document.embedJpg(content);
  return fail('pdf_image_unsupported');
}
export async function createPdfDocument(input: {
  spec: unknown;
  out: string;
  signal?: AbortSignal;
}) {
  if (
    !input.spec ||
    typeof input.spec !== 'object' ||
    Array.isArray(input.spec) ||
    extname(input.out).toLowerCase() !== '.pdf'
  )
    fail();
  const spec = input.spec as Record<string, unknown>,
    signal = input.signal ?? new AbortController().signal;
  const assets = await verifyOfficeRuntimeAssets();
  let document = await PDFDocument.create();
  if (spec.operation === 'edit')
    document = await PDFDocument.load(await bytes(spec.source), { updateMetadata: false });
  document.registerFontkit(pdfFontkit);
  let embedded: PDFFont | undefined;
  const font = async () =>
    (embedded ??= await document.embedFont(await readFile(assets.font), { subset: true }));
  if (spec.operation === 'create') {
    const pages = array(spec.pages, 200);
    if (!pages.length) fail();
    for (const pageValue of pages) {
      const pageSpec = record(pageValue);
      signal.throwIfAborted();
      const page = document.addPage([595.28, 841.89]);
      let y = 793.89;
      for (const blockValue of array(pageSpec.blocks, 1000)) {
        const block = record(blockValue);
        if (block.type === 'text' || block.type === 'title') {
          const size = block.type === 'title' ? 22 : 11,
            leading = size * 1.5,
            face = await font();
          for (const line of lines(text(block.text), face, size, 499.28)) {
            if (y - leading < 48) fail('layout_overflow');
            y -= leading;
            page.drawText(line, { x: 48, y, size, font: face });
          }
          y -= 8;
        } else if (block.type === 'image') {
          const width = number(block.width, 1, 499.28),
            height = number(block.height, 1, 745.89);
          if (y - height < 48) fail('layout_overflow');
          y -= height;
          page.drawImage(await image(document, block), { x: 48, y, width, height });
          y -= 8;
        } else fail('pdf_block_unsupported');
      }
    }
  } else if (spec.operation === 'merge') {
    const sources = array(spec.sources, 64);
    if (!sources.length) fail();
    for (const source of sources) {
      signal.throwIfAborted();
      const incoming = await PDFDocument.load(await bytes(source));
      if (document.getPageCount() + incoming.getPageCount() > 1000) fail('pdf_page_limit');
      for (const page of await document.copyPages(incoming, incoming.getPageIndices()))
        document.addPage(page);
    }
  } else if (spec.operation === 'edit') {
    if (spec.pages !== undefined) {
      const selection = array(spec.pages, 1000);
      if (!selection.length) fail();
      const indices = selection.map((value) => {
        const index = number(value, 0, document.getPageCount() - 1);
        if (!Number.isInteger(index)) fail();
        return index;
      });
      if (spec.fields) fail('pdf_page_selection_with_forms_unsupported');
      const selected = await PDFDocument.create();
      for (const page of await selected.copyPages(document, indices)) selected.addPage(page);
      document = selected;
      document.registerFontkit(pdfFontkit);
    }
    const pageAt = (value: unknown) => {
      const index = number(value, 0, document.getPageCount() - 1);
      if (!Number.isInteger(index)) fail();
      return document.getPage(index);
    };
    for (const rotationValue of array(spec.rotations ?? [], 1000)) {
      const rotation = record(rotationValue);
      const angle = number(rotation.degrees, -360, 360);
      if (angle % 90 !== 0) fail();
      pageAt(rotation.page).setRotation(degrees(angle));
    }
    for (const overlayValue of array(spec.overlays ?? [], 1000)) {
      const overlay = record(overlayValue);
      signal.throwIfAborted();
      const page = pageAt(overlay.page),
        x = number(overlay.x, 0, page.getWidth()),
        y = number(overlay.y, 0, page.getHeight());
      if (overlay.path !== undefined) {
        const width = number(overlay.width, 1, page.getWidth() - x),
          height = number(overlay.height, 1, page.getHeight() - y);
        page.drawImage(await image(document, overlay), { x, y, width, height });
      } else {
        const size = number(overlay.size ?? 11, 1, 100),
          face = await font(),
          value = text(overlay.text);
        if (
          value.includes('\n') ||
          y + size > page.getHeight() ||
          x + face.widthOfTextAtSize(value, size) > page.getWidth()
        )
          fail('layout_overflow');
        page.drawText(value, { x, y, size, font: face });
      }
    }
    if (spec.fields !== undefined) {
      if (
        !spec.fields ||
        typeof spec.fields !== 'object' ||
        Array.isArray(spec.fields) ||
        Object.keys(spec.fields).length > 500
      )
        fail();
      const form = document.getForm();
      for (const [name, value] of Object.entries(record(spec.fields))) {
        const field = form.getField(name);
        if (field instanceof PDFTextField) field.setText(text(value));
        else if (field instanceof PDFCheckBox && typeof value === 'boolean') {
          if (value) field.check();
          else field.uncheck();
        } else if (field instanceof PDFDropdown || field instanceof PDFOptionList)
          field.select(text(value));
        else fail('pdf_field_unsupported');
      }
      form.updateFieldAppearances(await font());
    }
  } else fail('pdf_operation_unsupported');
  signal.throwIfAborted();
  const output = await document.save({ updateFieldAppearances: false });
  if (output.length > 256 * 1024 * 1024) fail('pdf_output_limit');
  const directory = await mkdtemp(join(documentTemporaryRoot(), 'kite-pdf-'));
  try {
    const draft = join(directory, 'output.pdf');
    await writeFile(draft, output, { mode: 0o600 });
    signal.throwIfAborted();
    await exportDocument(draft, input.out, signal, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { success: true, name: basename(input.out), pages: document.getPageCount(), warnings: [] };
}
