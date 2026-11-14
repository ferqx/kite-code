import { expect, test } from 'bun:test';
import { waitForNativeFrame } from '../electron/native-frame-readiness';

function fixture() {
  let callback: (image: {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
  }) => void = () => {};
  let stop: (() => void) | undefined,
    ends = 0,
    invalidates = 0,
    current = true;
  const controller = new AbortController();
  const promise = waitForNativeFrame({
    contents: {
      isDestroyed: () => false,
      beginFrameSubscription: (_, cb) => {
        callback = cb;
      },
      endFrameSubscription: () => {
        ends++;
      },
      invalidate: () => {
        invalidates++;
      },
    },
    bounds: { width: 100, height: 80 },
    signal: controller.signal,
    cancelled: Error('cancelled'),
    current: () => current,
    cancel: () => controller.abort(),
    setStop: (value) => {
      stop = value;
    },
    ownsStop: (value) => stop === value,
  });
  return {
    promise,
    controller,
    stale: () => {
      current = false;
    },
    emit: (width = 100, height = 80) =>
      callback({ isEmpty: () => false, getSize: () => ({ width, height }) }),
    ends: () => ends,
    invalidates: () => invalidates,
  };
}
test('waits for full matching frame and unsubscribes once; late callbacks ignored', async () => {
  const f = fixture();
  f.emit(50, 40);
  expect(f.ends()).toBe(0);
  f.emit();
  await f.promise;
  f.emit();
  expect(f.ends()).toBe(1);
  expect(f.invalidates()).toBe(1);
});
test('abort cleans up once and cannot be revived by late frame', async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.promise).rejects.toThrow('cancelled');
  f.emit();
  expect(f.ends()).toBe(1);
});
test('owner geometry/frame/permission replacement cancels without promotion', async () => {
  const f = fixture();
  f.stale();
  f.emit();
  await expect(f.promise).rejects.toThrow('cancelled');
  expect(f.ends()).toBe(1);
});

function controlled(
  options: { aborted?: boolean; current?: boolean; throws?: 'begin' | 'invalidate' | 'end' } = {},
) {
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  let begin = 0,
    end = 0,
    invalidate = 0;
  let stop: (() => void) | undefined;
  let callback: (image: {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
  }) => void = () => {};
  const promise = waitForNativeFrame({
    contents: {
      isDestroyed: () => false,
      beginFrameSubscription: (_, cb) => {
        begin++;
        callback = cb;
        if (options.throws === 'begin') throw Error('begin failed');
      },
      endFrameSubscription: () => {
        end++;
        if (options.throws === 'end') throw Error('end failed');
      },
      invalidate: () => {
        invalidate++;
        if (options.throws === 'invalidate') throw Error('invalidate failed');
      },
    },
    bounds: { width: 100, height: 80 },
    signal: controller.signal,
    cancelled: Error('cancelled'),
    current: () => options.current !== false,
    cancel: () => controller.abort(),
    setStop: (value) => {
      stop = value;
    },
    ownsStop: (value) => stop === value,
  });
  return {
    promise,
    controller,
    counts: () => ({ begin, end, invalidate }),
    stop: () => stop,
    replace: (value: () => void) => {
      stop = value;
    },
    emit: (width = 100, height = 80, empty = false) =>
      callback({ isEmpty: () => empty, getSize: () => ({ width, height }) }),
  };
}
for (const options of [{ aborted: true }, { current: false }]) {
  test(`initial invalid owner does not subscribe ${JSON.stringify(options)}`, async () => {
    const f = controlled(options);
    await expect(f.promise).rejects.toThrow('cancelled');
    expect(f.counts()).toEqual({ begin: 0, end: 0, invalidate: 0 });
    expect(f.stop()).toBeUndefined();
  });
}
for (const phase of ['begin', 'invalidate', 'end'] as const) {
  test(`${phase} failure rejects and retires owned subscription`, async () => {
    const f = controlled({ throws: phase });
    if (phase === 'end') f.emit();
    await expect(f.promise).rejects.toThrow(`${phase} failed`);
    expect(f.counts()).toEqual({ begin: 1, end: 1, invalidate: phase === 'begin' ? 0 : 1 });
    expect(f.stop()).toBeUndefined();
    f.controller.abort();
    f.emit();
    expect(f.counts().end).toBe(1);
  });
}
test('old cancellation cannot unsubscribe or clear successor ownership', async () => {
  const f = controlled();
  const successor = () => {};
  f.replace(successor);
  f.controller.abort();
  await expect(f.promise).rejects.toThrow('cancelled');
  expect(f.counts().end).toBe(0);
  expect(f.stop()).toBe(successor);
  f.emit();
  expect(f.counts().end).toBe(0);
});
test('empty, wrong aspect and nonfinite frames never promote', async () => {
  const f = controlled();
  let promoted = false;
  void f.promise.then(() => {
    promoted = true;
  });
  f.emit(100, 80, true);
  f.emit(100, 100);
  f.emit(Number.NaN, 80);
  await Promise.resolve();
  expect(promoted).toBe(false);
  expect(f.counts().end).toBe(0);
  f.emit(200, 160);
  await f.promise;
  expect(promoted).toBe(true);
  expect(f.counts().end).toBe(1);
});
