import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import type { SubAgentRole } from '@/protocol/events';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import { formatReadFileRange, SPINNER, toolColor } from './render-utils';

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

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
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
      return typeof c === 'string' ? c.slice(0, 80) : '';
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

  // ── 计时器：useState + setInterval 由 React 批量合并，不产生重复渲染 ──
  // startedAt 存在 block 上，重挂载时 lazy init 自动恢复正确的已流逝时间。
  // Timer: useState + setInterval, batched by React — no duplicate renders.
  // startedAt lives on the block; lazy init restores correct elapsed on remount.
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [liveElapsed, setLiveElapsed] = useState(() =>
    block.status === 'running' && block.startedAt ? Date.now() - block.startedAt : 0,
  );
  const startedAtRef = useRef(block.startedAt);
  startedAtRef.current = block.startedAt;

  useEffect(() => {
    if (block.status !== 'running') return;
    const elapsedTimer = setInterval(() => {
      const at = startedAtRef.current;
      if (at != null) setLiveElapsed(Date.now() - at);
    }, 200);
    const spinnerTimer = setInterval(() => setSpinnerIdx((i) => (i + 1) % SPINNER.length), 80);
    return () => {
      clearInterval(elapsedTimer);
      clearInterval(spinnerTimer);
    };
  }, [block.status]);

  if (block.status === 'running') {
    const spinner = SPINNER[spinnerIdx];
    const stepCount = block.steps.length;
    const visibleSteps =
      stepCount > MAX_RUNNING_STEPS ? block.steps.slice(-MAX_RUNNING_STEPS) : block.steps;
    const skipped = stepCount - MAX_RUNNING_STEPS;

    const runDur = formatDuration(liveElapsed);
    const headRunBefore = stringWidth(`${spinner} ${label} · `);
    const fitRunTask = truncateToFit(taskSummary, Math.max(0, col - headRunBefore - 2));

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.warning}>{spinner} </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {fitRunTask}</Text>
        </Box>
        {skipped > 0 && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>... 以上 {skipped} 步已折叠</Text>
          </Box>
        )}
        {visibleSteps.map((step, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={dt.dim}>├─ {step.toolName}</Text>
            {step.toolArgs &&
              Object.keys(step.toolArgs).length > 0 &&
              (() => {
                const rawLabel = toolArgsLabel(step.toolName, step.toolArgs, step.totalLines);
                if (!rawLabel) return null;
                const stepPreW = stringWidth(`├─ ${step.toolName}`);
                const stepSufW = step.ok !== undefined ? 2 : 0; // " ✓" or " ✗"
                const fitLabel = truncateToFit(
                  rawLabel,
                  Math.max(0, col - 3 - stepPreW - stepSufW - 2),
                );
                return fitLabel ? <Text color={dt.muted}> {fitLabel}</Text> : null;
              })()}
            {step.ok !== undefined && (
              <Text color={step.ok ? dt.success : dt.error}> {step.ok ? '✓' : '✗'}</Text>
            )}
          </Box>
        ))}
        <Box paddingLeft={3}>
          <Text color={dt.dim}>└─ 进行中 ({runDur})</Text>
        </Box>
      </Box>
    );
  }

  // ── Settled (done, error, or cancelled): same layout as running, with final summary ──
  const settled =
    block.status === 'done' || block.status === 'error' || block.status === 'cancelled';
  if (settled) {
    const stepCount = block.steps.length;
    const visibleSteps =
      stepCount > MAX_RUNNING_STEPS ? block.steps.slice(-MAX_RUNNING_STEPS) : block.steps;
    const skipped = stepCount - MAX_RUNNING_STEPS;
    const isError = block.status === 'error';
    const isCancelled = block.status === 'cancelled';
    const doneDur = formatDuration(block.durationMs);
    const headDoneBefore = stringWidth(`● ${label} · `);
    const fitDoneTask = truncateToFit(taskSummary, Math.max(0, col - headDoneBefore - 2));

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={toolColor(block.status, dt)}>● </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {fitDoneTask}</Text>
        </Box>
        {skipped > 0 && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>... 以上 {skipped} 步已折叠</Text>
          </Box>
        )}
        {visibleSteps.map((step, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={dt.dim}>├─ {step.toolName}</Text>
            {step.toolArgs &&
              Object.keys(step.toolArgs).length > 0 &&
              (() => {
                const rawLabel = toolArgsLabel(step.toolName, step.toolArgs, step.totalLines);
                if (!rawLabel) return null;
                const stepPreW = stringWidth(`├─ ${step.toolName}`);
                const stepSufW = step.ok !== undefined ? 2 : 0; // " ✓" or " ✗"
                const fitLabel = truncateToFit(
                  rawLabel,
                  Math.max(0, col - 3 - stepPreW - stepSufW - 2),
                );
                return fitLabel ? <Text color={dt.muted}> {fitLabel}</Text> : null;
              })()}
            {step.ok !== undefined && (
              <Text color={step.ok ? dt.success : dt.error}> {step.ok ? '✓' : '✗'}</Text>
            )}
          </Box>
        ))}
        {(() => {
          if (isCancelled) {
            const cancelText = block.error || block.summary || 'Cancelled';
            const fitCancel = truncateToFit(cancelText, Math.max(0, col - 3 - 3 - 2));
            return (
              <Box paddingLeft={3}>
                <Text color={dt.dim}>└─ {fitCancel}</Text>
              </Box>
            );
          }
          if (isError) {
            const errText = block.error || 'Error';
            const fitErr = truncateToFit(errText, Math.max(0, col - 3 - 3 - 2));
            return (
              <Box paddingLeft={3}>
                <Text color={dt.error}>└─ {fitErr}</Text>
              </Box>
            );
          }
          // done — show with duration
          const doneLine = `done! (${doneDur})`;
          const fitDone = truncateToFit(doneLine, Math.max(0, col - 3 - 3 - 2));
          return (
            <Box paddingLeft={3}>
              <Text color={dt.dim}>└─ {fitDone}</Text>
            </Box>
          );
        })()}
      </Box>
    );
  }

  return null;
}
