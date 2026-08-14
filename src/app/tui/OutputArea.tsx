import { Box, Static, useInput } from 'ink';
import React, { type ReactNode, useMemo, useRef } from 'react';
import type { ContextCompactionProgressPhase } from '@/core/model/context-compaction-presentation';
import BlockRenderer from './components/BlockRenderer';
import CompactionProgress from './components/CompactionProgress';
import ConcurrentSubAgentBlock from './components/ConcurrentSubAgentBlock';
import { MAX_RUNNING_STEPS } from './components/SubAgentBlock';
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
  /** Terminal viewport rows used to bound the mutable output tail. */
  rows?: number;
  /** Active manual or automatic compaction rendered after the message list. */
  compactionPhase?: ContextCompactionProgressPhase;
}

// Footer/status/prompt plus OutputArea's bottom gap consume five rows. The
// child budget also keeps one explicit safety row because Ink treats
// outputHeight === rows as full-screen.
const DYNAMIC_CHROME_ROWS = 5;
const SUBAGENT_CARD_OVERHEAD_ROWS = 3;

type SubagentBlock = Extract<OutputBlock, { kind: 'subagent' }>;
type RenderItem =
  | OutputBlock
  | {
      kind: 'concurrent_subagents';
      id: string;
      blocks: SubagentBlock[];
    };

/** Preserve block order while replacing an identified concurrent sibling run
 * with one presentation item. Sequential children never receive a group id. */
export function aggregateConcurrentSubagents(blocks: OutputBlock[]): RenderItem[] {
  const items: RenderItem[] = [];
  for (let index = 0; index < blocks.length; ) {
    const block = blocks[index]!;
    if (block.kind !== 'subagent' || block.concurrencyGroupId == null) {
      items.push(block);
      index++;
      continue;
    }
    const siblings: SubagentBlock[] = [];
    let cursor = index;
    while (cursor < blocks.length) {
      const candidate = blocks[cursor]!;
      if (
        candidate.kind !== 'subagent' ||
        candidate.concurrencyGroupId !== block.concurrencyGroupId
      ) {
        break;
      }
      siblings.push(candidate);
      cursor++;
    }
    if (siblings.length > 1) {
      items.push({ kind: 'concurrent_subagents', id: block.concurrencyGroupId, blocks: siblings });
    } else {
      items.push(block);
    }
    index = cursor;
  }
  return items;
}

function lastOutputBlock(item: RenderItem | undefined): OutputBlock | undefined {
  return item?.kind === 'concurrent_subagents' ? item.blocks.at(-1) : item;
}

/**
 * Ink clears the entire main screen whenever its mutable frame reaches the
 * terminal height. That reset also destroys a user's native scroll position.
 * Keep a single child at the normal five-step tail, but share the available
 * step rows when several child cards are updating concurrently.
 */
