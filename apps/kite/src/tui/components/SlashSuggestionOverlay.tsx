import { Box, Text } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import stringWidth from 'string-width';
import type { SlashSuggestionData, SuggestionItem } from '#app/tui/hooks/useSlashSuggestions';
import { useI18n } from '#app/tui/i18n';
import { useTheme } from '#app/tui/theme';
import OverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './OverlayFrame';
import { OverlayListRow } from './OverlayPrimitives';

interface SlashSuggestionOverlayProps {
  suggestion: SlashSuggestionData;
  maxVisibleItems: number;
  width: number;
}

function displayCommand(item: SuggestionItem): string {
  return `/${item.command}`;
}

function displayAliases(item: SuggestionItem): string {
  if (item.aliases.length === 0) return '';
  return `· ${item.aliases.map((alias) => `/${alias}`).join(' ')}`;
}

function displayDetails(item: SuggestionItem): string {
  return [item.args, displayAliases(item)].filter(Boolean).join('  ');
}

export default function SlashSuggestionOverlay({
  suggestion,
  maxVisibleItems,
  width,
}: SlashSuggestionOverlayProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const visibleHeight = Math.min(suggestion.items.length, maxVisibleItems);
  const rowWidth = Math.max(12, width - 6);
  const showActiveMarkers = suggestion.items.some((item) => item.isActive);
  const indicatorWidth = 2;
  const statusColumnWidth = showActiveMarkers ? 6 : 0;
  const longestCommand = Math.max(
    ...suggestion.items.map((item) => stringWidth(displayCommand(item))),
  );
  const longestDetails = Math.max(
    ...suggestion.items.map((item) => stringWidth(displayDetails(item))),
  );
  const commandColumnWidth = Math.min(longestCommand + 2, Math.max(10, Math.floor(rowWidth * 0.3)));
  const showDescriptions = rowWidth - indicatorWidth - commandColumnWidth - statusColumnWidth >= 28;
  const descriptionReserve = showDescriptions ? 18 : 0;
  const detailsColumnWidth = Math.min(
    longestDetails + 2,
    Math.max(
      2,
      rowWidth - indicatorWidth - commandColumnWidth - statusColumnWidth - descriptionReserve,
    ),
  );
  const selectedPosition = Math.min(suggestion.selectedIndex + 1, suggestion.items.length);

  return (
    <OverlayFrame
      title={translate('slash.matches')}
      meta={
        <Text color={t.dim}>
          {selectedPosition} / {suggestion.items.length}
        </Text>
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: translate('common.navigate') },
            { keys: 'Tab / →', label: translate('slash.complete') },
            { keys: 'Enter', label: translate('common.confirm') },
            { keys: 'Esc', label: translate('common.close') },
          ]}
        />
      }
    >
      <Box height={visibleHeight}>
        <ScrollList selectedIndex={suggestion.selectedIndex} scrollAlignment="auto">
          {suggestion.items.map((item, index) => {
            const isSelected = index === suggestion.selectedIndex;
            const command = displayCommand(item);
            const details = displayDetails(item);
            const commandColor = item.disabled ? t.dim : isSelected ? t.primary : t.muted;

            return (
              <OverlayListRow
                key={item.id ?? item.command}
                selected={isSelected}
                disabled={item.disabled}
                content={
                  <>
                    <Box width={commandColumnWidth} flexShrink={0}>
                      <Text wrap="truncate-end" bold={isSelected} color={commandColor}>
                        {command}
                      </Text>
                    </Box>
                    <Box width={detailsColumnWidth} flexShrink={0}>
                      <Text wrap="truncate-end" color={t.dim}>
                        {details}
                      </Text>
                    </Box>
                    {showDescriptions && (
                      <Box flexGrow={1}>
                        <Text wrap="truncate-end" color={t.dim}>
                          {item.disabled ? translate('slash.unavailable') : ''}
                          {item.description}
                        </Text>
                        {isSelected && item.warning && (
                          <Text wrap="truncate-end" color={t.error}>
                            {'  '}
                            {item.warning}
                          </Text>
                        )}
                      </Box>
                    )}
                  </>
                }
                trailing={
                  showActiveMarkers ? <OverlayStatusColumn active={!!item.isActive} /> : undefined
                }
              />
            );
          })}
        </ScrollList>
      </Box>
    </OverlayFrame>
  );
}
