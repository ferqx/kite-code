import { Box, Text } from 'ink';
import React, { useMemo, useRef } from 'react';
import terminalStringWidth from 'string-width';
import { useWindowSize } from '#kite-cli/tui/hooks/useWindowSizeSig';
import { type Theme, useTheme } from '#kite-cli/tui/theme';

interface MarkdownBlockProps {
  content: string;
  streaming?: boolean;
  color?: string;
  /** 覆盖 useWindowSize 的 columns，用于容器已缩进时限制可用宽度 */
  maxWidth?: number;
}

export interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strikethrough?: boolean;
  link?: string;
}

// ── inline markdown parsing ──

export function parseInline(text: string): InlineSegment[] {
  const escaped: string[] = [];
  const protectedText = text.replace(/\\([\\`*{}[\]()#+\-.!_|>~])/g, (_, character: string) => {
    const index = escaped.push(character) - 1;
    return `\u{f0000}${index}\u{f0001}`;
  });
  const allPatterns =
    /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\))/g;
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  const restoreEscapes = (value: string) =>
    value.replace(/\u{f0000}(\d+)\u{f0001}/gu, (_, index: string) => escaped[Number(index)] ?? '');
  let match = allPatterns.exec(protectedText);

  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: restoreEscapes(protectedText.slice(lastIndex, match.index)) });
    }
    if (match[1]?.startsWith('***') && match[2] !== undefined) {
      segments.push({ text: restoreEscapes(match[2]), bold: true, italic: true });
    } else if (match[1]?.startsWith('**') && match[3] !== undefined) {
      segments.push({ text: restoreEscapes(match[3]), bold: true });
    } else if (match[1]?.startsWith('*') && !match[1]?.startsWith('**') && match[4] !== undefined) {
      segments.push({ text: restoreEscapes(match[4]), italic: true });
    } else if (match[5] !== undefined) {
      segments.push({ text: restoreEscapes(match[5]), code: true });
    } else if (match[6] !== undefined) {
      segments.push({ text: restoreEscapes(match[6]), strikethrough: true });
    } else if (match[7] !== undefined && match[8] !== undefined) {
      segments.push({
        text: restoreEscapes(match[7]),
        bold: true,
        link: restoreEscapes(match[8]),
      });
    }
    lastIndex = match.index + match[1]!.length;
    match = allPatterns.exec(protectedText);
  }

  if (lastIndex < protectedText.length) {
    segments.push({ text: restoreEscapes(protectedText.slice(lastIndex)) });
  }

  return segments;
}

function inlineVisibleText(text: string): string {
  return parseInline(text)
    .map((segment) => (segment.link ? `${segment.text} (${segment.link})` : segment.text))
    .join('');
}

// ── syntax highlighting for code blocks ──

interface Token {
  text: string;
  color?: string;
  bold?: boolean;
}

const TS_KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'try',
  'catch',
  'throw',
  'new',
  'class',
  'extends',
  'interface',
  'type',
  'async',
  'await',
  'default',
  'typeof',
  'instanceof',
  'in',
  'of',
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'super',
  'yield',
]);

const PY_KEYWORDS = new Set([
  'import',
  'from',
  'def',
  'return',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'try',
  'except',
  'raise',
  'class',
  'with',
  'as',
  'pass',
  'break',
  'continue',
  'True',
  'False',
  'None',
  'and',
  'or',
  'not',
  'in',
  'is',
  'lambda',
  'yield',
  'self',
  'print',
]);

const SH_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'return',
  'exit',
  'export',
  'local',
  'source',
  'echo',
  'cd',
  'ls',
  'rm',
  'mv',
  'cp',
  'mkdir',
  'git',
  'npm',
  'yarn',
  'bun',
  'node',
  'python',
  'pip',
  'cargo',
]);

function detectLang(fenceLine: string): string {
  const lang = fenceLine.slice(3).trim().toLowerCase();
  if (['ts', 'tsx', 'typescript'].includes(lang)) return 'ts';
  if (['js', 'jsx', 'javascript'].includes(lang)) return 'ts';
  if (['py', 'python'].includes(lang)) return 'py';
  if (['sh', 'bash', 'shell', 'zsh'].includes(lang)) return 'sh';
  if (['json'].includes(lang)) return 'json';
  return lang || '';
}

function tokenizeCodeLine(line: string, lang: string, t: Theme): Token[] {
  if (!lang || !line.trim()) return [{ text: line }];

  const tokens: Token[] = [];
  let i = 0;

  while (i < line.length) {
    if (
      (lang === 'ts' || lang === 'py' || lang === 'sh') &&
      line[i]! === '/' &&
      line[i + 1]! === '/'
    ) {
      tokens.push({ text: line.slice(i), color: t.dim });
      return tokens;
    }
    if (lang === 'py' && line[i]! === '#') {
      tokens.push({ text: line.slice(i), color: t.dim });
      return tokens;
    }
    if (lang === 'sh' && line[i]! === '#') {
      tokens.push({ text: line.slice(i), color: t.dim });
      return tokens;
    }

    if (line[i]! === '"' || line[i]! === "'" || line[i]! === '`') {
      const quote = line[i]!;
      let j = i + 1;
      while (j < line.length && line[j]! !== quote) {
        if (line[j]! === '\\') j++;
        j++;
      }
      if (j < line.length) j++;
      const str = line.slice(i, j);
      tokens.push({ text: str, color: t.success });
      i = j;
      continue;
    }

    if (/[0-9]/.test(line[i]!) && (i === 0 || /[\s([{=+\-*/%<>,;:]/.test(line[i - 1]!))) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxX._]/.test(line[j]!)) j++;
      const num = line.slice(i, j);
      if (/^[0-9]/.test(num)) {
        tokens.push({ text: num, color: t.primary });
        i = j;
        continue;
      }
    }

    if (/[a-zA-Z_$]/.test(line[i]!)) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      const kw = lang === 'py' ? PY_KEYWORDS : lang === 'sh' ? SH_KEYWORDS : TS_KEYWORDS;
      if (kw.has(word)) {
        tokens.push({ text: word, color: t.primary, bold: true });
      } else {
        tokens.push({ text: word });
      }
      i = j;
      continue;
    }

    tokens.push({ text: line[i]! });
    i++;
  }

  return tokens;
}

