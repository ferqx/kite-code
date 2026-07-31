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

import { tuiPollInterval, tuiWaitTimeout } from './timing';

/**
 * Strip ANSI escape sequences, OSC sequences, and terminal control
 * characters from PTY output. Preserves printable text and newlines.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: essential ANSI escape sequence regex — \x1b matches the ESC (0x1b) control character
const CSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC parsing requires ESC and BEL bytes
const OSC_RE = /\x1b\][^\x07]*\x07/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape parsing requires the ESC byte
const OTHER_ESC_RE = /\x1b[=>][0-9;]*[a-zA-Z]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal charset parsing requires the ESC byte
const CHARSET_RE = /\x1b[()][0-9A-Za-z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: DEC private-mode parsing requires the ESC byte
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
  const effectiveTimeout = tuiWaitTimeout(timeout);
  const effectiveInterval = tuiPollInterval(interval);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    const output = getOutput();
    if (screenContains(output, text)) return output;
    await new Promise((r) => setTimeout(r, effectiveInterval));
  }
  const last = stripAnsi(getOutput());
  throw new Error(
    `Timeout (${effectiveTimeout}ms) waiting for "${text}".\nLast output:\n${last.slice(-1000)}`,
  );
}

/** Poll until any one of the expected texts appears in terminal output. */
export async function waitForAnyText(
  getOutput: () => string,
  texts: readonly string[],
  timeout = 10000,
  interval = 100,
): Promise<string> {
  if (texts.length === 0) throw new Error('waitForAnyText requires at least one text');
  const effectiveTimeout = tuiWaitTimeout(timeout);
  const effectiveInterval = tuiPollInterval(interval);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    const output = getOutput();
    if (texts.some((text) => screenContains(output, text))) return output;
    await new Promise((resolve) => setTimeout(resolve, effectiveInterval));
  }
  const last = stripAnsi(getOutput());
  throw new Error(
    `Timeout (${effectiveTimeout}ms) waiting for any of ${JSON.stringify(texts)}.\n` +
      `Last output:\n${last.slice(-1000)}`,
  );
}

/** Poll for text to disappear from PTY output. */
export async function waitForTextGone(
  getOutput: () => string,
  text: string,
  timeout = 5000,
  interval = 100,
): Promise<void> {
  const effectiveTimeout = tuiWaitTimeout(timeout);
  const effectiveInterval = tuiPollInterval(interval);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (!screenContains(getOutput(), text)) return;
    await new Promise((r) => setTimeout(r, effectiveInterval));
  }
  throw new Error(`Timeout (${effectiveTimeout}ms) waiting for "${text}" to disappear`);
}

/** Poll a non-terminal condition until it becomes true. */
export async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeout = 10000,
  interval = 100,
): Promise<void> {
  const effectiveTimeout = tuiWaitTimeout(timeout);
  const effectiveInterval = tuiPollInterval(interval);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, effectiveInterval));
  }
  throw new Error(`Timeout (${effectiveTimeout}ms) waiting for ${description}`);
}

/** Assert that text remains absent for an explicit observation window. */
export async function expectTextAbsentFor(
  getOutput: () => string,
  text: string,
  duration = 500,
  interval = 25,
): Promise<void> {
  const effectiveInterval = tuiPollInterval(interval);
  const start = Date.now();
  while (Date.now() - start < duration) {
    if (screenContains(getOutput(), text)) {
      throw new Error(`Expected "${text}" to remain absent for ${duration}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, effectiveInterval));
  }
}

/**
 * Wait until terminal output stops changing for a bounded quiet window. Use
 * this after a semantic wait when the assertion needs the settled Ink frame;
 * it replaces fixed sleeps without guessing how long a shared runner needs.
 */
export async function waitForOutputQuiescence(
  getOutput: () => string,
  timeout = 5000,
  quietWindow = 250,
  requireOutput = true,
): Promise<string> {
  const effectiveTimeout = tuiWaitTimeout(timeout);
  const effectiveInterval = tuiPollInterval(Math.min(quietWindow / 4, 50));
  const startedAt = Date.now();
  let lastChangedAt = startedAt;
  let lastOutput = getOutput();
  let sawOutput = lastOutput.length > 0;

  while (Date.now() - startedAt < effectiveTimeout) {
    await new Promise((resolve) => setTimeout(resolve, effectiveInterval));
    const output = getOutput();
    if (output !== lastOutput) {
      lastOutput = output;
      sawOutput ||= output.length > 0;
      lastChangedAt = Date.now();
      continue;
    }
    if ((!requireOutput || sawOutput) && Date.now() - lastChangedAt >= quietWindow) return output;
  }

  throw new Error(
    `Timeout (${effectiveTimeout}ms) waiting for ${
      requireOutput ? 'new terminal output and ' : ''
    }a quiet window of ${quietWindow}ms.\n` + `Last output:\n${stripAnsi(lastOutput).slice(-1000)}`,
  );
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
