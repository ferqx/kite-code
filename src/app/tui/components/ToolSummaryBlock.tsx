import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import {
  actionName,
  formatReadFileRange,
  SPINNER,
  SPINNER_INTERVAL_MS,
  toolColor,
} from './render-utils';

const MAX_RUNNING_STEPS = 5;

/** 提取工具参数的可读标签，对齐 SubAgentBlock.toolArgsLabel */
function toolArgsLabel(name: string, args: Record<string, unknown>, totalLines?: number): string {
  switch (name) {
    case 'read_file': {
      const p = args.path;
      const filename = typeof p === 'string' ? p.replace(/^.*[/\\]/, '').slice(-50) : '';
      const range = formatReadFileRange(args, totalLines);
      return `${filename}${range}`;
    }
    case 'search_content': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      const glob = typeof args.glob === 'string' ? ` [${args.glob}]` : '';
      const path = typeof args.path === 'string' ? ` → ${args.path}` : '';
      return `"${pattern.slice(0, 60)}"${glob}${path}`;
    }
    case 'search_files': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      const path = typeof args.path === 'string' ? ` in ${args.path}` : '';
      return `${pattern.slice(0, 60)}${path}`;
    }
    case 'shell_execute':
    case 'bash': {
      const c = args.command;
      return typeof c === 'string' ? c.slice(0, 80) : '';
    }
    case 'read_mcp_resource': {
      const u = args.uri ?? args.resource;
      return typeof u === 'string' ? u.slice(0, 60) : '';
    }
    default: {
      const keys = Object.keys(args);
      if (keys.length === 1) {
        const v = args[keys[0]!];
        return typeof v === 'string' ? v.slice(0, 60) : '';
      }
      return '';
    }
  }
}

