import { Box, Text } from 'ink';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { useTheme } from '../theme';
import type { ConsolidatedToolEntry, OutputBlock } from '../types';
import {
  actionName,
  formatElapsed,
  formatReadFileRange,
  SPINNER,
  SPINNER_INTERVAL_MS,
  toolColor,
} from './render-utils';

// ══════════════════════════════════════════════════════════════════
// SpinnerDot — 独立组件，隔离 spinner 状态更新
//
// 把 spinner 抽离为独立组件是最关键的渲染性能优化。
// 父组件 ToolSummaryBlock 的 props（block, columns）在 spinner tick
// 之间不变 → React 跳过父组件重渲染 → Ink 只输出变化的 spinner 字符，
// 不触发整个 Thought 树（15+ Yoga 布局节点）的 diff/layout/write。
//
// SpinnerDot isolates spinner state so tick updates don't cascade into
// the parent ToolSummaryBlock re-render. When parent props are stable,
// React skips the parent tree entirely — Ink only writes the single
// changed spinner glyph, not the full Thought tree (15+ Yoga nodes).
// ══════════════════════════════════════════════════════════════════

function SpinnerDot({ active }: { active: boolean }) {
  const [idx, setIdx] = useState(0);
  const startRef = useRef(Date.now());
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
    if (active) startRef.current = Date.now();
    else setIdx(0);
  }, [active]);

  useEffect(() => {
    const tick = () => {
      if (!activeRef.current) return;
      setIdx(Math.floor((Date.now() - startRef.current) / 80) % SPINNER.length);
    };
    const timer = setInterval(tick, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return <Text>{SPINNER[idx]!} </Text>;
}

/** 工具步骤折叠阈值：超过此行数的 Thought 只展示最后 N 步，其余折叠。
 *  同时作用于 running 和 settled 状态——避免 settled 后在 scrollback 中刷屏。 */
const MAX_VISIBLE_STEPS = 5;

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

// ══════════════════════════════════════════════════════════════════
// StepRow — 单条工具步骤，memo 隔离
//
// 提取为独立 memo 组件是最关键的工具树渲染性能优化。
// 当新工具 push 到 tools 数组时，只有 <StepRow key={新callId}>
// 是新 key → React 创建新实例；已有 key 的 StepRow props 未变 →
// memo 跳过渲染。每个 step 的 stringWidth / truncateToFit 不会被
// 无意义地重复执行。
//
// StepRow is memo'd to skip re-render when parent re-renders due to
// a new tool push. Only the new key mounts; existing keys bail out.
// ══════════════════════════════════════════════════════════════════

interface StepRowProps {
  step: ConsolidatedToolEntry;
  connector: string;
  col: number;
  dt: ReturnType<typeof useTheme>;
}

const StepRow = memo(function StepRow({ step, connector, col, dt }: StepRowProps) {
  const isError = step.status === 'error' || step.status === 'exhausted';
  const lineColor = isError ? dt.error : dt.dim;
  const rawLabel = toolArgsLabel(step.name, step.args, step.totalLines);
  const stepPreW = stringWidth(`${connector}${actionName(step.name)}`);
  const errSummary = failureSummary(step, 32);
  const stepSufW = isError ? stringWidth(errSummary) + 1 : 0;
  const fitLabel = rawLabel
    ? truncateToFit(rawLabel, Math.max(0, col - 3 - stepPreW - stepSufW - 2))
    : null;

  return (
    <Box paddingLeft={3}>
      <Text color={lineColor}>{connector}</Text>
      <Text>{actionName(step.name)}</Text>
      {fitLabel && <Text color={lineColor}> {fitLabel}</Text>}
      {step.status === 'queued' && <Text color={dt.muted}> queued</Text>}
      {step.status === 'running' && <Text color={dt.warning}> …</Text>}
      {isError && errSummary && <Text color={dt.error}> {errSummary}</Text>}
    </Box>
  );
});

// ══════════════════════════════════════════════════════════════════
// ThinkingLine — 思考预览行，嵌在工具树底部
//
// 展示模型当前最新的思考内容（reason 文本），与工具步骤同缩进层级，
// 作为树的一部分而非置顶独立行。仅 running 态渲染。
// ══════════════════════════════════════════════════════════════════

function ThinkingLine({ text, col }: { text: string; col: number }) {
  const dt = useTheme();
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return (
    <Box paddingLeft={3}>
      <Text color={dt.dim}>├─ </Text>
      <Text color={dt.muted}>{truncateToFit(`Thinking ${trimmed}`, Math.max(0, col - 9))}</Text>
    </Box>
  );
}

export default memo(function ToolSummaryBlock({ block, columns }: ToolSummaryBlockProps) {
  const dt = useTheme();
  const col = columns > 0 ? columns : (process.stdout.columns ?? 80);

  // ── Derived booleans (memoized to avoid re-scanning tools array on every render) ──
  const { hasPendingTools, hasError, isRunning } = useMemo(() => {
    let pending = false;
    let err = false;
    for (const t of block.tools) {
      if (t.status === 'queued' || t.status === 'running') pending = true;
      if (t.status === 'error' || t.status === 'exhausted' || t.status === 'timeout') err = true;
      if (pending && err) break;
    }
    return { hasPendingTools: pending, hasError: err, isRunning: block.active };
  }, [block.active, block.tools]);

  const elapsedMs = block.totalElapsedMs;
  const elapsedStr = formatElapsed(elapsedMs);
  const summaryLine = block.summaryLine;

  // ── 折叠逻辑（running / settled 两态共享）──
  const steps = block.tools;
  const stepCount = steps.length;
  const visibleSteps = useMemo(
    () => (stepCount > MAX_VISIBLE_STEPS ? steps.slice(-MAX_VISIBLE_STEPS) : steps),
    [stepCount, steps],
  );
  const skipped = Math.max(0, stepCount - MAX_VISIBLE_STEPS);
  const hasSkipped = skipped > 0;

  // ── Summary label ──
  const hasThink = block.hasThinking === true;
  const hasTools = block.tools.length > 0;
  const summaryLabel = hasThink
    ? hasTools
      ? `Thought for ${elapsedStr}, ${summaryLine}`
      : `Thought for ${elapsedStr}`
    : hasTools
      ? summaryLine
      : `Thought for ${elapsedStr}`;

  // ── 两态差异：footer / dot / connector ──
  const settledStatus = isRunning
    ? null
    : hasError
      ? 'error'
      : hasPendingTools
        ? 'cancelled'
        : 'done';
  const doneColor = settledStatus ? toolColor(settledStatus, dt) : undefined;
  const footer = isRunning
    ? `运行中 (${elapsedStr})`
    : settledStatus === 'error'
      ? '部分失败'
      : settledStatus === 'cancelled'
        ? '等待工具结果'
        : '完成';

  // ── Step connector ──
  // Running: always ├─. Settled without timeline: last visible step uses └─.
  // Settled with timeline: always ├─ (thinking lines intersperse, so no tool
  // is definitively "last" — only the footer uses └─).
  const getConnector = (i: number, total: number): string => {
    if (isRunning) return '├─ ';
    if (renderedTimeline) return '├─ ';
    return !hasSkipped && i === total - 1 ? '└─ ' : '├─ ';
  };

  // ── 时间线渲染：按 seq 顺序交错工具步骤与思考行 ──
  const renderedTimeline = useMemo(() => {
    const timeline = block.timeline;
    if (!timeline || timeline.length === 0) return null; // legacy fallback

    const toolIdx = new Map<string, number>();
    for (let i = 0; i < steps.length; i++) toolIdx.set(steps[i]!.callId, i);
    const vStart = Math.max(0, stepCount - MAX_VISIBLE_STEPS);

    // seq of the first visible tool
    let firstVisSeq = Infinity;
    for (const e of timeline) {
      if (e.kind === 'tool' && e.callId) {
        const i = toolIdx.get(e.callId);
        if (i != null && i >= vStart && e.seq < firstVisSeq) firstVisSeq = e.seq;
      }
    }

    // Expand visibility window backward to include any thinking entry
    // that immediately precedes the first visible tool.
    let includeFromSeq = firstVisSeq;
    if (firstVisSeq !== Infinity) {
      for (const e of timeline) {
        if (e.seq === firstVisSeq - 1 && e.kind === 'thinking') {
          includeFromSeq = firstVisSeq - 1;
          break;
        }
      }
    }

    type Item =
      | { kind: 'tool'; step: ConsolidatedToolEntry; idx: number }
      | { kind: 'thinking'; text: string };

    const items: Item[] = [];
    for (const e of timeline) {
      if (includeFromSeq !== Infinity && e.seq < includeFromSeq) continue;
      if (e.kind === 'tool' && e.callId) {
        const i = toolIdx.get(e.callId);
        if (i != null && i >= vStart) items.push({ kind: 'tool', step: steps[i]!, idx: i });
      } else if (e.kind === 'thinking' && e.text) {
        items.push({ kind: 'thinking', text: e.text });
      }
    }
    return items;
  }, [block.timeline, steps, stepCount]);

  // ═══════════════════════════════════════════════════════════
  // 统一渲染
  // ═══════════════════════════════════════════════════════════
  return (
    <Box flexDirection="column">
      <Box>
        {isRunning ? <SpinnerDot active={isRunning} /> : <Text color={doneColor}>● </Text>}
        <Text color={dt.dim}>{summaryLabel}</Text>
      </Box>
      {hasSkipped && (
        <Box paddingLeft={3}>
          <Text color={dt.dim}>├─ ... 以上 {skipped} 步已折叠</Text>
        </Box>
      )}
      {renderedTimeline
        ? renderedTimeline.map((item, i) => {
            if (item.kind === 'tool') {
              const connector = getConnector(i, renderedTimeline.length);
              return (
                <StepRow
                  key={item.step.callId}
                  step={item.step}
                  connector={connector}
                  col={col}
                  dt={dt}
                />
              );
            }
            // thinking line — interspersed chronologically
            return <ThinkingLine key={`think-${i}`} text={item.text} col={col} />;
          })
        : // Legacy fallback: no timeline → visibleSteps + thinking at bottom
          visibleSteps.map((step, i) => (
            <StepRow
              key={step.callId}
              step={step}
              connector={getConnector(i, visibleSteps.length)}
              col={col}
              dt={dt}
            />
          ))}
      {/* Running-only: thinking preview for legacy blocks or when timeline is empty */}
      {!renderedTimeline &&
        isRunning &&
        block.latestActivity?.kind === 'thinking' &&
        block.latestActivity.text && <ThinkingLine text={block.latestActivity.text} col={col} />}
      {/* Running-only: tool preview for legacy blocks (new tool not yet in visibleSteps) */}
      {!renderedTimeline &&
        isRunning &&
        block.latestActivity?.kind === 'tool' &&
        !visibleSteps.some(
          (s) => s.callId === (block.latestActivity as { kind: 'tool'; callId: string }).callId,
        ) && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>├─ </Text>
            <Text color={dt.muted}>{latestActivityLabel(block, Math.max(0, col - 9))}</Text>
          </Box>
        )}
      <Box paddingLeft={3}>
        <Text color={dt.dim}>└─ {footer}</Text>
      </Box>
    </Box>
  );
});