const CodeLine = React.memo(function CodeLine({ line, lang }: { line: string; lang: string }) {
  const t = useTheme();
  if (!lang) {
    return <Text color={t.muted}>{line}</Text>;
  }

  const tokens = tokenizeCodeLine(line, lang, t);
  return (
    <Text>
      {tokens.map((tok, i) => (
        <Text key={i} color={tok.color ?? t.muted} bold={tok.bold}>
          {tok.text}
        </Text>
      ))}
    </Text>
  );
});

// ── CJK display width ──

/** 代码行中 tab 的展宽列数 — 大多数终端默认 4 或 8，此处保守取 4 */
const TAB_WIDTH = 4;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function stringWidth(s: string): number {
  return terminalStringWidth(s);
}

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

/** 计算代码行在终端中的实际展宽，\t 按 TAB_WIDTH 展开
 *  Measure a code line's visual width with tab expansion. */
function codeLineWidth(line: string): number {
  let width = 0;
  for (const grapheme of graphemes(line)) {
    if (grapheme === '\t') {
      width += TAB_WIDTH;
    } else {
      width += stringWidth(grapheme);
    }
  }
  return width;
}

const CodeRow = React.memo(function CodeRow({
  line,
  lang,
  columns,
  borderColor,
}: {
  line: string;
  lang: string;
  columns: number;
  borderColor: string;
}) {
  const lineVisualWidth = codeLineWidth(line);
  const padLen = Math.max(0, columns - 3 - lineVisualWidth);
  return (
    <Box flexDirection="row">
      <Text color={borderColor}>│ </Text>
      <CodeLine line={line} lang={lang} />
      <Text color={borderColor}>{' '.repeat(padLen)}│</Text>
    </Box>
  );
});

// ── table detection & rendering ──

const PIPE = /[|│]/; // | or │ (box-drawing vertical)

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  // Markdown: | col1 | col2 | or │ col1 │ col2 │
  // Also support: col1 | col2 | col3 (no leading pipe)
  if (/^[|│]/.test(trimmed) && /[|│]$/.test(trimmed)) return true;
  // Row has at least one pipe separator → likely a table row
  const pipes = trimmed.match(/[|│]/g);
  return (pipes?.length ?? 0) >= 1;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Must contain at least one pipe (| or │) and consist of separator chars only
  if (!/[|│]/.test(trimmed)) return false;
  return /^[\s\-:|─━┼╿]+$/.test(trimmed);
}

