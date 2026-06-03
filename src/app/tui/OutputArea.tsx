import React, { useState, useRef } from "react";
import { Box, Text } from "ink";
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
  /** Agent 是否正在执行（控制 streaming 指示器） */
  running: boolean;
  /** 当 overlay 面板激活时，禁用方向键导航 */
  overlayActive?: boolean;
  /** 渲染在最上方的 Header 组件 */
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

export function formatElapsed(ms: number): string {
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

// ── Memoized block components ──
// Each block type wrapped in React.memo with its own equality check.
// Since the reducer maintains reference stability for unchanged blocks,
// memo prevents terminal re-renders for blocks whose content hasn't changed.

const UserBlock = React.memo(function UserBlock({ block }: { block: OutputBlock & { kind: "user" } }) {
  return (
    <Box marginBottom={1}>
      <MarkdownBlock content={"❯ " + block.content} />
    </Box>
  );
});

const TextBlock = React.memo(function TextBlock({ block, isFocused }: { block: OutputBlock & { kind: "text" }; isFocused: boolean }) {
  return (
    <Box marginBottom={1}>
      {(isFocused || block.streaming) ? <Text color={dt.primary}>❯ </Text> : null}
      <MarkdownBlock content={block.content} streaming={block.streaming} color={block.isError ? dt.error : undefined} />
    </Box>
  );
});

const ReasonBlock = React.memo(function ReasonBlock({ block, isFocused, thinkVisible, isConsecutive }: {
  block: OutputBlock & { kind: "reason" };
  isFocused: boolean;
  thinkVisible: boolean;
  isConsecutive: boolean;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {!isConsecutive && (
        <Text color={isFocused ? dt.primary : dt.dim}>
          {!thinkVisible || block.folded ? "▶ Thinking..." : "▼ Thinking"}
        </Text>
      )}
      {thinkVisible && !block.folded && (
        <Box paddingLeft={2}>
          <Text color={dt.muted}>{block.content}</Text>
        </Box>
      )}
      {isConsecutive && (block.folded || !thinkVisible) && (
        <Text color={dt.dim}>  ...</Text>
      )}
    </Box>
  );
});

const ToolCard = React.memo(function ToolCard({ block }: { block: OutputBlock & { kind: "tool_card" } }) {
  return (
    <Box marginBottom={1}>
      <ToolCardBlock block={block} />
    </Box>
  );
});

const FileChange = React.memo(function FileChange({ block }: { block: OutputBlock & { kind: "file_change" } }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={dt.muted}>── File Changes ──</Text>
      {block.changes.map((change, ci) => {
        const { prefix, color } = changePrefix(change.kind);
        const parts: string[] = [];
        if (change.linesAdded != null) parts.push(`+${change.linesAdded}`);
        if (change.linesRemoved != null) parts.push(`-${change.linesRemoved}`);
        const lineInfo = parts.length > 0 ? ` (${parts.join(" ")})` : "";
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
});

const Approval = React.memo(function Approval({ block }: { block: OutputBlock & { kind: "approval" } }) {
  const label = (() => {
    if (!block.resolved) return null;
    if (block.resolved.action === "cancelled") return "⊘ Cancelled";
    if (block.resolved.action === "denied") return "× Denied";
    if (block.resolved.action === "approve_once") return "✓ Approved (once)";
    if (block.resolved.action === "same_command") return `✓ Approved (same command)${block.resolved.pattern ? ` "${block.resolved.pattern}"` : ""}`;
    if (block.resolved.action === "full_access") return "✓ Approved (full access)";
    return `? ${block.resolved.action}`;
  })();
  return (
    <Box flexDirection="column" marginBottom={1}>
      {label ? (
        <Text color={label.startsWith("✓") ? dt.success : dt.error}>{label}</Text>
      ) : (
        <Text color={dt.warning}>⚠ Awaiting approval — {block.approval.command}</Text>
      )}
    </Box>
  );
});

const Question = React.memo(function Question({ block }: { block: OutputBlock & { kind: "question" } }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
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
});

const SubAgent = React.memo(function SubAgent({ block }: { block: OutputBlock & { kind: "subagent" } }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <SubAgentBlock block={block} />
    </Box>
  );
});

const PlanCard = React.memo(function PlanCard({ block }: { block: OutputBlock & { kind: "plan_card" } }) {
  return (
    <Box marginBottom={1}>
      <PlanCardBlock block={block} />
    </Box>
  );
});

// ── Block render dispatcher ──
function renderBlock(block: OutputBlock, isFocused: boolean, thinkingVisible: boolean, prevBlock?: OutputBlock) {
  switch (block.kind) {
    case "user": return <UserBlock key={block.id} block={block} />;
    case "text": return <TextBlock key={block.id} block={block} isFocused={isFocused} />;
    case "reason": {
      const isConsecutive = prevBlock?.kind === "reason";
      return <ReasonBlock key={block.id} block={block} isFocused={isFocused} thinkVisible={thinkingVisible} isConsecutive={isConsecutive} />;
    }
    case "tool_card": return <ToolCard key={block.id} block={block} />;
    case "file_change": return <FileChange key={block.id} block={block} />;
    case "approval": return <Approval key={block.id} block={block} />;
    case "question": return <Question key={block.id} block={block} />;
    case "subagent": return <SubAgent key={block.id} block={block} />;
    case "plan_card": return <PlanCard key={block.id} block={block} />;
    default: return null;
  }
}

// ── OutputArea component ──
const OutputArea = React.memo(function OutputArea({ blocks, onToggleReason, onTogglePlan, onToggleToolExpand, onToggleSubagentExpand, thinkingVisible, running: _running, overlayActive, header }: OutputAreaProps) {
  // Arrow key navigation across all blocks
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const focusedRef = useRef(focusedIdx);
  focusedRef.current = focusedIdx;
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
    if (blocks.length === 0) return;
    if (key.upArrow) {
      setFocusedIdx((prev) => Math.max(0, (prev ?? blocks.length) - 1));
    }
    if (key.downArrow) {
      setFocusedIdx((prev) => Math.min(blocks.length - 1, (prev ?? -1) + 1));
    }
    if (key.return && focusedRef.current !== null && focusedRef.current < blocks.length) {
      const block = blocks[focusedRef.current];
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

  return (
    <Box flexDirection="column">
      {header}
      {blocks.map((block, i) => {
        const isFocused = i === focusedIdx;
        const prevBlock = i > 0 ? blocks[i - 1] : undefined;
        return renderBlock(block, isFocused, thinkingVisible, prevBlock);
      })}
    </Box>
  );
});

export default OutputArea;
