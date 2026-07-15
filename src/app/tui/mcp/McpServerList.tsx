import { Box, Text } from 'ink';
import type { McpServerControlState } from '@/core/mcp';
import { useTheme } from '../theme';

export interface McpServerListProps {
  servers: readonly Readonly<McpServerControlState>[];
  selectedIndex: number;
  search: string;
  searchActive: boolean;
}

export function filterMcpServers(
  servers: readonly Readonly<McpServerControlState>[],
  search: string,
): readonly Readonly<McpServerControlState>[] {
  const query = search.trim().toLowerCase();
  if (!query) return servers;
  return servers.filter(
    (server) =>
      server.key.name.toLowerCase().includes(query) ||
      server.source.toLowerCase().includes(query) ||
      server.health.toLowerCase().includes(query) ||
      server.configStatus.toLowerCase().includes(query),
  );
}

export default function McpServerList({
  servers,
  selectedIndex,
  search,
  searchActive,
}: McpServerListProps) {
  const t = useTheme();
  if (servers.length === 0) {
    return (
      <Text color={t.muted}>
        {search ? 'No matching MCP servers.' : 'No MCP servers configured.'}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      {servers.map((server, index) => {
        const selected = index === selectedIndex;
        const color =
          server.health === 'ready'
            ? t.success
            : server.health === 'connecting' || server.health === 'discovering'
              ? t.warning
              : server.diagnostic
                ? t.error
                : t.muted;
        return (
          <Box key={`${server.source}:${server.key.name}`}>
            <Text color={selected ? t.primary : t.dim}>{selected ? '>' : ' '} </Text>
            <Text color={color}>[{statusLabel(server)}] </Text>
            <Text bold={selected}>{server.key.name}</Text>
            <Text color={t.dim}>
              {' '}
              {server.transport} / {server.source}
              {!server.effective ? ' / shadowed' : ''}
            </Text>
            <Text color={t.muted}>
              {' '}
              ({server.availableToolCount}/{server.toolCount} tools)
            </Text>
          </Box>
        );
      })}
      <Text color={searchActive ? t.warning : t.dim}>
        {searchActive ? `Search: ${search}_` : search ? `Filter: ${search}` : '/ search'}
      </Text>
    </Box>
  );
}

function statusLabel(server: Readonly<McpServerControlState>): string {
  if (server.health !== 'disconnected') return server.health.replaceAll('_', '-');
  return server.configStatus.replaceAll('_', '-');
}
