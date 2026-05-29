// ── MCP 连接管理 ──
import React from "react";
import { loadMcpConfig } from "@/core/config/index";
import { McpManager } from "@/core/mcp";

export function useMcpConnection(
  mcpManagerRef: React.MutableRefObject<McpManager | null>,
  sessionManager: { updateMcpManager(m: McpManager | null): void },
) {
  const [mcpManager, setMcpManager] = React.useState<McpManager | null>(null);
  const [mcpPromptRegistry, setMcpPromptRegistry] = React.useState<
    Map<string, { server: string; prompt: { name: string; description?: string } }> | undefined
  >(undefined);

  React.useEffect(() => {
    const mcpConfig = loadMcpConfig();
    const manager = new McpManager();
    mcpManagerRef.current = manager;
    setMcpManager(manager);
    sessionManager.updateMcpManager(manager);
    manager.connectAll(mcpConfig.servers).then(() => {
      setMcpPromptRegistry(new Map(manager.getPromptRegistry()));
    }).catch((err) => {
      console.error("[MCP] Failed to connect servers:", err);
    });
    return () => {
      manager.disconnectAll().catch((err) => {
        console.error("[MCP] Failed to disconnect servers:", err);
      });
      mcpManagerRef.current = null;
      setMcpManager(null);
      setMcpPromptRegistry(undefined);
    };
  }, []);

  return { mcpManager, mcpPromptRegistry };
}
