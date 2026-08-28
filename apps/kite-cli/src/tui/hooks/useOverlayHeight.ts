import { useStdout } from 'ink';

// Header(5) + Footer(4) + gap(1) = 10 rows of fixed app chrome
const APP_CHROME = 10;

/**
 * Returns the max content height for an overlay panel.
 * Reads stdout.rows live at render time — when App remounts on resize
 * (\x1b[2J\x1b[3J + key change), this hook re-runs with the new value.
 * @param chromeRows - rows consumed by the panel's non-list chrome (border, title, hints, margins)
 */
export function useOverlayHeight(chromeRows: number): number {
  const { stdout } = useStdout();
  return Math.max(5, stdout.rows - APP_CHROME - chromeRows);
}
