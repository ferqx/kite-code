import { useEffect, useState } from 'react';
import { SPINNER, SPINNER_INTERVAL_MS } from './render-utils';

/**
 * Unified blink-dot hook. All tool blocks share one timer pattern.
 *
 * @param active  Whether the dot should animate (false → always '  ')
 * @returns       Current frame string: '● ' or '  '
 */
export function useBlinkDot(active: boolean): string {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (active) setVisible(true);
  }, [active]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (active) setVisible((v) => !v);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);

  return active ? (visible ? SPINNER[0]! : SPINNER[1]!) : SPINNER[1]!;
}
