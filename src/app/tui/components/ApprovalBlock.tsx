import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { ShellApprovalGrant, ToolApprovalPayload } from '@/protocol/events';
import { ACTION_NAMES } from './render-utils';

interface Option {
  key: string;
  label: string;
  grant: ShellApprovalGrant | null;
}

interface ApprovalBlockProps {
  approval: ToolApprovalPayload;
  provider: TuiUserInputProvider;
  onResolved: (action: string, grant?: string, pattern?: string) => void;
}

export default function ApprovalBlock({ approval, provider, onResolved }: ApprovalBlockProps) {
  const t = useTheme();
  const riskColor = t.risk[approval.risk] ?? t.risk.unknown;

  const options: Option[] = [];
  for (const g of approval.grantOptions) {
    switch (g) {
      case 'approve_once':
        options.push({ key: 'a', label: 'Approve once', grant: 'approve_once' });
        break;
      case 'same_command':
        options.push({ key: 's', label: 'Approve same command', grant: 'same_command' });
        break;
      case 'full_access':
        options.push({ key: 'f', label: 'Approve all · full access', grant: 'full_access' });
        break;
    }
  }
  options.push({ key: 'd', label: 'Deny', grant: null });

  const [selectedIndex, setSelectedIndex] = useState(0);

  const prefix = approval.suggestedPrefixRule?.[0] ?? approval.command.split(/[;&|]/)[0]?.trim();

  function resolve(grant: ShellApprovalGrant | null) {
    if (grant) {
      const pat = grant === 'same_command' && prefix ? prefix : undefined;
      provider.submitAction({ type: 'approve', grant });
      onResolved(grant, grant, pat);
    } else {
      provider.submitAction({ type: 'reject' });
      onResolved('denied');
    }
  }

  useInput(
    (
      input: string,
      key: { escape?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean },
    ) => {
      // Esc 由全局 handler 处理 / Esc is handled by global handler
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(options.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const opt = options[selectedIndex];
        if (opt) resolve(opt.grant);
        return;
      }
      // 字母快捷键保留 / Letter shortcuts kept as quick access
      const match = options.find((o) => o.key === input.toLowerCase());
      if (match) resolve(match.grant);
    },
  );

  const cmd =
    approval.command.length > 100 ? `${approval.command.slice(0, 97)}...` : approval.command;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1}>
      <Text bold color={riskColor}>
        ● {ACTION_NAMES[approval.tool] ?? approval.tool}
      </Text>
      <Text color={t.primary}>{cmd}</Text>
      <Text color={t.dim}>
        {approval.summary}
        {approval.risk ? ` · ${approval.risk}` : ''}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={t.dim}>{'─'.repeat(40)}</Text>
        {options.map((o, i) => {
          const isSelected = i === selectedIndex;
          const isDeny = o.grant === null;
          return (
            <Text key={o.key} color={isSelected ? t.primary : isDeny ? t.error : t.muted}>
              {isSelected ? '▶' : ' '} {i + 1}. {o.label}
            </Text>
          );
        })}
        <Text color={t.dim}>{'─'.repeat(40)}</Text>
        <Text color={t.dim}>↑↓ select Enter confirm Esc cancel</Text>
      </Box>
    </Box>
  );
}
