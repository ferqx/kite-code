import type { KiteServiceSignal, KiteServiceSignalPort } from './ports';

interface ProcessSignalTarget {
  on(signal: KiteServiceSignal, listener: () => void): unknown;
  off(signal: KiteServiceSignal, listener: () => void): unknown;
}

/** Adapt process signal registration without making process a dependency of the lifecycle core. */
export function createProcessSignalPort(
  target: ProcessSignalTarget = process,
): KiteServiceSignalPort {
  return Object.freeze({
    subscribe(signal: KiteServiceSignal, listener: () => void): () => void {
      target.on(signal, listener);
      return () => target.off(signal, listener);
    },
  });
}

export const KITE_SERVICE_NOOP_SIGNALS: KiteServiceSignalPort = Object.freeze({
  subscribe: () => () => undefined,
});
