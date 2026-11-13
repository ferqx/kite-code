import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { createOfficeDocument } from '../src/tools/documents/office-command';
import { renderOfficePreview } from '../src/tools/documents/office-preview';
import { runOfficeCLI, verifyOfficeRuntimeAssets } from '../src/tools/documents/office-runtime';
import { readPdf } from '../src/tools/documents/pdf';
import { createPdfDocument } from '../src/tools/documents/pdf-command';

const root = await mkdtemp(join(tmpdir(), 'kite-office-smoke-'));
const signal = AbortSignal.timeout(120000);
const run = (args: readonly string[], signal: AbortSignal) => runOfficeCLI({ args, signal });
const check = (value: unknown, message: string) => {
  if (!value) throw Error(message);
};
type GlyphBox = { text: string; page: number; x: number; y: number; width: number; height: number };
async function checkVisibleGlyphs(path: string, boxes: GlyphBox[]) {
  const bytes = new Uint8Array(await readFile(path));
  for (const number of new Set(boxes.map((box) => box.page))) {
    const rendered = await readPdf(bytes, { pages: String(number + 1), mode: 'image' }, signal);
    const { data, info } = await sharp(rendered.pages[0]!.image)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // The production PDF worker renders these A4 pages at 1.5x. Each box holds
    // exactly one glyph on white, so text extraction or adjacent glyphs cannot
    // make a blank glyph pass this check.
    for (const box of boxes.filter((box) => box.page === number)) {
      let ink = 0;
      const left = Math.floor(box.x * 1.5),
        right = Math.ceil((box.x + box.width) * 1.5),
        top = Math.floor((841.89 - box.y - box.height) * 1.5),
        bottom = Math.ceil((841.89 - box.y) * 1.5);
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * info.width + x) * info.channels;
          if (data[offset + 3]! > 127 && data[offset]! < 230) ink++;
        }
      }
      check(ink > 2, `pdf_blank_glyph:${box.text}:page_${number + 1}`);
    }
  }
}
try {
  const assets = await verifyOfficeRuntimeAssets();
  const operations: Record<string, unknown[]> = {
    docx: [
      {
        command: 'add',
        parent: '/body',
        type: 'paragraph',
        props: { text: '中文办公文档 / Office report' },
      },
    ],
    xlsx: [
      { command: 'set', path: '/Sheet1/A1', props: { value: '2' } },
      { command: 'set', path: '/Sheet1/A2', props: { value: '3' } },
      { command: 'set', path: '/Sheet1/A3', props: { formula: 'SUM(A1:A2)' } },
    ],
    pptx: [
      { command: 'add', parent: '/', type: 'slide' },
      {
        command: 'add',
        parent: '/slide[1]',
        type: 'shape',
        props: { text: '中文演示', x: '1cm', y: '1cm', width: '15cm', height: '3cm' },
      },
    ],
  };
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const out = join(root, `sample.${format}`);
    const result = await createOfficeDocument({
      format,
      out,
      operations: operations[format],
      signal,
    });
    const preview = await renderOfficePreview({
      sourcePath: out,
      outputDirectory: join(root, format),
      signal,
      run,
    });
    check(
      preview.files.some((file) => file.path === 'katex/katex.min.js'),
      'missing_katex',
    );
    const html = await readFile(join(root, format, 'index.html'), 'utf8');
    check(!html.includes('https://cdn.jsdelivr.net/npm/katex@'), 'online_katex_remaining');
    console.log(JSON.stringify({ format, ...result, previewFiles: preview.files.length }));
  }
  let rejectedFormula = false;
  try {
    await createOfficeDocument({
      format: 'xlsx',
      out: join(root, 'bad-formula.xlsx'),
      operations: [{ command: 'set', path: '/Sheet1/A1', props: { formula: 'MissingSheet!A1' } }],
      signal,
    });
  } catch (error) {
    rejectedFormula = String(error).includes('office_formula_invalid:formula_ref_missing_sheet');
  }
  check(rejectedFormula, 'missing_sheet_formula_was_not_rejected');
  const imagePath = join(root, 'pixel.png');
  await writeFile(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const pdf = join(root, 'chinese.pdf');
  await createPdfDocument({
    out: pdf,
    spec: {
      operation: 'create',
      pages: [
        {
          blocks: [
            { type: 'title', text: '中文报告' },
            { type: 'text', text: '中文与 English 字体、实际字宽换行。' },
            { type: 'image', path: imagePath, width: 20, height: 20 },
          ],
        },
        { blocks: [{ type: 'text', text: '第二页' }] },
      ],
    },
    signal,
  });
  const merged = join(root, 'merged.pdf');
  await createPdfDocument({
    out: merged,
    spec: { operation: 'merge', sources: [pdf, pdf] },
    signal,
  });
  check((await PDFDocument.load(await readFile(merged))).getPageCount() === 4, 'merge_failed');
  const edited = join(root, 'edited.pdf');
  await createPdfDocument({
    out: edited,
    spec: {
      operation: 'edit',
      source: merged,
      pages: [3, 0],
      rotations: [{ page: 0, degrees: 90 }],
      overlays: [
        { page: 1, text: '修订', x: 50, y: 50 },
        { page: 0, path: imagePath, x: 50, y: 50, width: 20, height: 20 },
      ],
    },
    signal,
  });
  const doc = await PDFDocument.load(await readFile(edited));
  check(doc.getPageCount() === 2 && doc.getPage(0).getRotation().angle === 90, 'edit_failed');
  let overflow = false;
  try {
    await createPdfDocument({
      out: join(root, 'overflow.pdf'),
      spec: {
        operation: 'create',
        pages: [{ blocks: [{ type: 'text', text: '长文'.repeat(20000) }] }],
      },
      signal,
    });
  } catch (error) {
    overflow = String(error).includes('layout_overflow');
  }
  check(overflow, 'overflow_not_rejected');
  // Existing form fields: text, checkbox, choice and unsupported-field rejection share one adapter.
  const formDoc = await PDFDocument.create();
  formDoc.addPage();
  const form = formDoc.getForm();
  form.createTextField('name');
  form.createCheckBox('ok');
  const dropdown = form.createDropdown('choice');
  dropdown.addOptions(['甲', '乙']);
  const formSource = join(root, 'form.pdf');
  await writeFile(formSource, await formDoc.save());
  const formOut = join(root, 'filled.pdf');
  await createPdfDocument({
    out: formOut,
    spec: {
      operation: 'edit',
      source: formSource,
      fields: { name: '中文', ok: true, choice: '乙' },
    },
    signal,
  });
  check(
    (await PDFDocument.load(await readFile(formOut))).getForm().getTextField('name').getText() ===
      '中文',
    'form_failed',
  );
  // NotoSansSC's default variable-face subset previously extracted every
  // character while leaving most glyphs blank. Assert actual raster ink for
  // every isolated glyph through creation, reordered-page overlays and forms.
  const glyphs = [
    ...new Set(
      '中文报告第二页编辑修订日期财务摘要项目进展预算决策字体实际字宽换行，。：、！？（）《》ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    ),
  ];
  const glyphPages = Array.from({ length: Math.ceil(glyphs.length / 40) }, (_, page) => ({
    blocks: [{ type: 'text', text: glyphs.slice(page * 40, (page + 1) * 40).join('\n') }],
  }));
  const glyphPdf = join(root, 'glyphs.pdf');
  await createPdfDocument({
    out: glyphPdf,
    spec: { operation: 'create', pages: glyphPages },
    signal,
  });
  await checkVisibleGlyphs(
    glyphPdf,
    glyphs.map((text, index) => ({
      text,
      page: Math.floor(index / 40),
      x: 46,
      y: 793.89 - 16.5 * ((index % 40) + 1) - 3,
      width: 24,
      height: 15,
    })),
  );
  check((await readFile(glyphPdf)).length < 100000, 'pdf_font_was_not_subset');
  const cells = glyphs.map((text, index) => ({
    text,
    page: 0,
    x: 48 + (index % 12) * 40,
    y: 750 - Math.floor(index / 12) * 40,
    width: 30,
    height: 30,
  }));
  const blank = await PDFDocument.create();
  blank.addPage([595.28, 841.89]);
  const blankPath = join(root, 'glyph-blank.pdf');
  await writeFile(blankPath, await blank.save());
  const overlayPath = join(root, 'glyph-overlays.pdf');
  await createPdfDocument({
    out: overlayPath,
    signal,
    spec: {
      operation: 'edit',
      source: blankPath,
      pages: [0],
      overlays: cells.map((cell) => ({
        page: cell.page,
        text: cell.text,
        x: cell.x + 3,
        y: cell.y + 6,
        size: 16,
      })),
    },
  });
  await checkVisibleGlyphs(overlayPath, cells);
  const visibleForm = blank.getForm();
  for (const [index, cell] of cells.entries()) {
    const field = visibleForm.createTextField(`glyph${index}`);
    field.addToPage(blank.getPage(0), {
      x: cell.x,
      y: cell.y,
      width: cell.width,
      height: cell.height,
      borderWidth: 0,
    });
    field.setFontSize(16);
  }
  const visibleFormPath = join(root, 'glyph-form.pdf');
  await writeFile(visibleFormPath, await blank.save());
  const filledFormPath = join(root, 'glyph-form-filled.pdf');
  await createPdfDocument({
    out: filledFormPath,
    signal,
    spec: {
      operation: 'edit',
      source: visibleFormPath,
      fields: Object.fromEntries(glyphs.map((glyph, index) => [`glyph${index}`, glyph])),
    },
  });
  await checkVisibleGlyphs(filledFormPath, cells);
  console.log(
    JSON.stringify({
      pdf: 'create/merge/reorder/delete/rotate/overlay/forms/overflow passed',
      renderedGlyphs: { count: glyphs.length, create: true, overlays: true, forms: true },
      assets: assets.root,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
