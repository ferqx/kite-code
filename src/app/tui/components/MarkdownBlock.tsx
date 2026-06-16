import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { useWindowSize } from "@/app/tui/hooks/useWindowSizeSig";
import { useTheme, type Theme } from "@/app/tui/theme";

interface MarkdownBlockProps {
  content: string;
  streaming?: boolean;
  color?: string;
}

export interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

// ── inline markdown parsing ──

export function parseInline(text: string): InlineSegment[] {
  const allPatterns = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = allPatterns.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) });
    }
    if (match[1].startsWith("***") && match[2] !== undefined) {
      segments.push({ text: match[2], bold: true, italic: true });
    } else if (match[1].startsWith("**") && match[3] !== undefined) {
      segments.push({ text: match[3], bold: true });
    } else if (match[1].startsWith("*") && !match[1].startsWith("**") && match[4] !== undefined) {
      segments.push({ text: match[4], italic: true });
    } else if (match[5] !== undefined) {
      segments.push({ text: match[5], code: true });
    } else if (match[6] !== undefined && match[7] !== undefined) {
      segments.push({ text: match[6], bold: true, link: match[7] });
    }
    lastIndex = match.index + match[1].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  return segments;
}

// ── syntax highlighting for code blocks ──

interface Token { text: string; color?: string; bold?: boolean }

const TS_KEYWORDS = new Set([
  "import", "export", "from", "const", "let", "var", "function", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "try", "catch", "throw", "new", "class", "extends", "interface", "type",
  "async", "await", "default", "typeof", "instanceof", "in", "of",
  "true", "false", "null", "undefined", "this", "super", "yield",
]);

const PY_KEYWORDS = new Set([
  "import", "from", "def", "return", "if", "elif", "else", "for", "while",
  "try", "except", "raise", "class", "with", "as", "pass", "break", "continue",
  "True", "False", "None", "and", "or", "not", "in", "is", "lambda", "yield",
  "self", "print",
]);

const SH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done",
  "case", "esac", "in", "function", "return", "exit", "export",
  "local", "source", "echo", "cd", "ls", "rm", "mv", "cp", "mkdir",
  "git", "npm", "yarn", "bun", "node", "python", "pip", "cargo",
]);

function detectLang(fenceLine: string): string {
  const lang = fenceLine.slice(3).trim().toLowerCase();
  if (["ts", "tsx", "typescript"].includes(lang)) return "ts";
  if (["js", "jsx", "javascript"].includes(lang)) return "ts";
  if (["py", "python"].includes(lang)) return "py";
  if (["sh", "bash", "shell", "zsh"].includes(lang)) return "sh";
  if (["json"].includes(lang)) return "json";
  return lang || "";
}

function tokenizeCodeLine(line: string, lang: string, t: Theme): Token[] {
  if (!lang || !line.trim()) return [{ text: line }];

  const tokens: Token[] = [];
  let i = 0;

  while (i < line.length) {
    if ((lang === "ts" || lang === "py" || lang === "sh") && line[i] === "/" && line[i + 1] === "/") {
      tokens.push({ text: line.slice(i), color: t.dim });
      return tokens;
    }
    if (lang === "py" && line[i] === "#") {
      tokens.push({ text: line.slice(i), color: t.dim });
      return tokens;
    }
    if (lang === "sh" && line[i] === "#") {
      tokens.push({ text: line.slice(i), color: t.dim });
      return tokens;
    }

    if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === "\\") j++;
        j++;
      }
      if (j < line.length) j++;
      const str = line.slice(i, j);
      tokens.push({ text: str, color: t.success });
      i = j;
      continue;
    }

    if (/[0-9]/.test(line[i]) && (i === 0 || /[\s([{=+\-*/%<>,;:]/.test(line[i - 1]))) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxX._]/.test(line[j])) j++;
      const num = line.slice(i, j);
      if (/^[0-9]/.test(num)) {
        tokens.push({ text: num, color: t.primary });
        i = j;
        continue;
      }
    }

    if (/[a-zA-Z_$]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      const kw = lang === "py" ? PY_KEYWORDS : lang === "sh" ? SH_KEYWORDS : TS_KEYWORDS;
      if (kw.has(word)) {
        tokens.push({ text: word, color: t.primary, bold: true });
      } else {
        tokens.push({ text: word });
      }
      i = j;
      continue;
    }

    tokens.push({ text: line[i] });
    i++;
  }

  return tokens;
}

function CodeLine({ line, lang }: { line: string; lang: string }) {
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
}

// ── CJK display width ──

