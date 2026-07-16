import { Box, Text, useInput } from 'ink';
import { type MutableRefObject, useEffect, useState, useSyncExternalStore } from 'react';
import type { McpServerControlState } from '@/core/mcp';
import { useTheme } from '../theme';
import type { McpController } from './types';

export default function McpAuthPrompt({
  controller,
  server,
  layeredEscRef,
  onDefer,
}: {
  controller: McpController;
  server: Readonly<McpServerControlState>;
  layeredEscRef?: MutableRefObject<boolean>;
  onDefer: () => void;
}) {
  const t = useTheme();
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [starting, setStarting] = useState(false);

  if (layeredEscRef) layeredEscRef.current = true;
  useEffect(
    () => () => {
      if (layeredEscRef) layeredEscRef.current = false;
    },
    [layeredEscRef],
  );

  useInput((input, key) => {
    if (key.escape) {
      if (server.authStatus === 'authorizing' && server.authFlowId) {
        void controller.cancelAuth(server.authFlowId);
      } else {
        onDefer();
      }
      return;
    }
    if (starting || server.authStatus === 'authorizing') return;
    if (key.return || input === 'l') {
      setStarting(true);
      void controller.login(server.key).then((started) => {
        if (!started) setStarting(false);
      });
    }
  });

  const waiting = starting || server.authStatus === 'authorizing';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.warning}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.warning}>
        MCP authentication required
      </Text>
      <Text bold>{server.key.name}</Text>
      <Text color={t.muted}>
        {waiting
          ? 'Complete authorization in your browser. No tool call will be replayed automatically.'
          : 'This HTTP MCP server requires an interactive login.'}
      </Text>
      {server.authErrorCode && (
        <Text color={t.error}>Authentication error: {server.authErrorCode}</Text>
      )}
      {view.message && <Text color={t.muted}>{view.message}</Text>}
      <Text color={t.dim}>{waiting ? 'Esc cancel' : 'Enter/l login  Esc defer'}</Text>
    </Box>
  );
}