function parseTable(lines: string[]): {
  headers: string[];
  rows: string[][];
  headerSources: string[];
  rowSources: string[][];
  widths: number[];
} {
  const parseCells = (line: string) => {
    let trimmed = line.trim();
    // Strip leading/trailing pipe │
    trimmed = trimmed.replace(/^[|│]\s*/, '').replace(/\s*[|│]$/, '');
    const cells: string[] = [];
    let cell = '';
    let inCode = false;
    for (let index = 0; index < trimmed.length; index++) {
      const character = trimmed[index]!;
      if (character === '\\' && index + 1 < trimmed.length) {
        cell += character + trimmed[index + 1]!;
        index++;
      } else if (character === '`') {
        inCode = !inCode;
        cell += character;
      } else if (!inCode && PIPE.test(character)) {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += character;
      }
    }
    cells.push(cell.trim());
    return cells;
  };

  const headerSources = parseCells(lines[0]!);
  const headers = headerSources.map(inlineVisibleText);
  const rows: string[][] = [];
  const rowSources: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const sources = parseCells(lines[i]!).slice(0, headers.length);
    while (sources.length < headers.length) sources.push('');
    rowSources.push(sources);
    rows.push(sources.map(inlineVisibleText));
  }

  const widths = headers.map((h, col) => {
    let max = stringWidth(h);
    rows.forEach((r) => {
      const cell = r[col] ?? '';
      const w = stringWidth(cell);
      if (w > max) max = w;
    });
    return max;
  });

  return { headers, rows, headerSources, rowSources, widths };
}

// ── responsive table width ──
// Maximum table width available, accounting for block left-padding in layout
function tableMaxWidth(columns: number): number {
  return Math.max(1, columns);
}

interface TableInlineSegment extends InlineSegment {
  tone?: 'primary' | 'dim';
}

function tableInlineSegments(source: string): TableInlineSegment[] {
  return parseInline(source).flatMap((segment): TableInlineSegment[] =>
    segment.link
      ? [
          { ...segment, tone: 'primary' },
          { text: ` (${segment.link})`, tone: 'dim' },
        ]
      : [segment],
  );
}

function appendTableSegment(target: TableInlineSegment[], segment: TableInlineSegment): void {
  const previous = target.at(-1);
  if (
    previous &&
    previous.bold === segment.bold &&
    previous.italic === segment.italic &&
    previous.code === segment.code &&
    previous.strikethrough === segment.strikethrough &&
    previous.tone === segment.tone
  ) {
    previous.text += segment.text;
  } else {
    target.push({ ...segment });
  }
}

function wrapTableCell(source: string, maxWidth: number): TableInlineSegment[][] {
  const lines: TableInlineSegment[][] = [[]];
  let currentWidth = 0;
  for (const segment of tableInlineSegments(source)) {
    for (const grapheme of graphemes(segment.text)) {
      const width = stringWidth(grapheme);
      if (currentWidth + width > maxWidth && currentWidth > 0) {
        lines.push([]);
        currentWidth = 0;
        if (grapheme === ' ') continue;
      }
      // A single CJK/emoji grapheme can be wider than a one-column cell in a
      // very narrow terminal. Preserve the table boundary instead of letting
      // that grapheme overflow into the next column.
      if (width > maxWidth) {
        appendTableSegment(lines.at(-1)!, { text: '…' });
        currentWidth = 1;
      } else {
        appendTableSegment(lines.at(-1)!, { ...segment, text: grapheme });
        currentWidth += width;
      }
    }
  }
  const finalWidth = lines.map((line) =>
    line.reduce((total, segment) => total + stringWidth(segment.text), 0),
  );
  lines.forEach((line, index) => {
    const padding = Math.max(0, maxWidth - finalWidth[index]!);
    if (padding > 0) appendTableSegment(line, { text: ' '.repeat(padding) });
  });
  return lines;
}

