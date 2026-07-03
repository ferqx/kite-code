/**
 * Terminal Screen Model — ANSI stripping and text extraction for PTY output.
 *
 * PTY output contains raw ANSI escape sequences (colors, cursor movement,
 * clear screen, terminal titles, etc.). This module strips those sequences
 * to produce clean text suitable for assertions.
 *
 * Phase 2 MVP: simple regex-based ANSI stripping.
 * Phase 2+: consider @xterm/headless for full terminal emulation.
 */

/**
 * Strip ANSI escape sequences, OSC sequences, and terminal control
 * characters from PTY output. Preserves printable text and newlines.
 */
export function stripAnsi(raw: string): string {
  return (
    raw
      // CSI sequences: ESC [ ... <letter>
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      // OSC sequences: ESC ] ... BEL
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // Other escape sequences
      .replace(/\x1b[=>][0-9;]*[a-zA-Z]?/g, '')
      .replace(/\x1b[()][0-9A-Za-z]/g, '')
      // DEC private sequences
      .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
  );
}

/** Extract visible text lines from PTY output (ANSI-stripped, trimmed, non-empty). */
export function visibleLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line.length > 0);
}

/** Check if plain text is present in raw PTY output (ANSI-agnostic). */
export function screenContains(raw: string, text: string): boolean {
  return stripAnsi(raw).includes(text);
}

/** Poll for text in PTY output until timeout. Throws with last output on failure. */
export async function waitForText(
  getOutput: () => string,
  text: string,
  timeout = 10000,
  interval = 100,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const output = getOutput();
    if (screenContains(output, text)) return output;
    await new Promise((r) => setTimeout(r, interval));
  }
  const last = stripAnsi(getOutput());
  throw new Error(
    `Timeout (${timeout}ms) waiting for "${text}".\nLast output:\n${last.slice(-500)}`,
  );
}

/** Poll for text to disappear from PTY output. */
export async function waitForTextGone(
  getOutput: () => string,
  text: string,
  timeout = 5000,
  interval = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!screenContains(getOutput(), text)) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timeout (${timeout}ms) waiting for "${text}" to disappear`);
}

/** Take a clean-text snapshot of the current terminal screen. */
export function snapshot(raw: string): { text: string; lines: string[] } {
  const lines = visibleLines(raw);
  return { text: lines.join('\n'), lines };
}
