import { Box, Text } from 'ink';
import type { McpServerControlState } from '@/core/mcp';
import { useTheme } from '../theme';

export default function McpServerDetail({ server }: { server: Readonly<McpServerControlState> }) {
  const t = useTheme();
  return (
    <Box flexDirection="column">
      <Text bold>{server.key.name}</Text>
      <Text>Health: {server.health.replaceAll('_', ' ')}</Text>
      <Text>Config: {server.configStatus.replaceAll('_', ' ')}</Text>
      <Text>Transport: {server.transport}</Text>
      <Text>Source: {server.source}</Text>
      <Text color={t.dim}>Path: {server.sourcePath}</Text>
      <Text>
        Capabilities: {server.availableToolCount}/{server.toolCount} tools, {server.resourceCount}{' '}
        resources, {server.promptCount} prompts
      </Text>
      {server.lastAttemptAt && <Text color={t.dim}>Last attempt: {server.lastAttemptAt}</Text>}
      {server.capabilityRevision && (
        <Text color={t.dim}>Capability revision: {server.capabilityRevision.slice(0, 12)}</Text>
      )}
      {server.diagnostic && <Text color={t.error}>Diagnostic: {server.diagnostic.code}</Text>}
    </Box>
  );
}
