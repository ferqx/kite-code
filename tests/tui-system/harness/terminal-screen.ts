/**
 * Terminal Screen Model — ANSI stripping and text extraction for PTY output.
 *
 * PTY output contains raw ANSI escape sequences (colors, cursor movement,
 * clear screen, terminal titles, etc.). This module strips those sequences
 * to produce clean text suitable for assertions.
 *
 * `createHeadlessTerminalScreen()` is authoritative for UI assertions. The
 * regex helpers below remain useful for action-scoped raw-output diagnostics.
 */

import { Terminal } from '@xterm/headless';
import { tuiSystemDelay } from './cancellation';
import { tuiPollInterval, tuiWaitTimeout } from './timing';

export interface HeadlessTerminalScreen {
  /** Queue raw PTY bytes for VT parsing. */
  append(chunk: Uint8Array): Promise<void>;
  /** Resize the modeled terminal in the same order as pending PTY output. */
  resize(cols: number, rows: number): Promise<void>;
  /** Text currently visible in the terminal viewport. */
  viewport(): string;
  /**
   * Viewport projection for harness-owned input actions, whose cursor remains
   * at input end. Removes CtrlSafeTextInput's synthetic inverse-space cursor.
   */
  inputViewport(): string;
  /** Text retained by the terminal buffer, including scrollback. */
  scrollback(): string;
  /** Wait until all queued PTY bytes and resizes have been parsed. */
  settled(): Promise<void>;
  /** Capture a checkpoint in the sequence of parsed terminal frames. */
  mark(): TerminalFrameMark;
  /** Return modeled viewport frames parsed after a checkpoint. */
  framesSince(mark: TerminalFrameMark): readonly string[];
  dispose(): void;
}

const MAX_RETAINED_TERMINAL_FRAMES = 4096;

declare const TERMINAL_FRAME_MARK: unique symbol;
export type TerminalFrameMark = number & { readonly [TERMINAL_FRAME_MARK]: true };

function bufferText(
  terminal: Terminal,
  range: { start: number; end: number },
  options: { omitPromptCursor?: boolean } = {},
): string {
  const buffer = terminal.buffer.active;
  const logicalLines: Array<{ text: string; physicalRows: number[] }> = [];

  for (let index = range.start; index < range.end; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1]!.text += text;
      logicalLines[logicalLines.length - 1]!.physicalRows.push(index);
    } else {
      logicalLines.push({ text, physicalRows: [index] });
    }
  }

  if (options.omitPromptCursor) {
    let promptLineIndex = -1;
    for (let index = logicalLines.length - 1; index >= 0; index--) {
      if (/^\s*❯(?:\s|$)/.test(logicalLines[index]!.text)) {
        promptLineIndex = index;
        break;
      }
    }

    if (promptLineIndex >= 0) {
      let inputEndLineIndex = promptLineIndex;
      for (let index = promptLineIndex + 1; index < logicalLines.length; index++) {
        const trimmed = logicalLines[index]!.text.trim();
        if (/^[─━═╭╰┌└]/.test(trimmed) || /^(?:mock-model|\S+\s+·)/.test(trimmed)) break;
        inputEndLineIndex = index;
      }

      for (let index = inputEndLineIndex; index >= promptLineIndex; index--) {
        const projectionLine = logicalLines[index]!;
        const finalPhysicalRow = projectionLine.physicalRows.at(-1);
        const finalLine =
          finalPhysicalRow === undefined ? undefined : buffer.getLine(finalPhysicalRow);
        if (!projectionLine.text.endsWith(' ') || !finalLine) continue;
        for (let column = terminal.cols - 1; column >= 0; column--) {
          const cell = finalLine.getCell(column);
          if (!cell || cell.getCode() === 0) continue;
          if (cell.getChars() === ' ' && cell.isInverse()) {
            projectionLine.text = projectionLine.text.slice(0, -1);
          }
          break;
        }
        break;
      }
    }
  }

  while (logicalLines.length > 0 && logicalLines.at(-1)?.text === '') logicalLines.pop();
  return logicalLines.map((line) => line.text).join('\n');
}

/**
 * Model the terminal state produced by the PTY stream. Raw transcripts retain
 * erased Ink frames, so they are useful for diagnostics but not UI assertions.
 */
