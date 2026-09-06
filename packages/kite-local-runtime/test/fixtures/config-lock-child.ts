import { acquireConfigFileMutationLock } from '../../src/config';

const target = process.argv[2];
const startAt = Number(process.argv[3]);
const holdMs = Number(process.argv[4]);
if (!target || !Number.isSafeInteger(startAt) || !Number.isSafeInteger(holdMs)) {
  throw new Error('Expected target, synchronized start and hold duration.');
}

const waitMs = startAt - Date.now();
if (waitMs > 0) await Bun.sleep(waitMs);
const lock = acquireConfigFileMutationLock(target, { retryCount: 100, retryMs: 10 });
try {
  console.log(JSON.stringify({ acquiredAt: Date.now() }));
  await Bun.sleep(holdMs);
} finally {
  lock.release();
}
