import { Box, Text, useInput } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import { useState } from 'react';
import type { SandboxBackend } from '#app/sandbox/types';
import { useTheme } from '#app/tui/theme';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { SLASH_COMMAND_DEFS } from '../hooks/useSlashSuggestions';
import { useI18n } from '../i18n';
import { sandboxSupportsFullMode } from '../interaction-mode';
import OverlayFrame, { OverlayShortcutBar } from './OverlayFrame';
import { OverlaySection } from './OverlayPrimitives';

interface HelpPanelProps {
  onClose: () => void;
  sandboxBackend?: SandboxBackend;
}

interface ShortcutGroup {
  title: string;
  shortcuts: [string, string][];
}

export default function HelpPanel({ onClose, sandboxBackend = 'none' }: HelpPanelProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxContentHeight = useOverlayHeight(8);
  const modeHelp = !sandboxSupportsFullMode(sandboxBackend)
    ? translate('help.permissionsUnsandboxed')
    : translate('help.permissionsSandboxed');
  const commandShortcuts: [string, string][] = SLASH_COMMAND_DEFS.map((command) => [
    `/${command.name}`,
    command.name === 'permissions'
      ? modeHelp
      : (command.description ?? (command.descriptionKey ? translate(command.descriptionKey) : '')),
  ]);

  const groups: ShortcutGroup[] = [
    {
      title: translate('help.shortcuts'),
      shortcuts: [
        ['Shift+Tab', translate('help.planMode')],
        ['Ctrl+C', translate('help.interruptOrExit')],
        ['Ctrl+T', translate('help.toggleReasoning')],
        ['Ctrl+E', translate('help.expandInput')],
        ['Ctrl+L', translate('help.clearScreen')],
        ['Shift+Enter', translate('help.newline')],
        ['?', translate('help.open')],
        ['Esc', translate('help.cancelInteraction')],
      ],
    },
    {
      title: translate('help.input'),
      shortcuts: [
        ['Enter', translate('help.submit')],
        ['Shift+Enter', translate('help.newline')],
        ['Up/Down', translate('help.history')],
        ['Tab', translate('help.complete')],
      ],
    },
    {
      title: translate('help.commands'),
      shortcuts: commandShortcuts,
    },
  ];

  type FlatRow =
    | { type: 'header'; id: string; title: string }
    | { type: 'shortcut'; id: string; key: string; desc: string };

  const flatRows: FlatRow[] = groups.flatMap((group, gi) => [
    { type: 'header' as const, id: `h-${gi}`, title: group.title },
    ...group.shortcuts.map(([key, desc], si) => ({
      type: 'shortcut' as const,
      id: `s-${gi}-${si}`,
      key,
      desc,
    })),
  ]);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setScrollOffset((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((s) => Math.min(flatRows.length - 1, s + 1));
      return;
    }
    // Only close on Escape — other keys are ignored
  });

  return (
    <OverlayFrame
      title={translate('help.title')}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: translate('help.scroll') },
            { keys: 'Esc', label: translate('common.close') },
          ]}
        />
      }
    >
      <Box flexGrow={1} maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={scrollOffset} scrollAlignment="auto">
          {flatRows.map((row, i) => {
            if (row.type === 'header') {
              return (
                <OverlaySection key={row.id} first={i === 0}>
                  {row.title}
                </OverlaySection>
              );
            }
            return (
              <Box key={row.id} paddingLeft={2}>
                <Text color={t.primary}>{row.key.padEnd(18)}</Text>
                <Text color={t.muted}>{row.desc}</Text>
              </Box>
            );
          })}
        </ScrollList>
      </Box>
    </OverlayFrame>
  );
}
