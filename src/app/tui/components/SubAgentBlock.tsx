import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import type { SubAgentRole } from '@/protocol/events';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import { actionName, formatElapsed, formatReadFileRange, SPINNER, toolColor } from './render-utils';
import { useBlinkDot } from './use-blink-dot';

function roleLabel(role: SubAgentRole): string {
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
function truncateToFit(text: string, maxWidth: number): string {
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

/**
 * Light cleanup for single-line task display — strip leading markdown heading markers.
 */
function cleanTaskText(text: string): string {
  return text.replace(/^#+\s*/, '').trim();
}

/** Extract the first meaningful line of a task description as a readable one-liner */
function taskLabel(task: string): string {
  const lines = task.split('\n');
  // Skip leading markdown headings and blank lines to find the first content line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (!line) continue; // blank line
    if (/^#/.test(line)) {
      const content = line.replace(/^#+\s*/, '');
      if (content.length >= 15) {
        // meaningful heading like "# 背景：Kite Code 终端 TUI 应用 — 登录界面设计方案"
        const plain = content;
        return plain.length > 80 ? `${plain.slice(0, 77)}...` : plain;
      }
      // bare heading like "# Context" — skip
      continue;
    }
    // first non-heading content line
    const plain = line;
    return plain.length > 80 ? `${plain.slice(0, 77)}...` : plain;
  }
  // fallback: use first line as-is
  const first = lines[0]?.trim() ?? task;
  const plain = cleanTaskText(first);
  return plain.length > 80 ? `${plain.slice(0, 77)}...` : plain;
}

const MAX_RUNNING_STEPS = 5;

interface SubAgentBlockProps {
  block: OutputBlock & { kind: 'subagent' };
}

export default function SubAgentBlock({ block }: SubAgentBlockProps) {
  const dt = useTheme();
  const label = roleLabel(block.role);
  const taskSummary = taskLabel(block.task);
  const col = process.stdout.columns ?? 80;

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
  const isError = block.status === 'error';
  const isCancelled = block.status === 'cancelled';
  const isSettled = isError || isCancelled || block.status === 'done';
  const isWaiting = isRunning && block.awaitingApproval;

  if (!isRunning && !isSettled) return null;

  // ── Common: steps ──
  const stepCount = block.steps.length;
  const visibleSteps =
    stepCount > MAX_RUNNING_STEPS ? block.steps.slice(-MAX_RUNNING_STEPS) : block.steps;
  const skipped = stepCount - MAX_RUNNING_STEPS;

  // ── Header ──
  const icon = isRunning ? (isWaiting ? '○ ' : spinnerFrame) : '● ';
  const headBefore = stringWidth(`${isRunning ? SPINNER[0]! : '● '}${label} · `);
  const fitTask = truncateToFit(taskSummary, Math.max(0, col - headBefore - 2));

  // ── Footer ──
  const foot = isRunning
    ? isWaiting
      ? { text: '等待审批中', color: dt.dim }
      : { text: `进行中 (${formatElapsed(liveElapsed)})`, color: dt.dim }
    : isCancelled
      ? { text: 'Cancelled', color: dt.warning }
      : isError
        ? { text: block.error || 'Error', color: dt.error }
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
          <Text color={dt.dim}>... 以上 {skipped} 步已折叠</Text>
        </Box>
      )}
      {visibleSteps.map((step, i) => {
        // 颜色由 step.status 唯一决定，不依赖布尔值排列组合推断
        const lineColor =
          step.status === 'error' ? dt.error : step.status === 'rejected' ? dt.warning : dt.dim;
        return (
          <Box key={i} paddingLeft={3}>
            <Text color={lineColor}>├─ {actionName(step.toolName)}</Text>
            {step.toolArgs &&
              Object.keys(step.toolArgs).length > 0 &&
              (() => {
                const rawLabel = toolArgsLabel(step.toolName, step.toolArgs, step.totalLines);
                if (!rawLabel) return null;
                const stepPreW = stringWidth(`├─ ${actionName(step.toolName)}`);
                const fitLabel = truncateToFit(rawLabel, Math.max(0, col - 3 - stepPreW - 2));
                return fitLabel ? <Text color={lineColor}> {fitLabel}</Text> : null;
              })()}
          </Box>
        );
      })}
      <Box paddingLeft={3}>
        <Text color={foot.color}>└─ {truncateToFit(foot.text, Math.max(0, col - 3 - 3 - 2))}</Text>
      </Box>
    </Box>
  );
}
