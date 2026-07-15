import { Box, Text } from 'ink';
import type { McpPrompt } from '@/core/mcp';
import { useTheme } from '../theme';

export default function McpPromptList({ prompts }: { prompts: readonly Readonly<McpPrompt>[] }) {
  const t = useTheme();
  if (prompts.length === 0) return <Text color={t.muted}>No prompts discovered.</Text>;
  return (
    <Box flexDirection="column">
      {prompts.map((prompt) => (
        <Box key={prompt.name} flexDirection="column">
          <Text>/{prompt.name}</Text>
          {prompt.description && <Text color={t.dim}> {prompt.description}</Text>}
        </Box>
      ))}
    </Box>
  );
}
