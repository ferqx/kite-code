import React, { useState, useRef, useCallback } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import type { OutputBlock } from "./types";
import MarkdownBlock from "./components/MarkdownBlock";
import { darkTheme as t } from "./theme";

interface OutputAreaProps {
  blocks: OutputBlock[];
  onToggleReason: (id: number) => void;
  thinkingVisible: boolean;
}

function toolIcon(status: string): string {
  switch (status) {
    case "running": return "⏳";
    case "done": return "✓";
    case "error": return "✗";
    default: return "○";
  }
}

function toolColor(status: string): string {
  switch (status) {
    case "done": return t.success;
    case "error": return t.error;
    case "running": return t.warning;
    default: return t.muted;
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function changePrefix(kind: string): { prefix: string; color: string } {
  switch (kind) {
    case "add": return { prefix: "+", color: t.success };
    case "edit": return { prefix: "~", color: t.warning };
    case "delete": return { prefix: "-", color: t.error };
    default: return { prefix: "?", color: t.muted };
  }
}

function formatLines(added?: number, removed?: number): string {
  const parts: string[] = [];
  if (added != null) parts.push(`+${added}`);
  if (removed != null) parts.push(`-${removed}`);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

function resolveApprovalLabel(resolved?: { action: string; grant?: string; pattern?: string }): string {
  if (!resolved) return "";
  if (resolved.action === "denied") return "✗ Denied";
  if (resolved.grant === "full_access") return "✓ Approved (full access)";
  if (resolved.grant === "same_command") return `✓ Approved same command${resolved.pattern ? ` ("${resolved.pattern}")` : ""}`;
  return "✓ Approved once";
}

export default function OutputArea({ blocks, onToggleReason, thinkingVisible }: OutputAreaProps) {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;
  const autoScrollRef = useRef(true);

  const scrollToBottom = useCallback(() => { autoScrollRef.current = true; }, []);
  const userScrolled = useCallback(() => { autoScrollRef.current = false; }, []);

  useInput((_input: unknown, key: { upArrow?: boolean; downArrow?: boolean; pageup?: boolean; pagedown?: boolean; end?: boolean; return?: boolean }) => {
    if (key.upArrow || key.pageup) {
      userScrolled();
      if (blocks.length > 0) {
        setFocusedIndex((prev) => Math.max(0, (prev ?? blocks.length) - 1));
      }
    }
    if (key.downArrow || key.pagedown) {
      if (blocks.length > 0) {
        const next = Math.min(blocks.length - 1, (focusedIndexRef.current ?? -1) + 1);
        setFocusedIndex(next);
        if (next === blocks.length - 1) scrollToBottom();
      }
    }
    if (key.end) {
      setFocusedIndex(null);
      scrollToBottom();
    }
    if (key.return && focusedIndexRef.current !== null && focusedIndexRef.current < blocks.length) {
      const block = blocks[focusedIndexRef.current];
      if (block && block.kind === "reason") {
        onToggleReason(block.id);
      }
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {blocks.map((block, i) => {
        const isFocused = i === focusedIndex;

        switch (block.kind) {
          case "user":
            return (
              <Box key={block.id} flexDirection="column">
                <Box>
                  <Text color={t.primary} bold>▸ You</Text>
                </Box>
                <Box paddingLeft={2}>
                  <MarkdownBlock content={block.content} />
                </Box>
              </Box>
            );

          case "text":
            return (
              <Box key={block.id}>
                {isFocused ? <Text color={t.primary}>❯ </Text> : null}
                <MarkdownBlock content={block.content} streaming={block.streaming} />
              </Box>
            );

          case "reason":
            return (
              <Box key={block.id} flexDirection="column">
                <Text color={isFocused ? t.primary : t.dim}>
                  {!thinkingVisible || block.folded ? "▶ Thinking..." : "▼ Thinking"}
                </Text>
                {thinkingVisible && !block.folded && (
                  <Box paddingLeft={2}>
                    <Text color={t.muted}>{block.content}</Text>
                  </Box>
                )}
              </Box>
            );

          case "tool_card":
            return (
              <Box key={block.id}>
                <Text color={toolColor(block.status)}>
                  {toolIcon(block.status)} {block.name}
                </Text>
                {block.preview && block.status === "running" ? (
                  <Text color={t.muted}> {block.preview}</Text>
                ) : null}
                {block.status !== "running" ? (
                  <Text color={t.muted}> — {block.summary.slice(0, 120)}</Text>
                ) : (
                  <Text color={t.dim}> ...</Text>
                )}
                {block.elapsedMs != null && (
                  <Text color={t.dim}> ({formatElapsed(block.elapsedMs)})</Text>
                )}
              </Box>
            );

          case "file_change":
            return (
              <Box key={block.id} flexDirection="column">
                <Text color={t.muted}>── File Changes ──</Text>
                {block.changes.map((change, ci) => {
                  const { prefix, color } = changePrefix(change.kind);
                  const lineInfo = formatLines(change.linesAdded, change.linesRemoved);
                  return (
                    <Box key={`${block.id}-${ci}`} flexDirection="column">
                      <Box>
                        <Text color={color}>{prefix} {change.path}</Text>
                        {lineInfo ? <Text color={t.dim}>{lineInfo}</Text> : null}
                      </Box>
                      {change.preview && (
                        <Box paddingLeft={3} flexDirection="column">
                          {change.preview.split("\n").map((pl, pli) => (
                            <Text key={pli} color={t.dim}>
                              {pli === 0 ? "│ " : "│ "}{pl}
                            </Text>
                          ))}
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            );

          case "approval": {
            const label = resolveApprovalLabel(block.resolved);
            return (
              <Box key={block.id} flexDirection="column">
                {label ? (
                  <Text color={label.startsWith("✓") ? t.success : t.error}>{label}</Text>
                ) : (
                  <Text color={t.warning}>⚠ Awaiting approval — {block.approval.command}</Text>
                )}
              </Box>
            );
          }
          case "question": {
            return (
              <Box key={block.id} flexDirection="column">
                {block.resolved ? (
                  <Text color={t.primary}>? {block.resolved}</Text>
                ) : (
                  <Text color={t.primary}>? {block.question.question} (awaiting response...)</Text>
                )}
              </Box>
            );
          }

          default:
            return null;
        }
      })}
    </Box>
  );
}