function charWidth(code: number): number {
  if (code < 0x20) return 0;
  if (code < 0x7f) return 1;
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, symbols
    (code >= 0x3040 && code <= 0x33bf) || // Hiragana, Katakana, Bopomofo, CJK compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext-A
    (code >= 0x4e00 && code <= 0xa4cf) || // CJK Unified + Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
    (code >= 0xfe10 && code <= 0xfe6f) || // Vertical forms, CJK compat
    (code >= 0xff01 && code <= 0xff60) || // Fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth signs
    (code >= 0x1f300 && code <= 0x1f9ff) || // Emoji, pictographs
    (code >= 0x20000 && code <= 0x2ffff)   // CJK Ext-B+
  ) {
    return 2;
  }
  return 1;
}

function stringWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    width += charWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

// ── table detection & rendering ──

const PIPE = /[|│]/; // | or │ (box-drawing vertical)

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  // Markdown: | col1 | col2 | or │ col1 │ col2 │
  // Also support: col1 | col2 | col3 (no leading pipe)
  if (/^[|│]/.test(trimmed) && /[|│]$/.test(trimmed)) return true;
  // Row has at least two pipe separators → likely a table row
  const pipes = trimmed.match(/[|│]/g);
  return (pipes?.length ?? 0) >= 2;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Must contain at least one pipe (| or │) and consist of separator chars only
  if (!/[|│]/.test(trimmed)) return false;
  return /^[\s\-:|─━┼╿]+$/.test(trimmed);
}

function parseTable(lines: string[]): { headers: string[]; rows: string[][]; widths: number[] } {
  const parseCells = (line: string) => {
    let trimmed = line.trim();
    // Strip leading/trailing pipe │
    trimmed = trimmed.replace(/^[|│]\s*/, "").replace(/\s*[|│]$/, "");
    return trimmed.split(PIPE).map(c => c.trim());
  };

  const headers = parseCells(lines[0]);
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    rows.push(parseCells(lines[i]));
  }

  const widths = headers.map((h, col) => {
    let max = stringWidth(h);
    rows.forEach(r => {
      const cell = r[col] ?? "";
      const w = stringWidth(cell);
      if (w > max) max = w;
    });
    return max;
  });

  return { headers, rows, widths };
}

// ── responsive table width ──
// Maximum table width available, accounting for block left-padding in layout
function tableMaxWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(40, cols - 4);
}

/** Split text into lines that fit within maxWidth, padding each line to maxWidth. */
function wrapCell(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  const sw = stringWidth(text);
  if (sw <= maxWidth) return [text + " ".repeat(maxWidth - sw)];

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw === 0) continue;
    if (currentWidth + cw > maxWidth) {
      lines.push(current + " ".repeat(maxWidth - currentWidth));
      current = ch;
      currentWidth = cw;
      // Trim leading space after a forced break
      if (ch === " ") { current = ""; currentWidth = 0; }
    } else {
      current += ch;
      currentWidth += cw;
    }
  }
  if (current || lines.length === 0) {
    lines.push(current + " ".repeat(maxWidth - currentWidth));
  }
  return lines;
}

/** Truncate to single line with "…" — used for headers only. */
function truncateHeader(text: string, maxWidth: number): string {
  const sw = stringWidth(text);
  if (sw <= maxWidth) return text + " ".repeat(maxWidth - sw);
  const limit = maxWidth - 1;
  let result = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw === 0) continue;
    if (w + cw > limit) break;
    result += ch;
    w += cw;
  }
  return result + "…" + " ".repeat(limit - w);
}

function computeColumnWidths(
  headers: string[],
  rows: string[][],
  naturalWidths: number[],
): number[] {
  const colCount = headers.length;
  const overhead = 2 + (colCount - 1) + colCount * 2; // ││ + inner │ + padding
  const maxContentWidth = tableMaxWidth() - overhead;
  const naturalTotal = naturalWidths.reduce((a, w) => a + w, 0);
  if (naturalTotal <= maxContentWidth) return naturalWidths;
  if (maxContentWidth < colCount * 6) {
    const w = Math.max(6, Math.floor(tableMaxWidth() / colCount) - 3);
    return headers.map(() => w);
  }
  const scale = maxContentWidth / naturalTotal;
  return naturalWidths.map(w => Math.max(6, Math.floor(w * scale)));
}

/** Build a single border string: e.g. ┌────┬──────┐ */
function borderLine(left: string, mid: string, right: string, widths: number[], fill: string): string {
  return left + widths.map(w => fill.repeat(w + 2)).join(mid) + right;
}

