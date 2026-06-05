import React from "react";
import { Box, Text } from "ink";
import type { OutputBlock } from "../types";
import type { PlanStatus } from "@/protocol/events";
import { useTheme } from "../theme";

function planStatusIcon(status: PlanStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "in_progress": return "●";
    case "pending": return "○";
  }
}

function planStatusColor(status: PlanStatus, t: { success: string; warning: string; muted: string }): string {
  switch (status) {
    case "completed": return t.success;
    case "in_progress": return t.warning;
    case "pending": return t.muted;
  }
}

function stepStatusIcon(status: PlanStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "in_progress": return "▶";
    case "pending": return "·";
  }
}

function planStatusLabel(status: PlanStatus): string {
  switch (status) {
    case "completed": return "已完成";
    case "in_progress": return "进行中";
    case "pending": return "待开始";
  }
}

interface PlanCardBlockProps {
  block: OutputBlock & { kind: "plan_card" };
}

export default function PlanCardBlock({ block }: PlanCardBlockProps) {
  const dt = useTheme();
  if (block.folded) {
    return (
      <Box>
        <Text color={dt.muted}>
          ▶ Plan: {block.name} ({block.steps.length} 步骤, {planStatusLabel(block.planStatus)})
        </Text>
        <Text color={dt.dim}> Enter 展开</Text>
      </Box>
    );
  }

  const icon = planStatusIcon(block.planStatus);
  const color = planStatusColor(block.planStatus, dt);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={dt.primary} paddingX={1}>
      {/* Header */}
      <Box>
        <Text color={color}>{icon} </Text>
        <Text bold color={dt.primary}>Plan: {block.name}</Text>
      </Box>
      {/* Description */}
      {block.description && (
        <Box marginTop={1}>
          <Text color={dt.muted}>{block.description}</Text>
        </Box>
      )}
      {/* Steps */}
      <Box flexDirection="column" marginTop={1}>
        {block.steps.map((step, i) => {
          const sIcon = stepStatusIcon(step.status);
          const sColor = planStatusColor(step.status, dt);
          return (
            <Box key={i} paddingLeft={1}>
              <Text color={sColor}>{sIcon} </Text>
              <Text color={dt.muted}>{step.step}</Text>
            </Box>
          );
        })}
      </Box>
      {/* Footer */}
      <Box marginTop={1}>
        <Text color={dt.dim}>Status: {planStatusLabel(block.planStatus)}    Enter 折叠</Text>
      </Box>
    </Box>
  );
}
