import { Box, Text } from 'ink';
import { memo, useMemo } from 'react';
import stringWidth from 'string-width';
import { useTheme } from '../theme';
import type { ConsolidatedToolEntry, OutputBlock } from '../types';
import { activityDot } from './activity-dot';
import {
  actionName,
  formatElapsed,
  formatReadFileRange,
  writeFileActionName,
} from './render-utils';
import { wrapDisplayLines } from './soft-wrap';

// ══════════════════════════════════════════════════════════════════
// BlinkDot — 活动状态标记
//
// 进行中圆点为主题暗（dim，不抢眼）实心 ●。它保持静态，
// 只在 Runtime 事件导致真实重绘时更新，以免活动 Run 的墙钟动画持续写
// stdout，并打断原生终端的文本选择或强制 scrollback 回到底部。
//
// The small adapter keeps activity-dot semantics consistent across Thought,
// tool, and subagent views without owning a presentation timer.
// ══════════════════════════════════════════════════════════════════

function BlinkDot({ active }: { active: boolean }) {
  const dt = useTheme();
  const frame = activityDot(active);
  return <Text color={dt.dim}>{frame}</Text>;
}

/** 活动窗口正文预算：工具活动最多展示最后 N 步，reasoning 最多展示 N 行。
 *  settled Thought 只保留聚合标题，不再渲染活动窗口。 */
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

/** 思考块标题：`Thinking Xs`，有工具时附加 ` · <工具统计>` 后缀（规则 22）。
 *  统计后缀按可用宽度截断；放不下时整体省略后缀，不留孤悬分隔符。
 *  Thinking-block header: bare "Thinking Xs"; when tools exist, appends
 *  " · <tool stats>" truncated to fit — the suffix is dropped entirely when
 *  it doesn't fit, so no dangling separator remains (rule 22). */
function thinkingLabel(
  elapsedStr: string,
  summaryLine: string,
  hasTools: boolean,
  maxWidth: number,
): string {
  const base = `Thinking ${elapsedStr}`;
  if (!hasTools) return base;
  const prefix = `${base} · `;
  const fitted = truncateToFit(summaryLine, Math.max(0, maxWidth - stringWidth(prefix)));
  return fitted ? prefix + fitted : base;
}

function failureSummary(step: { status: string; summary: string }, maxWidth: number): string {
  if ((step.status !== 'error' && step.status !== 'exhausted') || !step.summary.trim()) return '';
  return truncateToFit(step.summary.replace(/\s+/g, ' ').trim(), maxWidth);
}

/** 步骤动词：write_file 按结果区分新建/覆写/追加，其余走静态映射
 *  Step verb: write_file distinguishes create/overwrite/append by result;
 *  other tools use the static ACTION_NAMES map */
function stepActionName(step: ConsolidatedToolEntry): string {
  return step.name === 'write_file'
    ? writeFileActionName(step.summary, step.args)
    : actionName(step.name);
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
  const label = args ? `${stepActionName(step)} ${args}` : stepActionName(step);
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
  const stepPreW = stringWidth(`${connector}${stepActionName(step)}`);
  const errSummary = failureSummary(step, 32);
  const stepSufW = isError ? stringWidth(errSummary) + 1 : 0;
  const fitLabel = rawLabel
    ? truncateToFit(rawLabel, Math.max(0, col - 3 - stepPreW - stepSufW - 2))
    : null;

  return (
    <Box paddingLeft={3}>
      <Text color={lineColor}>{connector}</Text>
      <Text>{stepActionName(step)}</Text>
      {fitLabel && <Text color={lineColor}> {fitLabel}</Text>}
      {step.status === 'queued' && <Text color={dt.muted}> queued</Text>}
      {step.status === 'running' && <Text color={dt.warning}> …</Text>}
      {isError && errSummary && <Text color={dt.error}> {errSummary}</Text>}
    </Box>
  );
});

// ══════════════════════════════════════════════════════════════════
// 活动 Thought 只展示最新的完整 reasoning；工具开始后由工具步骤替换，
// 后续 reasoning 再替换工具步骤。settle 后活动窗口消失。
// ══════════════════════════════════════════════════════════════════

