import { expect, jest, spyOn, test } from '#kite-test';
import { settleDesktopQuit } from '../electron/quit-settlement';

function deferredClose() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};

test('completed Service cleanup quits cleanly and clears its deadline', async () => {
  const timers = spyOn(globalThis, 'clearTimeout');
  let closes = 0;
  try {
    expect(
      await settleDesktopQuit({
        closeService: async () => {
          closes++;
        },
      }),
    ).toBe('clean');
    expect(closes).toBe(1);
    expect(timers).toHaveBeenCalledTimes(1);
  } finally {
    timers.mockRestore();
  }
});

for (const synchronous of [false, true])
  test(`${synchronous ? 'synchronous' : 'asynchronous'} cleanup failure forces quit and clears its deadline`, async () => {
    const timers = spyOn(globalThis, 'clearTimeout');
    let closes = 0;
    try {
      expect(
        await settleDesktopQuit({
          closeService: () => {
            closes++;
            if (synchronous) throw Error('Service close threw');
            return Promise.reject(Error('Service exited nonzero'));
          },
        }),
      ).toBe('force');
      expect(closes).toBe(1);
      expect(timers).toHaveBeenCalledTimes(1);
    } finally {
      timers.mockRestore();
    }
  });

for (const completion of ['resolve', 'reject'] as const)
  test(`a pending cleanup forces at four seconds and late ${completion} cannot change the result`, async () => {
    jest.useFakeTimers();
    const closing = deferredClose();
    const outcomes: string[] = [];
    let closes = 0;
    try {
      const result = settleDesktopQuit({
        closeService: () => {
          closes++;
          return closing.promise;
        },
      });
      void result.then((outcome) => outcomes.push(outcome));
      await flush();
      expect(closes).toBe(1);
      jest.advanceTimersByTime(3999);
      await flush();
      expect(outcomes).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(await result).toBe('force');
      if (completion === 'resolve') closing.resolve();
      else closing.reject(Error('late failure'));
      await flush();
      jest.advanceTimersByTime(10000);
      await flush();
      expect(outcomes).toEqual(['force']);
      expect(closes).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

test('presentation failure can retire the deadline without waiting for pending cleanup', async () => {
  jest.useFakeTimers();
  const closing = deferredClose();
  const abort = new AbortController();
  const outcomes: string[] = [];
  try {
    const result = settleDesktopQuit({ signal: abort.signal, closeService: () => closing.promise });
    void result.then((outcome) => outcomes.push(outcome));
    await flush();
    abort.abort();
    expect(await result).toBe('force');
    closing.resolve();
    await flush();
    jest.advanceTimersByTime(4000);
    await flush();
    expect(outcomes).toEqual(['force']);
  } finally {
    jest.useRealTimers();
  }
});
