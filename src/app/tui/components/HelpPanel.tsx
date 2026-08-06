import { Box, Text, useInput } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import { useState } from 'react';
import { useTheme } from '@/app/tui/theme';
import type { SandboxBackend } from '@/core/sandbox';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { SLASH_COMMAND_DEFS } from '../public-surface';
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
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxContentHeight = useOverlayHeight(8);
  const modeHelp =
    sandboxBackend === 'none'
      ? '设置权限模式（accept_edits/auto；Full 未启用沙箱）'
      : '设置权限模式（accept_edits/auto/full）';
  const commandShortcuts: [string, string][] = SLASH_COMMAND_DEFS.map((command) => [
    `/${command.name}`,
    command.name === 'permissions' ? modeHelp : command.description,
  ]);

  const groups: ShortcutGroup[] = [
    {
      title: '快捷键',
      shortcuts: [
        ['Shift+Tab', '进入/退出方案模式'],
        ['Ctrl+C', '中断运行 / 双按退出'],
        ['Ctrl+T', '展开/折叠所有 reasoning'],
        ['Ctrl+E', '展开输入框折叠内容'],
        ['Ctrl+L', '清空输出屏幕'],
        ['Shift+Enter', '换行'],
        ['?', '打开帮助面板（输入为空时）'],
        ['Esc', '取消交互 / 关闭面板'],
      ],
    },
    {
      title: '输入',
      shortcuts: [
        ['Enter', '提交消息'],
        ['Shift+Enter', '换行'],
        ['Up/Down', '命令历史'],
        ['Tab', '补全斜杠命令或文件路径'],
      ],
    },
    {
      title: '斜杠命令',
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
      title="快捷键"
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: '滚动' },
            { keys: 'Esc', label: '关闭' },
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
