import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import { actionName, formatReadFileRange, SPINNER, toolColor } from './render-utils';

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

interface ToolSummaryBlockProps {
  block: Extract<OutputBlock, { kind: 'tool_summary' }>;
  columns: number;
}

export default function ToolSummaryBlock({ block, columns }: ToolSummaryBlockProps) {
  const dt = useTheme();
  const col = columns > 0 ? columns : (process.stdout.columns ?? 80);

  const isRunning = block.tools.some((t) => t.status === 'running');
  const hasError = block.tools.some((t) => t.status === 'error');

  // ── 计时器 / Live timer ──
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [liveElapsed, setLiveElapsed] = useState(() =>
    isRunning && block.createdAt ? Date.now() - block.createdAt : block.totalElapsedMs,
  );
  const createdAtRef = useRef(block.createdAt);
  createdAtRef.current = block.createdAt;

  useEffect(() => {
    if (!isRunning) return;
    const elapsedTimer = setInterval(() => {
      const at = createdAtRef.current;
      if (at) setLiveElapsed(Date.now() - at);
    }, 200);
    const spinnerTimer = setInterval(() => setSpinnerIdx((i) => (i + 1) % SPINNER.length), 80);
    return () => {
      clearInterval(elapsedTimer);
      clearInterval(spinnerTimer);
    };
  }, [isRunning]);

  // Running: live counter; Settled: snapshot at transition moment
  const [finalElapsed, setFinalElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning && block.createdAt) {
      setFinalElapsed(Date.now() - block.createdAt);
    }
  }, [isRunning, block.createdAt]);
  const elapsedMs = isRunning
    ? liveElapsed
    : finalElapsed > 0
      ? finalElapsed
      : block.totalElapsedMs;
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
    const dot = spinner;
    const dotColor = dt.warning;

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dotColor}>{dot} </Text>
          <Text color={dt.dim}>
            Thought for {elapsedStr}, {summaryLine}
          </Text>
        </Box>
        {skipped > 0 && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>... 以上 {skipped} 步已折叠</Text>
          </Box>
        )}
        {visibleSteps.map((step, i) => (
          <Box key={step.callId} paddingLeft={3}>
            <Text color={dt.dim}>
              {i === visibleSteps.length - 1 && skipped === 0 ? '└─' : '├─'} {actionName(step.name)}
            </Text>
            {(() => {
              const rawLabel = toolArgsLabel(step.name, step.args);
              if (!rawLabel) return null;
              const stepPreW = stringWidth(
                `${i === visibleSteps.length - 1 && skipped === 0 ? '└─' : '├─'} ${actionName(step.name)}`,
              );
              const errSummary = failureSummary(step, 32);
              const stepSufW = step.status !== 'running' ? 2 + stringWidth(errSummary) + 1 : 0;
              const fitLabel = truncateToFit(
                rawLabel,
                Math.max(0, col - 3 - stepPreW - stepSufW - 2),
              );
              return fitLabel ? <Text color={dt.muted}> {fitLabel}</Text> : null;
            })()}
            {step.status === 'done' && <Text color={dt.success}> ✓</Text>}
            {step.status === 'error' && <Text color={dt.error}> ✗</Text>}
            {step.status === 'error' && failureSummary(step, 32) && (
              <Text color={dt.muted}> {failureSummary(step, 32)}</Text>
            )}
          </Box>
        ))}
        <Box paddingLeft={3}>
          <Text color={dt.dim}>└─ 运行中 ({elapsedStr})</Text>
        </Box>
      </Box>
    );
  }

  // ── Settled state (done / error / cancelled) ──
  const settledStatus = hasError ? 'error' : 'done';
  const doneColor = toolColor(settledStatus, dt);

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
        return (
          <Box key={step.callId} paddingLeft={3}>
            <Text color={dt.dim}>
              {isLast ? '└─' : '├─'} {actionName(step.name)}
            </Text>
            {(() => {
              const rawLabel = toolArgsLabel(step.name, step.args);
              if (!rawLabel) return null;
              const stepPreW = stringWidth(`${isLast ? '└─' : '├─'} ${step.name}`);
              const errSummary = failureSummary(step, 32);
              const stepSufW = step.ok !== undefined ? 2 + stringWidth(errSummary) + 1 : 0;
              const fitLabel = truncateToFit(
                rawLabel,
                Math.max(0, col - 3 - stepPreW - stepSufW - 2),
              );
              return fitLabel ? <Text color={dt.muted}> {fitLabel}</Text> : null;
            })()}
            {step.status === 'done' && <Text color={dt.success}> ✓</Text>}
            {step.status === 'error' && <Text color={dt.error}> ✗</Text>}
            {step.status === 'error' && failureSummary(step, 32) && (
              <Text color={dt.muted}> {failureSummary(step, 32)}</Text>
            )}
          </Box>
        );
      })}
      <Box paddingLeft={3}>
        <Text color={dt.dim}>└─ {hasError ? '部分失败' : '完成'}</Text>
      </Box>
    </Box>
  );
}
