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
// biome-ignore lint/suspicious/noControlCharactersInRegex: essential ANSI escape sequence regex — \x1b matches the ESC (0x1b) control character
const CSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
const OSC_RE = /\x1b\][^\x07]*\x07/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
const OTHER_ESC_RE = /\x1b[=>][0-9;]*[a-zA-Z]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
const CHARSET_RE = /\x1b[()][0-9A-Za-z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
const DEC_PRIVATE_RE = /\x1b\[\?[0-9;]*[hl]/g;

export function stripAnsi(raw: string): string {
  return raw
    .replace(CSI_RE, '')
    .replace(OSC_RE, '')
    .replace(OTHER_ESC_RE, '')
    .replace(CHARSET_RE, '')
    .replace(DEC_PRIVATE_RE, '');
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

// ── 结构化断言 / Structural assertions ──

/**
 * 返回 text 在可见行中首次出现的行号（0-indexed），未找到返回 -1。
 * Returns the 0-indexed line number where text first appears in visible lines, or -1.
 */
export function textPosition(raw: string, text: string): number {
  return visibleLines(raw).findIndex((line) => line.includes(text));
}

/**
 * 断言 first 在 second 之前出现。用于验证消息渲染顺序（text → tool_card → tool_done）。
 * Asserts that `first` appears before `second` in the terminal output.
 */
export function assertOrder(
  raw: string,
  first: string,
  second: string,
): { pass: boolean; detail: string } {
  const lines = visibleLines(raw);
  const firstIdx = lines.findIndex((l) => l.includes(first));
  const secondIdx = lines.findIndex((l) => l.includes(second));
  if (firstIdx === -1) {
    return { pass: false, detail: `"${first}" not found in output` };
  }
  if (secondIdx === -1) {
    return { pass: false, detail: `"${second}" not found in output` };
  }
  if (firstIdx > secondIdx) {
    return {
      pass: false,
      detail: `"${first}" (line ${firstIdx}) appears AFTER "${second}" (line ${secondIdx})`,
    };
  }
  return {
    pass: true,
    detail: `"${first}" (line ${firstIdx}) before "${second}" (line ${secondIdx})`,
  };
}

/**
 * 统计 text 在输出中出现的次数。用于验证中断块去重（重复弹框检测）。
 * Counts occurrences of text in the output. Used for interrupt dedup verification.
 */
export function countOccurrences(raw: string, text: string): number {
  const stripped = stripAnsi(raw);
  let count = 0;
  let pos = 0;
  while (true) {
    const found = stripped.indexOf(text, pos);
    if (found === -1) break;
    pos = found + text.length;
    count++;
  }
  return count;
}
