import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useTheme } from '@/app/tui/theme';

interface OverlaySearchInputProps {
  value: string;
  onChange: (value: string) => void;
  active: boolean;
  label?: string;
  emptyValue?: string;
  onSubmit?: (value: string) => void;
}

/**
 * Shared search row for selectable TUI overlays.
 *
 * The inactive state behaves like a list row. Activating it mounts the real
 * text input so keyboard input and cursor rendering stay consistent wherever
 * overlay search is offered.
 */
export default function OverlaySearchInput({
  value,
  onChange,
  active,
  label = '搜索',
  emptyValue = '—',
  onSubmit,
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
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            focus
            highlightPastedText
          />
        </Box>
      ) : (
        <Text color={t.dim}> {value || emptyValue}</Text>
      )}
    </Box>
  );
}
