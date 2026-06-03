import React from "react";
import { Box, Text } from "ink";
import type { OutputBlock } from "../types";
import MarkdownBlock from "./MarkdownBlock";
import SubAgentBlock from "./SubAgentBlock";
import ToolCardBlock from "./ToolCardBlock";
import PlanCardBlock from "./PlanCardBlock";
import { darkTheme } from "../theme";
const dt = darkTheme;

export function changePrefix(kind: string): { prefix: string; color: string } {
  switch (kind) {
    case "add": return { prefix: "+", color: dt.success };
    case "edit": return { prefix: "~", color: dt.warning };
    case "delete": return { prefix: "-", color: dt.error };
    default: return { prefix: "?", color: dt.muted };
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

const BLOCK_GAP = 1;

export default function renderBlock(
  block: OutputBlock,
  isFocused: boolean,
  thinkingVisible: boolean,
  _i: number,
  prevBlock?: OutputBlock,
) {
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
          {(isFocused || block.streaming) ? <Text color={dt.primary}>❯ </Text> : null}
          <MarkdownBlock content={block.content} streaming={block.streaming} color={block.isError ? dt.error : undefined} />
        </Box>
      );

    case "reason": {
      const isConsecutive = prevBlock?.kind === "reason";
      return (
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
          {!isConsecutive && (
            <Text color={isFocused ? dt.primary : dt.dim}>
              {!thinkingVisible || block.folded ? "▶ Thinking..." : "▼ Thinking"}
            </Text>
          )}
          {thinkingVisible && !block.folded && (
            <Box paddingLeft={2}>
              <Text color={dt.muted}>{block.content}</Text>
            </Box>
          )}
          {isConsecutive && (block.folded || !thinkingVisible) && (
            <Text color={dt.dim}>  ...</Text>
          )}
        </Box>
      );
    }

    case "tool_card":
      return (
        <Box key={block.id} marginBottom={BLOCK_GAP}>
          <ToolCardBlock block={block} />
        </Box>
      );

    case "file_change":
      return (
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
          <Text color={dt.muted}>── File Changes ──</Text>
          {block.changes.map((change, ci) => {
            const { prefix, color } = changePrefix(change.kind);
            const lineInfo = formatLines(change.linesAdded, change.linesRemoved);
            return (
              <Box key={`${block.id}-${ci}`} flexDirection="column">
                <Box>
                  <Text color={color}>{prefix} {change.path}</Text>
                  {lineInfo ? <Text color={dt.dim}>{lineInfo}</Text> : null}
                </Box>
                {change.preview && (
                  <Box paddingLeft={3} flexDirection="column">
                    {change.preview.split("\n").map((pl, pli) => (
                      <Text key={pli} color={dt.dim}>
                        │ {pl}
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
            <Text color={label.startsWith("✓") ? dt.success : dt.error}>{label}</Text>
          ) : (
            <Text color={dt.warning}>⚠ Awaiting approval — {block.approval.command}</Text>
          )}
        </Box>
      );
    }
    case "question": {
      return (
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
          {block.resolved ? (
            block.resolved === "cancelled" ? (
              <Text color={dt.dim}>⊘ Question cancelled</Text>
            ) : (
              <Text>
                <Text color={dt.success}>✓ Answered: </Text>
                <Text color={dt.muted}>{block.resolved}</Text>
              </Text>
            )
          ) : (
            <Text color={dt.primary}>? Question</Text>
          )}
        </Box>
      );
    }

    case "subagent":
      return (
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
          <SubAgentBlock block={block} />
        </Box>
      );

    case "plan_card":
      return (
        <Box key={block.id} marginBottom={BLOCK_GAP}>
          <PlanCardBlock block={block} />
        </Box>
      );

    default:
      return null;
  }
}
