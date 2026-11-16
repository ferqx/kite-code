import { expect, test } from 'bun:test';
import { NativeOutputDisplayVersions } from '../electron/output-display-versions';
import { NativeOutputReadCache } from '../src/native-output-read-cache';
import { sessionChange } from './native-change.fixture';

test('output display versions follow inactive roots and exact descendants without invalidating unrelated deliveries', () => {
  const versions = new NativeOutputDisplayVersions();
  const revision = (id: string) =>
    versions.snapshot('store', 'user', id).roots.find((root) => root.sessionId === id)!.revision;
  const a = revision('a'),
    b = revision('b');
  versions.sources('a', [
    {
      sessionId: 'child',
      runId: 'child-run',
      parentRunId: 'a-run',
      carrierExecutionId: 'carrier',
      name: 'same name',
    },
  ]);
  expect(
    versions.changed({
      ...sessionChange('foreign'),
      type: 'extension.record_updated',
      objectId: 'builtin.files/delivery/foreign',
    }),
  ).toBe(false);
  expect(revision('a')).toBe(a);
  expect(revision('b')).toBe(b);
  expect(
    versions.changed({
      ...sessionChange('child'),
      type: 'extension.record_updated',
      objectId: 'builtin.files/delivery/file',
    }),
  ).toBe(true);
  expect(revision('a')).toBeGreaterThan(a);
  expect(revision('b')).toBe(b);
  const delivered = revision('a');
  versions.changed({ ...sessionChange('child'), type: 'run.finished' });
  expect(revision('a')).toBeGreaterThan(delivered);
  const finished = revision('a');
  versions.changed({ ...sessionChange('child'), type: 'session.delete_requested' });
  expect(revision('a')).toBeGreaterThan(finished);
  expect(revision('b')).toBe(b);
  const beforePermission = revision('a');
  versions.changed({ ...sessionChange(null), type: 'host_control.changed' });
  expect(revision('a')).toBeGreaterThan(beforePermission);
  expect(revision('b')).toBeGreaterThan(b);
  const beforeUnknown = revision('a');
  versions.changed({ ...sessionChange('new-child'), type: 'run.started' });
  expect(revision('a')).toBeGreaterThan(beforeUnknown);
  const beforeInterrupted = revision('a');
  versions.changed({ ...sessionChange('child'), type: 'run.interrupted' });
  expect(revision('a')).toBeGreaterThan(beforeInterrupted);
  const beforeFork = revision('b');
  versions.changed({ ...sessionChange('fork'), type: 'session.forked' });
  expect(revision('b')).toBeGreaterThan(beforeFork);
  const beforeReset = versions.snapshot('store', 'user');
  versions.reset();
  expect(versions.snapshot('store', 'user').epoch).toBeGreaterThan(beforeReset.epoch);
  expect(versions.snapshot('store', 'user').roots).toEqual([]);
  for (let i = 0; i < 30; i++) revision(String(i));
  expect(versions.snapshot('store', 'user').roots).toHaveLength(12);
});

test('shared output reads coalesce only exact keys, retain bounded successes and reject ABA completion reuse', async () => {
  const cache = new NativeOutputReadCache();
  cache.select('a');
  let finish!: (value: string) => void;
  let calls = 0;
  const load = () => {
    calls++;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  };
  const first = cache.read('a/page/1', load),
    second = cache.read('a/page/1', load);
  expect(calls).toBe(1);
  finish('saved');
  expect(await first).toBe('saved');
  expect(await second).toBe('saved');
  expect(await cache.read('a/page/1', load)).toBe('saved');
  expect(calls).toBe(1);
  const old = cache.read('a/page/2', load);
  const finishOld = finish;
  cache.select('b');
  cache.select('a');
  const current = cache.read('a/page/2', load);
  expect(calls).toBe(3);
  finish('current');
  expect(await current).toBe('current');
  finishOld('stale');
  expect(await old).toBe('stale');
  expect(cache.get('a/page/2')).toBe('current');
  let retries = 0;
  const fail = () => {
    retries++;
    return Promise.reject(Error('denied'));
  };
  await expect(cache.read('denied', fail)).rejects.toThrow('denied');
  await expect(cache.read('denied', fail)).rejects.toThrow('denied');
  expect(retries).toBe(2);
  for (let i = 0; i < 300; i++) cache.set(`bounded/${i}`, i);
  expect(cache.get('bounded/0')).toBeUndefined();
  expect(cache.get('bounded/299')).toBe(299);
  cache.set('oversized', 'x'.repeat(3 * 1024 * 1024));
  expect(cache.get('oversized')).toBeUndefined();
});
