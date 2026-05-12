import React from "react";
import { Box, Text } from "ink";
import { darkTheme as t } from "../theme";

interface MarkdownBlockProps {
  content: string;
  streaming?: boolean;
}

interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

// ── inline markdown parsing ──

function parseInline(text: string): InlineSegment[] {
  const allPatterns = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
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

function tokenizeCodeLine(line: string, lang: string): Token[] {
  if (!lang || !line.trim()) return [{ text: line }];

  const tokens: Token[] = [];
  let i = 0;

  while (i < line.length) {
    // Comment: // or #
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

    // Strings
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

    // Numbers
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

    // Words (keywords, identifiers)
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

    // Other characters
    tokens.push({ text: line[i] });
    i++;
  }

  return tokens;
}

function CodeLine({ line, lang }: { line: string; lang: string }) {
  if (!lang) {
    return <Text color={t.muted}>{line}</Text>;
  }

  const tokens = tokenizeCodeLine(line, lang);
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

// ── main component ──

export default function MarkdownBlock({ content, streaming }: MarkdownBlockProps) {
  const lines = content.split("\n");
  let inCodeBlock = false;
  let codeLang = "";

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.startsWith("```")) {
          if (inCodeBlock) {
            inCodeBlock = false;
            codeLang = "";
          } else {
            inCodeBlock = true;
            codeLang = detectLang(line);
          }
          return (
            <Text key={i} color={t.dim}>
              {line}
            </Text>
          );
        }

        if (inCodeBlock) {
          return (
            <Box key={i} paddingLeft={1}>
              <Text color={t.dim}>│ </Text>
              <CodeLine line={line} lang={codeLang} />
            </Box>
          );
        }

        if (line.startsWith("### ")) {
          return (
            <Text key={i} bold color={t.primary}>
              {line.slice(4)}
            </Text>
          );
        }
        if (line.startsWith("## ")) {
          return (
            <Text key={i} bold color={t.primary}>
              ── {line.slice(3)} ──
            </Text>
          );
        }
        if (line.startsWith("# ")) {
          return (
            <Text key={i} bold color={t.primary} underline>
              {line.slice(2)}
            </Text>
          );
        }

        if (line.startsWith("- ") || line.startsWith("* ")) {
          const indent = line.match(/^\s*/)?.[0].length ?? 0;
          return (
            <Box key={i} paddingLeft={indent}>
              <Text color={t.muted}>· </Text>
              <MarkdownLine content={line.slice(2)} />
            </Box>
          );
        }

        if (line.startsWith("> ")) {
          return (
            <Text key={i} color={t.dim}>
              │ {line.slice(2)}
            </Text>
          );
        }

        if (line.trim() === "") {
          return <Box key={i} height={1} />;
        }

        return <MarkdownLine key={i} content={line} />;
      })}
      {streaming && <Text color={t.primary}>▌</Text>}
    </Box>
  );
}

function MarkdownLine({ content }: { content: string }) {
  const segments = parseInline(content);

  if (segments.length === 1 && !segments[0].bold && !segments[0].italic && !segments[0].code) {
    return <Text>{content}</Text>;
  }

  return (
    <Text>
      {segments.map((seg, j) => (
        <Text
          key={j}
          bold={seg.bold}
          italic={seg.italic}
          color={seg.code ? t.warning : undefined}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
