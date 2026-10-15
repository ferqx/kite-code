import {
  acquireProfileAccess,
  type ProfileAccess,
  type ProfileOptions,
} from '@kite-ai/agent/profile-access';

export class TuiStartupWaitError extends Error {
  readonly code = 'tui_startup_wait_timeout';
  constructor() {
    super('Profile remains in use by maintenance; retry after it finishes.');
  }
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
/** Wait only for the actual Profile owner lock; corruption and protection errors stay fatal. */
export async function waitForTuiProfileAccess(
  profile: ProfileOptions,
  options: { signal?: AbortSignal; onWait?(): void; timeoutMs?: number } = {},
): Promise<ProfileAccess> {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30_000)
    throw new Error('invalid_tui_startup_wait_timeout');
  const deadline = performance.now() + timeout;
  let announced = false;
  for (;;) {
    options.signal?.throwIfAborted();
    if (announced && performance.now() >= deadline) throw new TuiStartupWaitError();
    try {
      return acquireProfileAccess(profile);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'owner_busy')
        throw error;
      if (!announced) {
        announced = true;
        options.onWait?.();
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new TuiStartupWaitError();
      await delay(Math.min(100, remaining), options.signal);
    }
  }
}