function truncateTableHeader(source: string, maxWidth: number): TableInlineSegment[] {
  const visibleWidth = stringWidth(inlineVisibleText(source));
  if (visibleWidth <= maxWidth) return wrapTableCell(source, maxWidth)[0]!;
  const result: TableInlineSegment[] = [];
  let width = 0;
  for (const segment of tableInlineSegments(source)) {
    for (const grapheme of graphemes(segment.text)) {
      const graphemeWidth = stringWidth(grapheme);
      if (width + graphemeWidth > maxWidth - 1) {
        appendTableSegment(result, { text: `…${' '.repeat(maxWidth - width - 1)}` });
        return result;
      }
      appendTableSegment(result, { ...segment, text: grapheme });
      width += graphemeWidth;
    }
  }
  return result;
}

function TableInlineText({ segments }: { segments: TableInlineSegment[] }) {
  const t = useTheme();
  return (
    <>
      {segments.map((segment, index) => (
        <Text
          key={index}
          bold={segment.bold}
          italic={segment.italic}
          strikethrough={segment.strikethrough}
          color={
            segment.tone === 'primary' || segment.code
              ? t.primary
              : segment.tone === 'dim'
                ? t.dim
                : undefined
          }
        >
          {segment.text}
        </Text>
      ))}
    </>
  );
}

function computeColumnWidths(
  headers: string[],
  _rows: string[][],
  naturalWidths: number[],
  columns: number,
): number[] {
  const colCount = headers.length;
  const overhead = 2 + (colCount - 1) + colCount * 2; // ││ + inner │ + padding
  const maxContentWidth = Math.max(colCount, tableMaxWidth(columns) - overhead);
  const naturalTotal = naturalWidths.reduce((a, w) => a + w, 0);
  if (naturalTotal <= maxContentWidth) return naturalWidths;
  if (maxContentWidth < colCount * 6) {
    const w = Math.max(1, Math.floor((tableMaxWidth(columns) - 1) / colCount) - 3);
    return headers.map(() => w);
  }
  const scale = maxContentWidth / naturalTotal;
  return naturalWidths.map((w) => Math.max(1, Math.floor(w * scale)));
}

/** Build a single border string: e.g. ┌────┬──────┐ */
function borderLine(
  left: string,
  mid: string,
  right: string,
  widths: number[],
  fill: string,
): string {
  return left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right;
}

const TableTextLine = React.memo(function TableTextLine({
  line,
  trailingNewline = true,
}: {
  line: string;
  trailingNewline?: boolean;
}) {
  return (
    <>
      {line}
      {trailingNewline ? '\n' : ''}
    </>
  );
});

const TableDataRow = React.memo(
  function TableDataRow({ cells, widths }: { cells: string[]; widths: number[] }) {
    const wrapped = cells.map((cell, index) => wrapTableCell(cell, widths[index]!));
    const lineCount = Math.max(1, ...wrapped.map((lines) => lines.length));
    return (
      <>
        {Array.from({ length: lineCount }, (_, lineIndex) => (
          <React.Fragment key={lineIndex}>
            {'│'}
            {wrapped.map((cellLines, cellIndex) => (
              <React.Fragment key={cellIndex}>
                {' '}
                <TableInlineText
                  segments={cellLines[lineIndex] ?? [{ text: ' '.repeat(widths[cellIndex]!) }]}
                />
                {' │'}
              </React.Fragment>
            ))}
            {'\n'}
          </React.Fragment>
        ))}
      </>
    );
  },
  (previous, next) =>
    previous.cells.length === next.cells.length &&
    previous.cells.every((cell, index) => cell === next.cells[index]) &&
    previous.widths.length === next.widths.length &&
    previous.widths.every((width, index) => width === next.widths[index]),
);

function TableBlock({ lines, columns }: { lines: string[]; columns: number }) {
  const {
    headers,
    rows,
    headerSources,
    rowSources,
    widths: natural,
  } = useMemo(() => parseTable(lines), [lines]);
  const widths = useMemo(
    () => computeColumnWidths(headers, rows, natural, columns),
    [headers, rows, natural, columns],
  );

  const topBorder = borderLine('┌', '┬', '┐', widths, '─');
  const sepBorder = borderLine('├', '┼', '┤', widths, '─');
  const botBorder = borderLine('└', '┴', '┘', widths, '─');

  // Keep one parent Text so Yoga cannot introduce gaps between borders, while
  // memoized child rows retain their identity as the streaming table grows.
  return (
    <Text>
      <TableTextLine line={topBorder} />
      {'│'}
      {headerSources.map((header, index) => (
        <React.Fragment key={index}>
          {' '}
          <TableInlineText segments={truncateTableHeader(header, widths[index]!)} />
          {' │'}
        </React.Fragment>
      ))}
      {'\n'}
      <TableTextLine line={sepBorder} />
      {rowSources.map((row, index) => (
        <TableDataRow key={index} cells={row} widths={widths} />
      ))}
      <TableTextLine line={botBorder} trailingNewline={false} />
    </Text>
  );
}

