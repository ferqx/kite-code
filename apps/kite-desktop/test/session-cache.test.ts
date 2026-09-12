import { expect, test } from 'bun:test';
import type { Message } from '../src/presentation';
import { SessionHistoryCache } from '../src/session-cache';

const messages = (text = 'cached'): readonly Message[] => [
  { id: 'user:1', role: 'user', text, settled: true },
];

test('inactive cache transfers snapshots without cloning and records loaded empty history', () => {
  const cache = new SessionHistoryCache();
  const snapshot = messages();
  cache.save('a', 'workspace-a', snapshot);
  cache.save('empty', 'workspace-a', []);
  expect(cache.take('a')).toMatchObject({ workspaceDigest: 'workspace-a', hasLoadedHistory: true });
  expect(cache.take('a')).toBeUndefined();
  cache.save('a', 'workspace-a', snapshot);
  expect(cache.take('a')?.messages).toBe(snapshot);
  expect(cache.take('empty')).toMatchObject({ messages: [], hasLoadedHistory: true });
});

test('100 visited sessions retain only the 12 most recently departed histories', () => {
  const cache = new SessionHistoryCache();
  for (let index = 0; index < 100; index++) cache.save(String(index), 'workspace', messages());
  for (let index = 0; index < 88; index++) expect(cache.take(String(index))).toBeUndefined();
  for (let index = 88; index < 100; index++) expect(cache.take(String(index))).toBeDefined();
});

test('revisiting a cached session makes it the most recent when it leaves the view', () => {
  const cache = new SessionHistoryCache();
  for (let index = 0; index < 12; index++) cache.save(String(index), 'workspace', messages());
  const revisited = cache.take('0')!;
  cache.save('0', revisited.workspaceDigest, revisited.messages);
  cache.save('12', 'workspace', messages());
  expect(cache.take('1')).toBeUndefined();
  expect(cache.take('0')).toBeDefined();
});

test('payload budget evicts before count limit, rejects oversize and clears all references', () => {
  const cache = new SessionHistoryCache();
  const large = messages('x'.repeat(6 * 1024 * 1024));
  for (let index = 0; index < 6; index++) cache.save(String(index), 'workspace', large);
  expect(cache.take('0')).toBeUndefined();
  let bytes = 0;
  for (let index = 1; index < 6; index++) bytes += cache.take(String(index))!.bytes;
  expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  cache.save('too-large', 'workspace', messages('x'.repeat(8 * 1024 * 1024)));
  expect(cache.take('too-large')).toBeUndefined();
  cache.save('a', 'workspace', large);
  cache.clear();
  expect(cache.take('a')).toBeUndefined();
});
