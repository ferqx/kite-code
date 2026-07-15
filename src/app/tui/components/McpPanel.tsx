import { Box, Text, useInput } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import { useState } from 'react';
import type { McpProjectServerApprovalView } from '@/core/config';
import type { McpProjectDecision } from '@/core/config/mcp-project-approvals';
import type { McpManager } from '@/core/mcp';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useTheme } from '../theme';

interface McpPanelProps {
  manager: McpManager;
  projectApprovals: readonly McpProjectServerApprovalView[];
  decisionMessage?: string;
  onProjectDecision?: (
    view: McpProjectServerApprovalView,
    decision: McpProjectDecision,
  ) => void | Promise<void>;
  onClose: () => void;
}

type FlatRow =
  | { type: 'approval'; view: McpProjectServerApprovalView }
  | { type: 'approval-detail'; message: string; name: string }
  | {
      type: 'server';
      name: string;
      statusColor: string;
      statusIcon: string;
      transportLabel: string;
      toolCount: number;
    }
  | { type: 'error'; message: string }
  | { type: 'tool'; serverName: string; toolName: string }
  | { type: 'more-tools'; count: number }
  | { type: 'resources-header' }
  | { type: 'resource'; name: string; uri: string }
  | { type: 'more-resources'; count: number }
  | { type: 'max-tools-notice'; max: number };

