import { expect, test } from 'bun:test';
import type { NativeImageGalleryImage } from '../../src/native-image-gallery-bridge';
import { createNativeImageGalleryUrlCache } from '../../src/native-image-gallery-url-cache';

const image = (
  revision: string,
  size = 4,
): Extract<NativeImageGalleryImage, { status: 'ready' }> => ({
  status: 'ready',
  revision,
  mimeType: 'image/png',
  bytes: new Uint8Array(size),
});
function fixture(maxBytes = 64, maxEntries = 32) {
  const created: string[] = [],
    revoked: string[] = [];
  const cache = createNativeImageGalleryUrlCache({
    maxBytes,
    maxEntries,
    create: () => {
      const src = `blob:viewer-${created.length}`;
      created.push(src);
      return src;
    },
    revoke: (src) => revoked.push(src),
  });
  return { cache, created, revoked };
}
test('only ready admission reuses id+revision; duplicate ready/theme preserve URL and new revisions differ', () => {
  const f = fixture();
  const a = f.cache.admit('one', image('a'));
  f.cache.commit(a);
  f.cache.selecting(); // A loading selection never exposes a cache target by itself.
  expect(f.created).toHaveLength(1);
  expect(f.revoked).toEqual([]);
  expect(f.cache.admit('one', image('a'))).toBe(a);
  const b = f.cache.admit('one', image('b'));
  expect(b).not.toBe(a);
  expect(f.created).toHaveLength(2);
  f.cache.commit('blob:stale-unadmitted');
  expect(f.cache.snapshot()).toEqual({ bytes: 8, entries: 2 });
  f.cache.dispose();
  expect(f.revoked).toEqual([a, b]);
});
test('encoded budget and count LRU eviction never revoke committed or current candidate early', () => {
  const f = fixture(12, 3);
  const a = f.cache.admit('a', image('a'));
  f.cache.commit(a);
  const b = f.cache.admit('b', image('b'));
  f.cache.admit('c', image('c'));
  const d = f.cache.admit('d', image('d'));
  expect(f.revoked).toEqual([b]); // Uncommitted b was replaced. a remains painted.
  expect(f.cache.snapshot()).toEqual({ bytes: 12, entries: 3 });
  f.cache.commit(d);
  const e = f.cache.admit('e', image('e'));
  expect(f.revoked).toEqual([b, a]);
  expect(f.cache.snapshot()).toEqual({ bytes: 12, entries: 3 });
  expect(f.revoked).not.toContain(d);
  expect(f.revoked).not.toContain(e);
  f.cache.dispose();
  expect(new Set(f.revoked).size).toBe(f.created.length);
});
test('retry retires cache lookup immediately but preserves a still-committed image until replacement decode', () => {
  const f = fixture();
  const a = f.cache.admit('one', image('a'));
  f.cache.commit(a);
  f.cache.retry('one');
  expect(f.revoked).toEqual([]);
  const b = f.cache.admit('one', image('a'));
  expect(b).not.toBe(a);
  expect(f.revoked).toEqual([]);
  f.cache.commit(a); // A late commit cannot replace the current candidate.
  expect(f.revoked).toEqual([]);
  f.cache.commit(b);
  expect(f.revoked).toEqual([a]);
  f.cache.dispose();
  expect(f.revoked).toEqual([a, b]);
});
test('retired hidden/closed sessions revoke everything exactly once and reject late admissions', () => {
  const f = fixture();
  const a = f.cache.admit('one', image('a'));
  f.cache.commit(a);
  const b = f.cache.admit('two', image('b'));
  f.cache.dispose();
  f.cache.dispose();
  f.cache.commit(b);
  f.cache.selecting();
  f.cache.retry('one');
  expect(f.revoked).toEqual([a, b]);
  expect(f.cache.snapshot()).toEqual({ bytes: 0, entries: 0 });
  expect(() => f.cache.admit('two', image('b'))).toThrow('image_gallery_session_retired');
  const next = fixture();
  const fresh = next.cache.admit('one', image('a'));
  expect(next.created).toHaveLength(1); // Same metadata has no cross-session cache.
  next.cache.dispose();
  expect(next.revoked).toEqual([fresh]);
});
test('admission enforces encoded limits before allocating and rejects revision metadata mismatch', () => {
  const f = fixture(8, 2);
  const a = f.cache.admit('one', image('a'));
  f.cache.commit(a);
  expect(() => f.cache.admit('two', image('b', 9))).toThrow('image_gallery_presentation_budget');
  expect(f.created).toHaveLength(1);
  expect(() => f.cache.admit('one', image('a', 3))).toThrow('image_gallery_revision_mismatch');
  expect(f.revoked).toEqual([]);
  f.cache.dispose();
});
