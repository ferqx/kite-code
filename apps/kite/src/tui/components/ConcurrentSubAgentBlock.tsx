import { Box, Text } from 'ink';
import { memo, useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import { formatElapsed } from './render-utils';
import SubAgentBlock, {
  MAX_RUNNING_STEPS,
  roleLabel,
  subagentStepLabel,
  taskLabel,
  truncateToFit,
} from './SubAgentBlock';
import { useBlinkDot } from './use-blink-dot';

type SubagentBlock = Extract<OutputBlock, { kind: 'subagent' }>;

interface ConcurrentSubAgentBlockProps {
  blocks: SubagentBlock[];
  columns: number;
  maxVisibleSteps?: number;
  maxVisibleChildren?: number;
  allowExpanded?: boolean;
}

function isActive(block: SubagentBlock): boolean {
  return block.status === 'running' || block.status === 'suspended';
}

function childStatus(
  block: SubagentBlock,
  now: number,
): {
  text: string;
  tone: 'dim' | 'warning' | 'error';
} {
  const approvalState =
    block.approvalState ??
    (block.awaitingApproval || block.status === 'suspended' ? 'awaiting_user' : undefined);
  if (approvalState === 'auto_reviewing') return { text: '自动审查中', tone: 'dim' };
  if (approvalState === 'queued') return { text: '等待自动审查', tone: 'dim' };
  if (approvalState === 'awaiting_user') return { text: '等待你的批准', tone: 'warning' };
  if (block.status === 'running') {
    const elapsed = block.startedAt == null ? '' : ` (${formatElapsed(now - block.startedAt)})`;
    return { text: `进行中${elapsed}`, tone: 'dim' };
  }
  if (block.status === 'done') return { text: 'succeeded', tone: 'dim' };
  if (block.status === 'cancelled') return { text: 'Cancelled', tone: 'warning' };
  return { text: block.error || 'Error', tone: 'error' };
}

function currentToolLabel(block: SubagentBlock): string {
  let currentStep: SubagentBlock['steps'][number] | undefined;
  for (let index = block.steps.length - 1; index >= 0; index--) {
    const step = block.steps[index]!;
    if (step.status === 'pending' || step.status === 'awaiting_approval') {
      currentStep = step;
      break;
    }
  }
  if (currentStep) return subagentStepLabel(currentStep);
  if (block.status === 'done') return '已完成';
  if (block.status === 'error') return '已停止';
  if (block.status === 'cancelled') return '已取消';
  return block.steps.length === 0 ? '等待第一个工具调用' : '等待下一步';
}

function summarySuffix(blocks: SubagentBlock[]): string {
  const done = blocks.filter((block) => block.status === 'done').length;
  const failed = blocks.filter((block) => block.status === 'error').length;
  const cancelled = blocks.filter((block) => block.status === 'cancelled').length;
  const parts = [
    done > 0 ? `${done} succeeded` : '',
    failed > 0 ? `${failed} failed` : '',
    cancelled > 0 ? `${cancelled} cancelled` : '',
  ].filter(Boolean);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

/**
 * A concurrent sibling batch is one mutable presentation unit. The compact
 * view mirrors Thought: one stable header plus one activity row per child,
 * while Enter can still reveal the original per-child tool tails.
 */
const ConcurrentSubAgentBlock = memo(function ConcurrentSubAgentBlock({
  blocks,
  columns,
  maxVisibleSteps = MAX_RUNNING_STEPS,
  maxVisibleChildren = blocks.length,
  allowExpanded = true,
}: ConcurrentSubAgentBlockProps) {
  const dt = useTheme();
  const active = blocks.some(isActive);
  const waitingOnly =
    active &&
    blocks.every(
      (block) => !isActive(block) || block.awaitingApproval || block.status === 'suspended',
    );
  const spinnerFrame = useBlinkDot(active && !waitingOnly);
  const expanded = active && allowExpanded && blocks.some((block) => block.expanded === true);
  const earliestStartedAt = blocks.reduce<number | undefined>((earliest, block) => {
    if (block.startedAt == null) return earliest;
    return earliest == null ? block.startedAt : Math.min(earliest, block.startedAt);
  }, undefined);
  const startedAtRef = useRef(earliestStartedAt);
  startedAtRef.current = earliestStartedAt;
  const [liveElapsed, setLiveElapsed] = useState(() =>
    active && earliestStartedAt != null ? Date.now() - earliestStartedAt : 0,
  );

  useEffect(() => {
    if (!active || waitingOnly) return;
    const timer = setInterval(() => {
      const at = startedAtRef.current;
      if (at != null) setLiveElapsed(Date.now() - at);
    }, 200);
    return () => clearInterval(timer);
  }, [active, waitingOnly]);

  const icon = active ? (waitingOnly ? '○ ' : spinnerFrame) : '● ';
  const title = active ? 'Delegating' : 'Delegated';
  const terminalDuration = (() => {
    const starts = blocks.map((block) => block.startedAt).filter((value) => value != null);
    if (starts.length !== blocks.length) {
      return Math.max(0, ...blocks.map((block) => block.durationMs));
    }
    const earliest = Math.min(...starts);
    const latest = Math.max(
      ...blocks.map((block) => (block.startedAt ?? earliest) + block.durationMs),
    );
    return Math.max(0, latest - earliest);
  })();
  const elapsed = active
    ? ` · ${formatElapsed(liveElapsed)}`
    : ` · ${formatElapsed(terminalDuration)}`;
  const header = truncateToFit(
    `${title} · ${blocks.length} agents${summarySuffix(blocks)}${elapsed}`,
    Math.max(0, columns - 2),
  );
  const visibleChildLimit = Math.max(0, Math.floor(maxVisibleChildren));
  const skippedChildren = Math.max(0, blocks.length - visibleChildLimit);
  const visibleChildren =
    skippedChildren > 0
      ? visibleChildLimit === 0
        ? []
        : blocks.slice(-(visibleChildLimit > 1 ? visibleChildLimit - 1 : visibleChildLimit))
      : blocks;

  return (
    <Box flexDirection="column">
      <Box>
        <Text
          color={
            active
              ? dt.primary
              : blocks.some((block) => block.status === 'error')
                ? dt.error
                : dt.success
          }
        >
          {icon}
        </Text>
        <Text color={active ? dt.primary : dt.dim}>{header}</Text>
      </Box>
      {expanded ? (
        <Box flexDirection="column" paddingLeft={2}>
          {blocks.map((block) => (
            <SubAgentBlock
              key={block.subagentId}
              block={block}
              columns={Math.max(1, columns - 2)}
              maxVisibleSteps={maxVisibleSteps}
            />
          ))}
        </Box>
      ) : active ? (
        <>
          {skippedChildren > 0 && visibleChildLimit > 1 && (
            <Box paddingLeft={3}>
              <Text color={dt.dim}>
                {truncateToFit(`… ${skippedChildren} agents folded`, Math.max(0, columns - 3))}
              </Text>
            </Box>
          )}
          {visibleChildren.map((block, index) => {
            const status = childStatus(block, Date.now());
            const label = roleLabel(block.role);
            const branch = index === 0 ? '└─ ' : '   ';
            const nestedBranch = '   └─ ';
            const line = truncateToFit(
              `${label} · ${taskLabel(block.task)} · ${status.text}`,
              Math.max(0, columns - 6),
            );
            const color =
              status.tone === 'error' ? dt.error : status.tone === 'warning' ? dt.warning : dt.dim;
            const currentTool = truncateToFit(currentToolLabel(block), Math.max(0, columns - 9));
            return (
              <Box key={block.subagentId} flexDirection="column" paddingLeft={3}>
                <Box>
                  <Text color={dt.dim}>{branch}</Text>
                  <Text color={color}>{line}</Text>
                </Box>
                <Box>
                  <Text color={dt.dim}>{nestedBranch}</Text>
                  <Text color={dt.dim}>{currentTool}</Text>
                </Box>
              </Box>
            );
          })}
        </>
      ) : null}
    </Box>
  );
});

export default ConcurrentSubAgentBlock;