// ── HTML entity decoding ──
// Some models return HTML-escaped content (&#39; &quot; &amp; &lt; &gt;).
// Decode at render time so terminal displays the actual characters.
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// ── line grouping ──

export type LineGroup =
  | { kind: 'single'; line: string; index: number }
  | { kind: 'paragraph'; lines: string[]; startIndex: number }
  | { kind: 'list'; lines: string[]; startIndex: number }
  | { kind: 'quote'; lines: string[]; startIndex: number }
  | { kind: 'code'; lines: string[]; lang: string; startIndex: number }
  | { kind: 'table'; lines: string[]; startIndex: number };

function groupSourceIndex(group: LineGroup): number {
  return group.kind === 'single' ? group.index : group.startIndex;
}

const groupSignatureCache = new WeakMap<LineGroup, string>();

function groupSignature(group: LineGroup): string {
  const cached = groupSignatureCache.get(group);
  if (cached != null) return cached;
  const signature =
    group.kind === 'single'
      ? `single:${group.line}`
      : group.kind === 'paragraph'
        ? `paragraph:${group.lines.join('\n')}`
        : group.kind === 'list'
          ? `list:${group.lines.join('\n')}`
          : group.kind === 'quote'
            ? `quote:${group.lines.join('\n')}`
            : group.kind === 'code'
              ? `code:${group.lang}\0${group.lines.join('\n')}`
              : `table:${group.lines.join('\n')}`;
  groupSignatureCache.set(group, signature);
  return signature;
}

const MarkdownGroup = React.memo(
  function MarkdownGroup({
    group,
    render,
  }: {
    group: LineGroup;
    render: (group: LineGroup) => React.ReactNode;
  }) {
    return <>{render(group)}</>;
  },
  (previous, next) =>
    previous.render === next.render &&
    groupSignature(previous.group) === groupSignature(next.group),
);

function isParagraphLine(line: string): boolean {
  return (
    line.trim() !== '' &&
    !HEADING_RE.test(line) &&
    !isHorizontalRule(line) &&
    !UNORDERED_LIST_RE.test(line) &&
    !ORDERED_LIST_RE.test(line) &&
    !line.startsWith('> ') &&
    !line.startsWith('```')
  );
}

function isListLine(line: string): boolean {
  return UNORDERED_LIST_RE.test(line) || ORDERED_LIST_RE.test(line);
}

export function groupLines(lines: string[]): LineGroup[] {
  const groups: LineGroup[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Code block
    if (line.startsWith('```')) {
      const startIndex = i;
      const lang = detectLang(line);
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      groups.push({ kind: 'code', lines: codeLines, lang, startIndex });
      if (i < lines.length) i++; // skip closing ```
      continue;
    }

    // Table: must have header row + separator row
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const startIndex = i;
      const tableLines: string[] = [line, lines[i + 1]!];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) {
        tableLines.push(lines[i]!);
        i++;
      }
      groups.push({ kind: 'table', lines: tableLines, startIndex });
      continue;
    }

    if (isListLine(line)) {
      const startIndex = i;
      const listLines = [line];
      i++;
      while (i < lines.length && isListLine(lines[i]!)) {
        listLines.push(lines[i]!);
        i++;
      }
      groups.push({ kind: 'list', lines: listLines, startIndex });
      continue;
    }

    if (line.startsWith('> ')) {
      const startIndex = i;
      const quoteLines = [line];
      i++;
      while (i < lines.length && lines[i]!.startsWith('> ')) {
        quoteLines.push(lines[i]!);
        i++;
      }
      groups.push({ kind: 'quote', lines: quoteLines, startIndex });
      continue;
    }

    // Consecutive plain-text lines belong to one logical Markdown paragraph.
    // A later token can extend only this component without rebuilding every
    // completed line or paragraph before it.
    if (isParagraphLine(line)) {
      const startIndex = i;
      const paragraphLines = [line];
      i++;
      while (
        i < lines.length &&
        isParagraphLine(lines[i]!) &&
        !(isTableRow(lines[i]!) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
      ) {
        paragraphLines.push(lines[i]!);
        i++;
      }
      groups.push({ kind: 'paragraph', lines: paragraphLines, startIndex });
      continue;
    }

    groups.push({ kind: 'single', line, index: i });
    i++;
  }

  return groups;
}

