import { Box, Text } from 'ink';
import type { McpServerControlState } from '@/core/mcp';
import { useTheme } from '../theme';

export default function McpServerList({
  servers,
}: {
  servers: readonly Readonly<McpServerControlState>[];
}) {
  const t = useTheme();
  if (servers.length === 0) return <Text color={t.muted}>No MCP servers configured.</Text>;

  return (
    <Box flexDirection="column">
      {servers.map((server) => {
        const status = statusLabel(server);
        const color =
          status === 'ready'
            ? t.success
            : status === 'connecting' || status === 'discovering'
              ? t.warning
              : status === 'disabled'
                ? t.muted
                : t.error;
        return (
          <Box key={`${server.source}:${server.key.name}`}>
            <Text color={color}>[{status}] </Text>
            <Text>{server.key.name}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function statusLabel(server: Readonly<McpServerControlState>): string {
  if (server.health !== 'disconnected') return server.health.replaceAll('_', '-');
  if (server.configStatus === 'configured' || server.configStatus === 'approved') {
    return 'disconnected';
  }
  return server.configStatus.replaceAll('_', '-');
}
