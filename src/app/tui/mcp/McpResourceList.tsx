import { Box, Text } from 'ink';
import type { McpResource } from '@/core/mcp';
import { useTheme } from '../theme';

export default function McpResourceList({
  resources,
}: {
  resources: readonly Readonly<McpResource>[];
}) {
  const t = useTheme();
  if (resources.length === 0) return <Text color={t.muted}>No resources discovered.</Text>;
  return (
    <Box flexDirection="column">
      {resources.map((resource) => (
        <Box key={resource.uri} flexDirection="column">
          <Text>{resource.name || resource.uri}</Text>
          <Text color={t.dim}>{resource.uri}</Text>
        </Box>
      ))}
    </Box>
  );
}
