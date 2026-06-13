import { useStdout } from "ink";

// Header(5) + Footer(4) + gap(1) = 10 rows of fixed app chrome
const APP_CHROME = 10;

/**
 * Returns the max content height for an overlay panel.
 * App's useWindowSize() triggers re-render on every resize event,
 * so stdout.rows is always current at render time. No need for
 * a separate resize listener.
 * @param chromeRows - rows consumed by the panel's non-list chrome (border, title, hints, margins)
 */
export function useOverlayHeight(chromeRows: number): number {
  const { stdout } = useStdout();
  return Math.max(5, stdout.rows - APP_CHROME - chromeRows);
}
