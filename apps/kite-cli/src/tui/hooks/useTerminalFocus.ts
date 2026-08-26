import { useInput } from 'ink';
import { useSyncExternalStore } from 'react';
import { terminalFocusStore } from './terminal-focus-store';

/**
 * Tracks terminal window focus via DEC private mode 1004 focus-reporting.
 * Returns `true` when the terminal has focus, `false` when blurred.
 * Defaults to `true` (optimistic — most terminals start with focus).
 */
export function useTerminalFocus(): boolean {
  // Keep all terminal input on Ink's single readable-channel owner. Attaching a
  // process.stdin `data` listener here would switch the stream to flowing mode;
  // after an overlay/session remount Ink could then stop receiving both prompt
  // characters and global shortcuts.
  useInput((input) => {
    terminalFocusStore.handleInput(input);
  });

  return useSyncExternalStore(
    terminalFocusStore.subscribe,
    terminalFocusStore.getSnapshot,
    terminalFocusStore.getServerSnapshot,
  );
}
