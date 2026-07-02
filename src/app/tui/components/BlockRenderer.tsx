import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import MarkdownBlock from './MarkdownBlock';
import SubAgentBlock from './SubAgentBlock';
import { wrapDisplayLines } from './soft-wrap';
import ToolCardBlock from './ToolCardBlock';
import ToolSummaryBlock from './ToolSummaryBlock';

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

const BLOCK_GAP = 1;
/** Agent text 内容的左缩进量，与工具卡片 `● 工具名` 中工具名起始列对齐 */
const TEXT_INDENT = 2;

/** 每个 block 自己负责与上一个 block 的间距（marginTop），而非依赖前一个 block 的 marginBottom。
 *  这样避免了 Static/Dynamic 边界和 block 状态转换时 marginBottom 在 Ink Yoga 布局中被丢失的问题。
 *  Each block owns its own spacing from the previous block via marginTop,
 *  rather than relying on the previous block's marginBottom. This avoids
 *  marginBottom being lost across Static/Dynamic boundaries and state transitions.
 *
 *  斜杠命令是唯一的例外 — 命令结果应紧跟命令本身，0 间距。
 *  Slash commands are the only exception — results should directly follow the command. */
function gapFrom(prevBlock?: OutputBlock) {
  if (!prevBlock) return { marginTop: 0, marginBottom: 0 } as const;
  // 斜杠命令结果紧跟命令，无间距 / Slash command results follow commands directly, no gap
  if (prevBlock.kind === 'user' && prevBlock.content.startsWith('/')) {
    return { marginTop: 0, marginBottom: 0 } as const;
  }
  return { marginTop: BLOCK_GAP, marginBottom: 0 } as const;
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

      return (
        <Box marginTop={gapFrom(prevBlock).marginTop} marginBottom={0}>
          {wrappedLines.map((displayLine, i) => (
            <Box key={i} backgroundColor={dt.userMsgBg} width={columns}>
              <Text>{displayLine}</Text>
            </Box>
          ))}
        </Box>
      );
    }

    case 'text': {
      // 空白内容块（ASCII/Unicode 空白、控制字符等）不应渲染任何可见元素。
      // trim() 只能移除 ASCII 空白，\S 正则（Unicode 模式）可捕获各类
      // 不可见 Unicode 字符（ , ​ 等），避免 MarkdownBlock
      // 将其当作有效行渲染，导致 gapFrom marginTop 叠加产生双倍间距。
      // Blank/whitespace-only blocks (incl. Unicode whitespace) should
      // render nothing — trim() only catches ASCII whitespace; /\S/u
      // catches invisible Unicode characters that would otherwise
      // produce double-spacing via stacked marginTop.
      const hasVisible = /\S/u.test(block.content);
      if (!hasVisible) return null;
      return (
        <Box paddingLeft={TEXT_INDENT} marginTop={gapFrom(prevBlock).marginTop} marginBottom={0}>
          <MarkdownBlock
            content={block.content}
            streaming={block.streaming}
            color={block.isError ? dt.error : undefined}
            maxWidth={columns - TEXT_INDENT}
          />
        </Box>
      );
    }

    case 'reason':
      return null;

    case 'tool_card':
      return (
        <Box {...gapFrom(prevBlock)}>
          <ToolCardBlock block={block} awaitingApproval={awaitingApproval} columns={columns} />
        </Box>
      );

    case 'tool_summary': {
      const rc = block.tools.filter((t) => t.status === 'running').length;
      return (
        <Box key={`ts-${block.id}-${rc}-${block.totalElapsedMs}`} {...gapFrom(prevBlock)}>
          <ToolSummaryBlock block={block} columns={columns} />
        </Box>
      );
    }

    case 'file_change':
      // 文件变更已由 tool_card 展示，此处不重复
      return null;

    case 'approval': {
      // 审批中/已审批均由 tool_card 和 Footer 完整渲染，此处不重复
      // Approval pending/resolved is fully rendered by tool_card + Footer
      return null;
    }
    case 'question': {
      // 提问/回答/取消均由 tool_card 完整渲染，此处不重复
      // Question, answer, and cancellation are all fully rendered by the tool_card
      return null;
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