export interface MarkdownParseCache {
  content: string;
  rawLines: string[];
  groups: LineGroup[];
}

function displayedDecodedLines(rawLines: string[]): string[] {
  const lines = rawLines.map(decodeHtmlEntities);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function offsetGroup(group: LineGroup, offset: number): LineGroup {
  if (offset === 0) return group;
  return group.kind === 'single'
    ? { ...group, index: group.index + offset }
    : { ...group, startIndex: group.startIndex + offset };
}

/**
 * Incrementally parse cumulative streaming Markdown. Only the last existing
 * group is reparsed because an appended token can extend or promote that
 * group (for example a pipe row becoming a table); every earlier group is
 * immutable and retains object identity for React.memo.
 */
export function updateMarkdownParseCache(
  previous: MarkdownParseCache | undefined,
  content: string,
): MarkdownParseCache {
  if (previous?.content === content) return previous;

  if (previous && content.startsWith(previous.content)) {
    const suffix = content.slice(previous.content.length);
    const rawLines = previous.rawLines.slice();
    const additions = suffix.split('\n');
    if (rawLines.length === 0) rawLines.push('');
    rawLines[rawLines.length - 1] = `${rawLines[rawLines.length - 1]}${additions[0] ?? ''}`;
    rawLines.push(...additions.slice(1));

    const lastGroup = previous.groups.at(-1);
    const reparseStart = lastGroup ? groupSourceIndex(lastGroup) : 0;
    const stableGroups = lastGroup ? previous.groups.slice(0, -1) : [];
    const tailLines = displayedDecodedLines(rawLines.slice(reparseStart));
    const tailGroups = groupLines(tailLines).map((group) => offsetGroup(group, reparseStart));
    return { content, rawLines, groups: [...stableGroups, ...tailGroups] };
  }

  const rawLines = content.split('\n');
  return {
    content,
    rawLines,
    groups: groupLines(displayedDecodedLines(rawLines)),
  };
}

function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
}

const HEADING_RE = /^#{1,6}\s/;
const UNORDERED_LIST_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

function isBlankGroup(g: LineGroup | undefined): boolean {
  return !!g && g.kind === 'single' && g.line.trim() === '';
}

function isHeadingGroup(g: LineGroup | undefined): boolean {
  return !!g && g.kind === 'single' && HEADING_RE.test(g.line);
}

function isListGroup(g: LineGroup | undefined): boolean {
  if (g?.kind === 'list') return true;
  if (g?.kind !== 'single') return false;
  const line = g.line;
  return (
    !isBlankGroup(g) &&
    !isHeadingGroup(g) &&
    !isHorizontalRule(line) &&
    UNORDERED_LIST_RE.test(line)
  );
}

function isQuoteGroup(g: LineGroup | undefined): boolean {
  return (
    !!g &&
    (g.kind === 'quote' || (g.kind === 'single' && g.line.startsWith('> ') && !isBlankGroup(g)))
  );
}

function isStructuralGroup(g: LineGroup | undefined): boolean {
  if (!g) return false;
  if (g.kind === 'table' || g.kind === 'code') return true;
  if (g.kind === 'single') {
    const line = g.line;
    return isHorizontalRule(line) || isHeadingGroup(g);
  }
  return false;
}

function spacingBetween(prev: LineGroup, next: LineGroup, blanks: number): number {
  if (isListGroup(prev) && isListGroup(next)) return 0;
  if (isQuoteGroup(prev) && isQuoteGroup(next)) return 0;
  if (
    isStructuralGroup(prev) ||
    isStructuralGroup(next) ||
    isListGroup(prev) ||
    isListGroup(next) ||
    isQuoteGroup(prev) ||
    isQuoteGroup(next)
  ) {
    return Math.max(1, Math.min(blanks, 1));
  }
  return Math.min(blanks, 1);
}

