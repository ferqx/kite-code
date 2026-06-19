import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import { formatElapsed, SPINNER, toolColor } from './render-utils';

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
  const isExpanded = block.expanded ?? block.status === 'error';
  const hasSummary = block.summary ? block.summary.trimEnd().length > 0 : false;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={toolColor(block.status, dt)}>● </Text>
        <Text color={dt.primary}>{block.name}</Text>
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
