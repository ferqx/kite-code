import { Box, Text } from 'ink';
import { useTheme } from '../theme';
import type { McpSelectOption } from './model';

export default function McpSelect<T extends string>({
  options,
  selectedId,
  numbered = false,
}: {
  options: readonly McpSelectOption<T>[];
  selectedId?: T;
  numbered?: boolean;
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
          <Box key={option.id} flexDirection="column" marginTop={option.separatorBefore ? 1 : 0}>
            <Text color={color}>
              {selected ? (numbered ? '❯' : '>') : ' '} {numbered ? `${index + 1}. ` : ''}
              {option.label}
              {option.disabled ? ' (unavailable)' : ''}
            </Text>
            {option.description && <Text color={t.dim}> {option.description}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
