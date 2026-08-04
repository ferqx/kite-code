import { Box, Text } from 'ink';
import { useTheme } from '@/app/tui/theme';

export interface OverlayChoiceOption<T extends string = string> {
  id: T;
  label: string;
  description?: string;
  disabled?: boolean;
  destructive?: boolean;
  heading?: boolean;
  separatorBefore?: boolean;
}

export default function OverlayChoiceList<T extends string>({
  options,
  selectedId,
  numbered = false,
  selectionBackground = true,
}: {
  options: readonly OverlayChoiceOption<T>[];
  selectedId?: T;
  numbered?: boolean;
  selectionBackground?: boolean;
}) {
  const t = useTheme();

  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        if (option.heading) {
          return (
            <Box key={option.id} marginTop={index === 0 ? 0 : 1} paddingLeft={2}>
              <Text bold color={t.muted}>
                {option.label}
              </Text>
            </Box>
          );
        }

        const selected = option.id === selectedId;
        const color = option.disabled
          ? t.dim
          : option.destructive
            ? t.error
            : selected
              ? t.primary
              : t.muted;

        return (
          <Box
            key={option.id}
            flexDirection="column"
            marginTop={
              option.separatorBefore || (index > 0 && options[index - 1]?.description) ? 1 : 0
            }
            paddingX={1}
            width="100%"
            backgroundColor={selected && selectionBackground ? t.userMsgBg : undefined}
          >
            <Box>
              <Box width={2} flexShrink={0}>
                <Text bold color={selected ? t.primary : t.dim}>
                  {selected ? '❯ ' : '  '}
                </Text>
              </Box>
              <Text bold={selected} color={color}>
                {numbered ? `${index + 1}. ` : ''}
                {option.label}
                {option.disabled ? ' (unavailable)' : ''}
              </Text>
            </Box>
            {option.description && (
              <Box paddingLeft={2}>
                <Text color={t.dim}>{option.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
