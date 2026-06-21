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
      // 流式渲染期间，text 事件中的 \n 会按行拆分为独立 OutputBlock，
      // 其中 content === "" 的空行块仅表示段落分隔 — 前一个内容块的
      // marginBottom 已提供间距，空行块不应额外叠加 margin。
      // During streaming, \n in text events splits content into per-line
      // blocks. Empty-string blocks represent paragraph breaks — the
      // preceding content block's marginBottom already provides spacing.
      const isEmpty = block.content === '';
      return (
        <Box marginTop={0} marginBottom={isEmpty ? 0 : BLOCK_GAP}>
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
      // 审批中：Footer 渲染 ApprovalBlock，输出区不重复
      // 已审批：显示简要确认 / Resolved: show brief confirmation for scrollback
      if (!block.resolved) return null;

      const aRes = block.resolved;
      const aGrant = aRes.grant ?? aRes.pattern ?? '';
      const approved = aRes.action !== 'reject' && aRes.action !== 'cancelled';
      return (
        <Box flexDirection="column" {...gapFrom(prevBlock)}>
          <Text>
            <Text color={approved ? dt.success : dt.error}>{approved ? '✓' : '✗'}</Text>
            <Text color={dt.muted}>
              {' '}
              {approved ? 'Approved' : aRes.action === 'cancelled' ? 'Cancelled' : 'Rejected'}
              {aGrant ? ` · ${aGrant}` : ''}
            </Text>
          </Text>
        </Box>
      );
    }
    case 'question': {
      if (!block.resolved) {
        // 提问进行中：Footer 已渲染完整 UI；输出区显示问题文本作为 scrollback 标记
        return (
          <Box flexDirection="column" {...gapFrom(prevBlock)}>
            <Text color={dt.primary}>? {block.question.question}</Text>
          </Box>
        );
      }
      if (block.resolved === 'cancelled') {
        return (
          <Box flexDirection="column" {...gapFrom(prevBlock)}>
            <Text color={dt.dim}>Question skipped</Text>
          </Box>
        );
      }
      if (typeof block.resolved === 'object') {
        // 多问题模式 / Multi-question mode
        return (
          <Box flexDirection="column" {...gapFrom(prevBlock)}>
            <Text color={dt.success}>✓ Answered:</Text>
            {block.resolved.answers &&
              Object.entries(block.resolved.answers).map(([id, val]) => (
                <Text key={id} color={dt.muted}>
                  {'  '}
                  {id}: {val}
                </Text>
              ))}
          </Box>
        );
      }
      return (
        <Box flexDirection="column" {...gapFrom(prevBlock)}>
          <Text>
            <Text color={dt.success}>✓ Answered: </Text>
            <Text color={dt.muted}>{block.resolved}</Text>
          </Text>
        </Box>
      );
    }

    case 'plan_review': {
      // 方案内容直接渲染到 OutputArea（进入 Static），Footer 只渲染确认条
      // Plan content renders in OutputArea (frozen to Static), Footer only shows confirm bar

      const pRes = block.resolved;
      const autoMode = pRes?.action === 'approved_auto';
      const manualMode = pRes?.action === 'approved_manual';
      const approved = autoMode || manualMode;
      const supplemented = pRes?.action === 'supplemented';
      const cancelled = pRes?.action === 'cancelled';
      const pendingReview = !pRes || pRes.action === 'pending_review';

      const STATUS_ICON: Record<string, string> = {
        pending: '○',
        in_progress: '▶',
        completed: '✓',
      };

      // 有方案内容时渲染完整卡片（统一风格，仅标签文字区分状态）
      // Render full plan card — consistent style, status differentiated by label text only
      if (block.plan) {
        const label = approved
          ? ` · ${autoMode ? 'auto mode' : 'manual approval'}`
          : supplemented
            ? ' · supplemented'
            : cancelled
              ? ' · cancelled'
              : pendingReview
                ? ' · awaiting review'
                : ' · rejected';

        const cardMaxWidth = Math.max(40, columns - 6);
        return (
          <Box flexDirection="column" marginY={1} width={cardMaxWidth}>
            <Box flexDirection="column" borderStyle="round" borderColor={dt.primary} paddingX={1}>
              <Text bold color={dt.primary}>
                Plan: {block.plan.name}
                <Text color={dt.dim}>{label}</Text>
              </Text>
              {block.plan.description && (
                <Box marginTop={1} flexDirection="column">
                  <MarkdownBlock content={block.plan.description} />
                </Box>
              )}
              {block.plan.steps.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                  {block.plan.steps.map((s, i) => (
                    <Text key={`${s.step}-${i}`} color={dt.muted}>
                      {STATUS_ICON[s.status] ?? '○'} {i + 1}. {s.step}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          </Box>
        );
      }

      // 无方案内容（理论上不应出现）/ No plan content (should not happen)
      return (
        <Box flexDirection="column" {...gapFrom(prevBlock)}>
          <Text>
            <Text color={approved ? dt.success : dt.error}>
              {approved ? '✓' : supplemented ? '↩' : '✗'}
            </Text>
            <Text color={dt.muted}>
              {' '}
              {supplemented
                ? `Plan supplemented: ${pRes.feedback ?? ''}`
                : cancelled
                  ? 'Plan cancelled'
                  : 'Plan rejected'}
            </Text>
          </Text>
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
