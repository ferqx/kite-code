import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import type { Theme } from '../theme';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import MarkdownBlock from './MarkdownBlock';
import {
  ACTION_NAMES,
  formatElapsed,
  SPINNER,
  SPINNER_INTERVAL_MS,
  toolColor,
} from './render-utils';

export const MAX_TOOL_LINES = 5;
const SHELL_PREFIX = '⎿   ';
/** Reuse SHELL_PREFIX glyph for continuation lines — pure whitespace
 *  (like "    ") is vulnerable to collapsing in Ink's Yoga text layout. */
const SHELL_ALIGN = SHELL_PREFIX;

/** 从工具参数中提取可读的文件路径（仅末级文件名）/ Extract readable path label from tool args (filename only) */
function pathLabel(args: Record<string, unknown>): string {
  const p = args.path;
  if (typeof p !== 'string' || p.length === 0) return '(unknown)';
  return p.replace(/^.*[/\\]/, '').slice(-50);
}

/** ask_user 工具传入的选项类型 / Option type from ask_user tool args */
interface AskOption {
  id?: string;
  label: string;
  description?: string;
}

/** ask_user 工具传入的多问题项类型 / Multi-question item type from ask_user tool args */
interface AskQuestionItem {
  id?: string;
  question: string;
  options?: AskOption[];
  recommended?: string;
  allow_free_text?: boolean;
}

const ELLIPSIS = '…';
const ELLIPSIS_W = stringWidth(ELLIPSIS); // CJK 环境下可能为 2 / may be 2 in CJK locales

/** 按显示宽度硬截断字符串 / Hard-truncate string by display width */
function clip(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(s) <= maxWidth) return s;
  if (maxWidth <= ELLIPSIS_W) return ELLIPSIS;
  let result = '';
  let w = 0;
  const limit = maxWidth - ELLIPSIS_W;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > limit) break;
    result += ch;
    w += cw;
  }
  return `${result}${ELLIPSIS}`;
}

/** 截断答案——多行取首行，超长截断加 …，禁止换行
 *  Truncate answer — single-line first, cap with … to prevent wrapping */
function truncateAnswer(a: string, maxWidth: number): string {
  if (a === '(no answer)') return a;
  const lines = a.split('\n');
  if (lines.length <= 1) return clip(a, maxWidth);
  return clip(lines[0]!, Math.min(maxWidth, 40));
}

/** 解析 ask_user summary 中的答案（兼容裸 JSON 和上游已转纯文本格式）
 *  Parse ask_user answer from summary (compatible with raw JSON and upstream plain-text).
 *  上游 parseToolResultEvents 会将 JSON 转为 "key: value\n..." 纯文本，
 *  所以 JSON.parse 失败后还需按纯文本格式解析 answerMap。 */
function parseAskUserAnswers(
  args: Record<string, unknown>,
  summary: string,
): {
  answer: string;
  answerMap: Record<string, string> | undefined;
  isCancelled: boolean;
} {
  const questions = args.questions as AskQuestionItem[] | undefined;
  let answer: string | undefined;
  let answerMap: Record<string, string> | undefined;
  try {
    const p = JSON.parse(summary) as Record<string, unknown> | undefined;
    if (p && typeof p === 'object') {
      const am = p.answers as Record<string, string> | undefined;
      if (am && Object.keys(am).length > 0) answerMap = am;
      const a = p.answer as string | undefined;
      if (typeof a === 'string') answer = a || '(no answer)';
    }
  } catch {
    answer = summary;
    if (questions && questions.length > 0) {
      const map: Record<string, string> = {};
      const lines = summary.split('\n');
      for (const line of lines) {
        const colonIdx = line.indexOf(': ');
        if (colonIdx > 0) {
          map[line.slice(0, colonIdx)] = line.slice(colonIdx + 2);
        }
      }
      if (Object.keys(map).length > 0) {
        answerMap = map;
        answer = Object.values(map).find((v) => v.length > 0) ?? '(no answer)';
      }
    }
  }
  const isCancelled = answer === 'Cancelled' || summary === 'Cancelled';
  return { answer: answer ?? '(no answer)', answerMap, isCancelled };
}

