import { expect, test } from 'bun:test';
import { createImageDisplayRegionResource } from '../electron/image-display-region-resource';
import type { ImageDisplayInput } from '../electron/image-display-service';
import { imageDisplayRegionRequest } from '../electron/image-display-viewport';

const origin = 'kite-preview://test-image';
const url = (serial: number, box = '0/0/1000/1000') => `${origin}/region/${serial}/${box}.webp`;
const result = (input: ImageDisplayInput) => ({
  bytes: Uint8Array.of(1),
  mimeType: 'image/webp' as const,
  width: 1000,
  height: 1000,
  sourceWidth: 1000,
  sourceHeight: 40000,
  animated: false,
  frame: 'static' as const,
  region: input.region,
});

test('coordinate resource family accepts only exact in-bounds regions at its private preview origin', () => {
  const resource = createImageDisplayRegionResource({
    origin,
    source: '/private/snapshot',
    mediaType: 'image/png',
    width: 1000,
    height: 40000,
    signal: new AbortController().signal,
    check() {},
  });
  expect(resource.accepts(url(1))).toBe(true);
  for (const address of [
    url(1).replace('test-image', 'other'),
    url(1).replace('kite-preview:', 'https:'),
    `${url(1)}?path=/secret`,
    `${url(1)}#x`,
    url(1, '0/39001/1000/1000'),
    url(1, '0/0/1001/10'),
    url(1, '-1/0/1/1'),
    url(0),
    `${origin}/source`,
    url(1).replace('test-image', 'user@test-image'),
  ])
    expect(resource.accepts(address)).toBe(false);
  expect(
    imageDisplayRegionRequest('/region/1/0/39000/1000/1000.webp', { width: 1000, height: 40000 })
      ?.region.top,
  ).toBe(39000);
});

test('new viewport cancels previous decoder, late ROI cannot replace new region, parent close revokes', async () => {
  const parent = new AbortController();
  const calls: { input: ImageDisplayInput; resolve(value: ReturnType<typeof result>): void }[] = [];
  const resource = createImageDisplayRegionResource({
    origin,
    source: '/private/snapshot',
    mediaType: 'image/png',
    width: 1000,
    height: 40000,
    signal: parent.signal,
    check() {},
    render: (input) => new Promise((resolve) => calls.push({ input, resolve })),
  });
  const first = resource.load(url(1), new AbortController().signal);
  first.catch(() => {});
  await Promise.resolve();
  const second = resource.load(url(2, '0/1000/1000/1000'), new AbortController().signal);
  await Promise.resolve();
  expect(calls[0]!.input.signal.aborted).toBe(true);
  expect(calls[1]!.input.source).toEqual({ path: '/private/snapshot' });
  expect(calls[1]!.input.edge).toBe(2048);
  calls[0]!.resolve(result(calls[0]!.input));
  await expect(first).rejects.toThrow();
  calls[1]!.resolve(result(calls[1]!.input));
  expect((await second).region?.top).toBe(1000);
  await expect(resource.load(url(1), new AbortController().signal)).rejects.toThrow(
    'image_region_stale',
  );
  const third = resource.load(url(3), new AbortController().signal);
  third.catch(() => {});
  await Promise.resolve();
  parent.abort();
  expect(calls[2]!.input.signal.aborted).toBe(true);
  calls[2]!.resolve(result(calls[2]!.input));
  await expect(third).rejects.toThrow();
});

test('access is rechecked before and after decode, so revoked permission never delivers an ROI', async () => {
  let allowed = true,
    checks = 0;
  const resource = createImageDisplayRegionResource({
    origin,
    source: '/private/snapshot',
    mediaType: 'image/png',
    width: 1000,
    height: 40000,
    signal: new AbortController().signal,
    check() {},
    async verifyAccess() {
      checks++;
      if (!allowed) throw Error('permission_revoked');
    },
    async render(input) {
      allowed = false;
      return result(input);
    },
  });
  await expect(resource.load(url(1), new AbortController().signal)).rejects.toThrow(
    'permission_revoked',
  );
  expect(checks).toBe(2);
});
