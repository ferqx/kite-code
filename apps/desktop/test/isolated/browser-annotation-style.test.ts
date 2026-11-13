import { expect, test } from '#kite-test';
import { createBrowserAnnotationStyle } from '../../electron/browser-annotation-style';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const calls: unknown[] = [];
  const keys = new Set<string>();
  let count = 0;
  const port = {
    async insertCSS(css: string, options: { cssOrigin: 'user' }) {
      calls.push({ css, options });
      const key = `key-${++count}`;
      keys.add(key);
      return key;
    },
    async removeInsertedCSS(key: string) {
      calls.push({ remove: key });
      keys.delete(key);
    },
  };
  return { port, calls, keys, style: createBrowserAnnotationStyle(port) };
}

test('same navigation shares one fixed USER stylesheet and navigation replaces its exact key', async () => {
  const f = fixture();
  const first = f.style.ensure(0);
  expect(f.style.ensure(0)).toBe(first);
  await first;
  await f.style.ensure(0);
  expect(f.calls).toEqual([
    {
      css: '#__agent_browser_annotations__{display:none!important}',
      options: { cssOrigin: 'user' },
    },
  ]);
  await f.style.ensure(1);
  expect(f.calls[1]).toEqual({ remove: 'key-1' });
  expect([...f.keys]).toEqual(['key-2']);
  await f.style.clear();
  expect([...f.keys]).toEqual([]);
  expect(f.calls.at(-1)).toEqual({ remove: 'key-2' });
});

test('revocation waits for a late insertion and removes its accurate key before completing', async () => {
  const f = fixture();
  const insertion = deferred<string>();
  const entered = deferred<void>();
  f.port.insertCSS = async () => {
    entered.resolve();
    return insertion.promise;
  };
  const pending = f.style.ensure(2);
  const stale = pending.catch((error: Error) => error);
  await entered.promise;
  let cleared = false;
  const clear = f.style.clear().then(() => {
    cleared = true;
  });
  await Promise.resolve();
  expect(cleared).toBe(false);
  insertion.resolve('late-key');
  expect(await stale).toEqual(Error('browser_annotation_style_stale'));
  await clear;
  expect(f.calls).toEqual([{ remove: 'late-key' }]);
  expect(cleared).toBe(true);
});

test('navigation invalidates an in-flight insertion before installing the new style', async () => {
  const f = fixture();
  const insertion = deferred<string>();
  const insert = f.port.insertCSS;
  const entered = deferred<void>();
  let started = false;
  f.port.insertCSS = async (css, options) => {
    if (!started) {
      started = true;
      entered.resolve();
      return insertion.promise;
    }
    return insert(css, options);
  };
  const first = f.style.ensure(3);
  const stale = first.catch((error: Error) => error);
  await entered.promise;
  const second = f.style.ensure(4);
  insertion.resolve('old-navigation-key');
  expect(await stale).toEqual(Error('browser_annotation_style_stale'));
  await second;
  expect(f.calls[0]).toEqual({ remove: 'old-navigation-key' });
  expect([...f.keys]).toEqual(['key-1']);
});

test('failed revocation rejects and retains the original key for an explicit cleanup retry', async () => {
  const f = fixture();
  await f.style.ensure(5);
  const remove = f.port.removeInsertedCSS;
  f.port.removeInsertedCSS = async () => {
    throw Error('remove_failed');
  };
  await expect(f.style.clear()).rejects.toThrow('remove_failed');
  expect([...f.keys]).toEqual(['key-1']);
  f.port.removeInsertedCSS = remove;
  await f.style.clear();
  expect(f.calls.at(-1)).toEqual({ remove: 'key-1' });
  expect([...f.keys]).toEqual([]);
  await f.style.ensure(5);
  expect([...f.keys]).toEqual(['key-2']);
});

test('clear waits for actual removal and resume is serialized after it', async () => {
  const f = fixture();
  await f.style.ensure(6);
  const removal = deferred<void>();
  const remove = f.port.removeInsertedCSS;
  f.port.removeInsertedCSS = async (key) => {
    await removal.promise;
    await remove(key);
  };
  let cleared = false;
  const clear = f.style.clear().then(() => {
    cleared = true;
  });
  const resume = f.style.ensure(6);
  await Promise.resolve();
  expect(cleared).toBe(false);
  expect([...f.keys]).toEqual(['key-1']);
  removal.resolve();
  await clear;
  await resume;
  expect([...f.keys]).toEqual(['key-2']);
  expect(f.calls[1]).toEqual({ remove: 'key-1' });
});

test('queued obsolete ensures never insert and invalid navigations have no effects', async () => {
  const f = fixture();
  const pending = f.style.ensure(7);
  const stale = pending.catch((error: Error) => error);
  await f.style.clear();
  expect(await stale).toEqual(Error('browser_annotation_style_stale'));
  for (const navigation of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    await expect(f.style.ensure(navigation)).rejects.toThrow('navigation_invalid');
  expect(f.calls).toEqual([]);
});
