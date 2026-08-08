import { Box, Text } from 'ink';
import SyntaxHighlight from 'ink-syntax-highlight';
import React, { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import type { UserInputResult } from '@/protocol/events';
import type { Theme } from '../theme';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import MarkdownBlock from './MarkdownBlock';
import { ACTION_NAMES, formatElapsed, toolColor, writeFileActionName } from './render-utils';
import { useBlinkDot } from './use-blink-dot';

export const MAX_TOOL_LINES = 5;
const SHELL_PREFIX = '⎿   ';
/** Reuse SHELL_PREFIX glyph for continuation lines — pure whitespace
 *  (like "    ") is vulnerable to collapsing in Ink's Yoga text layout. */
const SHELL_ALIGN = SHELL_PREFIX;

interface ToolSearchDisplayResult {
  candidate_count?: number;
  candidates?: Array<{
    kind?: string;
    name?: string;
    provider?: string;
  }>;
}

interface McpResourceListDisplayResult {
  resource_count?: number;
  resources?: Array<{ server?: string; uri?: string; name?: string; mime_type?: string }>;
}

function parseToolSearchResult(summary: string): ToolSearchDisplayResult | undefined {
  try {
    const parsed = JSON.parse(summary) as ToolSearchDisplayResult;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseMcpResourceList(summary: string): McpResourceListDisplayResult | undefined {
  try {
    const parsed = JSON.parse(summary) as McpResourceListDisplayResult;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mcpToolDisplayName(name: string): string {
  if (!name.startsWith('mcp__')) return ACTION_NAMES[name] ?? name;
  const parts = name.slice('mcp__'.length).split('__');
  if (parts.length < 2) return name;
  return `${parts.shift()} · ${parts.join('__')}`;
}

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
  userInput?: UserInputResult,
): {
  answer: string;
  answerMap: Record<string, string> | undefined;
  isCancelled: boolean;
} {
  const questions = args.questions as AskQuestionItem[] | undefined;
  if (userInput) {
    const answerMap =
      userInput.answers && Object.keys(userInput.answers).length > 0
        ? userInput.answers
        : undefined;
    const answer = userInput.answer || '(no answer)';
    return { answer, answerMap, isCancelled: answer === 'Cancelled' };
  }

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
 *  多问题：⎿  sub_q User: answer / ⎿  sub_q User: answer */
function renderAskUserSummary(
  args: Record<string, unknown>,
  summary: string,
  dt: Theme,
  maxLine: number,
  userInput?: UserInputResult,
): React.ReactNode {
  const questions = args.questions as AskQuestionItem[] | undefined;
  const { answer, answerMap, isCancelled } = parseAskUserAnswers(args, summary, userInput);

  // 已取消（结构化答案为 Cancelled，或无结构化答案且 summary 为空/Cancelled）→ 展示所有问题 + Cancelled 标记
  // Cancelled (structured answer is Cancelled, or no structured result and summary is empty/Cancelled)
  const cancelled = isCancelled || (!userInput && (!summary || summary.trim().length === 0));
  if (cancelled) {
    if (questions && questions.length > 0) {
      return (
        <>
          {questions.map((q, i) => {
            const prefix = '⎿ ';
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
          const prefix = '⎿ ';
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

/** 根据文件扩展名推断 highlight.js 语言标识 / Map file extension → highlight.js language */
function detectLanguage(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    jsonc: 'jsonc',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    md: 'markdown',
    mdx: 'markdown',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    css: 'css',
    scss: 'scss',
    less: 'less',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    bat: 'dos',
    cmd: 'dos',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    dockerfile: 'dockerfile',
    lua: 'lua',
  };
  return map[ext];
}

/** 拆分 diff/内容行：前缀（行号+标记）和代码正文 / Split line into prefix (line#+marker) and code body */
const LINE_RE = /^(\s*\d+\s[-+ ])(.*)$/;

/** 文件工具的摘要渲染 — 自动区分 diff 格式（红底/绿底）和纯文本格式（无背景）
 *  Summary renderer for file tools — auto-detects diff format (red/green bg)
 *  vs plain content format (no background)
 *  导出供测试直接断言染色分类（exported for coloring classification tests） */
export function renderFileSummary(summary: string, dt: Theme, language?: string) {
  const lines = summary.trimEnd().split('\n');
  const statsLine = lines[0]!;
  const diffLines = lines.slice(1);

  // 检测是否为 diff 格式：任意内容行以 "行号 + 单个空格 + +/- 标记" 开头。
  // core 的 diff 格式中删除/新增行为 `num + 一个空格 + 标记`（标记紧贴正文），
  // 而上下文行与纯内容格式为 `num + 两个空格 + 正文`；因此必须要求恰好一个空格，
  // 否则以 "- " / "+ " 开头的正文（如 Markdown 列表项）会被误判为删除/新增行。
  // Detect diff format: "lineNum + exactly one space + +/- marker". Removed/added
  // lines use one space before the marker; context and plain-content lines use two
  // spaces before the text, so requiring exactly one space avoids misclassifying
  // body text starting with "- " / "+ " (e.g. Markdown list items) as diff markers.
  const isDiff = diffLines.length > 0 && diffLines.some((line) => /^\s*\d+ [-+]/.test(line));

  // write_file 新建：所有内容行视为新增，全绿底。内容未变则保留 dim。
  // write_file create: treat all lines as added (green). Unchanged → dim.
  const isWriteFileContent =
    !isDiff && statsLine.startsWith('Wrote ') && !statsLine.includes('(content unchanged)');

  // 文件变更需要完整展示，避免用户只看到删除部分而看不到新增内容。
  // File changes are user-facing output and should be shown in full.
  const displayLines = diffLines;

  return (
    <React.Fragment>
      <Text color={dt.dim}>⎿ {statsLine}</Text>
      {diffLines.length > 0 && isDiff ? (
        <Box paddingLeft={3} flexDirection="column">
          {displayLines.map((line, i) => {
            const isRemoved = /^\s*\d+ -/.test(line);
            const isAdded = /^\s*\d+ \+/.test(line);
            const bg = isRemoved ? dt.diffRemovedBg : isAdded ? dt.diffAddedBg : undefined;
            const fg = isRemoved || isAdded ? 'white' : dt.dim;
            const m = line.match(LINE_RE);
            return (
              <Box key={i} width="100%" backgroundColor={bg}>
                <Text color={fg}>{m ? m[1] : line}</Text>
                {m && language ? (
                  <SyntaxHighlight code={m[2]!} language={language} />
                ) : m ? (
                  <Text color={fg}>{m[2]}</Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ) : diffLines.length > 0 ? (
        <Box paddingLeft={3} flexDirection="column">
          {displayLines.map((line, i) => {
            const activeBg = isWriteFileContent ? dt.diffAddedBg : undefined;
            const activeFg = isWriteFileContent ? 'white' : dt.dim;
            const m = line.match(LINE_RE);
            return (
              <Box key={i} width="100%" backgroundColor={activeBg}>
                <Text color={activeFg}>{m ? m[1] : line}</Text>
                {m && language ? (
                  <SyntaxHighlight code={m[2]!} language={language} />
                ) : m ? (
                  <Text color={activeFg}>{m[2]}</Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ) : null}
    </React.Fragment>
  );
}

interface ToolCardBlockProps {
  block: OutputBlock & { kind: 'tool_card' };
  /** 工具等待审批时隐藏计时器 / Hide timer when tool is awaiting approval */
  awaitingApproval?: boolean;
  /** ask_user 等待用户输入时显示等待状态 / Show waiting label while ask_user awaits input */
  awaitingInput?: boolean;
  /** 可用列宽（从 BlockRenderer 传入）/ Available terminal columns */
  columns?: number;
}

export default function ToolCardBlock({
  block,
  awaitingApproval,
  awaitingInput,
  columns = 80,
}: ToolCardBlockProps) {
  const dt = useTheme();
  const showElapsed = block.name === 'shell_execute' || block.name === 'web_fetch';
  const isWebFetch = block.name === 'web_fetch';

  // ── 闪烁圆点：统一 hook ──
  const spinnerActive =
    block.status === 'running' && !awaitingApproval && block.name !== 'ask_user';
  const spinnerFrame = useBlinkDot(spinnerActive);

  // ── 计时器：ref 驱动，基于绝对时间，免疫重复渲染 ──
  const [liveElapsed, setLiveElapsed] = useState(() =>
    block.status === 'running' && block.startedAt ? Date.now() - block.startedAt : 0,
  );
  const startedAtRef = useRef(block.startedAt);
  startedAtRef.current = block.startedAt;

  useEffect(() => {
    if (!showElapsed) return;
    const timer = setInterval(() => {
      const at = startedAtRef.current;
      if (at != null) setLiveElapsed(Date.now() - at);
    }, 200);
    return () => clearInterval(timer);
  }, [showElapsed]);

  const isShell = block.name === 'shell_execute';

  if (block.status === 'queued') {
    const displayName =
      block.name === 'tool_search'
        ? 'Searching for tools…'
        : block.name === 'list_mcp_resources'
          ? 'Listing MCP resources…'
          : block.name === 'write_file'
            ? writeFileActionName(block.summary, block.args)
            : mcpToolDisplayName(block.name);
    return (
      <Box>
        <Text color={dt.muted}>○ </Text>
        <Text>{displayName}</Text>
        {block.preview ? <Text color={dt.muted}> {block.preview}</Text> : null}
        <Text color={dt.dim}> (queued)</Text>
      </Box>
    );
  }

  if (block.status === 'running') {
    // 等待审批/输入时用静态 ○ 代替轮播 spinner / Static dot for tools awaiting approval or input
    const isWaiting = awaitingApproval || block.name === 'ask_user';
    const spinner = isWaiting ? '○ ' : spinnerFrame;
    const displayName =
      block.name === 'tool_search'
        ? 'Searching for tools…'
        : block.name === 'list_mcp_resources'
          ? 'Listing MCP resources…'
          : block.name === 'list_mcp_tools'
            ? 'Listing MCP tools…'
            : block.name === 'write_file'
              ? writeFileActionName(block.summary, block.args)
              : mcpToolDisplayName(block.name);
    // isAskUserRunning 已移除：running 状态的问题由 Footer InputBlock 渲染，scrollback 不重复
    return (
      <Box flexDirection="column">
        <Box>
          <Text>{spinner}</Text>
          <Text>{displayName}</Text>
          {block.preview ? <Text color={dt.muted}> {block.preview}</Text> : null}
          {awaitingApproval ? (
            <Text color={dt.dim}> (awaiting approval)</Text>
          ) : awaitingInput && block.name === 'ask_user' ? (
            <Text color={dt.dim}> (awaiting input)</Text>
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
        {block.reviewFailure ? (
          <Box paddingLeft={2}>
            <Text color={dt.error}>
              {SHELL_PREFIX}⚠ auto-review: {block.reviewFailure}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // done or error
  const isFileTool = block.name === 'edit_file' || block.name === 'write_file';
  const fileLanguage =
    isFileTool && typeof block.args.path === 'string' ? detectLanguage(block.args.path) : undefined;
  const isPlan = block.name === 'write_plan' || block.name === 'update_plan';
  const isAskUser = block.name === 'ask_user';
  const isExpanded =
    block.expanded ??
    (block.status === 'error' ||
      block.status === 'cancelled' ||
      block.status === 'timeout' ||
      block.status === 'exhausted');
  const hasSummary = block.summary ? block.summary.trimEnd().length > 0 : false;
  const toolSearch =
    block.name === 'tool_search' ? parseToolSearchResult(block.summary) : undefined;
  const searchCandidates = toolSearch?.candidates?.filter(
    (candidate) => typeof candidate.name === 'string' && candidate.name.length > 0,
  );
  const resourceList =
    block.name === 'list_mcp_resources' ? parseMcpResourceList(block.summary) : undefined;
  const listedResources = resourceList?.resources?.filter(
    (resource) =>
      typeof resource.server === 'string' &&
      resource.server.length > 0 &&
      typeof resource.uri === 'string' &&
      resource.uri.length > 0,
  );
  const displayName =
    block.name === 'tool_search'
      ? block.status === 'done'
        ? (toolSearch?.candidate_count ?? searchCandidates?.length ?? 0) > 0
          ? 'Searched for tools'
          : 'No matching tools found'
        : 'Tool search failed'
      : block.name === 'list_mcp_resources'
        ? block.status === 'done'
          ? 'Listed MCP resources'
          : 'MCP resource listing failed'
        : block.name === 'list_mcp_tools'
          ? block.status === 'done'
            ? 'Listed MCP tools'
            : 'MCP tool listing failed'
          : block.name === 'write_file'
            ? writeFileActionName(block.summary, block.args)
            : mcpToolDisplayName(block.name);
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
      {block.name === 'tool_search' &&
        block.status === 'done' &&
        searchCandidates &&
        searchCandidates.length > 0 && (
          <Box paddingLeft={2} flexDirection="column">
            {searchCandidates.map((candidate, index) => {
              const provider =
                typeof candidate.provider === 'string' && candidate.provider.length > 0
                  ? candidate.provider
                  : candidate.kind === 'skill'
                    ? 'skill'
                    : 'MCP';
              const branch = index === searchCandidates.length - 1 ? '└' : '├';
              return (
                <Text key={`${provider}-${candidate.name}-${index}`} color={dt.muted}>
                  {branch} {provider} · {candidate.name}
                </Text>
              );
            })}
          </Box>
        )}
      {block.name === 'list_mcp_resources' &&
        block.status === 'done' &&
        listedResources &&
        listedResources.length > 0 && (
          <Box paddingLeft={2} flexDirection="column">
            {listedResources.map((resource, index) => (
              <Text key={`${resource.server}-${resource.uri}-${index}`} color={dt.muted}>
                {index === listedResources.length - 1 ? '└' : '├'} {resource.server} ·{' '}
                {resource.uri}
              </Text>
            ))}
          </Box>
        )}
      {/* 方案工具：Markdown 完整渲染，不截断 / Plan: full Markdown, no truncation */}
      {isExpanded && isPlan && hasSummary && (
        <Box paddingLeft={2} marginTop={1} flexDirection="column">
          <MarkdownBlock content={block.summary!} maxWidth={columns - 2} />
          {block.status === 'exhausted' && (
            <Text color={dt.warning}>⎿ blocked (too many repeated failures)</Text>
          )}
        </Box>
      )}
      {/* ask_user 工具：紧凑渲染答案，每行 ⎿ 前缀，仿 shell_execute 布局
          ask_user: compact ⎿-prefixed lines, shell_execute style.
          不依赖 hasSummary — 问题文本存在 args 中，summary 为空时仍渲染问题列表。
          自适应截断：maxLine = 终端列宽 − paddingLeft */}
      {isExpanded && isAskUser && (
        <Box paddingLeft={2} flexDirection="column">
          {block.status === 'exhausted' ? (
            <Text color={dt.warning}>⎿ blocked (too many repeated failures)</Text>
          ) : block.status === 'error' ? (
            <Text color={dt.error}>⎿ {block.summary || 'Ask failed.'}</Text>
          ) : (
            renderAskUserSummary(block.args, block.summary ?? '', dt, columns - 2, block.userInput)
          )}
        </Box>
      )}
      {/* Shell + Web Fetch 工具：统一渲染 / Shell + Web Fetch: unified rendering */}
      {isExpanded && (isShell || isWebFetch) && (
        <Box paddingLeft={2} flexDirection="column">
          {block.status === 'cancelled' && block.summary === 'Cancelled' ? null : hasSummary ? (
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
            {SHELL_PREFIX}
            {block.status === 'exhausted'
              ? 'blocked (too many repeated failures)'
              : isWebFetch
                ? block.status === 'cancelled'
                  ? 'cancelled'
                  : block.status === 'error'
                    ? 'fetch failed'
                    : block.status === 'timeout'
                      ? `timed out after ${block.timeoutMs ?? 15000}ms`
                      : 'fetched'
                : block.status === 'cancelled' ||
                    block.summary?.startsWith('Command cancelled') ||
                    block.summary?.includes('"cancelled":true')
                  ? 'cancelled'
                  : block.status === 'timeout'
                    ? block.timeoutMs != null
                      ? `timed out after ${block.timeoutMs}ms`
                      : 'timed out'
                    : `exit: ${block.status === 'error' ? 'error' : '0'}`}
          </Text>
          {'reviewFailure' in block && block.reviewFailure ? (
            <Text color={dt.error}>
              {SHELL_PREFIX}⚠ auto-review: {block.reviewFailure}
            </Text>
          ) : null}
        </Box>
      )}
      {/* 文件工具 / File tools — 无 summary 时展示文件路径（如工具被取消无 ToolMessage） */}
      {isExpanded && isFileTool && (
        <Box paddingLeft={3} flexDirection="column">
          {block.status === 'exhausted' ? (
            <Text color={dt.warning}>⎿ blocked (too many repeated failures)</Text>
          ) : hasSummary ? (
            renderFileSummary(block.summary!, dt, fileLanguage)
          ) : (
            <Text color={dt.dim}>⎿ {pathLabel(block.args)} (no result)</Text>
          )}
          {block.reviewFailure ? (
            <Text color={dt.error}>
              {SHELL_PREFIX}⚠ auto-review: {block.reviewFailure}
            </Text>
          ) : null}
        </Box>
      )}
      {/* 其他工具 / Other tools */}
      {isExpanded && !isPlan && !isAskUser && !isShell && !isFileTool && hasSummary && (
        <Box paddingLeft={3} flexDirection="column">
          {renderToolSummary(
            block.summary!,
            block.status === 'error' || block.status === 'exhausted',
            dt,
          )}
        </Box>
      )}
    </Box>
  );
}
