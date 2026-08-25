import type { SubAgentRole } from '@kite-ai/runtime-contract';
import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { useTheme } from '../theme';
import type { OutputBlock, SubAgentStepRecord } from '../types';
import { actionName, formatElapsed, formatReadFileRange, SPINNER, toolColor } from './render-utils';
import { useBlinkDot } from './use-blink-dot';

export function roleLabel(role: SubAgentRole): string {
  switch (role) {
    case 'explore':
      return 'Explore';
    case 'plan':
      return 'Plan';
    case 'code':
      return 'Code';
    case 'review':
      return 'Review';
    default:
      return role;
  }
}
/** 将文本截断到指定宽度，超出部分用 "…" 替代。
 *  Truncate text to fit within maxWidth columns, appending "…" if truncated. */
export function truncateToFit(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const w = stringWidth(text);
  if (w <= maxWidth) return text;
  const target = maxWidth - 1; // reserve 1 column for "…"
  if (target <= 0) return '';
  let result = '';
  let cw = 0;
  for (const ch of text) {
    const chW = stringWidth(ch);
    if (cw + chW > target) break;
    result += ch;
    cw += chW;
  }
  return `${result}…`;
}

/** Extract human-readable label from tool args */
function toolArgsLabel(name: string, args: Record<string, unknown>, totalLines?: number): string {
  switch (name) {
    case 'read_file': {
      const p = args.path;
      const filename = typeof p === 'string' ? p.replace(/^.*[/\\]/, '').slice(-50) : '';
      const range = formatReadFileRange(args, totalLines);
      return `${filename}${range}`;
    }
    case 'edit_file':
    case 'write_file': {
      const p = args.path;
      return typeof p === 'string' ? p.replace(/^.*[/\\]/, '').slice(-50) : '';
    }
    case 'shell_execute':
    case 'bash': {
      const c = args.command;
      if (typeof c !== 'string') return '';
      const firstLine = c.split('\n')[0]!;
      return firstLine.slice(0, 80);
    }
    case 'grep': {
      const q = args.pattern ?? args.query;
      return typeof q === 'string' ? `"${q.slice(0, 60)}"` : '';
    }
    case 'glob': {
      const p = args.pattern;
      return typeof p === 'string' ? p.slice(0, 60) : '';
    }
    case 'read_mcp_resource': {
      const u = args.uri ?? args.resource;
      return typeof u === 'string' ? u.slice(0, 60) : '';
    }
    case 'ask_user': {
      const q = args.question;
      const firstLine = typeof q === 'string' ? q.split('\n')[0]! : '';
      return firstLine.slice(0, 60);
    }
    default: {
      // pick first string arg that isn't obviously content
      const keys = Object.keys(args);
      if (keys.length === 1) {
        const v = args[keys[0]!];
        return typeof v === 'string' ? v.slice(0, 60) : '';
      }
      const labelKey = keys.find((k) =>
        ['path', 'name', 'command', 'pattern', 'query', 'url', 'uri'].includes(k),
      );
      if (labelKey) {
        const v = args[labelKey];
        return typeof v === 'string' ? v.slice(0, 60) : '';
      }
      return '';
    }
  }
}

/** One-line representation of a child tool invocation shared by compact and expanded cards. */
export function subagentStepLabel(step: SubAgentStepRecord): string {
  const argsLabel =
    step.toolArgs && Object.keys(step.toolArgs).length > 0
      ? toolArgsLabel(step.toolName, step.toolArgs, step.totalLines)
      : '';
  return `${actionName(step.toolName)}${argsLabel ? ` ${argsLabel}` : ''}`;
}

/**
 * Light cleanup for single-line task display — strip leading markdown heading markers.
 */