/** Render a table row that may span multiple lines (cells wrap). */
function dataRowLines(cells: string[], widths: number[]): string[] {
  const wrapped = cells.map((c, i) => wrapCell(c, widths[i]));
  const maxLines = Math.max(1, ...wrapped.map(w => w.length));
  const lines: string[] = [];
  for (let li = 0; li < maxLines; li++) {
    const parts = wrapped.map((w, ci) => {
      const cell = li < w.length ? w[li] : " ".repeat(widths[ci]);
      return " " + cell + " ";
    });
    lines.push("│" + parts.join("│") + "│");
  }
  return lines;
}

function TableBlock({ lines }: { lines: string[] }) {
  const t = useTheme();
  const { headers, rows, widths: natural } = useMemo(() => parseTable(lines), [lines]);
  const widths = useMemo(
    () => computeColumnWidths(headers, rows, natural),
    [headers, rows, natural],
  );

  const topBorder  = borderLine("┌", "┬", "┐", widths, "─");
  const sepBorder  = borderLine("├", "┼", "┤", widths, "─");
  const botBorder  = borderLine("└", "┴", "┘", widths, "─");
  const headerLine = "│" + headers.map((h, i) => " " + truncateHeader(h, widths[i]) + " ").join("│") + "│";

  return (
    <Box flexDirection="column">
      <Text color={t.dim}>{topBorder}</Text>
      <Text bold color={t.primary}>{headerLine}</Text>
      <Text color={t.dim}>{sepBorder}</Text>
      {rows.map((row, ri) =>
        dataRowLines(row, widths).map((line, li) => (
          <Text key={`${ri}-${li}`} color={t.muted}>{line}</Text>
        ))
      )}
      <Text color={t.dim}>{botBorder}</Text>
    </Box>
  );
}

// ── HTML entity decoding ──
// Some models return HTML-escaped content (&#39; &quot; &amp; &lt; &gt;).
// Decode at render time so terminal displays the actual characters.
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// ── line grouping ──

type LineGroup =
  | { kind: "single"; line: string; index: number }
  | { kind: "code"; lines: string[]; lang: string; startIndex: number }
  | { kind: "table"; lines: string[]; startIndex: number };

function groupLines(lines: string[]): LineGroup[] {
  const groups: LineGroup[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = detectLang(line);
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      groups.push({ kind: "code", lines: codeLines, lang, startIndex: i });
      if (i < lines.length) i++; // skip closing ```
      continue;
    }

    // Table: must have header row + separator row
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      groups.push({ kind: "table", lines: tableLines, startIndex: i });
      continue;
    }

    groups.push({ kind: "single", line, index: i });
    i++;
  }

  return groups;
}

function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
}

const HEADING_RE = /^#{1,6}\s/;
const UNORDERED_LIST_RE = /^(\s*)[-*]\s+(.*)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

function isBlankGroup(g: LineGroup | undefined): boolean {
  return !!g && g.kind === "single" && g.line.trim() === "";
}

function isHeadingGroup(g: LineGroup | undefined): boolean {
  return !!g && g.kind === "single" && HEADING_RE.test(g.line);
}

function isListGroup(g: LineGroup | undefined): boolean {
  if (!g || g.kind !== "single") return false;
  const line = g.line;
  return !isBlankGroup(g) && !isHeadingGroup(g) && !isHorizontalRule(line) && UNORDERED_LIST_RE.test(line);
}

function isQuoteGroup(g: LineGroup | undefined): boolean {
  return !!g && g.kind === "single" && g.line.startsWith("> ") && !isBlankGroup(g);
}

function isStructuralGroup(g: LineGroup | undefined): boolean {
  if (!g) return false;
  if (g.kind === "table" || g.kind === "code") return true;
  if (g.kind === "single") {
    const line = g.line;
    return isHorizontalRule(line) || isHeadingGroup(g);
  }
  return false;
}

function spacingBetween(prev: LineGroup, next: LineGroup, blanks: number): number {
  if (isListGroup(prev) && isListGroup(next)) return 0;
  if (isQuoteGroup(prev) && isQuoteGroup(next)) return 0;
  if (
    isStructuralGroup(prev) || isStructuralGroup(next) ||
    isListGroup(prev) || isListGroup(next) ||
    isQuoteGroup(prev) || isQuoteGroup(next)
  ) {
    return Math.max(1, Math.min(blanks, 1));
  }
  return Math.min(blanks, 1);
}

// ── main component ──