const ListRow = React.memo(function ListRow({ line, color }: { line: string; color?: string }) {
  const t = useTheme();
  const ulMatch = line.match(UNORDERED_LIST_RE);
  if (ulMatch) {
    const indent = ulMatch[1]!.length;
    let item = ulMatch[2]!;
    let bullet = '• ';
    const taskMatch = item.match(/^(\[[ xX]\])\s+(.*)$/);
    if (taskMatch) {
      bullet = taskMatch[1]! === '[ ]' ? '☐ ' : '☑ ';
      item = taskMatch[2]!;
    }
    return (
      <Box paddingLeft={indent}>
        <Text color={t.muted}>{bullet}</Text>
        <MarkdownLine content={item} color={color} />
      </Box>
    );
  }

  const olMatch = line.match(ORDERED_LIST_RE);
  if (!olMatch) return null;
  return (
    <Box paddingLeft={olMatch[1]!.length}>
      <Text color={t.muted}>{olMatch[2]!}. </Text>
      <MarkdownLine content={olMatch[3]!} color={color} />
    </Box>
  );
});

const QuoteRow = React.memo(function QuoteRow({ line, color }: { line: string; color?: string }) {
  const t = useTheme();
  return (
    <Box flexDirection="row">
      <Text color={t.dim}>▎ </Text>
      <MarkdownLine content={line.slice(2)} color={color} />
    </Box>
  );
});

// ── main component ──

