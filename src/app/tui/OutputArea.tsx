import React, { useState, useRef, useCallback } from "react";
import { Box, Text, useStdout } from "ink";
import { useInput } from "ink";
import type { OutputBlock } from "./types";
import MarkdownBlock from "./components/MarkdownBlock";
import { darkTheme as t } from "./theme";

interface OutputAreaProps {
  blocks: OutputBlock[];
  onToggleReason: (id: number) => void;
  thinkingVisible: boolean;
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
  if (resolved.action === "denied") return "× Denied";
  if (resolved.action === "approve_once") {
    if (resolved.grant === "full_access") return "✓ Approved (full access)";
    if (resolved.grant === "same_command") return `✓ Approved (same command)${resolved.pattern ? ` "${resolved.pattern}"` : ""}`;
    return "✓ Approved (once)";
  }
  return `? ${resolved.action}`;
}

// Rough line count estimate for a block — used for viewport culling
function blockLineEstimate(block: OutputBlock, thinkingVisible: boolean): number {
  switch (block.kind) {
    case "user": return 2 + (block.content.split("\n").length || 1);
    case "text": return Math.max(1, block.content.split("\n").length);
    case "reason": {
      if (!thinkingVisible || block.folded) return 1;
      return 1 + (block.content.split("\n").length || 1);
    }
    case "tool_card": return block.status === "running" || !block.summary ? 1 : 2;
    case "file_change": return 2 + block.changes.length * 2 + block.changes.reduce((s, c) => s + (c.preview ? c.preview.split("\n").length : 0), 0);
    case "approval": return 1;
    case "question": return 1;
    default: return 1;
  }
}

function renderBlock(block: OutputBlock, isFocused: boolean, thinkingVisible: boolean, _i: number) {
  switch (block.kind) {
    case "user":
      return (
        <Box key={block.id}>
          <Text color={t.primary}>❯ </Text>
          <MarkdownBlock content={block.content} />
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
        <Box key={block.id} flexDirection="column">
          <Box>
            <Text color={toolColor(block.status)}>⏺ </Text>
            <Text color={t.primary}>{block.name}</Text>
            {block.preview ? (
              <Text color={t.muted}> {block.preview}</Text>
            ) : null}
            {block.status === "running" ? (
              <Text color={t.dim}> ...</Text>
            ) : null}
            {block.elapsedMs != null && (
              <Text color={t.dim}> ({formatElapsed(block.elapsedMs)})</Text>
            )}
          </Box>
          {block.status !== "running" && block.summary ? (
            <Box paddingLeft={3}>
              <Text color={t.dim}>⎿ {block.summary.slice(0, 200)}</Text>
            </Box>
          ) : null}
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
            <Text>
              <Text color={t.success}>✓ Answered: </Text>
              <Text color={t.muted}>{block.resolved}</Text>
            </Text>
          ) : (
            <Text color={t.primary}>? Question</Text>
          )}
        </Box>
      );
    }

    default:
      return null;
  }
}

export default function OutputArea({ blocks, onToggleReason, thinkingVisible }: OutputAreaProps) {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;
  const autoScrollRef = useRef(true);
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 24;
  // Reserve space for Header (3) + Footer (1) + InputLine (1) + chrome (1)
  const maxHeight = Math.max(8, terminalRows - 6);

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

  // Viewport culling: when auto-scrolling (at bottom), show newest blocks.
  // When user scrolled up, center viewport around the focused block.
  let visibleStart = 0;
  let visibleEnd = blocks.length;

  if (blocks.length > 0) {
    if (autoScrollRef.current) {
      // Show from bottom
      let lineCount = 0;
      for (let i = blocks.length - 1; i >= 0; i--) {
        lineCount += blockLineEstimate(blocks[i], thinkingVisible);
        if (lineCount > maxHeight) {
          visibleStart = i + 1;
          break;
        }
      }
    } else if (focusedIndexRef.current != null) {
      // Center viewport around focused block
      const center = focusedIndexRef.current;
      const halfHeight = Math.floor(maxHeight / 2);
      let upLines = 0;
      visibleStart = center;
      for (let i = center - 1; i >= 0; i--) {
        upLines += blockLineEstimate(blocks[i], thinkingVisible);
        visibleStart = i;
        if (upLines >= halfHeight) break;
      }
      let downLines = blockLineEstimate(blocks[center], thinkingVisible);
      visibleEnd = center + 1;
      for (let i = center + 1; i < blocks.length; i++) {
        downLines += blockLineEstimate(blocks[i], thinkingVisible);
        visibleEnd = i + 1;
        if (downLines >= maxHeight) break;
      }
    }
  }

  const visibleBlocks = blocks.slice(visibleStart, visibleEnd);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visibleBlocks.map((block, i) => {
        const realIndex = visibleStart + i;
        const isFocused = realIndex === focusedIndex;
        return renderBlock(block, isFocused, thinkingVisible, realIndex);
      })}
    </Box>
  );
}