/** ask_user 紧凑摘要渲染：每行 ⎿ 前缀，单行答案，仿 shell_execute 布局
 *  Compact ask_user summary: ⎿-prefixed single-line answers, shell_execute style.
 *  单问题：⎿   User: answer
 *  多步骤：⎿  Step1 sub_q User: answer / ⎿  Step2 sub_q User: answer */
function renderAskUserSummary(
  args: Record<string, unknown>,
  summary: string,
  dt: Theme,
  maxLine: number,
): React.ReactNode {
  const questions = args.questions as AskQuestionItem[] | undefined;
  const { answer, answerMap, isCancelled } = parseAskUserAnswers(args, summary);

  // 已取消（summary 为空或 "Cancelled"）→ 展示所有问题 + Cancelled 标记
  // Cancelled (empty summary or "Cancelled") → show all questions with Cancelled label
  const cancelled = isCancelled || !summary || summary.trim().length === 0;
  if (cancelled) {
    if (questions && questions.length > 0) {
      return (
        <>
          {questions.map((q, i) => {
            const prefix = `⎿ Step${i + 1} `;
            const suffix = ` Cancelled`;
            const qMax = Math.max(0, maxLine - stringWidth(prefix) - stringWidth(suffix));
            const qShort = clip(q.question, qMax);
            return (
              <Text key={`${q.id ?? 'q'}-${i}`} color={dt.dim}>
                {prefix}
                {qShort}
                {suffix}
              </Text>
            );
          })}
        </>
      );
    }
    const question = args.question as string | undefined;
    if (question) {
      const prefix = '⎿ ';
      const suffix = ' Cancelled';
      const qMax = Math.max(0, maxLine - stringWidth(prefix) - stringWidth(suffix));
      return (
        <Text color={dt.dim}>
          {prefix}
          {clip(question, qMax)}
          {suffix}
        </Text>
      );
    }
    return <Text color={dt.dim}>⎿ Cancelled</Text>;
  }

  // 多问题模式：每步一行，问题和答案均分可用宽度 / Multi-question: one line per step, split width between Q and A
  if (questions && questions.length > 0 && answerMap) {
    return (
      <>
        {questions.map((q, i) => {
          const id = q.id ?? String(i);
          const raw = answerMap[id] ?? '';
          const prefix = `⎿ Step${i + 1} `;
          const midfix = ` User: `;
          const contentWidth = maxLine - stringWidth(prefix) - stringWidth(midfix);
          // 确保 qMax + aMax = contentWidth，窄终端不会溢出 / Guarantee sum fits contentWidth
          const rawQMax = Math.floor(contentWidth * 0.45);
          const qMax = Math.max(10, Math.min(rawQMax, contentWidth - 10));
          const aMax = contentWidth - qMax;
          const qShort = clip(q.question, qMax);
          const aShort = truncateAnswer(raw || '(no answer)', aMax);
          return (
            <Text key={`${q.id ?? 'q'}-${i}`} color={dt.dim}>
              {prefix}
              {qShort}
              {midfix}
              {aShort}
            </Text>
          );
        })}
      </>
    );
  }

  // 单问题模式 / Single question
  const prefix = '⎿ User: ';
  const aMax = Math.max(0, maxLine - stringWidth(prefix));
  return (
    <Text color={dt.dim}>
      {prefix}
      {truncateAnswer(answer, aMax)}
    </Text>
  );
}

const SHELL_PREFIX_W = stringWidth(SHELL_PREFIX);

/** 统一的 shell 输出渲染：SHELL_PREFIX + 终端宽度截断 + 5 行窗口 + 尾行展示最新 N 行。
 *  始终 fragment + map 渲染（消除单/多行分支切换导致的 reconciliation 问题）。
 *  Unified shell output renderer: shears common logic from renderShellSummary + renderLiveShellOutput. */
