import { expect, spyOn, test } from 'bun:test';
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

test('completed Service cleanup quits cleanly and closes exactly once', async () => {
  let closes = 0;
  const outcome = await settleDesktopQuit({
    closeService: async () => {
      closes += 1;
    },
  });
  expect(outcome).toBe('clean');
  expect(closes).toBe(1);
});

test('rejected Service cleanup forces quit and closes exactly once', async () => {
  let closes = 0;
  const outcome = await settleDesktopQuit({
    closeService: async () => {
      closes += 1;
      throw new Error('Service exited nonzero');
    },
  });
  expect(outcome).toBe('force');
  expect(closes).toBe(1);
});

test('synchronous cleanup failure forces quit and closes exactly once', async () => {
  let closes = 0;
  const outcome = await settleDesktopQuit({
    closeService: () => {
      closes += 1;
      throw new Error('Service close threw');
    },
  });
  expect(outcome).toBe('force');
  expect(closes).toBe(1);
});

for (const completion of ['resolve', 'reject'] as const) {
  test(`background cleanup stays pending without a timer until actual ${completion}`, async () => {
    const closing = deferredClose();
    let closes = 0;
    let settled = false;
    const timers = spyOn(globalThis, 'setTimeout');
    try {
      const outcome = settleDesktopQuit({
        closeService: () => {
          closes += 1;
          return closing.promise;
        },
      });
      void outcome.then(() => {
        settled = true;
      });
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      expect(closes).toBe(1);
      expect(settled).toBe(false);
      expect(timers).not.toHaveBeenCalled();
      if (completion === 'resolve') closing.resolve();
      else closing.reject(new Error('Background Service cleanup failed'));
      expect(await outcome).toBe(completion === 'resolve' ? 'clean' : 'force');
      expect(closes).toBe(1);
      expect(timers).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
    }
  });
}