export function concurrentSubagentStepLimit(blocks: OutputBlock[], terminalRows = 24): number {
  const subagentCount = blocks.filter((block) => block.kind === 'subagent').length;
  if (subagentCount <= 1) return MAX_RUNNING_STEPS;

  const otherBlockCount = blocks.length - subagentCount;
  // Arbitrary text/tool blocks have no trustworthy row estimate. In a mixed
  // mutable tail, spend no additional rows on child steps instead of guessing.
  if (otherBlockCount > 0) return 0;

  const interBlockGaps = Math.max(0, blocks.length - 1);
  const fixedRows =
    DYNAMIC_CHROME_ROWS + interBlockGaps + subagentCount * SUBAGENT_CARD_OVERHEAD_ROWS;
  const availableStepRows = Math.max(0, Math.floor(terminalRows) - fixedRows);
  return Math.min(MAX_RUNNING_STEPS, Math.floor(availableStepRows / subagentCount));
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
  rows,
  compactionPhase,
}: OutputAreaProps) {
  const onToggleReasonRef = useRef(onToggleReason);
  onToggleReasonRef.current = onToggleReason;
  const onToggleToolRef = useRef(onToggleToolExpand);
  onToggleToolRef.current = onToggleToolExpand;
  const onToggleSubagentRef = useRef(onToggleSubagentExpand);
  onToggleSubagentRef.current = onToggleSubagentExpand;
  const visibleDynamicBlocks = useMemo(
    () => visibleDynamicBlocksForApproval(activeDynamicBlocks, awaitingApproval),
    [activeDynamicBlocks, awaitingApproval],
  );
  const staticRenderItems = useMemo(
    () => aggregateConcurrentSubagents(mergedStaticBlocks),
    [mergedStaticBlocks],
  );
  const staticPresentationItems = useMemo(
    () => (staticItems ? [staticItems[0], ...staticRenderItems] : undefined),
    [staticItems, staticRenderItems],
  );
  const dynamicRenderItems = useMemo(
    () => aggregateConcurrentSubagents(visibleDynamicBlocks),
    [visibleDynamicBlocks],
  );
  const maxVisibleSubagentSteps = concurrentSubagentStepLimit(visibleDynamicBlocks, rows);
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
        {staticPresentationItems && staticKey && (
          <Static key={staticKey} items={staticPresentationItems}>
            {(_item, index) => {
              if (index === 0) {
                return (
                  <React.Fragment key="header">
                    {staticHeader}
                    <Box height={1} />
                  </React.Fragment>
                );
              }
              const item = staticRenderItems[index - 1];
              if (!item) return null;
              const prevBlock = lastOutputBlock(
                index > 1 ? staticRenderItems[index - 2] : undefined,
              );
              if (item.kind === 'concurrent_subagents') {
                return (
                  <Box key={`subagent-group-${item.id}`} marginTop={prevBlock ? 1 : 0}>
                    <ConcurrentSubAgentBlock blocks={item.blocks} columns={Math.max(1, columns)} />
                  </Box>
                );
              }
              return (
                <BlockRenderer
                  key={blockFingerprint(item)}
                  block={item}
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
        {dynamicRenderItems.map((item, i) => {
          const prevBlock =
            i > 0
              ? lastOutputBlock(dynamicRenderItems[i - 1])
              : lastOutputBlock(staticRenderItems.at(-1));
          if (item.kind === 'concurrent_subagents') {
            const topMarginRows = prevBlock ? 1 : 0;
            return (
              <Box
                key={`subagent-group-${item.id}`}
                flexDirection="column"
                marginTop={prevBlock ? 1 : 0}
              >
                <ConcurrentSubAgentBlock
                  blocks={item.blocks}
                  columns={Math.max(1, columns)}
                  maxVisibleSteps={maxVisibleSubagentSteps}
                  maxVisibleChildren={
                    dynamicRenderItems.length === 1
                      ? Math.max(
                          0,
                          Math.floor(rows ?? 24) - DYNAMIC_CHROME_ROWS - 2 - topMarginRows,
                        )
                      : 0
                  }
                  allowExpanded={
                    dynamicRenderItems.length === 1 &&
                    1 +
                      item.blocks.reduce(
                        (height, block) => height + 2 + (block.steps.length > 0 ? 1 : 0),
                        0,
                      ) +
                      DYNAMIC_CHROME_ROWS +
                      topMarginRows <
                      Math.floor(rows ?? 24)
                  }
                />
              </Box>
            );
          }
          return (
            <BlockRenderer
              key={item.id}
              block={item}
              isFocused={false}
              index={i}
              prevBlock={prevBlock}
              awaitingApproval={awaitingApproval}
              awaitingInput={awaitingInput}
              columns={innerColumns}
              maxVisibleSubagentSteps={maxVisibleSubagentSteps}
            />
          );
        })}
        {compactionPhase && <CompactionProgress phase={compactionPhase} />}
      </Box>
    </Box>
  );
}