/** 格式化耗时 / Format elapsed time. Minimum 1s. */
function formatDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/** 截断文本到指定宽度 / Truncate text to fit within maxWidth */
function truncateToFit(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const w = stringWidth(text);
  if (w <= maxWidth) return text;
  const target = maxWidth - 1;
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

function failureSummary(step: { status: string; summary: string }, maxWidth: number): string {
  if (step.status !== 'error' || !step.summary.trim()) return '';
  return truncateToFit(step.summary.replace(/\s+/g, ' ').trim(), maxWidth);
}

function latestActivityLabel(
  block: Extract<OutputBlock, { kind: 'tool_summary' }>,
  maxWidth: number,
): string {
  const activity = block.latestActivity;
  if (!activity) return '';
  if (activity.kind === 'thinking') {
    return truncateToFit(`Thinking ${activity.text.replace(/\s+/g, ' ').trim()}`, maxWidth);
  }
  const step = block.tools.find((t) => t.callId === activity.callId);
  if (!step) return '';
  const args = toolArgsLabel(step.name, step.args, step.totalLines);
  const label = args ? `${actionName(step.name)} ${args}` : actionName(step.name);
  return truncateToFit(label, maxWidth);
}

interface ToolSummaryBlockProps {
  block: Extract<OutputBlock, { kind: 'tool_summary' }>;
  columns: number;
}

export default function ToolSummaryBlock({ block, columns }: ToolSummaryBlockProps) {
  const dt = useTheme();
  const col = columns > 0 ? columns : (process.stdout.columns ?? 80);

  const hasPendingTools = block.tools.some((t) => t.status === 'running');
  const isRunning = block.active;
  const hasError = block.tools.some((t) => t.status === 'error');

  // ── 计时器：ref 驱动，基于绝对时间，免疫重复渲染 ──
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [liveElapsed, setLiveElapsed] = useState(() =>
    isRunning && block.createdAt ? Date.now() - block.createdAt : block.totalElapsedMs,
  );
  const createdAtRef = useRef(block.createdAt);
  createdAtRef.current = block.createdAt;

  const spinnerStartRef = useRef(Date.now());
  const spinnerRunningRef = useRef(false);

  useEffect(() => {
    spinnerRunningRef.current = isRunning;
    if (isRunning) spinnerStartRef.current = Date.now();
    else setSpinnerIdx(0);
  }, [isRunning]);

  // Single persistent timer — reads running state from ref, never restarts.
  useEffect(() => {
    const tick = () => {
      if (!spinnerRunningRef.current) return;
      const idx = Math.floor((Date.now() - spinnerStartRef.current) / 80) % SPINNER.length;
      setSpinnerIdx(idx);
    };
    const spinnerTimer = setInterval(tick, SPINNER_INTERVAL_MS);
    const elapsedTimer = setInterval(() => {
      const at = createdAtRef.current;
      if (at) setLiveElapsed(Date.now() - at);
    }, 200);
    return () => {
      clearInterval(spinnerTimer);
      clearInterval(elapsedTimer);
    };
  }, []);

  const elapsedMs = isRunning ? liveElapsed : block.totalElapsedMs;
  const elapsedStr = formatDuration(elapsedMs);
  const summaryLine = block.summaryLine;

  // ── 工具步骤列表 / Tool steps ──
  const steps = block.tools;
  const stepCount = steps.length;
  const visibleSteps =
    isRunning && stepCount > MAX_RUNNING_STEPS ? steps.slice(-MAX_RUNNING_STEPS) : steps;
  const skipped = isRunning ? Math.max(0, stepCount - MAX_RUNNING_STEPS) : 0;

  // ── Running state ──
  if (isRunning) {
    const spinner = SPINNER[spinnerIdx]!;
    const visibleCallIds = new Set(visibleSteps.map((step) => step.callId));
    const shouldShowActivity =
      block.latestActivity?.kind === 'thinking' ||
      (block.latestActivity?.kind === 'tool' && !visibleCallIds.has(block.latestActivity.callId));
    const activityLabel = shouldShowActivity
      ? latestActivityLabel(block, Math.max(0, col - 9))
      : '';

    return (
      <Box flexDirection="column">
        <Box>
          <Text>{spinner} </Text>
          <Text color={dt.dim}>
            Thought for {elapsedStr}, {summaryLine}
          </Text>
        </Box>
        {activityLabel && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>├─ </Text>
            <Text color={dt.muted}>{activityLabel}</Text>
          </Box>
        )}
        {skipped > 0 && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>├─ ... 以上 {skipped} 步已折叠</Text>
          </Box>
        )}
        {visibleSteps.map((step) => {
          const isError = step.status === 'error';
          const lineColor = isError ? dt.error : dt.dim;
          return (
            <Box key={step.callId} paddingLeft={3}>
              <Text color={lineColor}>├─ </Text>
              <Text>{actionName(step.name)}</Text>
              {(() => {
                const rawLabel = toolArgsLabel(step.name, step.args, step.totalLines);
                if (!rawLabel) return null;
                const stepPreW = stringWidth(`├─ ${actionName(step.name)}`);
                const errSummary = failureSummary(step, 32);
                const stepSufW = isError ? stringWidth(errSummary) + 1 : 0;
                const fitLabel = truncateToFit(
                  rawLabel,
                  Math.max(0, col - 3 - stepPreW - stepSufW - 2),
                );
                return fitLabel ? <Text color={lineColor}> {fitLabel}</Text> : null;
              })()}
              {isError && failureSummary(step, 32) && (
                <Text color={dt.error}> {failureSummary(step, 32)}</Text>
              )}
            </Box>
          );
        })}
        <Box paddingLeft={3}>
          <Text color={dt.dim}>└─ 运行中 ({elapsedStr})</Text>
        </Box>
      </Box>
    );
  }

  // ── Settled state: use explicit result when available, fall back to inference ──
  const settledStatus =
    block.result ?? (hasError ? 'error' : hasPendingTools ? 'cancelled' : 'done');
  const doneColor = toolColor(settledStatus, dt);
  const footerText =
    settledStatus === 'error'
      ? '部分失败'
      : settledStatus === 'cancelled'
        ? '等待工具结果'
        : '完成';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={doneColor}>● </Text>
        <Text color={dt.dim}>
          Thought for {elapsedStr}, {summaryLine}
        </Text>
      </Box>
      {visibleSteps.map((step, i) => {
        const isLast = i === visibleSteps.length - 1;
        const isError = step.status === 'error';
        const lineColor = isError ? dt.error : dt.dim;
        return (
          <Box key={step.callId} paddingLeft={3}>
            <Text color={lineColor}>{isLast ? '└─' : '├─'} </Text>
            <Text>{actionName(step.name)}</Text>
            {(() => {
              const rawLabel = toolArgsLabel(step.name, step.args, step.totalLines);
              if (!rawLabel) return null;
              const stepPreW = stringWidth(`${isLast ? '└─' : '├─'} ${actionName(step.name)}`);
              const errSummary = failureSummary(step, 32);
              const stepSufW = isError ? stringWidth(errSummary) + 1 : 0;
              const fitLabel = truncateToFit(
                rawLabel,
                Math.max(0, col - 3 - stepPreW - stepSufW - 2),
              );
              return fitLabel ? <Text color={lineColor}> {fitLabel}</Text> : null;
            })()}
            {step.status === 'running' && <Text color={dt.warning}> …</Text>}
            {isError && failureSummary(step, 32) && (
              <Text color={dt.error}> {failureSummary(step, 32)}</Text>
            )}
          </Box>
        );
      })}
      <Box paddingLeft={3}>
        <Text color={dt.dim}>└─ {footerText}</Text>
      </Box>
    </Box>
  );
}
