import React from "react";
import { Box, Text } from "ink";
import type { OutputBlock } from "../types";
import type { SubAgentRole } from "@/protocol/events";
import { darkTheme as dt } from "../theme";

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

interface SubAgentBlockProps {
  block: OutputBlock & { kind: "subagent" };
}

export default function SubAgentBlock({ block }: SubAgentBlockProps) {
  const icon = roleIcon(block.role);
  const label = roleLabel(block.role);

  if (block.status === "running") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.warning}>▸ {icon} </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {block.task}</Text>
          <Text color={dt.dim}> ...</Text>
        </Box>
        {block.steps.map((step, i) => (
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
          <Text color={dt.muted}> · {block.task}</Text>
        </Box>
        <Box paddingLeft={3}>
          <Text color={dt.error}>{block.error ?? "Unknown error"}</Text>
        </Box>
      </Box>
    );
  }

  // done
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={dt.success}>▼ {icon} </Text>
        <Text color={dt.primary}>{label}</Text>
        <Text color={dt.muted}> · {block.task}</Text>
        <Text color={dt.dim}> — {block.toolCallCount} 次工具调用，{formatDuration(block.durationMs)}</Text>
      </Box>
      {block.summary && (
        <Box paddingLeft={3} flexDirection="column">
          {block.summary.split("\n").map((line, i) => (
            <Text key={i} color={dt.dim}>
              {i === 0 ? "│ " : "  "}{line.slice(0, 300)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
