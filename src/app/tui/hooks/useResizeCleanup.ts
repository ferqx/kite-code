import { useEffect, useRef } from "react";
import { useStdout } from "ink";

/**
 * Keeps the scrollback buffer clean during terminal resize.
 *
 * During a drag-resize Ink's `resized()` handler fires a full layout +
 * render cycle on every event — this is inherently expensive and nothing
 * we do can eliminate that.  What we *can* prevent is the scrollback
 * buffer filling up with dozens of intermediate renders at different
 * widths, which produces the most persistent visual artifact (scrolling
 * back reveals garbled duplicates).
 *
 * **Strategy (zero React cost):**
 * On every resize event, write a single `\x1B[3J` escape sequence to
 * clear the scrollback buffer.  This is instantaneous, has no visible
 * effect on the screen, and requires no React state updates.
 *
 * We intentionally do **not** clear the visible screen or invalidate
 * `<Static>` — those would require expensive React work and cause a
 * visible flash.  Ink's own `log.update` handles redrawing the dynamic
 * area correctly.  Any transient visible ghost lines from narrow→wide
 * transitions will be cleaned up on the next user action (send message,
 * Ctrl+L, etc.).
 */
export function useResizeCleanup() {
  const { stdout } = useStdout();
  const readyRef = useRef(false);

  // Skip resize events during the first 500 ms of mount to avoid false
  // triggers from ink-testing-library's stdout dimension setup.
  useEffect(() => {
    const id = setTimeout(() => {
      readyRef.current = true;
    }, 500);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (!readyRef.current) return;
      // \x1B[3J = clear scrollback buffer (single escape sequence, instant)
      process.stdout.write("\x1B[3J");
    };

    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);
}
