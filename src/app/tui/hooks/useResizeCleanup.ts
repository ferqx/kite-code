import { useEffect, useRef } from "react";
import { useStdout } from "ink";

/**
 * Cleans scrollback artifacts from terminal resize.
 *
 * During drag-resize, Ink fires a full render cycle on every event.
 * Intermediate renders at different widths leave garbled duplicates in
 * the scrollback.  We debounce \x1B[3J (clear scrollback) so it runs
 * only once after the resize sequence settles, rather than on every
 * intermediate event — this preserves old <Static> content during the
 * drag and only cleans up the final state.
 */
export function useResizeCleanup() {
  const { stdout } = useStdout();
  const readyRef = useRef(false);

  useEffect(() => {
    const id = setTimeout(() => {
      readyRef.current = true;
    }, 500);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (!readyRef.current) return;
      // No-op: we no longer clear scrollback during resize.
      // <Static> content (conversation history) lives in scrollback;
      // \x1B[3J destroys it.  Leave scrollback as-is.
    };

    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);
}
