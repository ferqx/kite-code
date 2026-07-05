import { Box, Text, useInput, useStdout } from 'ink';
import { useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';

interface Option {
  key: string;
  label: string;
  action: 'approve' | 'deny';
}

interface ApprovalBlockProps {
  approval?: unknown;
  provider: TuiUserInputProvider;
  onResolved: (action: string, grant?: string) => void;
}

const OPTIONS: Option[] = [
  { key: 'y', label: 'Yes · 仅本次', action: 'approve' },
  { key: 'd', label: 'Deny · 拒绝', action: 'deny' },
];

export default function ApprovalBlock({ provider, onResolved }: ApprovalBlockProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const cols = stdout?.columns ?? 80;

  function resolve(opt: Option) {
    if (opt.action === 'approve') {
      provider.submitAction({ type: 'approve', grant: 'approve_once' });
      onResolved('approve', 'approve_once');
    } else {
      provider.submitAction({ type: 'reject' });
      onResolved('denied');
    }
  }

  useInput((_input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(OPTIONS.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const opt = OPTIONS[selectedIndex];
      if (opt) resolve(opt);
    }
  });

  return (
    <Box flexDirection="column">
      {/* top border */}
      <Text color={t.dim}>{'─'.repeat(cols)}</Text>

      {/* title */}
      <Box marginTop={1}>
        <Text>Approve this tool call?</Text>
      </Box>

      {/* options */}
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((o, i) => {
          const isSelected = i === selectedIndex;
          const color = isSelected ? t.primary : o.action === 'deny' ? t.dim : t.muted;
          return (
            <Box key={o.key} marginTop={i > 0 ? 1 : 0}>
              <Text color={color}>
                {isSelected ? '>' : ' '} {o.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* footer */}
      <Box marginTop={1} marginBottom={1}>
        <Text color={t.dim}>↑↓ select Enter confirm Esc cancel</Text>
      </Box>
    </Box>
  );
}
