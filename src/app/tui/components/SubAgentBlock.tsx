import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { OutputBlock } from "../types";
import type { SubAgentRole } from "@/protocol/events";
import { darkTheme as dt } from "../theme";
import MarkdownBlock from "./MarkdownBlock";

function roleIcon(role: SubAgentRole): string {
  switch (role) {
    case "explore": return "🔍";
    case "code": return "🔧";
    case "review": return "👁";
    default: return "•";
  }
}

function roleLabel(role: SubAgentRole): string {
  switch (role) {
    case "explore": return "Explore";
    case "code": return "Code";
    case "review": return "Review";
    default: return role;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/** Truncate task text to a readable one-liner */
function taskLabel(task: string): string {
  const firstLine = task.split("\n")[0]?.trim() ?? task;
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
}

const MAX_RUNNING_STEPS = 10;

interface SubAgentBlockProps {
  block: OutputBlock & { kind: "subagent" };
}

export default function SubAgentBlock({ block }: SubAgentBlockProps) {
  const icon = roleIcon(block.role);
  const label = roleLabel(block.role);
  const taskSummary = taskLabel(block.task);

  // Live elapsed time for running state
  const [liveElapsed, setLiveElapsed] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    if (block.status !== "running") return;
    startRef.current = Date.now();
    setLiveElapsed(0);
    const timer = setInterval(() => setLiveElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(timer);
  }, [block.status, block.subagentId]);

  if (block.status === "running") {
    const stepCount = block.steps.length;
    const visibleSteps = stepCount > MAX_RUNNING_STEPS
      ? block.steps.slice(-MAX_RUNNING_STEPS)
      : block.steps;
    const skipped = stepCount - MAX_RUNNING_STEPS;

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.warning}>▸ {icon} </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {taskSummary}</Text>
          {stepCount > 0 && (
            <Text color={dt.dim}> ({stepCount} 步)</Text>
          )}
          <Text color={dt.dim}> ({formatDuration(liveElapsed)})</Text>
        </Box>
        {skipped > 0 && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>... 以上 {skipped} 步已折叠</Text>
          </Box>
        )}
        {visibleSteps.map((step, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={dt.dim}>├─ {step.toolName}</Text>
            {step.toolArgs && Object.keys(step.toolArgs).length > 0 && (
              <Text color={dt.muted}> {JSON.stringify(step.toolArgs).slice(0, 60)}</Text>
            )}
            {step.ok !== undefined && (
              <Text color={step.ok ? dt.success : dt.error}>
                {" "}{step.ok ? "✓" : "✗"}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    );
  }

  if (block.status === "error") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.error}>✗ {icon} </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {taskSummary}</Text>
        </Box>
        <Box paddingLeft={3}>
          <Text color={dt.error}>{block.error ?? "Unknown error"}</Text>
        </Box>
      </Box>
    );
  }

  // done — 使用 MarkdownBlock 渲染摘要，保留 Markdown 格式
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={dt.success}>▼ {icon} </Text>
        <Text color={dt.primary}>{label}</Text>
        <Text color={dt.muted}> · {taskSummary}</Text>
        <Text color={dt.dim}> — {block.toolCallCount} 次工具调用，{formatDuration(block.durationMs)}</Text>
      </Box>
      {block.summary && (
        <Box paddingLeft={3} flexDirection="column">
          <Box paddingLeft={0}>
            <Text color={dt.dim}>│ </Text>
          </Box>
          <MarkdownBlock content={block.summary} color={dt.dim} />
        </Box>
      )}
    </Box>
  );
}
