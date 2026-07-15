import { Box, Text } from 'ink';
import type { McpToolControlState } from '@/core/mcp';
import { useTheme } from '../theme';

export default function McpToolList({
  tools,
}: {
  tools: readonly Readonly<McpToolControlState>[];
}) {
  const t = useTheme();
  if (tools.length === 0) return <Text color={t.muted}>No tools discovered.</Text>;
  return (
    <Box flexDirection="column">
      {tools.map((tool) => (
        <Box key={tool.name} flexDirection="column">
          <Text color={tool.available ? t.success : t.error}>
            [{tool.available ? 'available' : 'quarantined'}] {tool.name}
          </Text>
          {tool.description && <Text color={t.dim}> {tool.description}</Text>}
        </Box>
      ))}
    </Box>
  );
}
