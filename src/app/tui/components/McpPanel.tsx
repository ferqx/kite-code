import React from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import type { McpManager } from "@/core/mcp";
import type { McpServerState } from "@/core/mcp/index";
import { darkTheme as t } from "../theme";

interface McpPanelProps {
  manager: McpManager;
  onClose: () => void;
}

export default function McpPanel({ manager, onClose }: McpPanelProps) {
  useInput(() => {
    onClose();
  });

  const states = manager.getServerStates();

  if (states.size === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={t.dim} paddingX={1} marginY={1}>
        <Text bold color={t.primary}>
          MCP Servers
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={t.muted}>No MCP servers configured.</Text>
          <Text color={t.dim}>
            Add mcpServers to ~/.openpx/openpx.jsonc or .mcp.json in your project root.
          </Text>
        </Box>
        <Text color={t.dim}>
          Press any key to close
        </Text>
      </Box>
    );
  }

  // Collect all tool entries for truncation at the panel level
  // Show up to 10 tools total across all servers
  let totalToolsShown = 0;
  const MAX_TOOLS = 10;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.dim} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>
        MCP Servers
      </Text>

      {[...states.entries()].map(([name, state]: [string, McpServerState]) => {
        const connected = state.connected;
        const statusColor = connected ? t.success : t.error;
        const statusIcon = connected ? "●" : "○";
        const transportLabel = state.config.type === "http" ? "http" : "stdio";
        const toolCount = state.tools.length;
        const errorMsg = !connected && state.error ? state.error : null;

        // Calculate how many tools to show for this server
        const remaining = MAX_TOOLS - totalToolsShown;
        const toolsToShow = state.tools.slice(0, Math.max(0, remaining));
        const hiddenCount = Math.max(0, state.tools.length - toolsToShow.length);
        totalToolsShown += toolsToShow.length;

        return (
          <Box key={name} flexDirection="column" marginTop={1}>
            <Box>
              <Text color={statusColor}>{statusIcon} </Text>
              <Text bold>{name}</Text>
              <Text color={t.dim}> ({transportLabel})</Text>
              <Text color={t.muted}> — {toolCount} tool{toolCount !== 1 ? "s" : ""}</Text>
            </Box>

            {errorMsg && (
              <Box paddingLeft={2}>
                <Text color={t.error}>Error: {errorMsg}</Text>
              </Box>
            )}

            {toolsToShow.length > 0 && (
              <Box flexDirection="column" paddingLeft={2}>
                {toolsToShow.map((tool) => (
                  <Text key={tool.name} color={t.muted}>
                    mcp__{name}__{tool.name}
                  </Text>
                ))}
                {hiddenCount > 0 && (
                  <Text color={t.dim}>…and {hiddenCount} more</Text>
                )}
              </Box>
            )}

            {totalToolsShown >= MAX_TOOLS && (
              <Box paddingLeft={2}>
                <Text color={t.dim}>
                  (showing first {MAX_TOOLS} tools total)
                </Text>
              </Box>
            )}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color={t.dim}>
          Press any key to close
        </Text>
      </Box>
    </Box>
  );
}
