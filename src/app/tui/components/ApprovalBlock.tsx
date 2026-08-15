import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { ShellApprovalGrant, ToolApprovalPayload } from '@/protocol/events';
import { useI18n } from '../i18n';
import OverlayChoiceList from './OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './OverlayFrame';

export interface ApprovalBlockProps {
  approval: ToolApprovalPayload;
  provider: TuiUserInputProvider;
  onResolved: (action: string, grant?: string) => void;
}

interface Option {
  label: string;
  action: 'approve' | 'deny';
  grant?: ShellApprovalGrant;
}

function approvalToolCategory(tool: string, translate: ReturnType<typeof useI18n>['t']): string {
  if (tool === 'shell_execute') return 'Shell';
  if (tool === 'write_file' || tool === 'edit_file') return translate('approval.fileEdit');
  if (tool === 'task') return 'Subagent';
  if (tool.startsWith('mcp__')) return 'MCP';
  return (
    tool.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim() || translate('approval.genericTool')
  );
}

export default function ApprovalBlock({ approval, provider, onResolved }: ApprovalBlockProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const rawInputBuffer = useRef('');
  const approvalLabel = (approval.command || approval.summary || approval.tool)
    .replace(/\s+/gu, ' ')
    .trim();
  const isCommand = approval.tool === 'shell_execute';
  const toolCategory = approvalToolCategory(approval.tool, translate);
  const visibleOptions: Option[] = [
    { label: translate('approval.once'), action: 'approve', grant: 'approve_once' },
    { label: translate('approval.session'), action: 'approve', grant: 'same_command' },
    { label: translate('approval.deny'), action: 'deny' },
  ];
  const options = visibleOptions.filter(
    (option) => option.action === 'deny' || approval.grantOptions.includes(option.grant!),
  );
  const choiceOptions = options.map((option) => ({
    id: option.grant ?? 'deny',
    label: option.label,
    description:
      option.grant === 'approve_once'
        ? translate('approval.onceDescription')
        : option.grant === 'same_command'
          ? translate(
              isCommand ? 'approval.sessionCommandDescription' : 'approval.sessionToolDescription',
            )
          : translate(
              isCommand ? 'approval.denyCommandDescription' : 'approval.denyToolDescription',
            ),
  }));

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
      const nextIndex = Math.min(options.length - 1, selectedIndexRef.current + 1);
      selectedIndexRef.current = nextIndex;
      setSelectedIndex(nextIndex);
      return;
    }
    if (key.return) {
      const opt = options[selectedIndexRef.current];
      if (opt) resolve(opt);
      return;
    }
  });

  return (
    <OverlayFrame
      title={translate('approval.title', { tool: toolCategory })}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: translate('common.navigate') },
            { keys: 'Enter', label: translate('common.confirm') },
            { keys: 'Esc', label: translate('common.cancel') },
          ]}
        />
      }
    >
      <Box
        marginLeft={1}
        paddingLeft={1}
        width="100%"
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={t.dim}
      >
        <Text wrap="truncate-end">{approvalLabel}</Text>
      </Box>
      <Box marginTop={1}>
        <OverlayChoiceList
          options={choiceOptions}
          selectedId={choiceOptions[selectedIndex]?.id}
          selectionBackground={false}
        />
      </Box>
    </OverlayFrame>
  );
}
