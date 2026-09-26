/** Keep a user-visible emergency exit available when owned Service cleanup stalls. */
export async function settleDesktopQuit(input: {
  closeService: () => Promise<void>;
  confirmForceExit: () => Promise<boolean>;
  warnFailedCleanup: () => Promise<void>;
  waitMs: number;
}): Promise<'clean' | 'force'> {
  const settlement = Promise.resolve()
    .then(input.closeService)
    .then(
      () => 'clean' as const,
      () => 'failed' as const,
    );
  for (;;) {
    const result = await waitForSettlement(settlement, input.waitMs);
    if (result === 'clean') return 'clean';
    if (result === 'failed') {
      await input.warnFailedCleanup();
      return 'force';
    }
    if (await input.confirmForceExit()) return 'force';
  }
}

function waitForSettlement(
  settlement: Promise<'clean' | 'failed'>,
  waitMs: number,
): Promise<'clean' | 'failed' | 'waiting'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('waiting'), waitMs);
    void settlement.then((result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}
