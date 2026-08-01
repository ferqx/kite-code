import { AsyncLocalStorage } from 'node:async_hooks';

const stepCancellation = new AsyncLocalStorage<AbortSignal>();

export function runWithTuiSystemStepSignal<T>(
  signal: AbortSignal,
  run: () => T | Promise<T>,
): Promise<T> {
  return Promise.resolve(stepCancellation.run(signal, run));
}

export function currentTuiSystemStepSignal(): AbortSignal | undefined {
  return stepCancellation.getStore();
}

export function throwIfTuiSystemStepAborted(): void {
  const signal = currentTuiSystemStepSignal();
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('TUI system step aborted');
  }
}

export async function tuiSystemDelay(ms: number): Promise<void> {
  const signal = currentTuiSystemStepSignal();
  throwIfTuiSystemStepAborted();
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('TUI system step aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