export default React.memo(function MarkdownBlock({ content, streaming, color }: MarkdownBlockProps) {
  const t = useTheme();
  const { columns } = useWindowSize();
  const groups = useMemo(() => {
    const lines = decodeHtmlEntities(content).split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return groupLines(lines);
  }, [content]);

  const nonBlank = groups.reduce<{ group: LineGroup; blanksBefore: number }[]>((acc, g) => {
    if (isBlankGroup(g)) {
      if (acc.length === 0) return acc;
      acc[acc.length - 1].blanksBefore++;
      return acc;
    }
    acc.push({ group: g, blanksBefore: 0 });
    return acc;
  }, []);

  function renderGroup(group: LineGroup): React.ReactNode {
    if (group.kind === "code") {
      if (group.lines.length === 0) return null;
      const lang = group.lang || "code";
      const label = `┌─ ${lang} `;
      const labelWidth = stringWidth(label);
      const topFill = Math.max(0, columns - labelWidth);
      const topBorder = label + "─".repeat(topFill);
      const bottomBorder = "└" + "─".repeat(Math.max(0, columns - 1));
      return (
        <Box flexDirection="column">
          <Text color={t.dim}>{topBorder}</Text>
          {group.lines.map((codeLine, ci) => (
            <Box key={ci} flexDirection="row">
              <Text color={t.dim}>│ </Text>
              <CodeLine line={codeLine} lang={group.lang} />
            </Box>
          ))}
          <Text color={t.dim}>{bottomBorder}</Text>
        </Box>
      );
    }

    if (group.kind === "table") {
      return <TableBlock lines={group.lines} />;
    }

    const line = group.line;

    if (line.startsWith("### ")) {
      return (
        <Text bold color={t.primary}>
          <MarkdownLine content={line.slice(4)} color={t.primary} />
        </Text>
      );
    }
    if (line.startsWith("## ")) {
      return (
        <Text bold color={t.primary}>
          ── <MarkdownLine content={line.slice(3)} color={t.primary} /> ──
        </Text>
      );
    }
    if (line.startsWith("# ")) {
      return (
        <Text bold underline color={t.primary}>
          <MarkdownLine content={line.slice(2)} color={t.primary} />
        </Text>
      );
    }

    if (isHorizontalRule(line)) {
      return <Text color={t.dim}>{"─".repeat(columns)}</Text>;
    }

    const ulMatch = line.match(UNORDERED_LIST_RE);
    if (ulMatch) {
      const indent = ulMatch[1].length;
      let item = ulMatch[2];
      let bullet = "• ";
      const taskMatch = item.match(/^(\[[ xX]\])\s+(.*)$/);
      if (taskMatch) {
        bullet = taskMatch[1] === "[ ]" ? "☐ " : "☑ ";
        item = taskMatch[2];
      }
      return (
        <Box paddingLeft={indent}>
          <Text color={t.muted}>{bullet}</Text>
          <MarkdownLine content={item} color={color} />
        </Box>
      );
    }

    const olMatch = line.match(ORDERED_LIST_RE);
    if (olMatch && !line.startsWith("```")) {
      const indent = olMatch[1].length;
      return (
        <Box paddingLeft={indent}>
          <Text color={t.muted}>{olMatch[2]}. </Text>
          <MarkdownLine content={olMatch[3]} color={color} />
        </Box>
      );
    }

    if (line.startsWith("> ")) {
      return (
        <Box flexDirection="row">
          <Text color={t.dim}>▎ </Text>
          <MarkdownLine content={line.slice(2)} color={color} />
        </Box>
      );
    }

    return <MarkdownLine content={line} color={color} />;
  }

  let prevGroup: LineGroup | undefined;
  let prevBlanks = 0;
  return (
    <Box flexDirection="column">
      {nonBlank.map(({ group, blanksBefore }, i) => {
        // blanksBefore on each group is actually blanks AFTER it (accumulated from blank groups).
        // The spacing between prev and current should use prevBlanks (blanks after prev group).
        const spacing = prevGroup ? spacingBetween(prevGroup, group, prevBlanks) : 0;
        prevGroup = group;
        prevBlanks = blanksBefore;
        return (
          <React.Fragment key={i}>
            {spacing > 0 && <Box height={spacing} />}
            {renderGroup(group)}
          </React.Fragment>
        );
      })}
    </Box>
  );
});

function MarkdownLine({ content, color }: { content: string; color?: string }) {
  const t = useTheme();
  const segments = parseInline(content);

  if (segments.length === 1 && !segments[0].bold && !segments[0].italic && !segments[0].code) {
    return <Text color={color}>{content}</Text>;
  }

  return (
    <Text>
      {segments.map((seg, j) => {
        if (seg.link) {
          return (
            <React.Fragment key={j}>
              <Text bold color={t.primary}>{seg.text}</Text>
              <Text color={t.dim}> ({seg.link})</Text>
            </React.Fragment>
          );
        }
        return (
          <Text
            key={j}
            bold={seg.bold}
            italic={seg.italic}
            color={seg.code ? t.primary : (color ?? undefined)}
          >
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}
