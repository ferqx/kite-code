import stringWidth from 'string-width';
import { fixedTuiCommands } from './commands';
import { fileReference, fileToken } from './file-candidates';

type Unit = { text: string; pasted?: true };
export type ComposerDisplay = (unit: Unit) => string;
export type ComposerLine = { start: number; end: number; cells: number };
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const units = (text: string): Unit[] =>
  Array.from(segmenter.segment(text), ({ segment }) => ({ text: segment }));
export function composerDisplay(
  unit: Unit,
  t: (label: string) => string = (label) => label,
): string {
  if (unit.pasted) return `[${t('Pasted')} ${Array.from(unit.text).length} ${t('characters')}]`;
  return unit.text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: display terminal protocol bytes as text; raw input stays unchanged.
    /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
/** Volatile editor only. The controller and host retain the real, unabridged draft. */
export class ComposerBuffer {
  parts: Unit[] = [];
  cursor = 0;
  private endAffinity = false;
  candidate = 0;
  dismissed = false;
  private history: Unit[][] = [];
  private historyIndex = -1;
  private scratch: Unit[] = [];
  get text() {
    return this.parts.map((unit) => unit.text).join('');
  }
  sync(text: string) {
    if (text === this.text) return;
    this.parts = units(text);
    this.cursor = this.parts.length;
    this.changed();
  }
  private changed() {
    const offset = this.parts
      .slice(0, this.cursor)
      .reduce((sum, part) => sum + part.text.length, 0);
    const normalized: Unit[] = [];
    let plain = '';
    const flush = () => {
      normalized.push(...units(plain));
      plain = '';
    };
    for (const part of this.parts) {
      if (part.pasted) {
        flush();
        normalized.push(part);
      } else plain += part.text;
    }
    flush();
    this.parts = normalized;
    let length = 0;
    this.cursor = 0;
    while (this.cursor < this.parts.length && length < offset) {
      length += this.parts[this.cursor]!.text.length;
      this.cursor++;
    }
    this.endAffinity = false;
    this.dismissed = false;
    this.candidate = 0;
  }
  insert(text: string, paste = false) {
    const next =
      paste && (text.length > 80 || text.includes('\n'))
        ? [{ text, pasted: true as const }]
        : units(text);
    this.parts.splice(this.cursor, 0, ...next);
    this.cursor += next.length;
    this.historyIndex = -1;
    this.changed();
  }
  remove(backwards: boolean) {
    const index = backwards ? this.cursor - 1 : this.cursor;
    if (index < 0 || index >= this.parts.length) return;
    this.parts.splice(index, 1);
    if (backwards) this.cursor--;
    this.changed();
  }
  horizontal(direction: -1 | 1) {
    this.endAffinity = false;
    this.cursor = Math.max(0, Math.min(this.parts.length, this.cursor + direction));
  }
  lines(width: number, display: ComposerDisplay = composerDisplay): ComposerLine[] {
    const result: ComposerLine[] = [];
    let start = 0,
      cells = 0;
    for (let index = 0; index < this.parts.length; index++) {
      const part = this.parts[index]!;
      if (!part.pasted && part.text === '\n') {
        result.push({ start, end: index, cells });
        start = index + 1;
        cells = 0;
        continue;
      }
      const size = stringWidth(display(part));
      if (cells && cells + size > width) {
        result.push({ start, end: index, cells });
        start = index;
        cells = 0;
      }
      cells += size;
    }
    result.push({ start, end: this.parts.length, cells });
    return result;
  }
  row(width: number, display: ComposerDisplay = composerDisplay) {
    const lines = this.lines(width, display);
    let index = lines.length - 1;
    while (index > 0 && this.cursor < lines[index]!.start) index--;
    if (
      this.endAffinity &&
      index > 0 &&
      this.cursor === lines[index]!.start &&
      lines[index - 1]!.end === this.cursor
    )
      index--;
    return { lines, index, line: lines[index]! };
  }
  boundary(end: boolean, width: number, display: ComposerDisplay = composerDisplay) {
    const { line } = this.row(width, display);
    this.cursor = end ? line.end : line.start;
    this.endAffinity = end;
  }
  vertical(direction: -1 | 1, width: number, display: ComposerDisplay = composerDisplay) {
    const { lines, index, line } = this.row(width, display),
      target = lines[index + direction];
    if (!target) {
      this.navigateHistory(direction);
      return;
    }
    const column = stringWidth(
      this.parts
        .slice(line.start, this.cursor)
        .map((part) => display(part))
        .join(''),
    );
    let next = target.start,
      cells = 0;
    while (next < target.end) {
      const size = stringWidth(display(this.parts[next]!));
      if (cells + size > column) break;
      cells += size;
      next++;
    }
    this.cursor = next;
    this.endAffinity = next === target.end;
  }
  remember() {
    if (!this.text.trim()) return;
    this.history.push(structuredClone(this.parts));
    if (this.history.length > 100) this.history.shift();
    this.historyIndex = -1;
  }
  private navigateHistory(direction: -1 | 1) {
    if (direction === -1) {
      if (!this.history.length) return;
      if (this.historyIndex === -1) {
        this.scratch = structuredClone(this.parts);
        this.historyIndex = this.history.length;
      }
      this.historyIndex = Math.max(0, this.historyIndex - 1);
      this.parts = structuredClone(this.history[this.historyIndex]!);
    } else {
      if (this.historyIndex === -1) return;
      this.historyIndex++;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1;
        this.parts = structuredClone(this.scratch);
      } else this.parts = structuredClone(this.history[this.historyIndex]!);
    }
    this.cursor = this.parts.length;
    this.changed();
  }
  get fileToken() {
    if (this.dismissed) return undefined;
    const offset = this.parts.slice(0, this.cursor).reduce((n, p) => n + p.text.length, 0);
    const token = fileToken(this.text, offset);
    if (!token) return undefined;
    let pos = 0;
    for (const part of this.parts) {
      const end = pos + part.text.length;
      if (part.pasted && pos < token.end && end > token.start) return undefined;
      pos = end;
    }
    return token;
  }
  completeFile(path: string, key: string) {
    const token = this.fileToken;
    if (!token || token.key !== key) return false;
    const inserted = fileReference(path);
    this.parts = units(this.text.slice(0, token.start) + inserted + this.text.slice(token.end));
    const offset = token.start + inserted.length;
    let pos = 0;
    this.cursor = 0;
    while (this.cursor < this.parts.length && pos < offset)
      pos += this.parts[this.cursor++]!.text.length;
    this.dismissed = true;
    this.candidate = 0;
    return true;
  }
  get candidates() {
    if (this.dismissed || !/^\/[a-z]*$/i.test(this.text)) return [];
    return fixedTuiCommands.filter((command) => command.startsWith(this.text.toLowerCase()));
  }
  complete() {
    const choice = this.candidates[this.candidate];
    if (!choice) return false;
    this.parts = units(choice);
    this.cursor = this.parts.length;
    this.dismissed = true;
    return true;
  }
}