function cleanTaskText(text: string): string {
  return text.replace(/^#+\s*/, '').trim();
}

/** Bound the explicit public sub-agent name for compact display. */
export function taskLabel(task: string): string {
  const plain = cleanTaskText(task).replace(/\s+/gu, ' ');
  return plain.length > 80 ? `${plain.slice(0, 77)}...` : plain;
}

export const MAX_RUNNING_STEPS = 5;

interface SubAgentBlockProps {
  block: OutputBlock & { kind: 'subagent' };
  /** Available columns from the owning layout; defaults to the real terminal width. */
  columns?: number;
  /**
   * Dynamic OutputArea may lower this while several child cards are live so
   * Ink never crosses its full-screen clear threshold. Standalone/static cards
   * keep the normal five-step tail.
   */
  maxVisibleSteps?: number;
}

export default function SubAgentBlock({
  block,
  columns,
  maxVisibleSteps = MAX_RUNNING_STEPS,
}: SubAgentBlockProps) {
  const dt = useTheme();
  const label = roleLabel(block.role);
  const taskSummary = taskLabel(block.task);
  const col = columns ?? process.stdout.columns ?? 80;

  // ── 闪烁圆点：统一 hook ──
  const spinnerActive = block.status === 'running' && !block.awaitingApproval;
  const spinnerFrame = useBlinkDot(spinnerActive);

  // ── 计时器：ref 驱动，基于绝对时间，免疫重复渲染 ──
  const [liveElapsed, setLiveElapsed] = useState(() =>
    block.status === 'running' && block.startedAt ? Date.now() - block.startedAt : 0,
  );
  const startedAtRef = useRef(block.startedAt);
  startedAtRef.current = block.startedAt;

  useEffect(() => {
    // 只有子 agent 真正执行时才计时。等待审批、done/error/cancelled
    // 状态下输出不依赖 liveElapsed，继续跑定时器只会每 200ms 触发
    // 一次组件重渲染，驱动整个 TUI 持续刷新。
    if (block.status !== 'running' || block.awaitingApproval) return;
    const timer = setInterval(() => {
      const at = startedAtRef.current;
      if (at != null) setLiveElapsed(Date.now() - at);
    }, 200);
    return () => clearInterval(timer);
  }, [block.status, block.awaitingApproval]);

  // ── Status flags ──
  const isRunning = block.status === 'running';
  const isSuspended = block.status === 'suspended';
  const isActive = isRunning || isSuspended;
  const isError = block.status === 'error';
  const isCancelled = block.status === 'cancelled';
  const isSettled = isError || isCancelled || block.status === 'done';
  const approvalState =
    block.approvalState ??
    (block.awaitingApproval || isSuspended ? ('awaiting_user' as const) : undefined);
  const isWaiting = approvalState != null;

  if (!isActive && !isSettled) return null;

  // ── Common: steps ──
  const stepCount = block.steps.length;
  const visibleStepLimit = Math.max(0, Math.floor(maxVisibleSteps));
  const visibleSteps =
    stepCount > visibleStepLimit
      ? visibleStepLimit === 0
        ? []
        : block.steps.slice(-visibleStepLimit)
      : block.steps;
  const skipped = stepCount - visibleSteps.length;

  // ── Header ──
  const icon = isActive ? (isWaiting ? '○ ' : spinnerFrame) : '● ';
  const headBefore = stringWidth(`${isActive ? SPINNER[0]! : '● '}${label} · `);
  const fitTask = truncateToFit(taskSummary, Math.max(0, col - headBefore - 2));

  // ── Footer ──
  const foot = isActive
    ? isWaiting
      ? {
          text:
            approvalState === 'auto_reviewing'
              ? '自动审查中'
              : approvalState === 'queued_auto_review'
                ? '等待自动审查'
                : approvalState === 'queued_user_approval' || approvalState === 'queued'
                  ? '人工审批排队中'
                  : '等待你的批准',
          color: approvalState === 'awaiting_user' ? dt.warning : dt.dim,
        }
      : { text: `进行中 (${formatElapsed(liveElapsed)})`, color: dt.dim }
    : isCancelled
      ? { text: 'Cancelled', color: dt.warning }
      : isError
        ? {
            text: block.failureDiagnostic
              ? `${block.error || 'Error'} [${block.failureDiagnostic.code}/${block.failureDiagnostic.stage}]`
              : block.error || 'Error',
            color: dt.error,
          }
        : { text: `done! (${formatElapsed(block.durationMs)})`, color: dt.dim };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={toolColor(block.status, dt)}>{icon}</Text>
        <Text color={dt.primary}>{label}</Text>
        <Text color={dt.muted}> · {fitTask}</Text>
      </Box>
      {skipped > 0 && (
        <Box paddingLeft={3}>
          <Text color={dt.dim}>
            {truncateToFit(`... 以上 ${skipped} 步已折叠`, Math.max(0, col - 3))}
          </Text>
        </Box>
      )}
      {visibleSteps.map((step, i) => {
        // 颜色由 step.status 唯一决定，不依赖布尔值排列组合推断
        const lineColor =
          step.status === 'error' ? dt.error : step.status === 'rejected' ? dt.warning : dt.dim;
        const line = `├─ ${subagentStepLabel(step)}`;
        return (
          <Box key={i} paddingLeft={3}>
            <Text color={lineColor}>{truncateToFit(line, Math.max(0, col - 3))}</Text>
          </Box>
        );
      })}
      <Box paddingLeft={3}>
        <Text color={foot.color}>└─ {truncateToFit(foot.text, Math.max(0, col - 3 - 3 - 2))}</Text>
      </Box>
    </Box>
  );
}
