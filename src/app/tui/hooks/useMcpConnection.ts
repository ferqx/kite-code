// ── MCP 连接管理 ──
import React from 'react';
import { loadMcpConfig, type McpProjectServerApprovalView } from '@/core/config/index';
import {
  decideProjectMcpServer,
  type McpProjectDecision,
} from '@/core/config/mcp-project-approvals';
import { McpManager } from '@/core/mcp';

export function useMcpConnection(
  mcpManagerRef: React.MutableRefObject<McpManager | null>,
  sessionManager: { updateMcpManager(m: McpManager | null): void },
  workspace: string,
) {
  const [mcpManager, setMcpManager] = React.useState<McpManager | null>(null);
  const [mcpProjectApprovals, setMcpProjectApprovals] = React.useState<
    readonly McpProjectServerApprovalView[]
  >([]);
  const [mcpDecisionMessage, setMcpDecisionMessage] = React.useState<string | undefined>();
  const [mcpPromptRegistry, setMcpPromptRegistry] = React.useState<
    Map<string, { server: string; prompt: { name: string; description?: string } }> | undefined
  >(undefined);

  React.useEffect(() => {
    const mcpConfig = loadMcpConfig(undefined, workspace);
    setMcpProjectApprovals(mcpConfig.catalog.projectApprovals);
    const manager = new McpManager();
    mcpManagerRef.current = manager;
    setMcpManager(manager);
    sessionManager.updateMcpManager(manager);
    let cancelled = false;
    manager
      .connectAll(mcpConfig.servers)
      .then(() => {
        if (cancelled) return;
        setMcpPromptRegistry(new Map(manager.getPromptRegistry()));
      })
      .catch((err) => {
        console.error('[MCP] Failed to connect servers:', err);
      });
    return () => {
      cancelled = true;
      const current = mcpManagerRef.current;
      mcpManagerRef.current = null;
      current?.disconnectAll().catch((err) => {
        console.error('[MCP] Failed to disconnect servers:', err);
      });
      sessionManager.updateMcpManager(null);
      setMcpManager(null);
      setMcpPromptRegistry(undefined);
      setMcpProjectApprovals([]);
    };
  }, [sessionManager.updateMcpManager, mcpManagerRef, workspace]);

  const decideMcpProjectServer = React.useCallback(
    async (view: McpProjectServerApprovalView, decision: McpProjectDecision) => {
      const result = decideProjectMcpServer({
        workspace,
        serverName: view.name,
        sourceKind: view.sourceKind,
        sourcePath: view.sourcePath,
        expectedConfigDigest: view.configDigest,
        decision,
      });
      if (result.status !== 'recorded') {
        setMcpDecisionMessage(result.message);
        const refreshed = loadMcpConfig(undefined, workspace);
        setMcpProjectApprovals(refreshed.catalog.projectApprovals);
        return;
      }

      setMcpDecisionMessage(
        decision === 'approved'
          ? `Approved project MCP server ${view.name}.`
          : `Rejected project MCP server ${view.name}.`,
      );
      const refreshed = loadMcpConfig(undefined, workspace);
      setMcpProjectApprovals(refreshed.catalog.projectApprovals);

      const previous = mcpManagerRef.current;
      await previous?.disconnectAll().catch((error) => {
        console.error('[MCP] Failed to disconnect servers after approval change:', error);
      });
      const manager = new McpManager();
      mcpManagerRef.current = manager;
      setMcpManager(manager);
      sessionManager.updateMcpManager(manager);
      await manager.connectAll(refreshed.servers);
      setMcpPromptRegistry(new Map(manager.getPromptRegistry()));
    },
    [mcpManagerRef, sessionManager, workspace],
  );

  return {
    mcpManager,
    mcpPromptRegistry,
    mcpProjectApprovals,
    mcpDecisionMessage,
    decideMcpProjectServer,
  };
}
