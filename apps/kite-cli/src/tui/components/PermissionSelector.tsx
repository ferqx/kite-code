import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import type { SandboxBackend } from '#kite-cli/sandbox/types';
import { useI18n } from '#kite-cli/tui/i18n';
import { useTheme } from '#kite-cli/tui/theme';
import OverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './OverlayFrame';
import { OverlayListRow } from './OverlayPrimitives';

type InteractionMode = 'accept_edits' | 'auto' | 'full';

interface PermissionSelectorProps {
  currentMode: InteractionMode;
  sandboxBackend: SandboxBackend;
  onSelect: (mode: InteractionMode) => void;
  onClose: () => void;
  sessionGrantCount?: number;
  onClearSessionGrants?: () => void;
}

export default function PermissionSelector({
  currentMode,
  sandboxBackend,
  onSelect,
  onClose,
  sessionGrantCount = 0,
  onClearSessionGrants,
}: PermissionSelectorProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const options: ReadonlyArray<{ mode: InteractionMode; label: string; description: string }> = [
    {
      mode: 'accept_edits',
      label: translate('permission.acceptEdits'),
      description: translate('permission.acceptEditsDescription'),
    },
    {
      mode: 'auto',
      label: translate('permission.auto'),
      description: translate('permission.autoDescription'),
    },
    {
      mode: 'full',
      label: translate('permission.full'),
      description: translate('permission.fullDescription'),
    },
  ];
  // Full is an interaction mode, not an approval grant. Its availability must
  // not be inferred from the backend sandbox probe; execution still fails
  // closed at the Runtime boundary when a backend cannot honor the mode.
  void sandboxBackend;
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.mode === currentMode),
    ),
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const move = (direction: 1 | -1) => {
    setSelected((current) => {
      return (current + direction + options.length) % options.length;
    });
  };

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if ((input === 'c' || input === 'C') && sessionGrantCount > 0) {
      onClearSessionGrants?.();
      return;
    }
    if (key.upArrow) move(-1);
    if (key.downArrow) move(1);
    if (key.return) {
      const option = options[selectedRef.current]!;
      onSelect(option.mode);
      onClose();
    }
  });

  return (
    <OverlayFrame
      title={translate('permission.title')}
      meta={
        <Text color={t.dim}>
          {selected + 1} / {options.length}
        </Text>
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: translate('common.navigate') },
            { keys: 'Enter', label: translate('common.select') },
            ...(sessionGrantCount > 0
              ? [{ keys: 'C', label: translate('approval.clearSessionGrants') }]
              : []),
            { keys: 'Esc', label: translate('common.close') },
          ]}
        />
      }
    >
      <Box flexDirection="column">
        {options.map((option, index) => {
          return (
            <Box key={option.mode} flexDirection="column">
              <OverlayListRow
                selected={selected === index}
                primary={option.label}
                secondary={option.description}
                trailing={<OverlayStatusColumn active={option.mode === currentMode} />}
              />
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} paddingLeft={1}>
        <Text color={t.dim}>
          {translate('approval.sessionGrants', { count: sessionGrantCount })}
        </Text>
      </Box>
    </OverlayFrame>
  );
}
