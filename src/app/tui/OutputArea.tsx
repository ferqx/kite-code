import React, { useState, useRef } from "react";
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

export function toolColor(status: string): string {
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

export function changePrefix(kind: string): { prefix: string; color: string } {
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
  if (resolved.action === "cancelled") return "⊘ Cancelled";
  if (resolved.action === "denied") return "× Denied";
  if (resolved.action === "approve_once") return "✓ Approved (once)";
  if (resolved.action === "same_command") return `✓ Approved (same command)${resolved.pattern ? ` "${resolved.pattern}"` : ""}`;
  if (resolved.action === "full_access") return "✓ Approved (full access)";
  return `? ${resolved.action}`;
}

const MAX_TOOL_LINES = 12;

function renderToolSummary(summary: string, isError: boolean) {
  const prefix = isError ? "✕ " : "⎿ ";
  const color = isError ? t.error : t.dim;
  const text = summary.trimEnd();
  const lines = text.split("\n");

  if (lines.length <= 1) {
    return (
      <Text color={color}>
        {prefix}{text.slice(0, 300)}
      </Text>
    );
  }

  const displayLines = lines.slice(0, MAX_TOOL_LINES);
  const truncated = lines.length > MAX_TOOL_LINES;

  return (
    <React.Fragment>
      {displayLines.map((line, i) => (
        <Text key={i} color={color}>
          {i === 0 ? prefix : "   "}{line.slice(0, 200)}
        </Text>
      ))}
      {truncated && (
        <Text color={t.dim}>   ... ({lines.length - MAX_TOOL_LINES} more lines)</Text>
      )}
    </React.Fragment>
  );
}

const BLOCK_GAP = 1;

function renderBlock(block: OutputBlock, isFocused: boolean, thinkingVisible: boolean, _i: number, prevBlock?: OutputBlock) {
  switch (block.kind) {
    case "user":
      return (
        <Box key={block.id} marginBottom={BLOCK_GAP}>
          <MarkdownBlock content={"❯ " + block.content} />
        </Box>
      );

    case "text":
      return (
        <Box key={block.id} marginBottom={BLOCK_GAP}>
          {isFocused ? <Text color={t.primary}>❯ </Text> : null}
          <MarkdownBlock content={block.content} streaming={block.streaming} color={block.isError ? t.error : undefined} />
        </Box>
      );

    case "reason": {
      const isConsecutive = prevBlock?.kind === "reason";
      return (
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
          {!isConsecutive && (
            <Text color={isFocused ? t.primary : t.dim}>
              {!thinkingVisible || block.folded ? "▶ Thinking..." : "▼ Thinking"}
            </Text>
          )}
          {thinkingVisible && !block.folded && (
            <Box paddingLeft={2}>
              <Text color={t.muted}>{block.content}</Text>
            </Box>
          )}
          {isConsecutive && (block.folded || !thinkingVisible) && (
            <Text color={t.dim}>  ...</Text>
          )}
        </Box>
      );
    }

    case "tool_card":
      return (
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
          <Box>
            <Text color={toolColor(block.status)}>⏺ </Text>
            <Text color={t.primary}>{block.name}</Text>
            {block.preview ? (
              <Text color={t.muted}> {block.preview}</Text>
            ) : null}
            {block.detail ? (
              <Text color={t.dim}> {block.detail}</Text>
            ) : null}
            {block.status === "running" ? (
              <Text color={t.dim}> ...</Text>
            ) : null}
            {block.elapsedMs != null && block.name === "shell_execute" && (
              <Text color={t.dim}> ({formatElapsed(block.elapsedMs)})</Text>
            )}
          </Box>
          {block.status === "error" && block.summary ? (
            <Box paddingLeft={3} flexDirection="column">
              {renderToolSummary(block.summary, true)}
            </Box>
          ) : null}
        </Box>
      );

    case "file_change":
      return (
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
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
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
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
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
          {block.resolved ? (
            block.resolved === "cancelled" ? (
              <Text color={t.dim}>⊘ Question cancelled</Text>
            ) : (
              <Text>
                <Text color={t.success}>✓ Answered: </Text>
                <Text color={t.muted}>{block.resolved}</Text>
              </Text>
            )
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

  useInput((_input: unknown, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    if (key.upArrow) {
      setFocusedIndex((prev) => {
        if (blocks.length === 0) return null;
        return Math.max(0, (prev ?? blocks.length) - 1);
      });
    }
    if (key.downArrow) {
      setFocusedIndex((prev) => {
        if (blocks.length === 0) return null;
        return Math.min(blocks.length - 1, (prev ?? -1) + 1);
      });
    }
    if (key.return && focusedIndexRef.current !== null && focusedIndexRef.current < blocks.length) {
      const block = blocks[focusedIndexRef.current];
      if (block && block.kind === "reason") {
        onToggleReason(block.id);
      }
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      {blocks.map((block, i) => {
        const isFocused = i === focusedIndex;
        return renderBlock(block, isFocused, thinkingVisible, i, blocks[i - 1]);
      })}
    </Box>
  );
}
