// Soft-wrap utility shared by CtrlSafeTextInput and BlockRenderer (user block).
// Handles CJK double-width characters and script-boundary breaks that plain
// wrapAnsi with hard:true cannot handle correctly.

import stringWidth from 'string-width';

// ── Character classification ──

export function isCJK(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x3130 && code <= 0x318f) || // Hangul Compatibility Jamo
    (code >= 0xff00 && code <= 0xffef) || // Fullwidth forms
    (code >= 0x3000 && code <= 0x303f) // CJK punctuation
  );
}

export function isASCIILetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

// ── Width computation on code-point arrays ──

function computeWidth(chars: string[], start: number, end: number): number {
  let width = 0;
  for (let k = start; k < end && k < chars.length; k++) {
    width += stringWidth(chars[k]!);
  }
  return width;
}

/** Split a string into Unicode code points (preserving surrogates). */
function toCodePoints(text: string): string[] {
  const chars: string[] = [];
  let _pos = 0;
  for (const char of text) {
    chars.push(char);
    _pos += char.length;
  }
  return chars;
}

export interface WrappedLine {
  text: string;
  /** UTF-16 index in the original logical line */
  start: number;
}

/**
 * Soft-wrap a single logical line into visual lines that fit within `maxWidth`
 * display columns. Each CJK character is counted as 2 columns via string-width.
 *
 * Break priorities for a line that would overflow:
 *   1. Latest whitespace that keeps the line content within `maxWidth`.
 *      Whitespace itself is excluded from the line. Only applies when both
 *      sides of the whitespace are ASCII letters (English word boundary).
 *   2. Latest CJK/Non-CJK script boundary, but only when the remaining gap on
 *      the line is too small to fit the next script's first character.
 *   3. Hard break at the last character that still fits.
 */
export function softWrapLine(text: string, maxWidth: number): WrappedLine[] {
  if (maxWidth <= 0 || text.length === 0) {
    return [{ text, start: 0 }];
  }

  const chars = toCodePoints(text);
  const indices: number[] = [];
  let pos = 0;
  for (const char of chars) {
    indices.push(pos);
    pos += char.length;
  }
  indices.push(pos);

  const result: WrappedLine[] = [];
  let lineStart = 0; // index in chars
  let lineStartIdx = 0; // UTF-16 index in text
  let lineWidth = 0;

  for (let i = 0; i < chars.length; i++) {
    const charWidth = stringWidth(chars[i]!);

    if (lineWidth + charWidth > maxWidth && i > lineStart) {
      let breakAt = -1;
      let excludeBreakChar = false;

      // 1. Latest whitespace whose preceding content fits (English word boundary only).
      for (let j = i - 1; j >= lineStart; j--) {
        if (chars[j] === ' ' || chars[j] === '\t') {
          let p = j - 1;
          while (p >= lineStart && (chars[p] === ' ' || chars[p] === '\t')) p--;
          let n = j + 1;
          while (n < chars.length && (chars[n] === ' ' || chars[n] === '\t')) n++;
          const prevChar = p >= lineStart ? chars[p] : undefined;
          const nextChar = n < chars.length ? chars[n] : undefined;
          if (prevChar && nextChar && isASCIILetter(prevChar) && isASCIILetter(nextChar)) {
            const contentWidth = computeWidth(chars, lineStart, j);
            if (contentWidth <= maxWidth) {
              breakAt = j;
              excludeBreakChar = true;
              break;
            }
          }
        }
      }

      // 2. Latest script boundary that fits without wasting usable space.
      if (breakAt < 0) {
        for (let j = i - 1; j >= lineStart; j--) {
          if (j + 1 < chars.length && isCJK(chars[j]!) !== isCJK(chars[j + 1]!)) {
            const widthUpToJ = computeWidth(chars, lineStart, j + 1);
            const nextCharWidth = stringWidth(chars[j + 1]!);
            if (widthUpToJ <= maxWidth && maxWidth - widthUpToJ < nextCharWidth) {
              breakAt = j;
              excludeBreakChar = false;
              break;
            }
          }
        }
      }

      // 3. Hard break at the last character that still fits.
      if (breakAt < 0) {
        for (let j = i - 1; j >= lineStart; j--) {
          if (computeWidth(chars, lineStart, j + 1) <= maxWidth) {
            breakAt = j;
            excludeBreakChar = false;
            break;
          }
        }
      }

      // Fallback: break before current char.
      if (breakAt < 0) {
        breakAt = i - 1;
        excludeBreakChar = false;
      }

      const lineEnd = breakAt + (excludeBreakChar ? 0 : 1);
      const lineText = chars.slice(lineStart, lineEnd).join('');
      result.push({ text: lineText, start: lineStartIdx });

      lineStart = breakAt + 1;
      lineStartIdx = indices[lineStart] ?? pos;
      lineWidth = 0;
      for (let k = lineStart; k <= i; k++) {
        lineWidth += stringWidth(chars[k]!);
      }
    } else {
      lineWidth += charWidth;
    }
  }

  result.push({ text: chars.slice(lineStart).join(''), start: lineStartIdx });
  return result;
}

/**
 * Split text into display lines. Explicit `\n` boundaries are preserved,
 * and long logical lines are soft-wrapped to `maxWidth` columns when provided.
 */
export function wrapDisplayLines(text: string, maxWidth?: number): string[] {
  if (maxWidth === undefined) {
    return text.length > 0 ? text.split('\n') : [''];
  }

  const logicalLines = text.length > 0 ? text.split('\n') : [''];
  const lines: string[] = [];

  for (const logicalLine of logicalLines) {
    if (maxWidth <= 0 || logicalLine.length === 0) {
      lines.push(logicalLine);
      continue;
    }

    const wrapped = softWrapLine(logicalLine, maxWidth);
    for (const { text: lineText } of wrapped) {
      lines.push(lineText);
    }
  }

  return lines;
}
