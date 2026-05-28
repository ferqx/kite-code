import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { ScrollList } from "ink-scroll-list";
import type { McpManager } from "@/core/mcp";
import type { McpServerState } from "@/core/mcp/index";
import { useTheme } from "../theme";
import { useOverlayHeight } from "../hooks/useOverlayHeight";

interface McpPanelProps {
  manager: McpManager;
  onClose: () => void;
}

type FlatRow =
  | { type: "server"; name: string; statusColor: string; statusIcon: string; transportLabel: string; toolCount: number }
  | { type: "error"; message: string }
  | { type: "tool"; serverName: string; toolName: string }
  | { type: "more-tools"; count: number }
  | { type: "resources-header" }
  | { type: "resource"; name: string; uri: string }
  | { type: "more-resources"; count: number }
  | { type: "max-tools-notice"; max: number };

export default function McpPanel({ manager, onClose }: McpPanelProps) {
  const t = useTheme();
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxContentHeight = useOverlayHeight(8);
  const states = manager.getServerStates();

  useInput((_input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { setScrollOffset((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setScrollOffset((s) => Math.min(flatRows.length - 1, s + 1)); return; }
    onClose();
  });

  if (states.size === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginY={1}>
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
          Esc close
        </Text>
      </Box>
    );
  }

  // Flatten server/tool/resource structure into rows
  let totalToolsShown = 0;
  const MAX_TOOLS = 10;
  const flatRows: FlatRow[] = [];

  for (const [name, state] of states.entries()) {
    const connected = state.connected;
    const statusColor = connected ? t.success : t.error;
    const statusIcon = connected ? "●" : "○";
    const transportLabel = state.config.type === "http" ? "http" : "stdio";
    const toolCount = state.tools.length;

    flatRows.push({ type: "server", name, statusColor, statusIcon, transportLabel, toolCount });

    if (!connected && state.error) {
      flatRows.push({ type: "error", message: state.error });
    }

    const remaining = MAX_TOOLS - totalToolsShown;
    const toolsToShow = state.tools.slice(0, Math.max(0, remaining));
    const hiddenCount = Math.max(0, state.tools.length - toolsToShow.length);
    totalToolsShown += toolsToShow.length;

    for (const tool of toolsToShow) {
      flatRows.push({ type: "tool", serverName: name, toolName: tool.name });
    }
    if (hiddenCount > 0) {
      flatRows.push({ type: "more-tools", count: hiddenCount });
    }

    if (connected && state.resources && state.resources.length > 0) {
      flatRows.push({ type: "resources-header" });
      for (const r of state.resources.slice(0, 10)) {
        flatRows.push({ type: "resource", name: r.name || r.uri, uri: r.uri });
      }
      if (state.resources.length > 10) {
        flatRows.push({ type: "more-resources", count: state.resources.length - 10 });
      }
    }

    if (totalToolsShown >= MAX_TOOLS) {
      flatRows.push({ type: "max-tools-notice", max: MAX_TOOLS });
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>
        MCP Servers
      </Text>

      <Box marginTop={1} flexGrow={1} maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={scrollOffset} scrollAlignment="auto">
          {flatRows.map((row, i) => {
            switch (row.type) {
              case "server":
                return (
                  <Box key={`s-${row.name}`} marginTop={i === 0 ? 0 : 1}>
                    <Text color={row.statusColor}>{row.statusIcon} </Text>
                    <Text bold>{row.name}</Text>
                    <Text color={t.dim}> ({row.transportLabel})</Text>
                    <Text color={t.muted}> — {row.toolCount} tool{row.toolCount !== 1 ? "s" : ""}</Text>
                  </Box>
                );
              case "error":
                return (
                  <Box key={`e-${row.message}`} paddingLeft={2}>
                    <Text color={t.error}>Error: {row.message}</Text>
                  </Box>
                );
              case "tool":
                return (
                  <Text key={`t-${row.serverName}-${row.toolName}`} color={t.muted}>
                    mcp__{row.serverName}__{row.toolName}
                  </Text>
                );
              case "more-tools":
                return (
                  <Text key={`mt-${row.count}`} color={t.dim}>…and {row.count} more</Text>
                );
              case "resources-header":
                return (
                  <Text key="rh" color={t.dim} bold>Resources:</Text>
                );
              case "resource":
                return (
                  <Text key={`r-${row.uri}`} color={t.muted}>
                    {"📄"} {row.name} ({row.uri})
                  </Text>
                );
              case "more-resources":
                return (
                  <Text key={`mr-${row.count}`} color={t.dim}>…and {row.count} more</Text>
                );
              case "max-tools-notice":
                return (
                  <Text key="mtn" color={t.dim}>
                    (showing first {row.max} tools total)
                  </Text>
                );
            }
          })}
        </ScrollList>
      </Box>

      <Box marginTop={1}>
        <Text color={t.dim}>
          Esc 关闭  ↑↓ 滚动
        </Text>
      </Box>
    </Box>
  );
}
