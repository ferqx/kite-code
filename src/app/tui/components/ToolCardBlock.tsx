import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { OutputBlock } from "../types";
import { useTheme } from "../theme";
import { SPINNER, toolColor, formatElapsed } from "./render-utils";

const MAX_TOOL_LINES = 12;

function renderToolSummary(summary: string, isError: boolean, dt: { error: string; dim: string }) {
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

interface ToolCardBlockProps {
  block: OutputBlock & { kind: "tool_card" };
}

export default function ToolCardBlock({ block }: ToolCardBlockProps) {
  const dt = useTheme();
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [liveElapsed, setLiveElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (block.status !== "running") return;
    startRef.current = Date.now();
    setLiveElapsed(0);
    const spinnerTimer = setInterval(() => setSpinnerIdx((i) => (i + 1) % SPINNER.length), 80);
    const elapsedTimer = setInterval(() => setLiveElapsed(Date.now() - startRef.current), 200);
    return () => { clearInterval(spinnerTimer); clearInterval(elapsedTimer); };
  }, [block.status, block.callId]);

  if (block.status === "running") {
    const spinner = SPINNER[spinnerIdx];
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.warning}>{spinner} </Text>
          <Text color={dt.primary}>{block.name}</Text>
          {block.preview ? (
            <Text color={dt.muted}> {block.preview}</Text>
          ) : null}
          <Text color={dt.dim}> ({formatElapsed(liveElapsed)})</Text>
        </Box>
      </Box>
    );
  }

  // done or error
  const isExpanded = block.expanded ?? block.status === "error";
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={toolColor(block.status, dt)}>⏺ </Text>
        <Text color={dt.primary}>{block.name}</Text>
        {block.detail ? (
          <Text color={dt.dim}> {block.detail}</Text>
        ) : null}
        {block.elapsedMs != null ? (
          <Text color={dt.dim}> ({formatElapsed(block.elapsedMs)})</Text>
        ) : null}
      </Box>
      {isExpanded && block.summary ? (
        <Box paddingLeft={3} flexDirection="column">
          {renderToolSummary(block.summary, block.status === "error", dt)}
        </Box>
      ) : null}
    </Box>
  );
}
