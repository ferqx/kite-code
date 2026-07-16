import { Box, Text, useInput } from 'ink';
import { type MutableRefObject, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useTheme } from '../theme';
import McpServerList from './McpServerList';
import type { McpController } from './types';

export interface McpOverlayProps {
  controller: McpController;
  layeredEscRef?: MutableRefObject<boolean>;
  onClose: () => void;
}

export default function McpOverlay({ controller, layeredEscRef, onClose }: McpOverlayProps) {
  const t = useTheme();
  const maxContentHeight = useOverlayHeight(8);
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const servers = useMemo(
    () => view.control.servers.filter((server) => server.effective),
    [view.control.servers],
  );
  const visibleCount = Number.isFinite(maxContentHeight)
    ? Math.max(1, maxContentHeight - 1)
    : Math.max(1, servers.length);
  const maxOffset = Math.max(0, servers.length - visibleCount);
  const [scrollOffset, setScrollOffset] = useState(0);

  if (layeredEscRef) layeredEscRef.current = true;

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, maxOffset));
  }, [maxOffset]);

  useEffect(
    () => () => {
      if (layeredEscRef) layeredEscRef.current = false;
    },
    [layeredEscRef],
  );

  useInput((_input, key) => {
    if (key.escape) onClose();
    else if (key.upArrow) setScrollOffset((current) => Math.max(0, current - 1));
    else if (key.downArrow) setScrollOffset((current) => Math.min(maxOffset, current + 1));
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.primary}>
        MCP Servers
      </Text>
      <Box marginTop={1} flexDirection="column" maxHeight={maxContentHeight}>
        <McpServerList servers={servers.slice(scrollOffset, scrollOffset + visibleCount)} />
      </Box>
      <Text color={t.dim}>{maxOffset > 0 ? 'Up/Down scroll  Esc close' : 'Esc close'}</Text>
    </Box>
  );
}