export default React.memo(function MarkdownBlock({ content, color, maxWidth }: MarkdownBlockProps) {
  const t = useTheme();
  const { columns: termColumns } = useWindowSize();
  const columns = maxWidth ?? termColumns;
  const parseCache = useRef<MarkdownParseCache | undefined>(undefined);
  const groups = useMemo(() => {
    const next = updateMarkdownParseCache(parseCache.current, content);
    parseCache.current = next;
    return next.groups;
  }, [content]);

  const nonBlank = groups.reduce<{ group: LineGroup; blanksBefore: number }[]>((acc, g) => {
    if (isBlankGroup(g)) {
      if (acc.length === 0) return acc;
      acc[acc.length - 1]!.blanksBefore++;
      return acc;
    }
    acc.push({ group: g, blanksBefore: 0 });
    return acc;
  }, []);

  const renderGroup = React.useCallback(
    (group: LineGroup): React.ReactNode => {
      if (group.kind === 'code') {
        if (group.lines.length === 0) return null;
        const lang = group.lang || 'code';
        // 顶边框 / Top border — 不够放完整 label 时退化为无标签模式
        const label = `┌─ ${lang} `;
        const labelWidth = stringWidth(label);
        let topBorder: string;
        if (columns > labelWidth + 1) {
          topBorder = `${label}${'─'.repeat(columns - labelWidth - 1)}┐`;
        } else {
          topBorder = `┌${'─'.repeat(Math.max(0, columns - 2))}┐`;
        }
        // 底边框 / Bottom border
        const bottomBorder = `└${'─'.repeat(Math.max(0, columns - 2))}┘`;
        return (
          <Box flexDirection="column">
            <Text color={t.dim}>{topBorder}</Text>
            {group.lines.map((codeLine, ci) => (
              <CodeRow
                key={ci}
                line={codeLine}
                lang={group.lang}
                columns={columns}
                borderColor={t.dim}
              />
            ))}
            <Text color={t.dim}>{bottomBorder}</Text>
          </Box>
        );
      }

      if (group.kind === 'table') {
        return <TableBlock lines={group.lines} columns={columns} />;
      }

      if (group.kind === 'paragraph') {
        return <MarkdownLine content={group.lines.join('\n')} color={color} />;
      }

      if (group.kind === 'list') {
        return (
          <Box flexDirection="column">
            {group.lines.map((line, index) => (
              <ListRow key={index} line={line} color={color} />
            ))}
          </Box>
        );
      }

      if (group.kind === 'quote') {
        return (
          <Box flexDirection="column">
            {group.lines.map((line, index) => (
              <QuoteRow key={index} line={line} color={color} />
            ))}
          </Box>
        );
      }

      const line = group.line;

      if (line.startsWith('###### ')) {
        return (
          <Text bold color={t.dim}>
            <MarkdownLine content={line.slice(7)} color={t.dim} />
          </Text>
        );
      }
      if (line.startsWith('##### ')) {
        return (
          <Text bold color={t.muted}>
            <MarkdownLine content={line.slice(6)} color={t.muted} />
          </Text>
        );
      }
      if (line.startsWith('#### ')) {
        return (
          <Text bold color={t.muted}>
            <MarkdownLine content={line.slice(5)} color={t.muted} />
          </Text>
        );
      }
      if (line.startsWith('### ')) {
        return (
          <Text bold color={t.primary}>
            <MarkdownLine content={line.slice(4)} color={t.primary} />
          </Text>
        );
      }
      if (line.startsWith('## ')) {
        return (
          <Text bold color={t.primary}>
            ── <MarkdownLine content={line.slice(3)} color={t.primary} /> ──
          </Text>
        );
      }
      if (line.startsWith('# ')) {
        return (
          <Text bold underline color={t.primary}>
            <MarkdownLine content={line.slice(2)} color={t.primary} />
          </Text>
        );
      }

      if (isHorizontalRule(line)) {
        return <Text color={t.dim}>{'─'.repeat(columns)}</Text>;
      }

      const ulMatch = line.match(UNORDERED_LIST_RE);
      if (ulMatch) {
        const indent = ulMatch[1]!.length;
        let item = ulMatch[2]!;
        let bullet = '• ';
        const taskMatch = item.match(/^(\[[ xX]\])\s+(.*)$/);
        if (taskMatch) {
          bullet = taskMatch[1]! === '[ ]' ? '☐ ' : '☑ ';
          item = taskMatch[2]!;
        }
        return (
          <Box paddingLeft={indent}>
            <Text color={t.muted}>{bullet}</Text>
            <MarkdownLine content={item} color={color} />
          </Box>
        );
      }

      const olMatch = line.match(ORDERED_LIST_RE);
      if (olMatch && !line.startsWith('```')) {
        const indent = olMatch[1]!.length;
        return (
          <Box paddingLeft={indent}>
            <Text color={t.muted}>{olMatch[2]!}. </Text>
            <MarkdownLine content={olMatch[3]!} color={color} />
          </Box>
        );
      }

      if (line.startsWith('> ')) {
        return (
          <Box flexDirection="row">
            <Text color={t.dim}>▎ </Text>
            <MarkdownLine content={line.slice(2)} color={color} />
          </Box>
        );
      }

      return <MarkdownLine content={line} color={color} />;
    },
    [color, columns, t.dim, t.muted, t.primary],
  );

  let prevGroup: LineGroup | undefined;
  let prevBlanks = 0;
  return (
    <Box flexDirection="column">
      {nonBlank.map(({ group, blanksBefore }) => {
        // blanksBefore on each group is actually blanks AFTER it (accumulated from blank groups).
        // The spacing between prev and current should use prevBlanks (blanks after prev group).
        const spacing = prevGroup ? spacingBetween(prevGroup, group, prevBlanks) : 0;
        prevGroup = group;
        prevBlanks = blanksBefore;
        return (
          <React.Fragment key={`md-block:${groupSourceIndex(group)}`}>
            {spacing > 0 && <Box height={spacing} />}
            <MarkdownGroup group={group} render={renderGroup} />
          </React.Fragment>
        );
      })}
    </Box>
  );
});

function MarkdownLine({ content, color }: { content: string; color?: string }) {
  const t = useTheme();
  const segments = parseInline(content);

  if (
    segments.length === 1 &&
    !segments[0]!.bold &&
    !segments[0]!.italic &&
    !segments[0]!.code &&
    !segments[0]!.strikethrough
  ) {
    return <Text color={color}>{segments[0]!.text}</Text>;
  }

  return (
    <Text>
      {segments.map((seg, j) => {
        if (seg.link) {
          return (
            <React.Fragment key={j}>
              <Text bold color={t.primary}>
                {seg.text}
              </Text>
              <Text color={t.dim}> ({seg.link})</Text>
            </React.Fragment>
          );
        }
        return (
          <Text
            key={j}
            bold={seg.bold}
            italic={seg.italic}
            strikethrough={seg.strikethrough}
            color={seg.code ? t.primary : (color ?? undefined)}
          >
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}
