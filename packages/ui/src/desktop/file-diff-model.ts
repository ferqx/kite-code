/** Presentation only: consume the host's bounded receipt, never read or reconstruct a file. */
export const DIFF_PREVIEW_BYTES = 64 * 1024;
export const DIFF_PREVIEW_ROWS = 400;
export const DIFF_LINE_UNITS = 2048;
const TOKEN_LIMIT = 1024;
const LINE_TOKEN_LIMIT = 48;

export type DiffToken = {
  text: string;
  kind?: 'comment' | 'string' | 'keyword' | 'number' | 'type';
};
export type DiffLine = { text: string; number?: number; tokens: readonly DiffToken[] };
export type DiffRow =
  | { kind: 'context'; before?: DiffLine; after?: DiffLine }
  | { kind: 'change'; before?: DiffLine; after?: DiffLine }
  | { kind: 'meta' | 'omitted' | 'raw'; text: string };
export type DiffModel = {
  format: 'operation' | 'git' | 'plain';
  split: readonly DiffRow[];
  unified: readonly DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
  omitted: boolean;
};
export type DiffDisplayRow = DiffRow | { kind: 'fold'; id: number; count: number };

type Atom =
  | { kind: 'context'; before: DiffLine; after: DiffLine }
  | { kind: 'added'; line: DiffLine }
  | { kind: 'removed'; line: DiffLine }
  | { kind: 'meta' | 'omitted' | 'raw'; text: string };

export function clipDiffLine(text: string): string {
  if (text.length <= DIFF_LINE_UNITS) return text;
  let end = DIFF_LINE_UNITS - 1;
  if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

/** UTF-8 budget, including newlines, without allocating/encoding an unbounded source. */
function boundedLines(source: string): { lines: string[]; truncated: boolean } {
  let end = 0;
  let bytes = 0;
  let start = 0;
  const lines: string[] = [];
  while (end < source.length && lines.length < DIFF_PREVIEW_ROWS) {
    const code = source.charCodeAt(end);
    const pair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      source.charCodeAt(end + 1) >= 0xdc00 &&
      source.charCodeAt(end + 1) <= 0xdfff;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > DIFF_PREVIEW_BYTES) break;
    bytes += size;
    end += pair ? 2 : 1;
    if (code === 10) {
      lines.push(source.slice(start, end - (source[end - 2] === '\r' ? 2 : 1)));
      start = end;
    }
  }
  if (start < end && lines.length < DIFF_PREVIEW_ROWS) lines.push(source.slice(start, end));
  return { lines, truncated: end < source.length };
}

const KEYWORDS = new Set(
  'as async await break case catch class const continue def default delete else enum export extends false finally fn for from function if impl import in interface let match new null of pass private protected public raise return self static struct super switch throw true try type typeof undefined use var void while yield'.split(
    ' ',
  ),
);
const CODE_PATH =
  /\.(?:[cm]?[jt]sx?|jsonc?|py|rs|go|java|[ch](?:pp)?|cs|swift|kt|sh|bash|sql|css|scss|ya?ml|toml)$/i;

/** A small lexical palette, not a grammar loader. Both work and span allocation are capped. */
function tokenize(text: string, enabled: boolean, budget: { remaining: number }): DiffToken[] {
  if (!enabled || !budget.remaining || text.length > 1024) return [{ text }];
  const result: DiffToken[] = [];
  let plain = 0;
  let at = 0;
  while (at < text.length && result.length < LINE_TOKEN_LIMIT - 2 && budget.remaining > 1) {
    const start = at;
    const char = text[at]!;
    let kind: DiffToken['kind'];
    if (char === '/' && text[at + 1] === '/') {
      at = text.length;
      kind = 'comment';
    } else if (char === '"' || char === "'" || char === '`') {
      at++;
      while (at < text.length) {
        if (text[at++] === '\\') at = Math.min(at + 1, text.length);
        else if (text[at - 1] === char) break;
      }
      kind = 'string';
    } else if (/[A-Za-z_$]/.test(char)) {
      at++;
      while (at < text.length && /[\w$]/.test(text[at]!)) at++;
      const word = text.slice(start, at);
      if (KEYWORDS.has(word)) kind = 'keyword';
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) kind = 'type';
    } else if (/\d/.test(char) && (at === 0 || !/[\w$]/.test(text[at - 1]!))) {
      at++;
      while (at < text.length && /[\w.]/.test(text[at]!)) at++;
      kind = 'number';
    } else at++;
    if (!kind) continue;
    if (plain < start) {
      result.push({ text: text.slice(plain, start) });
      budget.remaining--;
    }
    result.push({ text: text.slice(start, at), kind });
    budget.remaining--;
    plain = at;
  }
  if (plain < text.length) result.push({ text: text.slice(plain) });
  return result.length ? result : [{ text }];
}