function ThinkingWindow({ lines }: { lines: string[] }) {
  const dt = useTheme();
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={3}>
      <Box>
        <Text color={dt.dim}>└─ </Text>
        <Text color={dt.muted}>{lines[0]}</Text>
      </Box>
      {lines.slice(1).map((line, index) => (
        <Box key={`${index + 1}:${line}`} paddingLeft={3}>
          <Text color={dt.muted}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

export default memo(function ToolSummaryBlock({ block, columns }: ToolSummaryBlockProps) {
  const dt = useTheme();
  const col = columns > 0 ? columns : (process.stdout.columns ?? 80);

  const isRunning = block.active;

  // Snapshot elapsed time only on event-driven renders. Do not create a clock
  // that repaints an unchanged active Thought while the user reads scrollback.
  const liveNow = Date.now();
  const elapsedMs =
    block.liveModelStartedAt === undefined
      ? block.totalElapsedMs
      : block.totalElapsedMs + Math.max(0, liveNow - block.liveModelStartedAt);
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
  const thinkingText =
    isRunning && block.latestActivity?.kind === 'thinking' ? block.latestActivity.text : undefined;
  const thinkingLines = useMemo(() => {
    if (!thinkingText?.trim()) return [];
    const compactText = thinkingText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');
    const wrapped = wrapDisplayLines(compactText, Math.max(1, col - 6)).filter(
      (line) => line.trim().length > 0,
    );
    return wrapped.length > MAX_VISIBLE_STEPS
      ? [...wrapped.slice(0, MAX_VISIBLE_STEPS), '...']
      : wrapped;
  }, [col, thinkingText]);
  const showsThinking = thinkingLines.length > 0;
  // ── Summary label ──
  // 思考块标题 = "Thinking Xs · <工具统计>"：有工具时以 " · " 分隔附加
  // summaryLine 统计（如 "Thinking 2s · read 3 files"），随工具事件实时
  // 刷新；无工具的纯思考块保持裸 "Thinking Xs"。步骤树仍展示工具明细。
  // 非思考聚合块（无 hasThinking）保持纯工具统计标签（对应 CC 的
  // "⏺ Read N files" 聚合行，规则 20）。elapsed 为模型调用时长（规则 22）。
  // Thinking blocks render "Thinking Xs · <tool stats>" (stats from
  // summaryLine, live-updated on tool events; the step tree below keeps the
  // detail). Pure thinking without tools keeps the bare "Thinking Xs";
  // non-thinking aggregates keep the pure tool-stats label (rule 20).
  // elapsed = model-call duration (rule 22). col-2 扣除圆点列宽。
  const hasThink = block.hasThinking === true;
  const hasTools = block.tools.length > 0;
  const summaryLabel = hasThink
    ? thinkingLabel(elapsedStr, summaryLine, hasTools, col - 2)
    : hasTools
      ? summaryLine
      : `Thinking ${elapsedStr}`;

  // ── Step connector ──
  // A compact detail group has one entry branch. Its later sibling rows align
  // with the first tool instead of implying a parent/child relationship.
  const getConnector = (i: number): string => {
    return i === 0 && !hasSkipped ? '└─ ' : '   ';
  };

  // ── settle 后只保留 Thought 摘要，不展示 reasoning 正文 ──
  // 聚合摘要的圆点只表示“阶段正在进行”，因此 Thought 与非 Thought
  // 聚合块完成后都不保留圆点。独立工具卡使用自己的结果状态语义。
  // 置于所有 hook 之后，保证 hook 调用顺序稳定（rules-of-hooks）。
  // ── Pure-thinking block settled: single line, no dot — ● is reserved for
  // stateful rows (running activity / tool outcome colors); a settled pure
  // thought carries no status. Two leading spaces keep the label aligned
  // with tool-block names. Placed after all hooks (rules-of-hooks).
  // A sealed summary is not a visual expansion state. The first visible text
  // event has already ended the Thought from the user's perspective.
  if (!isRunning) {
    return (
      <Box flexDirection="column">
        <Box>
          {/* 两个空格列位 = 圆点列宽（"● "），避免 settle 时标题横向跳动 */}
          <Text color={dt.dim}>{`  ${summaryLabel}`}</Text>
        </Box>
      </Box>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 统一渲染
  // ═══════════════════════════════════════════════════════════
  return (
    <Box flexDirection="column">
      <Box>
        {isRunning ? <BlinkDot active /> : <Text>{'  '}</Text>}
        <Text color={dt.dim}>{summaryLabel}</Text>
      </Box>
      {!showsThinking && hasSkipped && (
        <Box paddingLeft={3}>
          <Text color={dt.dim}>└─ ... 以上 {skipped} 步已折叠</Text>
        </Box>
      )}
      {showsThinking ? (
        <ThinkingWindow lines={thinkingLines} />
      ) : (
        visibleSteps.map((step, i) => (
          <StepRow key={step.callId} step={step} connector={getConnector(i)} col={col} dt={dt} />
        ))
      )}
      {/* Running-only: tool preview for legacy blocks (new tool not yet in visibleSteps) */}
      {!showsThinking &&
        isRunning &&
        block.latestActivity?.kind === 'tool' &&
        !visibleSteps.some(
          (s) => s.callId === (block.latestActivity as { kind: 'tool'; callId: string }).callId,
        ) && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>{visibleSteps.length === 0 && !hasSkipped ? '└─ ' : '   '}</Text>
            <Text color={dt.muted}>{latestActivityLabel(block, Math.max(0, col - 9))}</Text>
          </Box>
        )}
    </Box>
  );
});
