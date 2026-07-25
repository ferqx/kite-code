import { Box, Text } from 'ink';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { useTheme } from '../theme';
import type { ConsolidatedToolEntry, OutputBlock } from '../types';
import MarkdownBlock from './MarkdownBlock';
import { actionName, formatElapsed, formatReadFileRange, toolColor } from './render-utils';

// ══════════════════════════════════════════════════════════════════
// BlinkDot — 独立组件，隔离闪烁圆点状态更新
//
// 进行中圆点为主题暗（dim，不抢眼）实心 ● 显隐闪烁（500ms 切换）：
// 隐藏帧渲染为两个空格，符号位置、宽度（2 字符）不变，无行位移。
// settle 后变为纯思考白点（muted）——"运行中暗灰闪烁、完成后白色静止"。
// 思考链与非思考链聚合共用此组件。
//
// 把圆点抽离为独立组件是最关键的渲染性能优化。
// 父组件 ToolSummaryBlock 的 props（block, columns）在闪烁之间不变
// → React 跳过父组件重渲染 → Ink 只输出变化的圆点字符，
// 不触发整个 Thought 树（15+ Yoga 布局节点）的 diff/layout/write。
//
// BlinkDot isolates the blink state so tick updates don't cascade
// into the parent ToolSummaryBlock re-render. When parent props are
// stable, React skips the parent tree entirely — Ink only writes the
// single changed dot glyph, not the full Thought tree.
// ══════════════════════════════════════════════════════════════════

/** 闪烁间隔：500ms 显/隐切换（1s 周期）/ Blink toggle interval (1s cycle) */
const DOT_BLINK_INTERVAL_MS = 500;

function BlinkDot({ active }: { active: boolean }) {
  const dt = useTheme();
  const [visible, setVisible] = useState(true);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
    if (active) setVisible(true);
  }, [active]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (activeRef.current) setVisible((v) => !v);
    }, DOT_BLINK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // 隐藏帧渲染为两个空格，与 "● " 同宽，无行位移
  // Hidden frame renders two spaces — same width as "● ", no layout shift
  return <Text color={dt.dim}>{visible ? '● ' : '  '}</Text>;
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

/** 思考块标题：`Thought for Xs`，有工具时附加 ` · <工具统计>` 后缀（规则 22）。
 *  统计后缀按可用宽度截断；放不下时整体省略后缀，不留孤悬分隔符。
 *  Thinking-block header: bare "Thought for Xs"; when tools exist, appends
 *  " · <tool stats>" truncated to fit — the suffix is dropped entirely when
 *  it doesn't fit, so no dangling separator remains (rule 22). */
function thinkingLabel(
  elapsedStr: string,
  summaryLine: string,
  hasTools: boolean,
  maxWidth: number,
): string {
  const base = `Thought for ${elapsedStr}`;
  if (!hasTools) return base;
  const prefix = `${base} · `;
  const fitted = truncateToFit(summaryLine, Math.max(0, maxWidth - stringWidth(prefix)));
  return fitted ? prefix + fitted : base;
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
  // 思考块标题 = "Thought for Xs · <工具统计>"：有工具时以 " · " 分隔附加
  // summaryLine 统计（如 "Thought for 2s · read 3 files"），随工具事件实时
  // 刷新；无工具的纯思考块保持裸 "Thought for Xs"。步骤树仍展示工具明细。
  // 非思考聚合块（无 hasThinking）保持纯工具统计标签（对应 CC 的
  // "⏺ Read N files" 聚合行，规则 20）。elapsed 为模型调用时长（规则 22）。
  // Thinking blocks render "Thought for Xs · <tool stats>" (stats from
  // summaryLine, live-updated on tool events; the step tree below keeps the
  // detail). Pure thinking without tools keeps the bare "Thought for Xs";
  // non-thinking aggregates keep the pure tool-stats label (rule 20).
  // elapsed = model-call duration (rule 22). col-2 扣除圆点列宽。
  const hasThink = block.hasThinking === true;
  const hasTools = block.tools.length > 0;
  const summaryLabel = hasThink
    ? thinkingLabel(elapsedStr, summaryLine, hasTools, col - 2)
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
  // thinking 条目仅运行态渲染；settle 后只剩工具步骤（历史不保留 thinking 预览）。
  // Thinking entries render only while active; settled blocks keep tool steps only
  // (thinking previews are not retained in history).
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
    // that immediately precedes the first visible tool (running state only —
    // settled blocks don't render thinking entries at all).
    let includeFromSeq = firstVisSeq;
    if (block.active && firstVisSeq !== Infinity) {
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
      } else if (e.kind === 'thinking' && e.text && block.active) {
        items.push({ kind: 'thinking', text: e.text });
      }
    }
    return items;
  }, [block.timeline, block.active, steps, stepCount]);

  // ── ADR-0030 / 规则 24：块顶旁白字幕 ──
  // 已确认字幕（captions，被随后只读工具确认）按时间顺序累积；待确认字幕
  // （pendingCaption，运行态等待工具确认 / 脱离）实时附在其后。两者以
  // Markdown 渲染于标题行之下、步骤树之上，缩进与标题文字列对齐。
  // Confirmed narrations (captions) accumulate chronologically; the pending
  // caption (awaiting tool confirmation / detachment) trails them live.
  // Hook 必须置于所有早退之前（rules-of-hooks）。
  const captionContent = useMemo(() => {
    const parts = [
      ...(block.captions ?? []),
      ...(block.pendingCaption ? [block.pendingCaption] : []),
    ];
    return parts.length > 0 ? parts.join('\n\n') : '';
  }, [block.captions, block.pendingCaption]);

  // ── 纯思考块 settle 后：单行 "Thought for Xs"（无圆点、无步骤树/footer）──
  // ● 保留给"有状态"的行（运行态闪烁点 / 工具块绿红黄完成点）；纯思考
  // settle 后没有状态可传达，不渲染圆点，但保留两个空格列位，使文字起始
  // 列与工具块名字列对齐。
  // 置于所有 hook 之后，保证 hook 调用顺序稳定（rules-of-hooks）。
  // ── Pure-thinking block settled: single line, no dot — ● is reserved for
  // stateful rows (running blink / tool outcome colors); a settled pure
  // thought carries no status. Two leading spaces keep the label aligned
  // with tool-block names. Placed after all hooks (rules-of-hooks).
  if (!isRunning && stepCount === 0) {
    return (
      <Box>
        {/* 两个空格列位 = 圆点列宽（"● "），文字起始列与工具块名字列对齐（规则 19） */}
        <Text color={dt.dim}>{`  ${summaryLabel}`}</Text>
      </Box>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 统一渲染
  // ═══════════════════════════════════════════════════════════
  return (
    <Box flexDirection="column">
      <Box>
        {isRunning ? <BlinkDot active={isRunning} /> : <Text color={doneColor}>● </Text>}
        <Text color={dt.dim}>{summaryLabel}</Text>
      </Box>
      {captionContent !== '' && (
        <Box paddingLeft={2}>
          <MarkdownBlock content={captionContent} streaming={false} maxWidth={col - 2} />
        </Box>
      )}
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
