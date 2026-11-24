import { expect, test } from 'bun:test';
import { NativeOutputDisplayVersions } from '../electron/output-display-versions';
import { NativeOutputReadCache } from '../src/native-output-read-cache';
import { sessionChange } from './native-change.fixture';

test('output display versions refresh Run and source data independently of display authority', () => {
  const versions = new NativeOutputDisplayVersions();
  const root = (id: string) =>
    versions.snapshot('store', 'user', id).roots.find((root) => root.sessionId === id)!;
  const originalA = root('a');
  const originalB = root('b');
  const child = {
    sessionId: 'child',
    runId: 'child-run',
    parentRunId: 'a-run',
    carrierExecutionId: 'carrier',
    name: 'same name',
  };
  expect(versions.sources('a', [child])).toBe(false);
  expect(versions.sources('a', [{ ...child, name: 'renamed' }])).toBe(false);
  expect(
    versions.changed({
      ...sessionChange('foreign'),
      type: 'extension.record_updated',
      objectId: 'builtin.files/delivery/foreign',
    }),
  ).toBe(false);
  expect(root('a')).toEqual(originalA);
  expect(root('b')).toEqual(originalB);
  expect(
    versions.changed({
      ...sessionChange('child'),
      type: 'extension.record_updated',
      objectId: 'builtin.files/delivery/file',
    }),
  ).toBe(true);
  const delivered = root('a');
  expect(delivered).toMatchObject({
    revision: originalA.revision,
    sourcesRevision: originalA.sourcesRevision,
    files: [{ sessionId: 'child', revision: expect.any(Number) }],
  });
  expect(root('b')).toEqual(originalB);
  versions.changed({ ...sessionChange('child'), type: 'run.finished', objectId: 'child-run' });
  const finished = root('a');
  expect(finished.files).toEqual([
    ...delivered.files,
    { sessionId: 'child', runId: 'child-run', revision: expect.any(Number) },
  ]);
  expect(finished.revision).toBe(delivered.revision);
  expect(finished.sourcesRevision).toBe(delivered.sourcesRevision);
  versions.changed({ ...sessionChange('a'), type: 'run.started', objectId: 'new-run' });
  const started = root('a');
  expect(started.files).toEqual([
    ...finished.files,
    { sessionId: 'a', runId: 'new-run', revision: expect.any(Number) },
  ]);
  expect(started.revision).toBe(finished.revision);
  expect(started.sourcesRevision).toBe(finished.sourcesRevision);
  versions.changed({
    ...sessionChange('a'),
    type: 'extension.record_updated',
    objectId: 'builtin.files/delivery/00000000000000000001/producer/file',
    payload: { outputRunId: 'old-run' },
  });
  const lateDelivery = root('a');
  expect(lateDelivery.files).toEqual([
    ...started.files,
    { sessionId: 'a', runId: 'old-run', revision: expect.any(Number) },
  ]);
  versions.changed({
    ...sessionChange('new-child'),
    type: 'run.started',
    objectId: 'child-started',
  });
  expect(root('a')).toEqual({ ...lateDelivery, sourcesRevision: expect.any(Number) });
  expect(root('a').sourcesRevision).toBeGreaterThan(started.sourcesRevision);
  expect(root('b').sourcesRevision).toBeGreaterThan(originalB.sourcesRevision);
  const beforeFork = root('b');
  versions.changed({ ...sessionChange('fork'), type: 'session.forked' });
  expect(root('b').sourcesRevision).toBeGreaterThan(beforeFork.sourcesRevision);
  expect(root('b').revision).toBe(beforeFork.revision);
  const beforeExactLoss = root('a').revision;
  expect(versions.sources('a', [{ ...child, carrierExecutionId: 'different-carrier' }])).toBe(true);
  expect(root('a').revision).toBeGreaterThan(beforeExactLoss);
  expect(root('a').files).toEqual([]);
  const beforeDelete = root('a');
  versions.changed({ ...sessionChange('child'), type: 'session.delete_requested' });
  expect(root('a').revision).toBeGreaterThan(beforeDelete.revision);
  expect(root('a').files).toEqual([]);
  expect(root('b').revision).toBe(beforeFork.revision);
  const beforePermission = root('a').revision;
  versions.changed({ ...sessionChange(null), type: 'host_control.changed' });
  expect(root('a').revision).toBeGreaterThan(beforePermission);
  expect(root('b').revision).toBeGreaterThan(beforeFork.revision);
  for (let index = 0; index < 70; index++)
    versions.changed({ ...sessionChange('a'), type: 'run.interrupted', objectId: String(index) });
  const capped = root('a');
  expect(capped.filesRevision).toBeGreaterThan(0);
  expect(capped.files).toHaveLength(5);
  expect(capped.files.every((file) => file.revision > capped.filesRevision)).toBe(true);
  const beforeReset = versions.snapshot('store', 'user');
  versions.reset();
  expect(versions.snapshot('store', 'user').epoch).toBeGreaterThan(beforeReset.epoch);
  expect(versions.snapshot('store', 'user').roots).toEqual([]);
  for (let i = 0; i < 30; i++) root(String(i));
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
