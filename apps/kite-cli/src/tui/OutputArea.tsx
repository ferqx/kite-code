import type { ContextCompactionProgressPhase } from '@kite-ai/runtime-contract';
import { Box, Static, useInput } from 'ink';
import React, { type ReactNode, useMemo, useRef } from 'react';
import BlockRenderer from './components/BlockRenderer';
import CompactionProgress from './components/CompactionProgress';
import ConcurrentSubAgentBlock from './components/ConcurrentSubAgentBlock';
import { MAX_RUNNING_STEPS } from './components/SubAgentBlock';
import {
  projectApprovalViewport,
  projectOutputBlockTimelineItem,
  type TimelineItem,
} from './presentation/timeline';
import { blockRenderCacheKey } from './render/useStaticContent';
import type { OutputBlock } from './types';

export { changePrefix } from './components/BlockRenderer';
export { toolColor } from './components/render-utils';
export type { StaticContentResult } from './render/useStaticContent';
export { blockRenderCacheKey, useStaticContent } from './render/useStaticContent';

interface OutputAreaProps {
  staticItems?: unknown[];
  staticKey?: string;
  staticHeader?: ReactNode;
  /** Current physical render epoch. Child keys must not be reused across a
   * screen/session reset because Ink keeps component-local layout state. */
  renderEpoch?: number;
  /** All static blocks (immutable, rendered by <Static>) */
  mergedStaticBlocks: OutputBlock[];
  /** Blocks kept in the dynamic tree — may still mutate (tool running, streaming text, etc.) */
  activeDynamicBlocks: OutputBlock[];
  /** Canonical Timeline items for Static ownership. Production passes these
   * from useStaticContent; block arrays remain a test/compatibility adapter. */
  mergedStaticTimeline?: readonly TimelineItem[];
  /** Canonical live/dynamic Timeline items after projector-owned visibility. */
  activeDynamicTimeline?: readonly TimelineItem[];
  onToggleReason: (id: number) => void;
  onToggleToolExpand?: (id: number) => void;
  onToggleSubagentExpand?: (id: number) => void;
  /** Current prompt owns Enter whenever it contains a submission candidate. */
  canToggleLastBlock?: () => boolean;
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
  | TimelineItem
  | {
      kind: 'concurrent_subagents';
      id: string;
      items: TimelineItem[];
      blocks: SubagentBlock[];
    };

type AdaptedRenderItem =
  | OutputBlock
  | {
      kind: 'concurrent_subagents';
      id: string;
      blocks: SubagentBlock[];
    };

function timelineBlock(item: TimelineItem): OutputBlock {
  return item.renderModel.block;
}

/** Preserve block order while replacing an identified concurrent sibling run
 * with one presentation item. Sequential children never receive a group id. */
function aggregateConcurrentTimelineItems(items: readonly TimelineItem[]): RenderItem[] {
  const renderItems: RenderItem[] = [];
  for (let index = 0; index < items.length; ) {
    const item = items[index]!;
    const block = timelineBlock(item);
    if (block.kind !== 'subagent' || block.concurrencyGroupId == null) {
      renderItems.push(item);
      index++;
      continue;
    }
    const groupId = block.concurrencyGroupId;
    const siblingItems: TimelineItem[] = [];
    const siblings: SubagentBlock[] = [];
    let cursor = index;
    while (cursor < items.length) {
      const candidateItem = items[cursor]!;
      const candidate = timelineBlock(candidateItem);
      if (candidate.kind !== 'subagent' || candidate.concurrencyGroupId !== groupId) {
        break;
      }
      siblingItems.push(candidateItem);
      siblings.push(candidate);
      cursor++;
    }
    if (siblings.length > 1) {
      renderItems.push({
        kind: 'concurrent_subagents',
        id: groupId,
        items: siblingItems,
        blocks: siblings,
      });
    } else {
      renderItems.push(item);
    }
    index = cursor;
  }
  return renderItems;
}

/** Compatibility adapter for callers that still provide raw OutputBlocks. */
export function aggregateConcurrentSubagents(blocks: OutputBlock[]): AdaptedRenderItem[] {
  return aggregateConcurrentTimelineItems(blocks.map(projectOutputBlockTimelineItem)).map((item) =>
    item.kind === 'concurrent_subagents'
      ? { kind: item.kind, id: item.id, blocks: item.blocks }
      : item.renderModel.block,
  );
}

function lastOutputBlock(
  item: RenderItem | AdaptedRenderItem | undefined,
): OutputBlock | undefined {
  if (!item) return undefined;
  return item.kind === 'concurrent_subagents'
    ? item.blocks.at(-1)
    : 'renderModel' in item
      ? timelineBlock(item)
      : item;
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

/**
 * OutputArea renders <Static> (immutable settled blocks + header) inline,
 * and all mutable blocks in the dynamic tree. Blocks only enter <Static>
 * once they become truly immutable (tool done, text complete, etc.).
 */
function OutputArea({
  staticItems,
  staticKey,
  staticHeader,
  renderEpoch = 0,
  activeDynamicBlocks,
  mergedStaticBlocks,
  mergedStaticTimeline,
  activeDynamicTimeline,
  onToggleReason,
  onToggleToolExpand,
  onToggleSubagentExpand,
  canToggleLastBlock,
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
  const canToggleLastBlockRef = useRef(canToggleLastBlock);
  canToggleLastBlockRef.current = canToggleLastBlock;
  const staticTimeline = useMemo(
    () => mergedStaticTimeline ?? mergedStaticBlocks.map(projectOutputBlockTimelineItem),
    [mergedStaticBlocks, mergedStaticTimeline],
  );
  const dynamicTimeline = useMemo(
    () => activeDynamicTimeline ?? activeDynamicBlocks.map(projectOutputBlockTimelineItem),
    [activeDynamicBlocks, activeDynamicTimeline],
  );
  // The projector is the only owner of approval visibility. Applying it here
  // is idempotent for the already-projected production input and keeps the
  // compatibility block-array path on the same canonical code path.
  const visibleDynamicTimeline = useMemo(
    () =>
      activeDynamicTimeline
        ? dynamicTimeline
        : projectApprovalViewport(dynamicTimeline, awaitingApproval).visibleItems,
    [activeDynamicTimeline, awaitingApproval, dynamicTimeline],
  );
  const visibleDynamicBlocks = useMemo(
    () => visibleDynamicTimeline.map(timelineBlock),
    [visibleDynamicTimeline],
  );
  const staticRenderItems = useMemo(
    () => aggregateConcurrentTimelineItems(staticTimeline),
    [staticTimeline],
  );
  const staticPresentationItems = useMemo(
    () => (staticItems ? [staticItems[0], ...staticRenderItems] : undefined),
    [staticItems, staticRenderItems],
  );
  const dynamicRenderItems = useMemo(
    () => aggregateConcurrentTimelineItems(visibleDynamicTimeline),
    [visibleDynamicTimeline],
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
        if (canToggleLastBlockRef.current?.() === false) return;
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
                  <Box
                    key={`${renderEpoch}:subagent-group-${item.id}`}
                    marginTop={prevBlock ? 1 : 0}
                  >
                    <ConcurrentSubAgentBlock blocks={item.blocks} columns={Math.max(1, columns)} />
                  </Box>
                );
              }
              return (
                <BlockRenderer
                  key={`${renderEpoch}:${blockRenderCacheKey(timelineBlock(item))}`}
                  item={item}
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
                key={`${renderEpoch}:subagent-group-${item.id}`}
                flexDirection="column"
                marginTop={prevBlock ? 1 : 0}
              >
                <ConcurrentSubAgentBlock
                  blocks={item.blocks}
                  columns={Math.max(1, columns)}
                  maxVisibleSteps={maxVisibleSubagentSteps}
                  maxVisibleChildren={Math.max(
                    0,
                    Math.floor(
                      (Math.floor(rows ?? 24) - DYNAMIC_CHROME_ROWS - 3 - topMarginRows) / 2,
                    ),
                  )}
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
              key={`${renderEpoch}:${item.id}`}
              item={item}
              isFocused={false}
              index={i}
              prevBlock={prevBlock}
              awaitingApproval={awaitingApproval}
              awaitingInput={awaitingInput}
              columns={innerColumns}
              maxVisibleSubagentSteps={
                timelineBlock(item).kind === 'subagent' ? maxVisibleSubagentSteps : undefined
              }
            />
          );
        })}
        {compactionPhase && <CompactionProgress phase={compactionPhase} />}
      </Box>
    </Box>
  );
}

export default React.memo(OutputArea);
