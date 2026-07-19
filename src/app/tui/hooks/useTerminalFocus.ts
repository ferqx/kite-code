import { useEffect, useRef, useState } from 'react';

// Terminal focus events (DEC private mode 1004)
//   CSI I  -> focus gained
//   CSI O  -> focus lost
const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';

/**
 * Tracks terminal window focus via DEC private mode 1004 focus-reporting.
 * Returns `true` when the terminal has focus, `false` when blurred.
 * Defaults to `true` (optimistic — most terminals start with focus).
 */
export function useTerminalFocus(): boolean {
  const [hasFocus, setHasFocus] = useState(true);
  const hasFocusRef = useRef(true);
  hasFocusRef.current = hasFocus;

  useEffect(() => {
    process.stdout.write(ENABLE_FOCUS_REPORTING);

    const onData = (buf: Buffer) => {
      const s = buf.toString();
      if (s.includes(FOCUS_IN)) {
        if (!hasFocusRef.current) setHasFocus(true);
      } else if (s.includes(FOCUS_OUT)) {
        if (hasFocusRef.current) setHasFocus(false);
      }
    };

    process.stdin.on('data', onData);

    return () => {
      process.stdout.write(DISABLE_FOCUS_REPORTING);
      process.stdin.off('data', onData);
    };
  }, []);

  return hasFocus;
}
