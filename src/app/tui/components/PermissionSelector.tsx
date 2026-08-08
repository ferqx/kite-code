import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
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

const OPTIONS: ReadonlyArray<{ mode: InteractionMode; label: string; description: string }> = [
  {
    mode: 'accept_edits',
    label: '接受编辑',
    description: '本地工作区操作自动执行；出网、外部写入和未知副作用需确认',
  },
  { mode: 'auto', label: '自动审批', description: '模型自动审核，不确定时询问' },
  { mode: 'full', label: '完全权限', description: '完全自主，全部放行，不询问用户' },
];

export default function PermissionSelector({
  currentMode,
  sandboxBackend,
  onSelect,
  onClose,
}: PermissionSelectorProps) {
  const t = useTheme();
  const fullAvailable = sandboxSupportsFullModeV1(sandboxBackend);
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      OPTIONS.findIndex((option) => option.mode === currentMode),
    ),
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const move = (direction: 1 | -1) => {
    setSelected((current) => {
      let next = current;
      do {
        next = (next + direction + OPTIONS.length) % OPTIONS.length;
      } while (OPTIONS[next]!.mode === 'full' && !fullAvailable);
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
      const option = OPTIONS[selectedRef.current]!;
      if (option.mode === 'full' && !fullAvailable) return;
      onSelect(option.mode);
      onClose();
    }
  });

  return (
    <OverlayFrame
      title="选择权限模式"
      meta={
        <Text color={t.dim}>
          {selected + 1} / {OPTIONS.length}
        </Text>
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: '导航' },
            { keys: 'Enter', label: '选择' },
            { keys: 'Esc', label: '关闭' },
          ]}
        />
      }
    >
      <Box flexDirection="column">
        {OPTIONS.map((option, index) => {
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
              {disabled && <Text color={t.warning}> 当前未在沙箱环境开启</Text>}
            </Box>
          );
        })}
      </Box>
    </OverlayFrame>
  );
}
