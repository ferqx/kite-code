import { expect, test } from 'bun:test';
import { settleDesktopQuit } from '../electron/quit-settlement';

test('normal Service cleanup quits without warning or force', async () => {
  let prompts = 0;
  const outcome = await settleDesktopQuit({
    closeService: async () => undefined,
    confirmForceExit: async () => {
      prompts += 1;
      return true;
    },
    warnFailedCleanup: async () => {
      prompts += 1;
    },
    waitMs: 10,
  });
  expect(outcome).toBe('clean');
  expect(prompts).toBe(0);
});

test('failed Service cleanup offers exit instead of trapping the client', async () => {
  let warnings = 0;
  const outcome = await settleDesktopQuit({
    closeService: async () => {
      throw new Error('Service exited nonzero');
    },
    confirmForceExit: async () => {
      throw new Error('Failed cleanup must not reenter a wait');
    },
    warnFailedCleanup: async () => {
      warnings += 1;
    },
    waitMs: 10,
  });
  expect(outcome).toBe('force');
  expect(warnings).toBe(1);
});

test('stalled cleanup offers force exit without waiting for the Runtime lock', async () => {
  let prompts = 0;
  const outcome = await settleDesktopQuit({
    closeService: () => new Promise<void>(() => undefined),
    confirmForceExit: async () => {
      prompts += 1;
      return true;
    },
    warnFailedCleanup: async () => {
      throw new Error('A pending cleanup has not failed');
    },
    waitMs: 10,
  });
  expect(outcome).toBe('force');
  expect(prompts).toBe(1);
});

test('continuing to wait still permits a clean exit when Service later settles', async () => {
  let resolveClose!: () => void;
  const closing = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  let prompts = 0;
  const outcome = await settleDesktopQuit({
    closeService: () => closing,
    confirmForceExit: async () => {
      prompts += 1;
      resolveClose();
      return false;
    },
    warnFailedCleanup: async () => undefined,
    waitMs: 10,
  });
  expect(outcome).toBe('clean');
  expect(prompts).toBe(1);
});
