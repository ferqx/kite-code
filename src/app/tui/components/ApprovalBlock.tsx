import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { ShellApprovalGrant, ToolApprovalPayload } from '@/protocol/events';
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

const VISIBLE_OPTIONS: Option[] = [
  { label: '允许一次', action: 'approve', grant: 'approve_once' },
  { label: '本次会话允许', action: 'approve', grant: 'same_command' },
  { label: '拒绝', action: 'deny' },
];

function approvalToolCategory(tool: string): string {
  if (tool === 'shell_execute') return 'Shell';
  if (tool === 'write_file' || tool === 'edit_file') return '文件编辑';
  if (tool === 'task') return 'Subagent';
  if (tool.startsWith('mcp__')) return 'MCP';
  return tool.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim() || '通用工具';
}

export default function ApprovalBlock({ approval, provider, onResolved }: ApprovalBlockProps) {
  const t = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const rawInputBuffer = useRef('');
  const approvalLabel = (approval.command || approval.summary || approval.tool)
    .replace(/\s+/gu, ' ')
    .trim();
  const isCommand = approval.tool === 'shell_execute';
  const toolCategory = approvalToolCategory(approval.tool);
  const options = VISIBLE_OPTIONS.filter(
    (option) => option.action === 'deny' || approval.grantOptions.includes(option.grant!),
  );
  const choiceOptions = options.map((option) => ({
    id: option.grant ?? 'deny',
    label: option.label,
    description:
      option.grant === 'approve_once'
        ? '仅批准本次执行'
        : option.grant === 'same_command'
          ? `相同${isCommand ? '命令' : '工具'}在本次会话中不再询问`
          : `不${isCommand ? '执行命令' : '调用工具'}并结束当前轮次`,
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
      title={`${toolCategory} · 工具授权`}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: '导航' },
            { keys: 'Enter', label: '确认' },
            { keys: 'Esc', label: '取消' },
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
