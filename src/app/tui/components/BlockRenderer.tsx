import React from "react";
import { Box, Text } from "ink";
import type { OutputBlock } from "../types";
import MarkdownBlock from "./MarkdownBlock";
import SubAgentBlock from "./SubAgentBlock";
import ToolCardBlock from "./ToolCardBlock";
import PlanCardBlock from "./PlanCardBlock";
import { useTheme } from "../theme";

export function changePrefix(kind: string, theme?: { success: string; warning: string; error: string; muted: string }): { prefix: string; color: string } {
  const t = theme ?? { success: "#4ADE80", warning: "#FBBF24", error: "#F87171", muted: "#9CA3AF" };
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

const BLOCK_GAP = 1;
const REASON_INDENT = 2;
const REASON_MAX_LINES = 5;

interface BlockRendererProps {
  block: OutputBlock;
  isFocused: boolean;
  index: number;
  prevBlock?: OutputBlock;
  /** 当主 agent 等待审批时，工具并未真正执行，隐藏计时器 / When awaiting approval, tool isn't actually running, hide timer */
  awaitingApproval?: boolean;
}

const BlockRenderer = React.memo(function BlockRenderer({
  block, isFocused, index: _i, prevBlock, awaitingApproval,
}: BlockRendererProps) {
  const dt = useTheme();
  switch (block.kind) {
    case "user":
      return (
        <Box marginBottom={BLOCK_GAP}>
          <MarkdownBlock content={"❯ " + block.content} />
        </Box>
      );

    case "text":
      return (
        <Box marginBottom={BLOCK_GAP}>
          <MarkdownBlock content={block.content} streaming={block.streaming} color={block.isError ? dt.error : undefined} />
        </Box>
      );

    case "reason": {
      const isConsecutive = prevBlock?.kind === "reason";
      const lines = block.content.split("\n");
      const truncated = lines.length > REASON_MAX_LINES;
      const display = truncated ? lines.slice(0, REASON_MAX_LINES) : lines;
      return (
        <Box flexDirection="column" marginBottom={BLOCK_GAP}>
          {!isConsecutive && (
            <Text color={isFocused ? dt.primary : dt.dim}>
              {block.folded ? "▶ Thinking..." : "▼ Thinking"}
            </Text>
          )}
          {!block.folded && (
            <Box flexDirection="column" marginLeft={REASON_INDENT}>
              {display.map((line, i) => (
                <Text key={i} color={dt.muted}>{line}</Text>
              ))}
              {truncated && (
                <Text color={dt.dim}>...</Text>
              )}
            </Box>
          )}
          {isConsecutive && block.folded && (
            <Text color={dt.dim}>  ...</Text>
          )}
        </Box>
      );
    }

    case "tool_card":
      return (
        <Box marginBottom={BLOCK_GAP}>
          <ToolCardBlock block={block} awaitingApproval={awaitingApproval} />
        </Box>
      );

    case "file_change":
      return (
        <Box flexDirection="column" marginBottom={BLOCK_GAP}>
          <Text color={dt.muted}>── File Changes ──</Text>
          {block.changes.map((change, ci) => {
            const { prefix, color } = changePrefix(change.kind, dt);
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
      // 审批展示在 Footer，输出区无需重复
      // Approval UI is in Footer, no duplicate needed in output area
      return null;
    }
    case "question": {
      return (
        <Box flexDirection="column" marginBottom={BLOCK_GAP}>
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
        <Box flexDirection="column" marginBottom={BLOCK_GAP}>
          <SubAgentBlock block={block} />
        </Box>
      );

    case "plan_card":
      return (
        <Box marginBottom={BLOCK_GAP}>
          <PlanCardBlock block={block} />
        </Box>
      );

    default: {
      const _exhaustive: never = block;
      return (
        <Box marginBottom={BLOCK_GAP}>
          <Text color={dt.warning}>
            ? Unknown block kind: {(_exhaustive as OutputBlock).kind}
          </Text>
        </Box>
      );
    }
  }
});

export default BlockRenderer;
