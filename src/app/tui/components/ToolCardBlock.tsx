import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme';
import type { Theme } from '../theme';
import type { OutputBlock } from '../types';
import { ACTION_NAMES, formatElapsed, SPINNER, toolColor } from './render-utils';

const MAX_TOOL_LINES = 5;
const SHELL_PREFIX = '⎿   ';
/** Reuse SHELL_PREFIX glyph for continuation lines — pure whitespace
 *  (like "    ") is vulnerable to collapsing in Ink's Yoga text layout. */
const SHELL_ALIGN = SHELL_PREFIX;

function renderShellSummary(summary: string, isError: boolean, dt: { error: string; dim: string }) {
  const color = isError ? dt.error : dt.dim;
  const text = summary.trimEnd();
  const lines = text.split('\n');

  if (lines.length <= 1) {
    return (
      <Text color={color}>
        {SHELL_PREFIX}
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
          {i === 0 ? SHELL_PREFIX : SHELL_ALIGN}
          {line.slice(0, 200)}
        </Text>
      ))}
      {truncated && (
        <Text color={dt.dim}>
          {SHELL_ALIGN}… +{lines.length - MAX_TOOL_LINES} lines
        </Text>
      )}
    </React.Fragment>
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
  const isDiff = diffLines.length > 0 && /^\s*\d+\s+[-+]/.test(diffLines[0]!);

  const displayLines = diffLines.slice(0, MAX_TOOL_LINES);
  const truncated = diffLines.length > MAX_TOOL_LINES;

  return (
    <React.Fragment>
      <Text color={dt.dim}>⎿  {statsLine}</Text>
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
          {truncated && (
            <Text color={dt.dim}>… +{diffLines.length - MAX_TOOL_LINES} lines</Text>
          )}
        </Box>
      ) : diffLines.length > 0 ? (
        <Box paddingLeft={3} flexDirection="column">
          {displayLines.map((line, i) => (
            <Text key={i} color={dt.dim}>{line}</Text>
          ))}
          {truncated && (
            <Text color={dt.dim}>… +{diffLines.length - MAX_TOOL_LINES} lines</Text>
          )}
        </Box>
      ) : null}
    </React.Fragment>
  );
}

interface ToolCardBlockProps {
  block: OutputBlock & { kind: 'tool_card' };
  /** 工具等待审批时隐藏计时器 / Hide timer when tool is awaiting approval */
  awaitingApproval?: boolean;
}

export default function ToolCardBlock({ block, awaitingApproval }: ToolCardBlockProps) {
  const dt = useTheme();
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [liveElapsed, setLiveElapsed] = useState(0);
  const startRef = useRef(Date.now());
  const showElapsed = block.name === 'shell_execute';

  useEffect(() => {
    if (block.status !== 'running') return;
    startRef.current = Date.now();
    setLiveElapsed(0);
    const spinnerTimer = setInterval(() => setSpinnerIdx((i) => (i + 1) % SPINNER.length), 80);
    if (showElapsed) {
      const elapsedTimer = setInterval(() => setLiveElapsed(Date.now() - startRef.current), 200);
      return () => {
        clearInterval(spinnerTimer);
        clearInterval(elapsedTimer);
      };
    }
    return () => {
      clearInterval(spinnerTimer);
    };
  }, [block.status, showElapsed]);

  if (block.status === 'running') {
    const spinner = SPINNER[spinnerIdx];
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.warning}>{spinner} </Text>
          <Text color={dt.primary}>{block.name}</Text>
          {block.preview ? <Text color={dt.muted}> {block.preview}</Text> : null}
          {awaitingApproval ? (
            <Text color={dt.dim}> (awaiting approval)</Text>
          ) : showElapsed ? (
            <Text color={dt.dim}> ({formatElapsed(liveElapsed)})</Text>
          ) : null}
        </Box>
      </Box>
    );
  }

  // done or error
  const isShell = block.name === 'shell_execute';
  const isFileTool = block.name === 'edit_file' || block.name === 'write_file';
  const isExpanded = block.expanded ?? block.status === 'error';
  const hasSummary = block.summary ? block.summary.trimEnd().length > 0 : false;
  const displayName = ACTION_NAMES[block.name] ?? block.name;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={toolColor(block.status, dt)}>● </Text>
        <Text color={dt.primary}>{displayName}</Text>
        {block.detail ? <Text color={dt.dim}> {block.detail}</Text> : null}
        {showElapsed && block.elapsedMs != null ? (
          <Text color={dt.dim}> ({formatElapsed(block.elapsedMs)})</Text>
        ) : null}
      </Box>
      {(isExpanded && hasSummary) || (isExpanded && isShell) ? (
        isShell ? (
          <Box paddingLeft={2} flexDirection="column">
            {hasSummary ? (
              renderShellSummary(block.summary!, block.status === 'error', dt)
            ) : (
              <Text color={dt.dim}>{SHELL_PREFIX}(No output)</Text>
            )}
            {block.status === 'error' && block.summary?.split('\n').length > 3 && (
              <Text color={dt.dim}>Enter 折叠</Text>
            )}
          </Box>
        ) : isFileTool ? (
          <Box paddingLeft={3} flexDirection="column">
            {renderFileSummary(block.summary!, dt)}
          </Box>
        ) : (
          <Box paddingLeft={3} flexDirection="column">
            {renderToolSummary(block.summary!, block.status === 'error', dt)}
            {block.status === 'error' && block.summary?.split('\n').length > 3 && (
              <Text color={dt.dim}>Enter 折叠</Text>
            )}
          </Box>
        )
      ) : null}
    </Box>
  );
}
