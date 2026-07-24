import { Box, Text, useInput, useStdout } from 'ink';
import { useRef, useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { ShellApprovalGrant } from '@/protocol/events';

export interface ApprovalBlockProps {
  approval?: unknown;
  provider: TuiUserInputProvider;
  onResolved: (action: string, grant?: string) => void;
}

interface Option {
  label: string;
  action: 'approve' | 'deny';
  grant?: ShellApprovalGrant;
}

const OPTIONS: Option[] = [
  { label: '允许一次', action: 'approve', grant: 'approve_once' },
  { label: '本次会话允许', action: 'approve', grant: 'same_command' },
  { label: '拒绝', action: 'deny' },
];

export default function ApprovalBlock({ provider, onResolved }: ApprovalBlockProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const rawInputBuffer = useRef('');
  const cols = stdout?.columns ?? 80;

  function resolve(opt: Option) {
    if (opt.action === 'approve') {
      const grant = opt.grant ?? 'approve_once';
      provider.submitAction({ type: 'approve', grant });
      onResolved('approve', grant);
    } else {
      provider.submitAction({ type: 'reject' });
      onResolved('denied');
    }
  }

  useInput((input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    rawInputBuffer.current = `${rawInputBuffer.current}${input}`.slice(-4);
    const upArrow =
      key.upArrow ||
      rawInputBuffer.current.endsWith('\u001b[A') ||
      rawInputBuffer.current.endsWith('[A');
    const downArrow =
      key.downArrow ||
      rawInputBuffer.current.endsWith('\u001b[B') ||
      rawInputBuffer.current.endsWith('[B');
    if (upArrow) {
      rawInputBuffer.current = '';
      const nextIndex = Math.max(0, selectedIndexRef.current - 1);
      selectedIndexRef.current = nextIndex;
      setSelectedIndex(nextIndex);
      return;
    }
    if (downArrow) {
      rawInputBuffer.current = '';
      const nextIndex = Math.min(OPTIONS.length - 1, selectedIndexRef.current + 1);
      selectedIndexRef.current = nextIndex;
      setSelectedIndex(nextIndex);
      return;
    }
    if (key.return) {
      const opt = OPTIONS[selectedIndexRef.current];
      if (opt) resolve(opt);
      return;
    }
  });

  return (
    <Box flexDirection="column">
      {/* top border */}
      <Text color={t.dim}>{'─'.repeat(cols)}</Text>

      {/* title */}
      <Box marginTop={1}>
        <Text>授权执行命令</Text>
      </Box>

      {/* options */}
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((o, i) => {
          const isSelected = i === selectedIndex;
          const color = isSelected ? t.primary : o.action === 'deny' ? t.dim : t.muted;
          return (
            <Box key={i} marginTop={i > 0 ? 1 : 0}>
              <Text color={color}>
                {isSelected ? '›' : ' '} {o.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* footer */}
      <Box marginTop={1} marginBottom={1}>
        <Text color={t.dim}>↑↓ 选择 Enter 确认 Esc 取消</Text>
      </Box>
    </Box>
  );
}
