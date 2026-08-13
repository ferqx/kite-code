import { Box, Static, useInput } from 'ink';
import React, { type ReactNode, useRef } from 'react';
import type { ContextCompactionProgressPhase } from '@/core/model/context-compaction-presentation';
import BlockRenderer from './components/BlockRenderer';
import CompactionProgress from './components/CompactionProgress';
import { blockFingerprint } from './render/useStaticContent';
import type { OutputBlock } from './types';

export { changePrefix } from './components/BlockRenderer';
export { toolColor } from './components/render-utils';
export type { StaticContentResult } from './render/useStaticContent';
export { blockFingerprint, useStaticContent } from './render/useStaticContent';

interface OutputAreaProps {
  staticItems?: unknown[];
  staticKey?: string;
  staticHeader?: ReactNode;
  /** All static blocks (immutable, rendered by <Static>) */
  mergedStaticBlocks: OutputBlock[];
  /** Blocks kept in the dynamic tree — may still mutate (tool running, streaming text, etc.) */
  activeDynamicBlocks: OutputBlock[];
  onToggleReason: (id: number) => void;
  onToggleToolExpand?: (id: number) => void;
  onToggleSubagentExpand?: (id: number) => void;
  overlayActive?: boolean;
  /** 主 agent 等待审批时隐藏工具计时器 / Hide tool timer when awaiting approval */
  awaitingApproval?: boolean;
  /** 主 agent 等待 ask_user 输入时标记 ask 工具 / Mark ask_user while waiting for input */
  awaitingInput?: boolean;
  columns: number;
  /** Active manual or automatic compaction rendered after the message list. */
  compactionPhase?: ContextCompactionProgressPhase;
}

function visibleDynamicBlocksForApproval(
  blocks: OutputBlock[],
  awaitingApproval?: boolean,
): OutputBlock[] {
  if (!awaitingApproval) return blocks;

  const pendingApprovalIndex = blocks.findIndex(
    (block) => block.kind === 'approval' && block.resolved === undefined,
  );
  if (pendingApprovalIndex >= 0) {
    for (let i = pendingApprovalIndex - 1; i >= 0; i--) {
      const block = blocks[i]!;
      if (block.kind === 'tool_card' && (block.status === 'queued' || block.status === 'running')) {
        return blocks.slice(0, i + 1);
      }
    }
    return blocks.slice(0, pendingApprovalIndex);
  }

  const approvalToolIndex = blocks.findIndex(
    (block) =>
      block.kind === 'tool_card' && (block.status === 'queued' || block.status === 'running'),
  );
  return approvalToolIndex >= 0 ? blocks.slice(0, approvalToolIndex + 1) : blocks;
}

/**
 * OutputArea renders <Static> (immutable settled blocks + header) inline,
 * and all mutable blocks in the dynamic tree. Blocks only enter <Static>
 * once they become truly immutable (tool done, text complete, etc.).
 */
export default function OutputArea({
  staticItems,
  staticKey,
  staticHeader,
  activeDynamicBlocks,
  mergedStaticBlocks,
  onToggleReason,
  onToggleToolExpand,
  onToggleSubagentExpand,
  overlayActive,
  awaitingApproval,
  awaitingInput,
  columns,
  compactionPhase,
}: OutputAreaProps) {
  const onToggleReasonRef = useRef(onToggleReason);
  onToggleReasonRef.current = onToggleReason;
  const onToggleToolRef = useRef(onToggleToolExpand);
  onToggleToolRef.current = onToggleToolExpand;
  const onToggleSubagentRef = useRef(onToggleSubagentExpand);
  onToggleSubagentRef.current = onToggleSubagentExpand;
  const visibleDynamicBlocks = visibleDynamicBlocksForApproval(
    activeDynamicBlocks,
    awaitingApproval,
  );
  const dynamicBlocksRef = useRef(visibleDynamicBlocks);
  dynamicBlocksRef.current = visibleDynamicBlocks;

  // Arrow key Enter-to-toggle on the last dynamic block
  useInput(
    (_input: unknown, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
      const blocks = dynamicBlocksRef.current;
      const last = blocks[blocks.length - 1];
      if (!last) return;
      if (key.return) {
        if (last.kind === 'reason') {
          onToggleReasonRef.current?.(last.id);
        } else if (last.kind === 'tool_card') {
          onToggleToolRef.current?.(last.id);
        } else if (last.kind === 'subagent') {
          onToggleSubagentRef.current?.(last.id);
        }
      }
    },
    { isActive: !overlayActive },
  );

  // 与 Footer 的 ApprovalBlock / PlanReviewBlock / InputBlock 的 border 内部 paddingX={1} 对齐，
  // 确保 body 区与 Footer 交互区的文本起始列一致。
  // Match text start column with Footer interaction blocks' inner paddingX={1}.
  const innerColumns = Math.max(20, columns);
  const hasMessages = mergedStaticBlocks.length + visibleDynamicBlocks.length > 0;

  return (
    <Box flexDirection="column" marginBottom={hasMessages ? 1 : 0}>
      <Box height={0} overflow="hidden">
        {staticItems && staticKey && (
          <Static key={staticKey} items={staticItems}>
            {(_item, index) => {
              if (index === 0) {
                return (
                  <React.Fragment key="header">
                    {staticHeader}
                    <Box height={1} />
                  </React.Fragment>
                );
              }
              const block = mergedStaticBlocks[index - 1];
              if (!block) return null;
              const prevBlock = index > 1 ? mergedStaticBlocks[index - 2] : undefined;
              return (
                <BlockRenderer
                  key={blockFingerprint(block)}
                  block={block}
                  isFocused={false}
                  index={index - 1}
                  prevBlock={prevBlock}
                  awaitingApproval={false}
                  awaitingInput={false}
                  columns={innerColumns}
                />
              );
            }}
          </Static>
        )}
      </Box>
      <Box flexDirection="column">
        {visibleDynamicBlocks.map((block, i) => {
          const prevBlock = i > 0 ? visibleDynamicBlocks[i - 1] : mergedStaticBlocks.at(-1);
          return (
            <BlockRenderer
              key={block.id}
              block={block}
              isFocused={false}
              index={i}
              prevBlock={prevBlock}
              awaitingApproval={awaitingApproval}
              awaitingInput={awaitingInput}
              columns={innerColumns}
            />
          );
        })}
        {compactionPhase && <CompactionProgress phase={compactionPhase} />}
      </Box>
    </Box>
  );
}
