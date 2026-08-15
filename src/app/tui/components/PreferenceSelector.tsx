import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { useI18n } from '../i18n';
import OverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './OverlayFrame';
import { OverlayListRow } from './OverlayPrimitives';

interface PreferenceOption {
  value: string;
  label: string;
  description: string;
}

interface PreferenceSelectorProps {
  title: string;
  currentValue: string;
  options: readonly PreferenceOption[];
  onSelect: (value: string) => void;
  onClose: () => void;
}

export default function PreferenceSelector({
  title,
  currentValue,
  options,
  onSelect,
  onClose,
}: PreferenceSelectorProps) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === currentValue),
    ),
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const move = (direction: 1 | -1) =>
    setSelected((current) => (current + direction + options.length) % options.length);

  useInput((_, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) move(-1);
    if (key.downArrow) move(1);
    if (key.return) {
      onSelect(options[selectedRef.current]!.value);
      onClose();
    }
  });

  return (
    <OverlayFrame
      title={title}
      meta={
        <Text>
          {selected + 1} / {options.length}
        </Text>
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: t('common.navigate') },
            { keys: 'Enter', label: t('common.select') },
            { keys: 'Esc', label: t('common.close') },
          ]}
        />
      }
    >
      <Box flexDirection="column">
        {options.map((option, index) => (
          <OverlayListRow
            key={option.value}
            selected={selected === index}
            primary={option.label}
            secondary={option.description}
            trailing={<OverlayStatusColumn active={option.value === currentValue} />}
          />
        ))}
      </Box>
    </OverlayFrame>
  );
}
