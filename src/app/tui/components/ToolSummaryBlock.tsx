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
  if ((step.status !== 'error' && step.status !== 'exhausted') || !step.summary.trim()) return '';
  return truncateToFit(step.summary.replace(/\s+/g, ' ').trim(), maxWidth);
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
  const hasError = block.tools.some(
    (t) => t.status === 'error' || t.status === 'exhausted' || t.status === 'timeout',
  );

  // ── Spinner：ref 驱动，基于绝对时间，免疫重复渲染 ──
  const [spinnerIdx, setSpinnerIdx] = useState(0);

  const spinnerStartRef = useRef(Date.now());
  const spinnerRunningRef = useRef(false);

  useEffect(() => {
    spinnerRunningRef.current = isRunning;
    if (isRunning) spinnerStartRef.current = Date.now();
    else setSpinnerIdx(0);
  }, [isRunning]);

  // Single persistent spinner timer — reads running state from ref, never restarts.
  useEffect(() => {
    const tick = () => {
      if (!spinnerRunningRef.current) return;
      const idx = Math.floor((Date.now() - spinnerStartRef.current) / 80) % SPINNER.length;
      setSpinnerIdx(idx);
    };
    const timer = setInterval(tick, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // 耗时由 reducer 在每次事件（tool_done / reason / closeCurrentThought）中更新，
  // 不再依赖前端 setInterval 主动计时。
  // Elapsed is updated by the reducer on each event (tool_done / reason / closeCurrentThought),
  // removing the need for a live setInterval-based timer.
  const elapsedMs = block.totalElapsedMs;
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
    // 工具全部完成 → ●；有 pending → spinner。只取决于工具状态。
    // ● when all tools done, spinner when any pending.
    const allToolsDone = block.tools.length > 0 && !hasPendingTools;

    // ── 阶段判定：Thinking ↔ Working 交替，阶段内容不混排 ──
    // Phase: Thinking when no tools or all tools done + new thinking started;
    // Working when tools are pending / running.
    const noTools = block.tools.length === 0;
    const isThinkingPhase = noTools || (allToolsDone && block.latestActivity?.kind === 'thinking');

    // ── Top line ──
    // Thinking: just "Thought for Xs"; Working: three-state with tool summary
    const topLine = isThinkingPhase
      ? `Thought for ${elapsedStr}`
      : block.hasThought
        ? `Thought for ${elapsedStr}, ${summaryLine}`
        : summaryLine;

    // ── Spinner ──
    // ● when all tools done, or when thinking-only (no tools to spin for)
    const showDot = allToolsDone || noTools;
    const spinner = showDot ? '●' : SPINNER[spinnerIdx]!;
    const spinnerColor = showDot ? toolColor('done', dt) : undefined;

    // ── Thinking phase: top line + single-line thinking preview, no tool steps ──
    // Single-line display avoids flicker from re-wrapping incremental text.
    if (isThinkingPhase) {
      const thinkText =
        block.latestActivity?.kind === 'thinking'
          ? truncateToFit(block.latestActivity.text, Math.max(1, col - 3))
          : '';

      return (
        <Box flexDirection="column">
          <Box>
            <Text color={spinnerColor}>{spinner} </Text>
            <Text color={dt.dim}>{topLine}</Text>
          </Box>
          {thinkText && (
            <Box paddingLeft={3}>
              <Text color={dt.muted}>{thinkText}</Text>
            </Box>
          )}
        </Box>
      );
    }

    // ── Working phase: top line + tool steps, no thinking preview ──
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={spinnerColor}>{spinner} </Text>
          <Text color={dt.dim}>{topLine}</Text>
        </Box>
        {skipped > 0 && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>├─ ... 以上 {skipped} 步已折叠</Text>
          </Box>
        )}
        {visibleSteps.map((step) => {
          const isError = step.status === 'error' || step.status === 'exhausted';
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
              {(step as any).reviewFailure && (
                <Text color={dt.error}> ⚠ {(step as any).reviewFailure}</Text>
              )}
            </Box>
          );
        })}
        <Box paddingLeft={3}>
          <Text color={dt.dim}>└─ {allToolsDone ? '完成' : `运行中 (${elapsedStr})`}</Text>
        </Box>
      </Box>
    );
  }

  // ── Settled state: derive from actual tool states, not cached block.result.
  //     block.result can be stale — closeCurrentThought sets it to 'cancelled'
  //     when exploration tools are still running, but tool_done events that
  //     arrive after the thought is closed never recompute it. ──
  const settledStatus = hasError ? 'error' : hasPendingTools ? 'cancelled' : 'done';
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
          {block.tools.length === 0
            ? `Thought for ${elapsedStr}`
            : block.hasThought
              ? `Thought for ${elapsedStr}, ${summaryLine}`
              : summaryLine}
        </Text>
      </Box>
      {visibleSteps.map((step, i) => {
        const isLast = i === visibleSteps.length - 1;
        const isError = step.status === 'error' || step.status === 'exhausted';
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
            {(step as any).reviewFailure && (
              <Text color={dt.error}> ⚠ {(step as any).reviewFailure}</Text>
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
