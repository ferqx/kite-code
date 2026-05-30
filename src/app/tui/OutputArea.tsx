import React, { useState, useRef, useMemo } from "react";
import { Box, Text, Static } from "ink";
import { useInput } from "ink";
import type { OutputBlock } from "./types";
import MarkdownBlock from "./components/MarkdownBlock";
import SubAgentBlock from "./components/SubAgentBlock";
import { darkTheme } from "./theme";
const dt = darkTheme; // for exported utility functions

interface OutputAreaProps {
  blocks: OutputBlock[];
  onToggleReason: (id: number) => void;
  thinkingVisible: boolean;
  /** 当 overlay 面板（HelpPanel/SessionSelector/ModelSelector 等）激活时，禁用方向键导航，避免同时触发多个 useInput handler */
  overlayActive?: boolean;
  /** 会话切换时强制 <Static> remount，避免累积重复输出 */
  sessionKey?: number;
  /** 渲染在 <Static> 最上方的静态头（Header 组件） */
  header?: React.ReactNode;
  /** 中断 block id：当存在中断时，以此 block 为界分割 Static/dynamic，确保中断 block 保持在交互区 */
  interruptBlockId?: number;
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

const MAX_TOOL_LINES = 12;

function renderToolSummary(summary: string, isError: boolean) {
  const prefix = isError ? "✕ " : "⎿ ";
  const color = isError ? dt.error : dt.dim;
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
        <Text color={dt.dim}>   ... ({lines.length - MAX_TOOL_LINES} more lines)</Text>
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
        <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
          <Box>
            <Text color={toolColor(block.status)}>⏺ </Text>
            <Text color={dt.primary}>{block.name}</Text>
            {block.preview ? (
              <Text color={dt.muted}> {block.preview}</Text>
            ) : null}
            {block.detail ? (
              <Text color={dt.dim}> {block.detail}</Text>
            ) : null}
            {block.status === "running" ? (
              <Text color={dt.dim}> ...</Text>
            ) : null}
            {block.elapsedMs != null && block.name === "shell_execute" && (
              <Text color={dt.dim}> ({formatElapsed(block.elapsedMs)})</Text>
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

    default:
      return null;
  }
}

/** 哨兵值：保证 <Static> items 始终至少有 1 项，使 Header 即使在无 completed block 时也能渲染 */
const HEADER_SENTINEL = { __header: true } as const;

const OutputArea = React.memo(function OutputArea({ blocks, onToggleReason, thinkingVisible, overlayActive, sessionKey, header, interruptBlockId }: OutputAreaProps) {
  // ── Split: completed blocks → <Static>, active block → dynamic tree ──
  // <Static> renders items once to the terminal scrollback buffer and skips
  // them in the interactive render pass. This keeps the interactive tree small
  // so Ink's reconciler + yoga-layout + diff run fast during typing.
  // When an interrupt is active, use its block as the boundary so the
  // question/approval block and everything after it stays interactive.
  const splitIdx = useMemo(() => {
    if (interruptBlockId != null) {
      const idx = blocks.findIndex(b => b.id === interruptBlockId);
      if (idx >= 0) return idx;
    }
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === "text" && (blocks[i] as { streaming?: boolean }).streaming) {
        return i;
      }
    }
    return -1;
  }, [blocks, interruptBlockId]);

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
      if (block && block.kind === "reason") {
        onToggleReason(block.id);
      }
    }
  });

  // ── <Static> items: [Header sentinel, ...completedBlocks] ──
  // index 0 → Header（仅首次渲染时输出，之后 <Static> 跳过）
  // index 1+ → completed blocks（逐条追加到终端 scrollback）
  // sessionKey 变化时 <Static> remount，重新渲染所有项（含 Header）
  const staticItems = useMemo(() => [HEADER_SENTINEL, ...completedBlocks], [completedBlocks]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static key={sessionKey} items={staticItems}>
        {(item, index) => {
          // 第 0 项：渲染 Header
          if (index === 0) {
            return <React.Fragment key="header">{header}</React.Fragment>;
          }
          // index 1+：渲染 completed block（index 需减 1 因为 sentinel 占了 index 0）
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