export default function McpPanel({
  manager,
  projectApprovals,
  decisionMessage,
  onProjectDecision,
  onClose,
}: McpPanelProps) {
  const t = useTheme();
  const [scrollOffset, setScrollOffset] = useState(0);
  const [pendingDecision, setPendingDecision] = useState<{
    view: McpProjectServerApprovalView;
    decision: McpProjectDecision;
  } | null>(null);
  const maxContentHeight = useOverlayHeight(8);
  const states = manager.getServerStates();
  let totalToolsShown = 0;
  const MAX_TOOLS = 10;
  const flatRows: FlatRow[] = [];

  useInput((_input, key) => {
    if (key.escape) {
      if (pendingDecision) {
        setPendingDecision(null);
        return;
      }
      onClose();
      return;
    }
    if (key.upArrow) {
      setScrollOffset((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((s) => Math.max(0, Math.min(flatRows.length - 1, s + 1)));
      return;
    }
    const selected = flatRows[scrollOffset];
    if (selected?.type === 'approval' && onProjectDecision) {
      if (_input === 'a' && selected.view.status !== 'approved') {
        if (
          pendingDecision?.view.configDigest === selected.view.configDigest &&
          pendingDecision.decision === 'approved'
        ) {
          setPendingDecision(null);
          void onProjectDecision(selected.view, 'approved');
        } else {
          setPendingDecision({ view: selected.view, decision: 'approved' });
        }
      } else if (_input === 'r' && selected.view.status !== 'rejected') {
        if (
          pendingDecision?.view.configDigest === selected.view.configDigest &&
          pendingDecision.decision === 'rejected'
        ) {
          setPendingDecision(null);
          void onProjectDecision(selected.view, 'rejected');
        } else {
          setPendingDecision({ view: selected.view, decision: 'rejected' });
        }
      }
    }
  });

  if (states.size === 0 && projectApprovals.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={t.primary}
        paddingX={1}
        marginY={1}
      >
        <Text bold color={t.primary}>
          MCP Servers
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={t.muted}>No MCP servers configured.</Text>
          <Text color={t.dim}>
            Add mcpServers to ~/.kite-code/kite-code.jsonc or .mcp.json in your project root.
          </Text>
        </Box>
        <Text color={t.dim}>Esc close</Text>
      </Box>
    );
  }

  // Flatten server/tool/resource structure into rows
  for (const view of projectApprovals) {
    flatRows.push({ type: 'approval', view });
    for (const message of view.diagnostics) {
      flatRows.push({ type: 'approval-detail', message, name: view.name });
    }
  }

  for (const [name, state] of states.entries()) {
    const callable =
      state.health === 'ready' || state.health === 'degraded' || state.health === 'half_open';
    const statusColor = state.health === 'ready' ? t.success : callable ? t.warning : t.error;
    const statusIcon = state.health === 'ready' ? '●' : callable ? '◐' : '○';
    const transportLabel = state.config.type === 'http' ? 'http' : 'stdio';
    const toolCount = state.tools.length;

    flatRows.push({ type: 'server', name, statusColor, statusIcon, transportLabel, toolCount });

    if (!callable && state.error) {
      flatRows.push({ type: 'error', message: state.error });
    }

    const remaining = MAX_TOOLS - totalToolsShown;
    const toolsToShow = state.tools.slice(0, Math.max(0, remaining));
    const hiddenCount = Math.max(0, state.tools.length - toolsToShow.length);
    totalToolsShown += toolsToShow.length;

    for (const tool of toolsToShow) {
      flatRows.push({ type: 'tool', serverName: name, toolName: tool.name });
    }
    if (hiddenCount > 0) {
      flatRows.push({ type: 'more-tools', count: hiddenCount });
    }

    if (callable && state.resources && state.resources.length > 0) {
      flatRows.push({ type: 'resources-header' });
      for (const r of state.resources.slice(0, 10)) {
        flatRows.push({ type: 'resource', name: r.name || r.uri, uri: r.uri });
      }
      if (state.resources.length > 10) {
        flatRows.push({ type: 'more-resources', count: state.resources.length - 10 });
      }
    }

    if (totalToolsShown >= MAX_TOOLS) {
      flatRows.push({ type: 'max-tools-notice', max: MAX_TOOLS });
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.primary}>
        MCP Servers
      </Text>

      <Box marginTop={1} flexGrow={1} maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={scrollOffset} scrollAlignment="auto">
          {flatRows.map((row, i) => {
            switch (row.type) {
              case 'approval': {
                const statusColor =
                  row.view.status === 'approved'
                    ? t.success
                    : row.view.status === 'pending_approval'
                      ? t.warning
                      : t.error;
                const statusLabel = row.view.status.replaceAll('_', ' ');
                return (
                  <Box
                    flexDirection="column"
                    key={`a-${row.view.sourceKind}-${row.view.name}`}
                    marginTop={i === 0 ? 0 : 1}
                  >
                    <Box>
                      <Text color={statusColor}>{scrollOffset === i ? '›' : ' '} </Text>
                      <Text bold>{row.view.name}</Text>
                      <Text color={t.dim}> ({row.view.transport}, project)</Text>
                      <Text color={statusColor}> — {statusLabel}</Text>
                      <Text color={t.dim}> [{row.view.configDigest.slice(0, 8)}]</Text>
                    </Box>
                    <Box paddingLeft={2}>
                      <Text color={t.dim}>来源：{row.view.sourcePath}</Text>
                    </Box>
                    <Box paddingLeft={2}>
                      <Text color={t.muted}>
                        {row.view.transport === 'stdio'
                          ? `命令：${row.view.review.command ?? '(invalid)'}（${row.view.review.argumentCount ?? 0} 个参数）`
                          : `端点：${row.view.review.endpoint ?? '(invalid or redacted)'}`}
                      </Text>
                    </Box>
                  </Box>
                );
              }
              case 'approval-detail':
                return (
                  <Box key={`ad-${row.name}-${row.message}`} paddingLeft={2}>
                    <Text color={t.error}>{row.message}</Text>
                  </Box>
                );
              case 'server':
                return (
                  <Box key={`s-${row.name}`} marginTop={i === 0 ? 0 : 1}>
                    <Text color={row.statusColor}>{row.statusIcon} </Text>
                    <Text bold>{row.name}</Text>
                    <Text color={t.dim}> ({row.transportLabel})</Text>
                    <Text color={t.muted}>
                      {' '}
                      — {row.toolCount} tool{row.toolCount !== 1 ? 's' : ''}
                    </Text>
                  </Box>
                );
              case 'error':
                return (
                  <Box key={`e-${row.message}`} paddingLeft={2}>
                    <Text color={t.error}>Error: {row.message}</Text>
                  </Box>
                );
              case 'tool':
                return (
                  <Text key={`t-${row.serverName}-${row.toolName}`} color={t.muted}>
                    mcp__{row.serverName}__{row.toolName}
                  </Text>
                );
              case 'more-tools':
                return (
                  <Text key={`mt-${row.count}`} color={t.dim}>
                    …and {row.count} more
                  </Text>
                );
              case 'resources-header':
                return (
                  <Text key="rh" color={t.dim} bold>
                    Resources:
                  </Text>
                );
              case 'resource':
                return (
                  <Text key={`r-${row.uri}`} color={t.muted}>
                    {'📄'} {row.name} ({row.uri})
                  </Text>
                );
              case 'more-resources':
                return (
                  <Text key={`mr-${row.count}`} color={t.dim}>
                    …and {row.count} more
                  </Text>
                );
              case 'max-tools-notice':
                return (
                  <Text key="mtn" color={t.dim}>
                    (showing first {row.max} tools total)
                  </Text>
                );
              default:
                return null;
            }
          })}
        </ScrollList>
      </Box>

      <Box marginTop={1}>
        <Text color={pendingDecision ? t.warning : t.dim}>
          {pendingDecision
            ? `再次按 ${pendingDecision.decision === 'approved' ? 'a' : 'r'} 确认${pendingDecision.decision === 'approved' ? '批准' : '拒绝'}；Esc 取消`
            : 'Esc 关闭 ↑↓ 选择 a 批准 r 拒绝'}
        </Text>
      </Box>
      {decisionMessage && <Text color={t.muted}>{decisionMessage}</Text>}
    </Box>
  );
}
