import { expect, test } from 'bun:test';
import {
  createPdfTextLayer,
  pdfTextLimits,
  validPdfTextLayer,
} from '../../../src/tools/documents/pdf-text-layer';

const item = {
  str: 'Hello 中文',
  transform: [12, 0, 0, 12, 30, 60],
  width: 60,
  height: 12,
  fontName: 'f',
  dir: 'ltr',
  hasEOL: true,
};
const styles = { f: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } };
const viewport = { width: 300, height: 200, scale: 1, transform: [1, 0, 0, -1, 0, 200] };
test('PDF preview preserves real text and transforms into the rendered viewport including crop and rotation', () => {
  const layer = createPdfTextLayer({ items: [item], styles }, viewport);
  expect(layer.status).toBe('available');
  expect(layer.items[0]?.text).toBe('Hello 中文');
  expect(layer.items[0]?.transform).toEqual([12, 0, 0, -12, 30, 140]);
  const rotated = createPdfTextLayer(
    { items: [item], styles },
    { ...viewport, width: 200, height: 300, transform: [0, 1, 1, 0, -10, -20] },
  );
  expect(rotated.items[0]?.transform).toEqual([0, 12, 12, 0, 50, 10]);
  const scaled = createPdfTextLayer(
    { items: [item], styles },
    { ...viewport, scale: 1.5, transform: [1.5, 0, 0, -1.5, 0, 300] },
  );
  expect(scaled.items[0]?.width).toBe(90);
  expect(scaled.items[0]?.transform).toEqual([18, 0, 0, -18, 45, 210]);
});
test('PDF preview preserves extraction order, RTL and vertical facts without inventing reading order or OCR', () => {
  const layer = createPdfTextLayer(
    {
      items: [
        item,
        { ...item, str: 'שלום', dir: 'rtl' },
        { ...item, str: '縦書き', dir: 'ttb', fontName: 'v' },
      ],
      styles: { ...styles, v: { ...styles.f, vertical: true } },
    },
    viewport,
  );
  expect(layer.items.map((i) => i.text)).toEqual(['Hello 中文', 'שלום', '縦書き']);
  expect(layer.items[1]?.dir).toBe('rtl');
  expect(layer.items[2]?.vertical).toBe(true);
  expect(createPdfTextLayer({ items: [], styles: {} }, viewport)).toEqual({
    status: 'empty',
    width: 300,
    height: 200,
    items: [],
  });
});
test('PDF preview fails text layer closed rather than publishing partial or executable data', () => {
  const unsafe = createPdfTextLayer(
    { items: [item], styles: { f: { ...styles.f, fontFamily: 'url(https://evil.invalid)' } } },
    viewport,
  );
  expect(unsafe.items[0]?.fontFamily).toBe('sans-serif');
  for (const items of [
    Array(pdfTextLimits.items + 1).fill(item),
    [{ ...item, str: 'x'.repeat(pdfTextLimits.itemLength + 1) }],
    [item, { ...item, transform: [1, 0, 0, 1, NaN, 0] }],
    Array(100).fill({ ...item, str: '中'.repeat(10000) }),
  ]) {
    expect(createPdfTextLayer({ items, styles }, viewport)).toEqual({
      status: 'unavailable',
      width: 300,
      height: 200,
      items: [],
    });
  }
  const good = createPdfTextLayer({ items: [item], styles }, viewport);
  expect(validPdfTextLayer(good)).toBe(true);
  for (const bad of [
    { ...good, status: 'empty' },
    { ...good, width: Infinity },
    { ...good, items: [{ ...good.items[0], fontFamily: 'url(x)' }] },
    { ...good, items: [{ ...good.items[0], transform: [1, 2] }] },
  ])
    expect(validPdfTextLayer(bad)).toBe(false);
});

test('real PDF worker returns bounded Chinese and column geometry beside identical PNG and caches it separately', async () => {
  const { readPdf, readCachedPdf } = await import('../../../src/tools/documents/pdf');
  const { chinesePagedPdf, columnsAndTablePdf } = await import('../../../../../tests/fixtures/pdf');
  const { temporaryDirectory } = await import('../../../../../tests/fixtures/test-filesystem');
  const { createHash } = await import('node:crypto');
  const { rmSync } = await import('node:fs');
  const signal = new AbortController().signal;
  const bytes = chinesePagedPdf();
  const bare = await readPdf(bytes, { mode: 'image', pages: '1-2' }, signal);
  const rich = await readPdf(bytes, { mode: 'image', pages: '1-2', textLayer: true }, signal);
  expect(bare.pages[0]?.textLayer).toBeUndefined();
  expect(rich.pages[0]?.image).toEqual(bare.pages[0]?.image);
  expect(rich.pages[0]?.textLayer?.status).toBe('available');
  expect(rich.pages[0]?.textLayer?.items.map((i) => i.text).join('')).toContain('中文');
  expect(rich.pages[1]?.textLayer).toEqual({
    status: 'empty',
    width: 1024,
    height: 2048,
    items: [],
  });
  const columns = await readPdf(columnsAndTablePdf(), { mode: 'image', textLayer: true }, signal);
  const layer = columns.pages[0]!.textLayer!;
  expect(validPdfTextLayer(layer)).toBe(true);
  const left = layer.items.find((i) => i.text.includes('LEFT 1'))!;
  const right = layer.items.find((i) => i.text.includes('RIGHT 1'))!;
  expect(left.transform[4]).toBeLessThan(right.transform[4]);
  expect(left.transform[5]).toBe(right.transform[5]);
  const profilePath = temporaryDirectory('kite-pdf-text-layer-cache-');
  try {
    const scope = {
      profilePath,
      storeId: 'text-layer-test',
      sourceHash: createHash('sha256').update(bytes).digest('hex'),
    };
    const first = await readCachedPdf(bytes, { mode: 'image', textLayer: true }, scope, signal);
    expect(
      (await readCachedPdf(bytes, { mode: 'image', textLayer: true }, scope, signal)).pages[0]
        ?.textLayer,
    ).toEqual(first.pages[0]?.textLayer);
    expect(
      (await readCachedPdf(bytes, { mode: 'image' }, scope, signal)).pages[0]?.textLayer,
    ).toBeUndefined();
  } finally {
    rmSync(profilePath, { recursive: true, force: true });
  }
}, 60000);
