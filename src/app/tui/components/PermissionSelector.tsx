import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { useI18n } from '@/app/tui/i18n';
import { useTheme } from '@/app/tui/theme';
import { type SandboxBackend, sandboxSupportsFullModeV1 } from '@/core/sandbox';
import OverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './OverlayFrame';
import { OverlayListRow } from './OverlayPrimitives';

type InteractionMode = 'accept_edits' | 'auto' | 'full';

interface PermissionSelectorProps {
  currentMode: InteractionMode;
  sandboxBackend: SandboxBackend;
  onSelect: (mode: InteractionMode) => void;
  onClose: () => void;
}

export default function PermissionSelector({
  currentMode,
  sandboxBackend,
  onSelect,
  onClose,
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
  const fullAvailable = sandboxSupportsFullModeV1(sandboxBackend);
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
      let next = current;
      do {
        next = (next + direction + options.length) % options.length;
      } while (options[next]!.mode === 'full' && !fullAvailable);
      return next;
    });
  };

  useInput((_, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) move(-1);
    if (key.downArrow) move(1);
    if (key.return) {
      const option = options[selectedRef.current]!;
      if (option.mode === 'full' && !fullAvailable) return;
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
            { keys: 'Esc', label: translate('common.close') },
          ]}
        />
      }
    >
      <Box flexDirection="column">
        {options.map((option, index) => {
          const disabled = option.mode === 'full' && !fullAvailable;
          return (
            <Box key={option.mode} flexDirection="column">
              <OverlayListRow
                selected={selected === index}
                primary={option.label}
                secondary={option.description}
                disabled={disabled}
                trailing={<OverlayStatusColumn active={option.mode === currentMode} />}
              />
              {disabled && (
                <Text color={t.warning}> {translate('permission.fullUnavailable')}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </OverlayFrame>
  );
}
