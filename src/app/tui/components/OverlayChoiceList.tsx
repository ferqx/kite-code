import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '@/app/tui/theme';
import { OverlayList, OverlayListRow, OverlaySection } from './OverlayPrimitives';

export interface OverlayChoiceOption<T extends string = string> {
  id: T;
  label: string;
  description?: string;
  disabled?: boolean;
  destructive?: boolean;
  heading?: boolean;
  separatorBefore?: boolean;
  trailing?: string;
  trailingTone?: 'success' | 'warning' | 'error' | 'muted';
  action?: boolean;
  /** Render custom content in place of the selected option label. */
  selectedContent?: ReactNode;
}

export default function OverlayChoiceList<T extends string>({
  options,
  selectedId,
  numbered = false,
  selectionBackground = true,
  compact = false,
}: {
  options: readonly OverlayChoiceOption<T>[];
  selectedId?: T;
  numbered?: boolean;
  selectionBackground?: boolean;
  compact?: boolean;
}) {
  const t = useTheme();
  return (
    <OverlayList>
      {options.map((option, index) => {
        if (option.heading) {
          return (
            <OverlaySection key={option.id} first={index === 0}>
              {option.label}
            </OverlaySection>
          );
        }

        const selected = option.id === selectedId;
        return (
          <Box
            key={option.id}
            marginTop={
              option.separatorBefore || (!compact && index > 0 && options[index - 1]?.description)
                ? 1
                : 0
            }
          >
            <OverlayListRow
              selected={selected}
              disabled={option.disabled}
              destructive={option.destructive}
              selectionBackground={selectionBackground}
              primary={`${numbered ? `${index + 1}. ` : ''}${option.label}${option.disabled ? ' (unavailable)' : ''}`}
              content={selected ? option.selectedContent : undefined}
              secondary={option.selectedContent ? undefined : option.description}
              primaryColor={option.action ? t.primary : undefined}
              trailing={
                option.trailing ? (
                  <Text
                    color={
                      option.trailingTone === 'success'
                        ? t.success
                        : option.trailingTone === 'warning'
                          ? t.warning
                          : option.trailingTone === 'error'
                            ? t.error
                            : t.dim
                    }
                  >
                    {option.trailing}
                  </Text>
                ) : undefined
              }
            />
          </Box>
        );
      })}
    </OverlayList>
  );
}
