import { useStdout } from "ink";
import { useState, useEffect } from "react";

// Header(5) + Footer(4) + gap(1) = 10 rows of fixed app chrome
const APP_CHROME = 10;

/**
 * Returns the max content height for an overlay panel.
 * Uses useStdout + resize listener instead of useWindowSize to avoid
 * excessive re-renders during terminal resize.
 * @param chromeRows - rows consumed by the panel's non-list chrome (border, title, hints, margins)
 */
export function useOverlayHeight(chromeRows: number): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows);

  useEffect(() => {
    const handleResize = () => setRows(stdout.rows);
    stdout.on("resize", handleResize);
    return () => { stdout.off("resize", handleResize); };
  }, [stdout]);

  return Math.max(5, rows - APP_CHROME - chromeRows);
}
