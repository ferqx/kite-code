import React, { useState, useRef, useMemo } from "react";
import { Box, Static } from "ink";
import { useInput } from "ink";
import type { Turn } from "./types";
import renderBlock, { changePrefix } from "./components/BlockRenderer";
export { changePrefix } from "./components/BlockRenderer";
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
