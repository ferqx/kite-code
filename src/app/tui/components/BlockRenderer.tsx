import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import MarkdownBlock from './MarkdownBlock';
import SubAgentBlock from './SubAgentBlock';
import { wrapDisplayLines } from './soft-wrap';
import ToolCardBlock from './ToolCardBlock';

export function changePrefix(
  kind: string,
  theme?: { success: string; warning: string; error: string; muted: string },
): { prefix: string; color: string } {
  const t = theme ?? {
    success: '#4ADE80',
    warning: '#FBBF24',
    error: '#F87171',
    muted: '#9CA3AF',
  };
  switch (kind) {
    case 'add':
      return { prefix: '+', color: t.success };
    case 'edit':
      return { prefix: '~', color: t.warning };
    case 'delete':
      return { prefix: '-', color: t.error };
    default:
      return { prefix: '?', color: t.muted };
  }
}

function formatLines(added?: number, removed?: number): string {
  const parts: string[] = [];
  if (added != null) parts.push(`+${added}`);
  if (removed != null) parts.push(`-${removed}`);
  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

const BLOCK_GAP = 1;

function gapFrom(_prevBlock?: OutputBlock) {
  return { marginTop: 0, marginBottom: BLOCK_GAP } as const;
}

interface BlockRendererProps {
  block: OutputBlock;
  isFocused: boolean;
  index: number;
  columns: number;
  prevBlock?: OutputBlock;
  /** 当主 agent 等待审批时，工具并未真正执行，隐藏计时器 / When awaiting approval, tool isn't actually running, hide timer */
  awaitingApproval?: boolean;
}

const BlockRenderer = React.memo(function BlockRenderer({
  block,
  isFocused: _isFocused,
  columns,
  index: _i,
  prevBlock,
  awaitingApproval,
}: BlockRendererProps) {
  const dt = useTheme();
  switch (block.kind) {
    case 'user': {
      const prompt = '❯ ';
      // 参照 InputLine: inputMaxWidth = columns - promptWidth*2，安全边距远大于 1
      // 这里的 wrapWidth 至少留 3 列 slack，防止 process.stdout.columns 与 Yoga 实际宽度
      // 不一致导致的边界换行（"空白行"和"单行变两行 bg"）
      const wrapWidth = Math.max(20, columns);
      const fullText = prompt + block.content;
      const wrappedLines = wrapDisplayLines(fullText, wrapWidth);

      const isSlashCommand = block.content.startsWith('/');
      return (
        <Box marginTop={gapFrom(prevBlock).marginTop} marginBottom={isSlashCommand ? 0 : BLOCK_GAP}>
          {wrappedLines.map((displayLine, i) => (
            <Box key={i} backgroundColor={dt.userMsgBg} width={columns}>
              <Text>{displayLine}</Text>
            </Box>
          ))}
        </Box>
      );
    }

    case 'text': {
      return (
        <Box marginTop={0} marginBottom={BLOCK_GAP}>
          <MarkdownBlock
            content={block.content}
            streaming={block.streaming}
            color={block.isError ? dt.error : undefined}
          />
        </Box>
      );
    }

    case 'reason':
      return null;

    case 'tool_card':
      // Plan progress is shown in StatusBar — hide individual update_plan calls
      if (block.name === 'update_plan') return null;
      return (
        <Box {...gapFrom(prevBlock)}>
          <ToolCardBlock block={block} awaitingApproval={awaitingApproval} />
        </Box>
      );

    case 'file_change':
      return (
        <Box flexDirection="column" {...gapFrom(prevBlock)}>
          <Text color={dt.muted}>── File Changes ──</Text>
          {block.changes.map((change, ci) => {
            const { prefix, color } = changePrefix(change.kind, dt);
            const lineInfo = formatLines(change.linesAdded, change.linesRemoved);
            return (
              <Box key={`${block.id}-${ci}`} flexDirection="column">
                <Box>
                  <Text color={color}>
                    {prefix} {change.path}
                  </Text>
                  {lineInfo ? <Text color={dt.dim}>{lineInfo}</Text> : null}
                </Box>
                {change.preview && (
                  <Box paddingLeft={3} flexDirection="column">
                    {change.preview.split('\n').map((pl, pli) => (
                      <Text key={pli} color={dt.dim}>
                        │ {pl}
                      </Text>
                    ))}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      );

    case 'approval': {
      // 审批展示在 Footer，输出区无需重复
      // Approval UI is in Footer, no duplicate needed in output area
      return null;
    }
    case 'question': {
      return (
        <Box flexDirection="column" {...gapFrom(prevBlock)}>
          {block.resolved ? (
            block.resolved === 'cancelled' ? (
              <Text color={dt.dim}>⊘ Question cancelled</Text>
            ) : (
              <Text>
                <Text color={dt.success}>✓ Answered: </Text>
                <Text color={dt.muted}>{block.resolved}</Text>
              </Text>
            )
          ) : (
            <Text color={dt.primary}>? Question</Text>
          )}
        </Box>
      );
    }

    case 'subagent':
      return (
        <Box flexDirection="column" {...gapFrom(prevBlock)}>
          <SubAgentBlock block={block} />
        </Box>
      );

    default: {
      const _exhaustive: never = block;
      return (
        <Box {...gapFrom(prevBlock)}>
          <Text color={dt.warning}>? Unknown block kind: {(_exhaustive as OutputBlock).kind}</Text>
        </Box>
      );
    }
  }
});

export default BlockRenderer;
