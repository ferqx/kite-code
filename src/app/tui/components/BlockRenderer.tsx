import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { OutputBlock } from "../types";
import MarkdownBlock from "./MarkdownBlock";
import SubAgentBlock from "./SubAgentBlock";
import ToolCardBlock from "./ToolCardBlock";
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

function gapFrom(prevBlock?: OutputBlock) {
  const afterText = prevBlock?.kind === "text" ? BLOCK_GAP : 0;
  return { marginTop: afterText, marginBottom: BLOCK_GAP } as const;
}

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
  const col = process.stdout.columns ?? 80;
  switch (block.kind) {
    case "user": {
      const prompt = "❯ ";
      const line = prompt + block.content;
      const w = stringWidth(line);
      const pad = col - w;
      return (
        <Box {...gapFrom(prevBlock)}>
          <Text backgroundColor={dt.userMsgBg}>
            {line}{pad > 0 ? " ".repeat(pad) : ""}
          </Text>
        </Box>
      );
    }

    case "text":
      return (
        <Box marginBottom={0}>
          <MarkdownBlock content={block.content} streaming={block.streaming} color={block.isError ? dt.error : undefined} />
        </Box>
      );

    case "reason":
      return null;

    case "tool_card":
      // Plan progress is shown in StatusBar — hide individual update_plan calls
      if (block.name === "update_plan") return null;
      return (
        <Box {...gapFrom(prevBlock)}>
          <ToolCardBlock block={block} awaitingApproval={awaitingApproval} />
        </Box>
      );

    case "file_change":
      return (
        <Box flexDirection="column" {...gapFrom(prevBlock)}>
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
        <Box flexDirection="column" {...gapFrom(prevBlock)}>
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
        <Box flexDirection="column" {...gapFrom(prevBlock)}>
          <SubAgentBlock block={block} />
        </Box>
      );

    default: {
      const _exhaustive: never = block;
      return (
        <Box {...gapFrom(prevBlock)}>
          <Text color={dt.warning}>
            ? Unknown block kind: {(_exhaustive as OutputBlock).kind}
          </Text>
        </Box>
      );
    }
  }
});

export default BlockRenderer;
