import { Box } from 'ink';
import { OverlayList, OverlayListRow, OverlaySection } from './OverlayPrimitives';

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
              option.separatorBefore || (index > 0 && options[index - 1]?.description) ? 1 : 0
            }
          >
            <OverlayListRow
              selected={selected}
              disabled={option.disabled}
              destructive={option.destructive}
              selectionBackground={selectionBackground}
              primary={`${numbered ? `${index + 1}. ` : ''}${option.label}${option.disabled ? ' (unavailable)' : ''}`}
              secondary={option.description}
            />
          </Box>
        );
      })}
    </OverlayList>
  );
}