function renderShellLines(
  text: string,
  color: string,
  maxLine: number,
  totalLines?: number,
  mode: 'tail' | 'head-tail' = 'tail',
) {
  const lines = text.trimEnd().split('\n');
  const contentWidth = Math.max(10, maxLine - SHELL_PREFIX_W);
  const displayLines =
    mode === 'head-tail' && lines.length > MAX_TOOL_LINES * 2
      ? [...lines.slice(0, MAX_TOOL_LINES), ...lines.slice(-MAX_TOOL_LINES)]
      : mode === 'head-tail'
        ? lines
        : lines.slice(-MAX_TOOL_LINES);
  const skipped =
    mode === 'head-tail'
      ? (totalLines ?? lines.length) - displayLines.length
      : (totalLines ?? lines.length) - MAX_TOOL_LINES;

  return (
    <>
      {mode === 'tail' && skipped > 0 && (
        <Text color={color}>
          {SHELL_ALIGN}… +{skipped} lines
        </Text>
      )}
      {displayLines.map((line, i) => {
        const insertOmission = mode === 'head-tail' && skipped > 0 && i === MAX_TOOL_LINES;
        return (
          <React.Fragment key={i}>
            {insertOmission && (
              <Text color={color}>
                {SHELL_ALIGN}… +{skipped} lines
              </Text>
            )}
            <Text color={color}>
              {SHELL_PREFIX}
              {clip(line, contentWidth)}
            </Text>
          </React.Fragment>
        );
      })}
    </>
  );
}

function renderToolSummary(summary: string, isError: boolean, dt: { error: string; dim: string }) {
  const prefix = isError ? '✕ ' : '⎿ ';
  /** Same width as prefix for continuation lines — avoids pure-whitespace collapsing and
   *  fixes a pre-existing 1-column alignment mismatch (was 3 spaces vs 2-char prefix). */
  const align = prefix;
  const color = isError ? dt.error : dt.dim;
  const text = summary.trimEnd();
  const lines = text.split('\n');

  if (lines.length <= 1) {
    return (
      <Text color={color}>
        {prefix}
        {text.slice(0, 300)}
      </Text>
    );
  }

  const displayLines = lines.slice(0, MAX_TOOL_LINES);
  const truncated = lines.length > MAX_TOOL_LINES;

  return (
    <React.Fragment>
      {displayLines.map((line, i) => (
        <Text key={i} color={color}>
          {i === 0 ? prefix : align}
          {line.slice(0, 200)}
        </Text>
      ))}
      {truncated && (
        <Text color={dt.dim}>
          {align}... ({lines.length - MAX_TOOL_LINES} more lines)
        </Text>
      )}
    </React.Fragment>
  );
}

/** 文件工具的摘要渲染 — 自动区分 diff 格式（红底/绿底）和纯文本格式（无背景）
 *  Summary renderer for file tools — auto-detects diff format (red/green bg)
 *  vs plain content format (no background) */
function renderFileSummary(summary: string, dt: Theme) {
  const lines = summary.trimEnd().split('\n');
  const statsLine = lines[0]!;
  const diffLines = lines.slice(1);

  // 检测是否为 diff 格式：任意内容行以 "行号 +" 或 "行号 -" 开头
  // Detect diff format: any content line starts with "lineNum +" or "lineNum -"
  const isDiff = diffLines.length > 0 && diffLines.some((line) => /^\s*\d+\s+[-+]/.test(line));

  const displayLines = diffLines.slice(0, MAX_TOOL_LINES);
  const truncated = diffLines.length > MAX_TOOL_LINES;

  return (
    <React.Fragment>
      <Text color={dt.dim}>⎿ {statsLine}</Text>
      {diffLines.length > 0 && isDiff ? (
        <Box paddingLeft={3} flexDirection="column">
          {displayLines.map((line, i) => {
            const isRemoved = /^\s*\d+\s+-/.test(line);
            const isAdded = /^\s*\d+\s+\+/.test(line);
            // 背景色走 ANSI 调色板（diffAddedBg=slot4, diffRemovedBg=slot5），OSC 4 切换主题即时更新
            // Background colors via ANSI palette (diffAddedBg=slot4, diffRemovedBg=slot5), OSC 4 instant update on theme switch
            const bg = isRemoved ? dt.diffRemovedBg : isAdded ? dt.diffAddedBg : undefined;
            const fg = isRemoved || isAdded ? 'white' : dt.dim;
            return (
              <Box key={i} width="100%" backgroundColor={bg}>
                <Text color={fg}>{line}</Text>
              </Box>
            );
          })}
          {truncated && <Text color={dt.dim}>… +{diffLines.length - MAX_TOOL_LINES} lines</Text>}
        </Box>
      ) : diffLines.length > 0 ? (
        <Box paddingLeft={3} flexDirection="column">
          {displayLines.map((line, i) => (
            <Text key={i} color={dt.dim}>
              {line}
            </Text>
          ))}
          {truncated && <Text color={dt.dim}>… +{diffLines.length - MAX_TOOL_LINES} lines</Text>}
        </Box>
      ) : null}
    </React.Fragment>
  );
}

