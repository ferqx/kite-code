import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { estimateNativeSnapshotBytes, NativeHistoryCache } from '../src/native-history-cache';

const messages = (content = 'cached') => [{ id: 'm', content }] as Message[];

test('inactive Native histories transfer ownership, including loaded empty snapshots', () => {
  const cache = new NativeHistoryCache();
  const snapshot = messages();
  cache.save('store', 'session', snapshot);
  cache.save('store', 'empty', []);
  expect(cache.take('store', 'session')).toBe(snapshot);
  expect(cache.take('store', 'session')).toBeUndefined();
  expect(cache.take('store', 'empty')).toEqual([]);
});

test('100 departed Native sessions retain 12 histories and revisits refresh eviction order', () => {
  const cache = new NativeHistoryCache();
  for (let index = 0; index < 100; index++) cache.save('store', String(index), messages());
  for (let index = 0; index < 88; index++)
    expect(cache.take('store', String(index))).toBeUndefined();
  const revisited = cache.take('store', '88')!;
  cache.save('store', '88', revisited);
  cache.save('store', '100', messages());
  expect(cache.take('store', '89')).toBeUndefined();
  expect(cache.take('store', '88')).toBe(revisited);
  for (let index = 90; index <= 100; index++)
    expect(cache.take('store', String(index))).toBeDefined();
});

test('Native byte budgets evict before count limit and oversized replacement drops prior data', () => {
  const cache = new NativeHistoryCache();
  const large = messages('x'.repeat(6 * 1024 * 1024));
  for (let index = 0; index < 6; index++) cache.save('store', String(index), large);
  expect(cache.take('store', '0')).toBeUndefined();
  for (let index = 1; index < 6; index++) expect(cache.take('store', String(index))).toBe(large);
  cache.save('store', 'oversized', messages());
  cache.save('store', 'oversized', messages('x'.repeat(8 * 1024 * 1024)));
  expect(cache.take('store', 'oversized')).toBeUndefined();
});

test('Native cache Store keys cannot collide and removal frees only the named Store', () => {
  const cache = new NativeHistoryCache();
  const one = messages('first');
  const two = messages('second');
  cache.save('a/b', 'c', one);
  cache.save('a', 'b/c', two);
  expect(cache.take('a/b', 'c')).toBe(one);
  expect(cache.take('a', 'b/c')).toBe(two);
  cache.save('a', 'session', one);
  cache.save('b', 'session', two);
  cache.evictStore('a');
  expect(cache.take('a', 'session')).toBeUndefined();
  expect(cache.take('b', 'session')).toBe(two);
  cache.save('b', 'session', two);
  cache.clear();
  expect(cache.take('b', 'session')).toBeUndefined();
});

test('Native snapshot budgets include nested tool arguments and source IDs and stop after the budget', () => {
  const metadata = {
    sourceIds: ['source-id'.repeat(16)],
    modelOutputs: [{ output: { toolCalls: [{ arguments: 'arguments'.repeat(16) }] } }],
  };
  expect(estimateNativeSnapshotBytes(metadata)).toBeGreaterThan(576);
  let visitedTail = false;
  const oversized = {
    content: 'body'.repeat(1024),
    get tail() {
      visitedTail = true;
      return metadata;
    },
  };
  expect(estimateNativeSnapshotBytes(oversized, 256)).toBeGreaterThan(256);
  expect(visitedTail).toBe(false);
});
