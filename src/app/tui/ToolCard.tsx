import React from "react";
import { Box, Text } from "ink";
import type { ToolCardState } from "./types";
import { darkTheme as t } from "./theme";

interface ToolCardProps {
  tools: ToolCardState[];
}

function statusIcon(status: ToolCardState["status"]): string {
  switch (status) {
    case "pending": return "○";
    case "running": return "⏳";
    case "done": return "✓";
    case "error": return "✗";
  }
}

function statusColor(status: ToolCardState["status"]): string {
  switch (status) {
    case "done": return t.success;
    case "error": return t.error;
    case "running": return t.warning;
    default: return t.muted;
  }
}

export default function ToolCard({ tools }: ToolCardProps) {
  if (tools.length === 0) return null;

  return (
    <Box flexDirection="column">
      {tools.map((tool) => (
        <Box key={tool.callId} flexDirection="column">
          <Box>
            <Text color={statusColor(tool.status)}>
              {statusIcon(tool.status)} {tool.name}
            </Text>
            {tool.status === "done" || tool.status === "error" ? (
              <Text color={t.muted}> — {tool.summary.slice(0, 120)}</Text>
            ) : null}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
