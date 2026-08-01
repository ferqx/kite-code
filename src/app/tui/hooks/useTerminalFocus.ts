import { useSyncExternalStore } from 'react';
import { terminalFocusStore } from './terminal-focus-store';

/**
 * Tracks terminal window focus via DEC private mode 1004 focus-reporting.
 * Returns `true` when the terminal has focus, `false` when blurred.
 * Defaults to `true` (optimistic — most terminals start with focus).
 */
export function useTerminalFocus(): boolean {
  return useSyncExternalStore(
    terminalFocusStore.subscribe,
    terminalFocusStore.getSnapshot,
    terminalFocusStore.getServerSnapshot,
  );
}
