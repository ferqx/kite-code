import React, { useMemo } from "react";
import { Box, Text } from "ink";
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
  const allPatterns = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = allPatterns.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) });
    }
    if (match[1].startsWith("**") && match[2] !== undefined) {
      segments.push({ text: match[2], bold: true });
    } else if (match[1].startsWith("*") && !match[1].startsWith("**") && match[3] !== undefined) {
      segments.push({ text: match[3], italic: true });
    } else if (match[4] !== undefined) {
      segments.push({ text: match[4], code: true });
    } else if (match[5] !== undefined && match[6] !== undefined) {
      segments.push({ text: match[5], bold: true, link: match[6] });
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
        tokens.push({ text: num, color: t.warning });
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

function padCell(text: string, width: number): string {
  const current = stringWidth(text);
  if (current >= width) return text;
  return text + " ".repeat(width - current);
}

function TableBlock({ lines }: { lines: string[] }) {
  const t = useTheme();
  const { headers, rows, widths } = parseTable(lines);

  return (
    <Box flexDirection="column">
      {/* header */}
      <Box>
        <Text color={t.dim}>┌</Text>
        {headers.map((h, ci) => (
          <React.Fragment key={ci}>
            {ci > 0 && <Text color={t.dim}>┬</Text>}
            <Text color={t.dim}>{"─".repeat(widths[ci] + 2)}</Text>
          </React.Fragment>
        ))}
        <Text color={t.dim}>┐</Text>
      </Box>
      <Box>
        <Text color={t.dim}>│</Text>
        {headers.map((h, ci) => (
          <React.Fragment key={ci}>
            {ci > 0 && <Text color={t.dim}>│</Text>}
            <Text bold color={t.primary}> {padCell(h, widths[ci])} </Text>
          </React.Fragment>
        ))}
        <Text color={t.dim}>│</Text>
      </Box>
      <Box>
        <Text color={t.dim}>├</Text>
        {widths.map((w, ci) => (
          <React.Fragment key={ci}>
            {ci > 0 && <Text color={t.dim}>┼</Text>}
            <Text color={t.dim}>{"─".repeat(w + 2)}</Text>
          </React.Fragment>
        ))}
        <Text color={t.dim}>┤</Text>
      </Box>
      {/* data rows */}
      {rows.map((row, ri) => (
        <Box key={ri}>
          <Text color={t.dim}>│</Text>
          {row.map((cell, ci) => (
            <React.Fragment key={ci}>
              {ci > 0 && <Text color={t.dim}>│</Text>}
              <Text color={t.muted}> {padCell(cell, widths[ci])} </Text>
            </React.Fragment>
          ))}
          {row.length < headers.length && (
            <Text color={t.muted}>{" ".repeat(widths.slice(row.length).reduce((a, w) => a + w + 3, 0))}</Text>
          )}
          <Text color={t.dim}>│</Text>
        </Box>
      ))}
      {/* bottom border */}
      <Box>
        <Text color={t.dim}>└</Text>
        {widths.map((w, ci) => (
          <React.Fragment key={ci}>
            {ci > 0 && <Text color={t.dim}>┴</Text>}
            <Text color={t.dim}>{"─".repeat(w + 2)}</Text>
          </React.Fragment>
        ))}
        <Text color={t.dim}>┘</Text>
      </Box>
    </Box>
  );
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
      i++; // skip closing ```
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

// ── main component ──

export default React.memo(function MarkdownBlock({ content, streaming, color }: MarkdownBlockProps) {
  const t = useTheme();
  const groups = useMemo(() => groupLines(content.split("\n")), [content]);

  return (
    <Box flexDirection="column">
      {groups.map((group, gi) => {
        if (group.kind === "code") {
          return (
            <Box key={gi} flexDirection="column">
              <Text color={t.dim}>┌─ {group.lang || "code"} ─</Text>
              {group.lines.map((codeLine, ci) => (
                <Box key={ci} paddingLeft={1}>
                  <Text color={t.dim}>│ </Text>
                  <CodeLine line={codeLine} lang={group.lang} />
                </Box>
              ))}
              <Text color={t.dim}>└─</Text>
            </Box>
          );
        }

        if (group.kind === "table") {
          return <TableBlock key={gi} lines={group.lines} />;
        }

        // ── single line ──
        const line = group.line;

        if (line.startsWith("### ")) {
          return (
            <Text key={gi} bold color={t.primary}>
              {line.slice(4)}
            </Text>
          );
        }
        if (line.startsWith("## ")) {
          return (
            <Text key={gi} bold color={t.primary}>
              ── {line.slice(3)} ──
            </Text>
          );
        }
        if (line.startsWith("# ")) {
          return (
            <Text key={gi} bold color={t.primary} underline>
              {line.slice(2)}
            </Text>
          );
        }

        if (line.startsWith("- ") || line.startsWith("* ")) {
          const indent = line.match(/^\s*/)?.[0].length ?? 0;
          return (
            <Box key={gi} paddingLeft={indent}>
              <Text color={t.muted}>· </Text>
              <MarkdownLine content={line.slice(2)} color={color} />
            </Box>
          );
        }

        if (line.startsWith("> ")) {
          return (
            <Text key={gi} color={t.dim}>
              │ {line.slice(2)}
            </Text>
          );
        }

        if (line.trim() === "") {
          return <Box key={gi} height={1} />;
        }

        return <MarkdownLine key={gi} content={line} color={color} />;
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
            color={seg.code ? t.warning : (color ?? undefined)}
          >
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}
