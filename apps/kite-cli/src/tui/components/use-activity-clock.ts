import { useSyncExternalStore } from 'react';

// One clock for mounted live indicators. It updates their small React subtrees,
// never Runtime state, and stops when the last active indicator leaves.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 250);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const inactiveSubscribe = () => () => {};
const snapshot = () => now;
const inactiveSnapshot = () => 0;
export function useActivityClock(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribe : inactiveSubscribe,
    active ? snapshot : inactiveSnapshot,
    inactiveSnapshot,
  );
}