interface ToolCardBlockProps {
  block: OutputBlock & { kind: 'tool_card' };
  /** 工具等待审批时隐藏计时器 / Hide timer when tool is awaiting approval */
  awaitingApproval?: boolean;
  /** 可用列宽（从 BlockRenderer 传入）/ Available terminal columns */
  columns?: number;
}

export default function ToolCardBlock({
  block,
  awaitingApproval,
  columns = 80,
}: ToolCardBlockProps) {
  const dt = useTheme();
  const showElapsed = block.name === 'shell_execute' || block.name === 'web_fetch';
  const isWebFetch = block.name === 'web_fetch';

  // ── 计时器：ref 驱动，基于绝对时间，免疫重复渲染 ──
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [liveElapsed, setLiveElapsed] = useState(() =>
    block.status === 'running' && block.startedAt ? Date.now() - block.startedAt : 0,
  );
  const startedAtRef = useRef(block.startedAt);
  startedAtRef.current = block.startedAt;

  // Spinner timing via ref — immune to effect re-runs from parent re-renders
  const spinnerStartRef = useRef(Date.now());
  const spinnerRunningRef = useRef(false);

  useEffect(() => {
    const shouldRun = block.status === 'running' && !awaitingApproval && block.name !== 'ask_user';
    spinnerRunningRef.current = shouldRun;
    if (shouldRun) spinnerStartRef.current = Date.now();
    else setSpinnerIdx(0);
  }, [block.status, awaitingApproval, block.name]);

  // Single persistent timer — never restarts. Reads running state from ref.
  useEffect(() => {
    const tick = () => {
      if (!spinnerRunningRef.current) return;
      const idx = Math.floor((Date.now() - spinnerStartRef.current) / 80) % SPINNER.length;
      setSpinnerIdx(idx);
    };
    const spinnerTimer = setInterval(tick, SPINNER_INTERVAL_MS);
    if (showElapsed) {
      const elapsedTimer = setInterval(() => {
        const at = startedAtRef.current;
        if (at != null) setLiveElapsed(Date.now() - at);
      }, 200);
      return () => {
        clearInterval(spinnerTimer);
        clearInterval(elapsedTimer);
      };
    }
    return () => clearInterval(spinnerTimer);
  }, [showElapsed]);

  const isShell = block.name === 'shell_execute';

  if (block.status === 'running') {
    // 等待审批/输入时用静态 ○ 代替轮播 spinner / Static dot for tools awaiting approval or input
    const isWaiting = awaitingApproval || block.name === 'ask_user';
    const spinner = isWaiting ? '○' : SPINNER[spinnerIdx];
    // isAskUserRunning 已移除：running 状态的问题由 Footer InputBlock 渲染，scrollback 不重复
    return (
      <Box flexDirection="column">
        <Box>
          <Text>{spinner} </Text>
          <Text>{ACTION_NAMES[block.name] ?? block.name}</Text>
          {block.preview ? <Text color={dt.muted}> {block.preview}</Text> : null}
          {awaitingApproval ? (
            <Text color={dt.dim}> (awaiting approval)</Text>
          ) : showElapsed ? (
            <Text color={dt.dim}> ({formatElapsed(liveElapsed)})</Text>
          ) : null}
        </Box>
        {/* ask_user 运行时问题由 Footer InputBlock 渲染，scrollback 不重复展示 */}
        {/* Shell 实时输出 — tail-follow 最近 5 行，与 renderShellSummary 保持视觉一致 */}
        {isShell && block.liveOutput && (
          <Box paddingLeft={2} flexDirection="column">
            {renderShellLines(block.liveOutput, dt.dim, columns - 2, block.liveTotalLines)}
          </Box>
        )}
      </Box>
    );
  }

  // done or error
  const isFileTool = block.name === 'edit_file' || block.name === 'write_file';
  const isPlan = block.name === 'update_plan';
  const isAskUser = block.name === 'ask_user';
  const isExpanded =
    block.expanded ??
    (block.status === 'error' || block.status === 'cancelled' || block.status === 'timeout');
  const hasSummary = block.summary ? block.summary.trimEnd().length > 0 : false;
  const displayName = ACTION_NAMES[block.name] ?? block.name;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={toolColor(block.status, dt)}>● </Text>
        <Text>{displayName}</Text>
        {block.detail ? <Text color={dt.dim}> {block.detail}</Text> : null}
        {showElapsed && block.elapsedMs != null ? (
          <Text color={dt.dim}> ({formatElapsed(block.elapsedMs)})</Text>
        ) : null}
      </Box>
      {/* 方案工具：Markdown 完整渲染，不截断 / Plan: full Markdown, no truncation */}
      {isExpanded && isPlan && hasSummary && (
        <Box paddingLeft={2} marginTop={1} flexDirection="column">
          <MarkdownBlock content={block.summary!} maxWidth={columns - 2} />
        </Box>
      )}
      {/* ask_user 工具：紧凑渲染答案，每行 ⎿ 前缀，仿 shell_execute 布局
          ask_user: compact ⎿-prefixed lines, shell_execute style.
          不依赖 hasSummary — 问题文本存在 args 中，summary 为空时仍渲染问题列表。
          自适应截断：maxLine = 终端列宽 − paddingLeft */}
      {isExpanded && isAskUser && (
        <Box paddingLeft={2} flexDirection="column">
          {renderAskUserSummary(block.args, block.summary ?? '', dt, columns - 2)}
        </Box>
      )}
      {/* Shell + Web Fetch 工具：统一渲染 / Shell + Web Fetch: unified rendering */}
      {isExpanded && (isShell || isWebFetch) && (
        <Box paddingLeft={2} flexDirection="column">
          {hasSummary ? (
            renderShellLines(
              block.summary!,
              dt.dim,
              columns - 2,
              undefined,
              isWebFetch || block.status === 'timeout' ? 'head-tail' : 'tail',
            )
          ) : (
            <Text color={dt.dim}>⎿ (No output)</Text>
          )}
          {/* 状态尾行 / Status footer */}
          <Text color={dt.dim}>
            ⎿{' '}
            {isWebFetch
              ? block.status === 'error'
                ? 'fetch failed'
                : block.status === 'timeout'
                  ? `timed out after ${block.timeoutMs ?? 15000}ms`
                  : 'fetched'
              : block.summary?.startsWith('Command cancelled') ||
                  block.summary?.includes('"cancelled":true')
                ? 'cancelled'
                : block.status === 'timeout'
                  ? block.timeoutMs != null
                    ? `timed out after ${block.timeoutMs}ms`
                    : 'timed out'
                  : `exit: ${block.status === 'error' ? 'error' : '0'}`}
          </Text>
          {(block.status === 'error' || isWebFetch) &&
            block.summary &&
            block.summary.split('\n').length > 3 && <Text color={dt.dim}>Enter 折叠</Text>}
        </Box>
      )}
      {/* 文件工具 / File tools — 无 summary 时展示文件路径（如工具被取消无 ToolMessage） */}
      {isExpanded && isFileTool && (
        <Box paddingLeft={3} flexDirection="column">
          {hasSummary ? (
            renderFileSummary(block.summary!, dt)
          ) : (
            <Text color={dt.dim}>⎿ {pathLabel(block.args)} (no result)</Text>
          )}
        </Box>
      )}
      {/* 其他工具 / Other tools */}
      {isExpanded &&
        !isPlan &&
        !isAskUser &&
        !isShell &&
        !isWebFetch &&
        !isFileTool &&
        hasSummary && (
          <Box paddingLeft={3} flexDirection="column">
            {renderToolSummary(block.summary!, block.status === 'error', dt)}
            {block.status === 'error' && block.summary?.split('\n').length > 3 && (
              <Text color={dt.dim}>Enter 折叠</Text>
            )}
          </Box>
        )}
    </Box>
  );
}
