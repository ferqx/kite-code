import React, { useRef, useMemo } from "react";
import { Box, Static } from "ink";
import { useInput } from "ink";
import type { Turn, OutputBlock } from "./types";
import BlockRenderer, { changePrefix } from "./components/BlockRenderer";
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
  /** 会话切换标识，每次切换会话递增；用于清空 <Static> 缓存 */
  sessionKey?: number;
}

/** Sentinel: ensures <Static> always has ≥1 item so Header renders even with no completed blocks */
const HEADER_SENTINEL = { __header: true } as const;

export default function OutputArea({ turns, onToggleReason, onTogglePlan, onToggleToolExpand, onToggleSubagentExpand, thinkingVisible, running, overlayActive, header, sessionKey }: OutputAreaProps) {
  // ── Two-level Static/Dynamic split ──
  //   Turn level: settled turns → Static, active turn → split further
  //   Block level: within active turn, completed blocks → Static, only the
  //   last block (streaming text / pending approval) stays in the dynamic tree.
  const settledTurns = running ? turns.slice(0, -1) : turns;
  const activeTurn   = running ? turns.at(-1) : undefined;

  // ── Turn-level settled blocks (cached — only changes when new turns settle or session switches) ──
  const settledBlockCount = settledTurns.reduce((n, t) => n + t.blocks.length, 0);
  const staticBlocksRef = useRef<OutputBlock[]>([]);
  const prevSessionKeyRef = useRef(sessionKey);
  const prevSettledCountRef = useRef(0);

  // Session switch: clear all caches and clear terminal.
  // Clear must be synchronous in render body so it lands in the same stdout flush
  // as Ink's new content — useEffect fires AFTER Ink has already flushed.
  if (sessionKey !== prevSessionKeyRef.current) {
    prevSessionKeyRef.current = sessionKey;
    staticBlocksRef.current = [];
    prevSettledCountRef.current = 0;
    // eslint-disable-next-line no-restricted-properties -- intentional synchronous clear before Ink flush
    process.stdout.write("\x1B[2J\x1B[H");
  }

  if (settledBlockCount !== prevSettledCountRef.current) {
    prevSettledCountRef.current = settledBlockCount;
    staticBlocksRef.current = settledTurns.flatMap(t => t.blocks);
  }
  const staticBlocks = staticBlocksRef.current;

  // ── Block-level split within the active turn ──
  // Compute directly from props each render — no caching ref that can go stale.
  // Reserve the last block for the dynamic tree regardless of kind,
  // so in-place status updates (tool_card/subagent running→done) are always reflected.
  const activeSettledBlocks = useMemo(() => {
    if (!activeTurn) return [];
    const allBlocks = activeTurn.blocks;
    if (allBlocks.length === 0) return [];
    const lastBlock = allBlocks[allBlocks.length - 1];
    const isStreamingText = lastBlock?.kind === "text" && lastBlock.streaming;
    // Reserve last block for dynamic tree unless it's a streaming text block
    // (streaming text: n-1 settled, last stays dynamic; other: n-1 settled, last stays dynamic)
    const settledCount = isStreamingText ? allBlocks.length - 1 : Math.max(0, allBlocks.length - 1);
    return settledCount > 0 ? allBlocks.slice(0, settledCount) : [];
  }, [activeTurn]);

  const lastActiveBlock = activeTurn ? activeTurn.blocks[activeTurn.blocks.length - 1] : undefined;

  // Stable callback refs for useInput (Ink 7 stale closure workaround)
  const onToggleReasonRef = useRef(onToggleReason);
  onToggleReasonRef.current = onToggleReason;
  const onTogglePlanRef = useRef(onTogglePlan);
  onTogglePlanRef.current = onTogglePlan;
  const onToggleToolRef = useRef(onToggleToolExpand);
  onToggleToolRef.current = onToggleToolExpand;
  const onToggleSubagentRef = useRef(onToggleSubagentExpand);
  onToggleSubagentRef.current = onToggleSubagentExpand;
  const lastActiveBlockRef = useRef(lastActiveBlock);
  lastActiveBlockRef.current = lastActiveBlock;

  // Arrow key navigation over the last active block only (all prior blocks are in Static)
  useInput((_input: unknown, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    const lab = lastActiveBlockRef.current;
    if (!lab) return;
    if (key.return) {
      if (lab.kind === "reason") {
        onToggleReasonRef.current?.(lab.id);
      } else if (lab.kind === "plan_card") {
        onTogglePlanRef.current?.(lab.id);
      } else if (lab.kind === "tool_card") {
        onToggleToolRef.current?.(lab.id);
      } else if (lab.kind === "subagent") {
        onToggleSubagentRef.current?.(lab.id);
      }
    }
  }, { isActive: !overlayActive });

  // ── Merged static items: [Header sentinel, ...turn-level settled, ...block-level settled] ──
  const mergedStaticBlocks = useMemo(
    () => [...staticBlocks, ...activeSettledBlocks],
    [staticBlocks, activeSettledBlocks],
  );
  const staticItems = useMemo(
    () => [HEADER_SENTINEL, ...mergedStaticBlocks],
    [mergedStaticBlocks],
  );

  // Force <Static> to remount on session switch (sessionKey) or agent state change (running).
  // Ink's Static tracks which items have been written to stdout; remounting resets this
  // tracking so the Header (first item) re-renders when its props (running/error) change.
  const staticKey = useMemo(
    () => `s-${sessionKey ?? 0}-${running ? 1 : 0}`,
    [sessionKey, running],
  );

  return (
    <Box flexDirection="column">
      <Box height={0} overflow="hidden">
      <Static key={staticKey} items={staticItems}>
        {(item, index) => {
          if (index === 0) {
            return <React.Fragment key="header">{header}</React.Fragment>;
          }
          const blockIdx = index - 1;
          const block = mergedStaticBlocks[blockIdx];
          if (!block) return null;
          const prevBlock = blockIdx > 0 ? mergedStaticBlocks[blockIdx - 1] : undefined;
          return <BlockRenderer
            key={block.id}
            block={block}
            isFocused={false}
            thinkingVisible={thinkingVisible}
            index={blockIdx}
            prevBlock={prevBlock}
          />;
        }}
      </Static>
      </Box>
      {/* Only the last block stays in the dynamic tree for live streaming */}
      {lastActiveBlock && (
        <BlockRenderer
          key={lastActiveBlock.id}
          block={lastActiveBlock}
          isFocused={false}
          thinkingVisible={thinkingVisible}
          index={0}
          prevBlock={activeSettledBlocks.length > 0
            ? activeSettledBlocks[activeSettledBlocks.length - 1]
            : staticBlocks.at(-1)}
        />
      )}
    </Box>
  );
}
