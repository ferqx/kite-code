import { Box, Text, useInput } from 'ink';
import { type MutableRefObject, useEffect, useState, useSyncExternalStore } from 'react';
import type { McpServerControlState } from '@/core/mcp';
import { useTheme } from '../theme';
import type { McpController } from './types';

export default function McpProjectTrustPrompt({
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
  const [pendingDecision, setPendingDecision] = useState<'approved' | 'rejected'>();
  const [saving, setSaving] = useState(false);

  if (layeredEscRef) layeredEscRef.current = true;

  useEffect(
    () => () => {
      if (layeredEscRef) layeredEscRef.current = false;
    },
    [layeredEscRef],
  );

  useInput((input, key) => {
    if (saving) return;
    if (key.escape) {
      onDefer();
      return;
    }
    const decision = input === 'a' ? 'approved' : input === 'r' ? 'rejected' : undefined;
    if (!decision) return;
    if (pendingDecision !== decision) {
      setPendingDecision(decision);
      return;
    }
    setPendingDecision(undefined);
    setSaving(true);
    void controller.decide(server.key, decision).then((recorded) => {
      if (!recorded) setSaving(false);
    });
  });

  if (!server.approval) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.warning}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.warning}>
        Project MCP configuration
      </Text>
      <Text bold>{server.key.name}</Text>
      <Text color={t.dim}>Source: {server.sourcePath}</Text>
      <Text color={t.dim}>Digest: {server.approval.configDigest.slice(0, 12)}</Text>
      {server.transport === 'stdio' ? (
        <Text>
          Command: {server.approval.review.command ?? '(invalid)'} (
          {server.approval.review.argumentCount ?? 0} arguments)
        </Text>
      ) : (
        <Text>Endpoint: {server.approval.review.endpoint ?? '(invalid or redacted)'}</Text>
      )}
      <Text color={t.muted}>Approval allows the connection, not individual MCP tool calls.</Text>
      {pendingDecision && (
        <Text color={t.warning}>
          Press {pendingDecision === 'approved' ? 'a' : 'r'} again to confirm.
        </Text>
      )}
      {saving && <Text color={t.dim}>Saving decision…</Text>}
      {view.message && <Text color={t.muted}>{view.message}</Text>}
      <Text color={t.dim}>a approve r reject Esc defer</Text>
    </Box>
  );
}
