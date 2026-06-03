import React, { useState, useRef, useMemo } from "react";
import { Box, Text, Static } from "ink";
import { useInput } from "ink";
import type { OutputBlock } from "./types";
import MarkdownBlock from "./components/MarkdownBlock";
import SubAgentBlock from "./components/SubAgentBlock";
import ToolCardBlock from "./components/ToolCardBlock";
import PlanCardBlock from "./components/PlanCardBlock";
import { darkTheme } from "./theme";
const dt = darkTheme; // for exported utility functions

interface OutputAreaProps {
  blocks: OutputBlock[];
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

export function toolColor(status: string): string {
  switch (status) {
    case "done": return dt.success;
    case "error": return dt.error;
    case "running": return dt.warning;
    default: return dt.muted;
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

const OutputArea = React.memo(function OutputArea({ blocks, onToggleReason, onTogglePlan, onToggleToolExpand, onToggleSubagentExpand, thinkingVisible, running, overlayActive, header }: OutputAreaProps) {
  // ── Split: completed blocks → <Static>, current turn → dynamic tree ──
  //
  // Ink's <Static> renders each item once to terminal scrollback and tracks
  // rendered items by array length (useState counter). This means:
  //   - staticItems.length must NEVER decrease between renders
  //   - a shrink-then-grow causes already-rendered items to be re-rendered
  //     to scrollback, producing duplicate messages
  //
  // The monotonic guard (maxSplitRef) prevents this within a single run.
  // On idle, we set rawSplitIdx = blocks.length (not -1) so the guard can
  // track the idle position. When the next turn starts, the guard holds
  // splitIdx at blocks.length, preventing staticItems from shrinking.
  //
  // splitIdx semantics:
  //   -1   → no turn exists yet (no user block); all blocks in Static
  //   0..N → split position; blocks before it in Static, after in dynamic
  //
  // Blocks needing dynamic (must be in the current turn):
  //   - text (streaming=true)    — growing content, "❯" cursor
  //   - tool_card (running)      — spinner animation + elapsed timer
  //   - subagent (running)       — elapsed timer + step updates
  //   - approval (!resolved)     — ApprovalBlock component
  //   - question (!resolved)     — InputBlock component
  const rawSplitIdx = useMemo(() => {
    // Find turn start (last user message)
    let turnStart = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === "user") { turnStart = i; break; }
    }

    // Find the earliest block in this turn that needs live updates
    let firstDynamic = -1;
    if (turnStart >= 0) {
      for (let i = turnStart; i < blocks.length; i++) {
        const b = blocks[i];
        if (
          (b.kind === "text" && (b as { streaming?: boolean }).streaming) ||
          (b.kind === "tool_card" && b.status === "running") ||
          (b.kind === "subagent" && b.status === "running") ||
          (b.kind === "approval" && !(b as { resolved?: unknown }).resolved) ||
          (b.kind === "question" && !(b as { resolved?: unknown }).resolved)
        ) {
          firstDynamic = i;
          break;
        }
      }
    }

    if (firstDynamic >= 0) return firstDynamic;
    // Idle: return blocks.length so the monotonic guard can track it.
    // This prevents staticItems from shrinking when the next turn starts.
    // -1 is reserved for "no turn exists" (no user block at all).
    if (!running) return blocks.length;
    if (turnStart >= 0) return turnStart;
    return -1;
  }, [blocks, running]);

  // Monotonic guard: prevents splitIdx from oscillating during a single run.
  // Reset on agent idle so the next turn can start fresh (splitIdx jumps to
  // blocks.length, guard records it; next turn's rawSplitIdx = turnStart ≤
  // blocks.length, so guard holds splitIdx at blocks.length, preventing
  // staticItems from shrinking).
  const maxSplitRef = useRef(-1);
  if (!running) {
    maxSplitRef.current = -1;
  }
  const splitIdx = rawSplitIdx >= 0 ? Math.max(rawSplitIdx, maxSplitRef.current) : rawSplitIdx;
  maxSplitRef.current = splitIdx;

  const completedBlocks = useMemo(
    () => splitIdx >= 0 ? blocks.slice(0, splitIdx) : blocks,
    [blocks, splitIdx]
  );
  const activeBlocks = useMemo(
    () => splitIdx >= 0 ? blocks.slice(splitIdx) : [],
    [blocks, splitIdx]
  );

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

  // ── <Static> items: [Header sentinel, ...completedBlocks] ──
  // index 0 → Header (rendered only on first pass; <Static> skips it after)
  // index 1+ → completed blocks (appended to terminal scrollback one by one)
  const staticItems = useMemo(() => [HEADER_SENTINEL, ...completedBlocks], [completedBlocks]);

  return (
    <Box flexDirection="column">
      <Box height={0} overflow="hidden">
      <Static items={staticItems}>
        {(item, index) => {
          if (index === 0) {
            return <React.Fragment key="header">{header}</React.Fragment>;
          }
          const blockIdx = index - 1;
          const block = completedBlocks[blockIdx];
          if (!block) return null;
          return renderBlock(
            block,
            false,
            thinkingVisible,
            blockIdx,
            blockIdx > 0 ? completedBlocks[blockIdx - 1] : undefined,
          );
        }}
      </Static>
      </Box>
      {/* Active blocks stay in the interactive tree for live updates */}
      {activeBlocks.map((block, i) => {
        const isFocused = i === focusedActiveIdx;
        const prevBlock = i > 0 ? activeBlocks[i - 1] : (completedBlocks.length > 0 ? completedBlocks[completedBlocks.length - 1] : undefined);
        return renderBlock(block, isFocused, thinkingVisible, 0, prevBlock);
      })}
    </Box>
  );
});

export default OutputArea;
