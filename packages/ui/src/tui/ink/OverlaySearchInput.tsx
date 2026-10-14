import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useInkTheme as useTheme } from '../presentation';

interface OverlaySearchInputProps {
  value: string;
  onChange: (value: string) => void;
  active: boolean;
  label?: string;
  emptyValue?: string;
  editor?: ReactNode;
}

/**
 * Shared search row for selectable TUI overlays.
 *
 * The inactive state behaves like a list row. Activating it mounts the real
 * host-owned input editor so keyboard input and cursor rendering stay consistent
 * without introducing a second input listener.
 */
export default function OverlaySearchInput({
  value,
  active,
  label = '搜索',
  emptyValue = '—',
  editor,
}: OverlaySearchInputProps) {
  const t = useTheme();

  return (
    <Box width="100%" paddingX={1} backgroundColor={active ? t.userMsgBg : undefined}>
      <Box width={2} flexShrink={0}>
        <Text bold color={active ? t.primary : t.dim}>
          {active ? '❯ ' : '  '}
        </Text>
      </Box>
      <Text bold={active} color={active ? t.primary : t.muted}>
        {label}:
      </Text>
      {active ? (
        <Box marginLeft={1} flexGrow={1}>
          {editor ?? <Text color={t.primary}>{value || emptyValue}</Text>}
        </Box>
      ) : (
        <Text color={t.dim}> {value || emptyValue}</Text>
      )}
    </Box>
  );
}
