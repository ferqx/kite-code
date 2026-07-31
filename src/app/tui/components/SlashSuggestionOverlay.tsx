import { Box, Text } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import stringWidth from 'string-width';
import type { SlashSuggestionData, SuggestionItem } from '@/app/tui/hooks/useSlashSuggestions';
import { useTheme } from '@/app/tui/theme';
import OverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './OverlayFrame';

interface SlashSuggestionOverlayProps {
  suggestion: SlashSuggestionData;
  maxVisibleItems: number;
  width: number;
}

function suggestionTitle(suggestion: SlashSuggestionData): string {
  switch (suggestion.kind) {
    case 'model':
      return suggestion.partial ? `模型匹配 "${suggestion.partial}"` : '模型选项';
    case 'effort':
      return suggestion.partial ? `推理深度匹配 "${suggestion.partial}"` : '推理深度';
    case 'theme':
      return suggestion.partial ? `主题匹配 "${suggestion.partial}"` : '主题选项';
    case 'permissions':
      return suggestion.partial ? `权限模式匹配 "${suggestion.partial}"` : '权限模式';
    default:
      return `命令匹配 /${suggestion.partial}`;
  }
}

function displayCommand(item: SuggestionItem, kind: SlashSuggestionData['kind']): string {
  return kind === 'command' ? `/${item.command}` : item.command;
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
  const visibleHeight = Math.min(suggestion.items.length, maxVisibleItems);
  const rowWidth = Math.max(12, width - 6);
  const showActiveMarkers = suggestion.items.some((item) => item.isActive);
  const indicatorWidth = 2;
  const statusColumnWidth = showActiveMarkers ? 6 : 0;
  const longestCommand = Math.max(
    ...suggestion.items.map((item) => stringWidth(displayCommand(item, suggestion.kind))),
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
      title={suggestionTitle(suggestion)}
      meta={
        <Text color={t.dim}>
          {selectedPosition} / {suggestion.items.length}
        </Text>
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: '导航' },
            { keys: 'Tab / →', label: '补全' },
            { keys: 'Enter', label: '确认' },
            { keys: 'Esc', label: '关闭' },
          ]}
        />
      }
    >
      <Box height={visibleHeight} marginTop={1}>
        <ScrollList selectedIndex={suggestion.selectedIndex} scrollAlignment="auto">
          {suggestion.items.map((item, index) => {
            const isSelected = index === suggestion.selectedIndex;
            const command = displayCommand(item, suggestion.kind);
            const details = displayDetails(item);
            const commandColor = item.disabled ? t.dim : isSelected ? t.primary : t.muted;

            return (
              <Box
                key={item.command}
                width="100%"
                paddingX={1}
                backgroundColor={isSelected ? t.userMsgBg : undefined}
              >
                <Box width={indicatorWidth} flexShrink={0}>
                  <Text bold color={isSelected ? t.primary : t.dim}>
                    {isSelected ? '❯ ' : '  '}
                  </Text>
                </Box>
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
                      {item.disabled ? '不可用 · ' : ''}
                      {item.description}
                    </Text>
                  </Box>
                )}
                {showActiveMarkers && <OverlayStatusColumn active={!!item.isActive} />}
              </Box>
            );
          })}
        </ScrollList>
      </Box>
    </OverlayFrame>
  );
}