export function createHeadlessTerminalScreen(
  cols: number,
  rows: number,
  maxRetainedFrames = MAX_RETAINED_TERMINAL_FRAMES,
): HeadlessTerminalScreen {
  if (!Number.isInteger(maxRetainedFrames) || maxRetainedFrames < 1) {
    throw new Error(`maxRetainedFrames must be a positive integer; received ${maxRetainedFrames}`);
  }
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 10_000,
    scrollOnEraseInDisplay: false,
    logLevel: 'off',
  });
  let pending = Promise.resolve();
  let disposed = false;
  const frames: Array<{ sequence: number; text: string }> = [];
  let nextOperationSequence = 0;
  let marksBeforeSequenceAreExpired = 0;

  const viewport = (): string => {
    const buffer = terminal.buffer.active;
    return bufferText(terminal, {
      start: buffer.viewportY,
      end: Math.min(buffer.viewportY + terminal.rows, buffer.length),
    });
  };

  const captureFrame = (sequence: number): void => {
    const frame = viewport();
    if (frames.at(-1)?.text === frame) return;
    frames.push({ sequence, text: frame });
    if (frames.length > maxRetainedFrames) {
      const removed = frames.splice(0, frames.length - maxRetainedFrames);
      marksBeforeSequenceAreExpired = Math.max(
        marksBeforeSequenceAreExpired,
        (removed.at(-1)?.sequence ?? -1) + 1,
      );
    }
  };

  const enqueue = (operation: () => void | Promise<void>): Promise<void> => {
    pending = pending.then(async () => {
      if (disposed) return;
      await operation();
    });
    return pending;
  };

  return {
    append(chunk) {
      const copy = chunk.slice();
      const sequence = nextOperationSequence++;
      return enqueue(
        () =>
          new Promise<void>((resolve) => {
            terminal.write(copy, () => {
              captureFrame(sequence);
              resolve();
            });
          }),
      );
    },
    resize(nextCols, nextRows) {
      const sequence = nextOperationSequence++;
      return enqueue(() => {
        terminal.resize(nextCols, nextRows);
        captureFrame(sequence);
      });
    },
    viewport() {
      return viewport();
    },
    inputViewport() {
      const buffer = terminal.buffer.active;
      return bufferText(
        terminal,
        {
          start: buffer.viewportY,
          end: Math.min(buffer.viewportY + terminal.rows, buffer.length),
        },
        { omitPromptCursor: true },
      );
    },
    scrollback() {
      return bufferText(terminal, { start: 0, end: terminal.buffer.active.length });
    },
    settled() {
      return pending;
    },
    mark() {
      return nextOperationSequence as TerminalFrameMark;
    },
    framesSince(mark) {
      if (!Number.isInteger(mark) || mark < 0 || mark > nextOperationSequence) {
        throw new Error(
          `Invalid terminal frame mark ${mark}; current operation sequence is ${nextOperationSequence}`,
        );
      }
      if (mark < marksBeforeSequenceAreExpired) {
        throw new Error(
          `Terminal frame mark ${mark} expired; earliest retained operation is ${marksBeforeSequenceAreExpired}`,
        );
      }
      return frames.filter((frame) => frame.sequence >= mark).map((frame) => frame.text);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      terminal.dispose();
    },
  };
}

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

/** Match a visible SessionSelector row rather than modal chrome or background conversation text. */
export function screenHasSessionRow(
  raw: string,
  name: string,
  expected: { selected?: boolean; active?: boolean } = {},
): boolean {
  if (!screenContains(raw, '会话列表')) return false;

  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const borderedLine = line.trimStart();
    if (!borderedLine.startsWith('│')) continue;
    const nameIndex = borderedLine.indexOf(name, 1);
    if (nameIndex < 0) continue;

    const prefix = borderedLine.slice(1, nameIndex);
    const rowPrefix = /^\s*(?<cursor>>|⏳)?\s*(?<active>●)?\s*$/.exec(prefix);
    if (!rowPrefix) continue;

    const selected = rowPrefix.groups?.cursor === '>';
    const active = rowPrefix.groups?.active === '●';
    if (expected.selected !== undefined && selected !== expected.selected) continue;
    if (expected.active !== undefined && active !== expected.active) continue;
    return true;
  }

  return false;
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
    await tuiSystemDelay(effectiveInterval);
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
    await tuiSystemDelay(effectiveInterval);
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
    await tuiSystemDelay(effectiveInterval);
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
    await tuiSystemDelay(effectiveInterval);
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
    await tuiSystemDelay(effectiveInterval);
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
    await tuiSystemDelay(effectiveInterval);
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
