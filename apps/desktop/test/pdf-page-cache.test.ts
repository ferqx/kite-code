import { expect, test } from 'bun:test';
import { createPdfPageCache } from '../electron/pdf-page-cache';

const bytes = Buffer.from('89504e470d0a1a0a01020304', 'hex');
const page = { data: bytes.toString('base64'), totalPages: 3 };
test('thumbnail, main image and repeated page requests render and charge once per owner', async () => {
  let calls = 0;
  const owner = new AbortController();
  const load = createPdfPageCache(
    page,
    async () => {
      calls++;
      return page;
    },
    owner.signal,
    () => {},
    { page: 12, total: 36 },
  );
  const a = load(2),
    b = load(2);
  expect(a).toBe(b);
  expect(await a).toEqual(bytes);
  for (let i = 0; i < 100; i++) expect(await load(2)).toBe(await a);
  expect(calls).toBe(1);
  expect(await load(1)).toEqual(bytes);
  expect(await load(3)).toEqual(bytes);
  expect(calls).toBe(2);
  owner.abort();
  expect(() => load(2)).toThrow();
});
test('failed render is retryable and does not consume successful page budget', async () => {
  let calls = 0;
  const owner = new AbortController();
  const load = createPdfPageCache(
    page,
    async () => {
      if (++calls === 1) throw Error('read_failed');
      return page;
    },
    owner.signal,
    () => {},
    { page: 12, total: 12 },
  );
  await expect(load(2)).rejects.toThrow('read_failed');
  expect(await load(2)).toEqual(bytes);
  expect(calls).toBe(2);
  await expect(load(3)).rejects.toThrow('preview_pdf_budget');
  expect(await load(2)).toEqual(bytes);
  owner.abort();
});
test('closing during render cannot cache or return late page content', async () => {
  const owner = new AbortController();
  let finish!: (p: typeof page) => void;
  const load = createPdfPageCache(
    page,
    () =>
      new Promise((r) => {
        finish = r;
      }),
    owner.signal,
    () => {},
  );
  const pending = load(2);
  await Promise.resolve();
  owner.abort();
  finish(page);
  await expect(pending).rejects.toThrow();
  expect(() => load(2)).toThrow();
});

test('text metadata is charged with PNG and over-budget layers degrade without losing image', async () => {
  const owner = new AbortController();
  const layer = {
    status: 'available' as const,
    width: 10,
    height: 10,
    items: [
      {
        text: 'x'.repeat(1000),
        transform: [1, 0, 0, 1, 0, 0],
        width: 1,
        height: 1,
        ascent: 0.8,
        descent: -0.2,
        vertical: false,
        dir: 'ltr',
        fontFamily: 'serif',
        hasEOL: false,
      },
    ],
  };
  const seen: unknown[] = [];
  const load = createPdfPageCache(
    { ...page, textLayer: layer },
    async () => ({ ...page, textLayer: layer }),
    owner.signal,
    () => {},
    { page: 200, total: 400 },
    (_page, value) => seen.push(value),
  );
  expect(await load(1)).toEqual(bytes);
  expect(seen[0]).toEqual({ ...layer, status: 'unavailable', items: [] });
  expect(await load(1)).toEqual(bytes);
  expect(seen).toHaveLength(1);
  owner.abort();
});
