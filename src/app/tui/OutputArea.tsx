import React, { useState, useRef, useMemo } from "react";
import { Box, Text, Static } from "ink";
import { useInput } from "ink";
import type { Turn, OutputBlock } from "./types";
import MarkdownBlock from "./components/MarkdownBlock";
import SubAgentBlock from "./components/SubAgentBlock";
import ToolCardBlock from "./components/ToolCardBlock";
import PlanCardBlock from "./components/PlanCardBlock";
import { darkTheme } from "./theme";
import { toolColor, formatElapsed } from "./components/render-utils";
const dt = darkTheme; // for exported utility functions

export { toolColor } from "./components/render-utils";

interface OutputAreaProps {
  turns: Turn[];
  onToggleReason: (id: number) => void;
  onTogglePlan?: (id: number) => void;
  onToggleToolExpand?: (id: number) => void;
  onToggleSubagentExpand?: (id: number) => void;
  thinkingVisible: boolean;
  /** Agent 是否正在执行（控制 Static/dynamic 分割策略） */
  running: boolean;
  /** 当 overlay 面板激活时，禁用方向键导航 */
  overlayActive?: boolean;
  /** 渲染在 <Static> 最上方的静态头（Header 组件） */
  header?: React.ReactNode;
}

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

/** Sentinel: ensures <Static> always has ≥1 item so Header renders even with no completed blocks */
const HEADER_SENTINEL = { __header: true } as const;

const OutputArea = React.memo(function OutputArea({ turns, onToggleReason, onTogglePlan, onToggleToolExpand, onToggleSubagentExpand, thinkingVisible, running, overlayActive, header }: OutputAreaProps) {
  // ── Turn-based Static/Dynamic split ──
  //   - running=true  → last turn in Dynamic, all previous in Static
  //   - running=false → all turns in Static
  //   Monotonically increasing staticBlocks: settled turns never decrease.
  const settledTurns = running ? turns.slice(0, -1) : turns;
  const activeTurn   = running ? turns.at(-1) : undefined;

  const staticBlocks = settledTurns.flatMap(t => t.blocks);
  const activeBlocks = activeTurn ? activeTurn.blocks : [];

  // Arrow key navigation for the dynamic (active) section only
  const [focusedActiveIdx, setFocusedActiveIdx] = useState<number | null>(null);
  const focusedRef = useRef(focusedActiveIdx);
  focusedRef.current = focusedActiveIdx;

  // Stable callback refs for useInput (Ink 7 stale closure workaround)
  const onToggleReasonRef = useRef(onToggleReason);
  onToggleReasonRef.current = onToggleReason;
  const onTogglePlanRef = useRef(onTogglePlan);
  onTogglePlanRef.current = onTogglePlan;
  const onToggleToolRef = useRef(onToggleToolExpand);
  onToggleToolRef.current = onToggleToolExpand;
  const onToggleSubagentRef = useRef(onToggleSubagentExpand);
  onToggleSubagentRef.current = onToggleSubagentExpand;

  useInput((_input: unknown, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    if (overlayActive) return;
    if (activeBlocks.length === 0) return;
    if (key.upArrow) {
      setFocusedActiveIdx((prev) => Math.max(0, (prev ?? activeBlocks.length) - 1));
    }
    if (key.downArrow) {
      setFocusedActiveIdx((prev) => Math.min(activeBlocks.length - 1, (prev ?? -1) + 1));
    }
    if (key.return && focusedRef.current !== null && focusedRef.current < activeBlocks.length) {
      const block = activeBlocks[focusedRef.current];
      if (!block) return;
      if (block.kind === "reason") {
        onToggleReasonRef.current?.(block.id);
      } else if (block.kind === "plan_card") {
        onTogglePlanRef.current?.(block.id);
      } else if (block.kind === "tool_card") {
        onToggleToolRef.current?.(block.id);
      } else if (block.kind === "subagent") {
        onToggleSubagentRef.current?.(block.id);
      }
    }
  });

  // ── <Static> items: [Header sentinel, ...staticBlocks] ──
  const staticItems = useMemo(() => [HEADER_SENTINEL, ...staticBlocks], [staticBlocks]);

  return (
    <Box flexDirection="column">
      <Box height={0} overflow="hidden">
      <Static items={staticItems}>
        {(item, index) => {
          if (index === 0) {
            return <React.Fragment key="header">{header}</React.Fragment>;
          }
          const blockIdx = index - 1;
          const block = staticBlocks[blockIdx];
          if (!block) return null;
          return renderBlock(
            block,
            false,
            thinkingVisible,
            blockIdx,
            blockIdx > 0 ? staticBlocks[blockIdx - 1] : undefined,
          );
        }}
      </Static>
      </Box>
      {/* Active blocks stay in the interactive tree for live updates */}
      {activeBlocks.map((block, i) => {
        const isFocused = i === focusedActiveIdx;
        const lastSettledBlock = staticBlocks.at(-1);
        const prevBlock = i > 0
          ? activeBlocks[i - 1]
          : lastSettledBlock;
        return renderBlock(block, isFocused, thinkingVisible, 0, prevBlock);
      })}
    </Box>
  );
});

export default OutputArea;