function number(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const NUMBERED = /^ *(\d+) ([ +-])(.*)$/;
const OPERATION_HEADER =
  /^Line diff \(bounded alignment; unchanged gaps omitted\)$|^Wrote \d+ lines to /;
const PRODUCER_LIMIT =
  /\.\.\. preview truncated \(64 KiB \/ 400 line limit\) \.\.\.|… \[line truncated at 2048 UTF-16 units\]|… \[path truncated\]/;

export function parseFileDiff(source: string, path = ''): DiffModel {
  const bounded = boundedLines(source);
  const lines = bounded.lines;
  const format = lines.some((line) => HUNK.test(line) || line.startsWith('diff --git '))
    ? 'git'
    : lines.some((line) => OPERATION_HEADER.test(line) || NUMBERED.test(line))
      ? 'operation'
      : 'plain';
  let truncated = bounded.truncated;
  let omitted = false;
  let added = 0;
  let removed = 0;
  const budget = { remaining: TOKEN_LIMIT };
  const syntax = CODE_PATH.test(path.slice(-32));
  const makeLine = (text: string, lineNumber?: number): DiffLine => {
    if (text.length > DIFF_LINE_UNITS) truncated = true;
    const clipped = clipDiffLine(text);
    return { text: clipped, number: lineNumber, tokens: tokenize(clipped, syntax, budget) };
  };
  const atoms: Atom[] = [];
  let hunk: { old: number; next: number; oldLeft: number; newLeft: number } | undefined;
  for (const raw of lines) {
    if (PRODUCER_LIMIT.test(raw)) truncated = true;
    const text = clipDiffLine(raw);
    if (format === 'operation') {
      if (raw === '... unchanged lines omitted ...') {
        omitted = true;
        atoms.push({ kind: 'omitted', text: '部分未变更行未保留，无法展开' });
        continue;
      }
      const match = NUMBERED.exec(raw);
      const n = match ? number(match[1]!) : undefined;
      if (match && n !== undefined && n > 0) {
        const line = makeLine(match[3]!, n);
        if (match[2] === '+') {
          added++;
          atoms.push({ kind: 'added', line });
        } else if (match[2] === '-') {
          removed++;
          atoms.push({ kind: 'removed', line });
        } else {
          // The operation producer records NEW line numbers for context only.
          // Text is verified unchanged; the absent old position stays unknown.
          atoms.push({ kind: 'context', before: { ...line, number: undefined }, after: line });
        }
        continue;
      }
      if (text !== raw) truncated = true;
      atoms.push({ kind: 'meta', text });
      continue;
    }
    if (format === 'git') {
      const header = HUNK.exec(raw);
      if (header) {
        const old = number(header[1]!);
        const next = number(header[3]!);
        const oldLeft = number(header[2] ?? '1');
        const newLeft = number(header[4] ?? '1');
        hunk =
          old !== undefined &&
          next !== undefined &&
          oldLeft !== undefined &&
          newLeft !== undefined &&
          Number.isSafeInteger(old + oldLeft) &&
          Number.isSafeInteger(next + newLeft) &&
          (old > 0 || oldLeft === 0) &&
          (next > 0 || newLeft === 0)
            ? { old, next, oldLeft, newLeft }
            : undefined;
        if (text !== raw) truncated = true;
        atoms.push({ kind: 'meta', text });
        continue;
      }
      if (raw === '\\ No newline at end of file') {
        if (text !== raw) truncated = true;
        atoms.push({ kind: 'meta', text });
        continue;
      }
      if (hunk && raw.startsWith('-') && hunk.oldLeft > 0) {
        atoms.push({ kind: 'removed', line: makeLine(raw.slice(1), hunk.old++) });
        hunk.oldLeft--;
        removed++;
        continue;
      }
      if (hunk && raw.startsWith('+') && hunk.newLeft > 0) {
        atoms.push({ kind: 'added', line: makeLine(raw.slice(1), hunk.next++) });
        hunk.newLeft--;
        added++;
        continue;
      }
      if (hunk && raw.startsWith(' ') && hunk.oldLeft > 0 && hunk.newLeft > 0) {
        const before = makeLine(raw.slice(1), hunk.old++);
        atoms.push({ kind: 'context', before, after: { ...before, number: hunk.next++ } });
        hunk.oldLeft--;
        hunk.newLeft--;
        continue;
      }
      // Metadata, another file, a producer omission or malformed hunk ends numbering.
      hunk = undefined;
      if (text !== raw) truncated = true;
      atoms.push({ kind: 'meta', text });
      continue;
    }
    if (text !== raw) truncated = true;
    atoms.push({ kind: 'raw', text });
  }
  const unified: DiffRow[] = atoms.map((atom) => {
    if (atom.kind === 'added') return { kind: 'change', after: atom.line };
    if (atom.kind === 'removed') return { kind: 'change', before: atom.line };
    return atom;
  });
  const split: DiffRow[] = [];
  for (let i = 0; i < atoms.length; ) {
    const atom = atoms[i]!;
    if (atom.kind !== 'added' && atom.kind !== 'removed') {
      split.push(atom);
      i++;
      continue;
    }
    const before: DiffLine[] = [];
    const after: DiffLine[] = [];
    while (i < atoms.length) {
      const next = atoms[i]!;
      if (next.kind === 'removed' && after.length === 0) before.push(next.line);
      else if (next.kind === 'added') after.push(next.line);
      else break;
      i++;
    }
    for (let j = 0; j < Math.max(before.length, after.length); j++) {
      split.push({ kind: 'change', before: before[j], after: after[j] });
    }
  }
  return { format, split, unified, added, removed, truncated, omitted };
}

/** Only retained context can be folded. Expanding replaces, never adds to, its row budget. */
export function fileDiffRows(
  rows: readonly DiffRow[],
  expanded: ReadonlySet<number>,
): DiffDisplayRow[] {
  const result: DiffDisplayRow[] = [];
  for (let at = 0; at < rows.length; ) {
    const row = rows[at]!;
    if (row.kind !== 'context') {
      result.push(row);
      at++;
      continue;
    }
    let end = at + 1;
    while (end < rows.length && rows[end]!.kind === 'context') end++;
    if (end - at > 8 && !expanded.has(at)) {
      result.push(...rows.slice(at, at + 3));
      result.push({ kind: 'fold', id: at, count: end - at - 6 });
      result.push(...rows.slice(end - 3, end));
    } else result.push(...rows.slice(at, end));
    at = end;
  }
  return result;
}
