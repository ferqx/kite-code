import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { McpServerControlState } from '@/core/mcp';
import { useTheme } from '../theme';
import type { McpController, McpMutationAction } from './types';

export default function McpConfirmDialog({
  controller,
  server,
  action,
  onDone,
  onCancel,
}: {
  controller: McpController;
  server: Readonly<McpServerControlState>;
  action: McpMutationAction;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [running, setRunning] = useState(false);
  useInput((input, key) => {
    if (running) return;
    if (key.escape || input.toLowerCase() === 'n') onCancel();
    else if (key.return || input.toLowerCase() === 'y') void confirm();
  });

  async function confirm(): Promise<void> {
    setRunning(true);
    const ok =
      action === 'enable'
        ? await controller.setEnabled(server, true)
        : action === 'disable'
          ? await controller.setEnabled(server, false)
          : action === 'remove'
            ? await controller.remove(server)
            : await controller.migrate(server);
    if (ok) onDone();
    else setRunning(false);
  }

  return (
    <Box flexDirection="column">
      <Text bold color={action === 'remove' ? t.error : t.warning}>
        Confirm {action}: {server.key.name}
      </Text>
      <Text>Source: {server.source}</Text>
      <Text>Path: {server.sourcePath}</Text>
      {action === 'remove' && server.fallbackSource && (
        <Text>After removal, the {server.fallbackSource} declaration becomes effective.</Text>
      )}
      {action === 'migrate' && (
        <Box flexDirection="column">
          <Text color={t.error}>
            - {server.sourcePath}#mcpServers.{server.key.name}
          </Text>
          <Text color={t.success}>+ .mcp.json#mcpServers.{server.key.name}</Text>
          <Text>The migrated declaration requires a new project approval.</Text>
        </Box>
      )}
      <Text color={t.dim}>{running ? 'Updating…' : 'Enter/y confirm  Esc/n cancel'}</Text>
    </Box>
  );
}
