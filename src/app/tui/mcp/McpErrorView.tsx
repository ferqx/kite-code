import { Box, Text } from 'ink';
import type { McpDiagnostic } from '@/core/mcp';
import { useTheme } from '../theme';

export default function McpErrorView({ diagnostic }: { diagnostic?: McpDiagnostic }) {
  const t = useTheme();
  if (!diagnostic) return <Text color={t.muted}>No diagnostic is available.</Text>;
  return (
    <Box flexDirection="column">
      <Text bold color={t.error}>
        {diagnosticTitle(diagnostic.code)}
      </Text>
      <Text>{diagnostic.message}</Text>
      <Text color={t.dim}>
        {diagnostic.retryable ? 'Retry is available with r.' : diagnosticAction(diagnostic.code)}
      </Text>
      {diagnostic.technical?.status !== undefined && (
        <Text color={t.dim}>HTTP status: {diagnostic.technical.status}</Text>
      )}
    </Box>
  );
}

function diagnosticTitle(code: McpDiagnostic['code']): string {
  return code.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}

function diagnosticAction(code: McpDiagnostic['code']): string {
  if (code === 'approval_required') return 'Open approval with a.';
  if (code === 'command_not_found') return 'Check the configured executable.';
  if (code === 'url_invalid') return 'Check the configured endpoint.';
  return 'Review the server configuration and diagnostic details.';
}
