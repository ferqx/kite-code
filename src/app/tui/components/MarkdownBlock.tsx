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

export default function MarkdownBlock({ content, streaming }: MarkdownBlockProps) {
  const lines = content.split("\n");
  let inCodeBlock = false;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.startsWith("```")) {
          if (inCodeBlock) {
            inCodeBlock = false;
          } else {
            inCodeBlock = true;
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
              <Text color={t.muted}>{line}</Text>
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
