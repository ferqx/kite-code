import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import type { SubAgentRole } from '@/protocol/events';
import { useTheme } from '../theme';
import type { OutputBlock } from '../types';
import { formatReadFileRange, SPINNER, toolColor } from './render-utils';

function roleLabel(role: SubAgentRole): string {
  switch (role) {
    case 'explore':
      return 'Explore';
    case 'code':
      return 'Code';
    case 'review':
      return 'Review';
    default:
      return role;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/** 将文本截断到指定宽度，超出部分用 "…" 替代。
 *  Truncate text to fit within maxWidth columns, appending "…" if truncated. */
function truncateToFit(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const w = stringWidth(text);
  if (w <= maxWidth) return text;
  const target = maxWidth - 1; // reserve 1 column for "…"
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

/** Extract human-readable label from tool args */
function toolArgsLabel(name: string, args: Record<string, unknown>, totalLines?: number): string {
  switch (name) {
    case 'read_file': {
      const p = args.path;
      const filename = typeof p === 'string' ? p.replace(/^.*[/\\]/, '').slice(-50) : '';
      const range = formatReadFileRange(args, totalLines);
      return `${filename}${range}`;
    }
    case 'edit_file':
    case 'write_file': {
      const p = args.path;
      return typeof p === 'string' ? p.replace(/^.*[/\\]/, '').slice(-50) : '';
    }
    case 'shell_execute':
    case 'bash': {
      const c = args.command;
      return typeof c === 'string' ? c.slice(0, 80) : '';
    }
    case 'grep': {
      const q = args.pattern ?? args.query;
      return typeof q === 'string' ? `"${q.slice(0, 60)}"` : '';
    }
    case 'glob': {
      const p = args.pattern;
      return typeof p === 'string' ? p.slice(0, 60) : '';
    }
    case 'read_mcp_resource': {
      const u = args.uri ?? args.resource;
      return typeof u === 'string' ? u.slice(0, 60) : '';
    }
    case 'ask_user': {
      const q = args.question;
      return typeof q === 'string' ? q.slice(0, 60) : '';
    }
    default: {
      // pick first string arg that isn't obviously content
      const keys = Object.keys(args);
      if (keys.length === 1) {
        const v = args[keys[0]!];
        return typeof v === 'string' ? v.slice(0, 60) : '';
      }
      const labelKey = keys.find((k) =>
        ['path', 'name', 'command', 'pattern', 'query', 'url', 'uri'].includes(k),
      );
      if (labelKey) {
        const v = args[labelKey];
        return typeof v === 'string' ? v.slice(0, 60) : '';
      }
      return '';
    }
  }
}

/** Truncate task text to a readable one-liner */
function taskLabel(task: string): string {
  const firstLine = task.split('\n')[0]?.trim() ?? task;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

const MAX_RUNNING_STEPS = 5;

interface SubAgentBlockProps {
  block: OutputBlock & { kind: 'subagent' };
}

export default function SubAgentBlock({ block }: SubAgentBlockProps) {
  const dt = useTheme();
  const label = roleLabel(block.role);
  const taskSummary = taskLabel(block.task);
  const col = process.stdout.columns ?? 80;

  // Live elapsed time + spinner for running state
  const [liveElapsed, setLiveElapsed] = useState(0);
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    if (block.status !== 'running') return;
    startRef.current = Date.now();
    setLiveElapsed(0);
    setSpinnerIdx(0);
    const elapsedTimer = setInterval(() => setLiveElapsed(Date.now() - startRef.current), 200);
    const spinnerTimer = setInterval(() => setSpinnerIdx((i) => (i + 1) % SPINNER.length), 80);
    return () => {
      clearInterval(elapsedTimer);
      clearInterval(spinnerTimer);
    };
  }, [block.status]);

  if (block.status === 'running') {
    const spinner = SPINNER[spinnerIdx];
    const stepCount = block.steps.length;
    const visibleSteps =
      stepCount > MAX_RUNNING_STEPS ? block.steps.slice(-MAX_RUNNING_STEPS) : block.steps;
    const skipped = stepCount - MAX_RUNNING_STEPS;

    const runDur = formatDuration(liveElapsed);
    const headRunBefore = stringWidth(`${spinner} ${label} · `);
    const fitRunTask = truncateToFit(taskSummary, Math.max(0, col - headRunBefore - 2));

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.warning}>{spinner} </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {fitRunTask}</Text>
        </Box>
        {skipped > 0 && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>... 以上 {skipped} 步已折叠</Text>
          </Box>
        )}
        {visibleSteps.map((step, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={dt.dim}>├─ {step.toolName}</Text>
            {step.toolArgs &&
              Object.keys(step.toolArgs).length > 0 &&
              (() => {
                const rawLabel = toolArgsLabel(step.toolName, step.toolArgs, step.totalLines);
                if (!rawLabel) return null;
                const stepPreW = stringWidth(`├─ ${step.toolName}`);
                const stepSufW = step.ok !== undefined ? 2 : 0; // " ✓" or " ✗"
                const fitLabel = truncateToFit(
                  rawLabel,
                  Math.max(0, col - 3 - stepPreW - stepSufW - 2),
                );
                return fitLabel ? <Text color={dt.muted}> {fitLabel}</Text> : null;
              })()}
            {step.ok !== undefined && (
              <Text color={step.ok ? dt.success : dt.error}> {step.ok ? '✓' : '✗'}</Text>
            )}
          </Box>
        ))}
        <Box paddingLeft={3}>
          <Text color={dt.dim}>└─ 进行中 ({runDur})</Text>
        </Box>
      </Box>
    );
  }

  // ── Settled (done or error): same layout as running, with final summary ──
  const settled = block.status === 'done' || block.status === 'error';
  if (settled) {
    const stepCount = block.steps.length;
    const visibleSteps =
      stepCount > MAX_RUNNING_STEPS ? block.steps.slice(-MAX_RUNNING_STEPS) : block.steps;
    const skipped = stepCount - MAX_RUNNING_STEPS;
    const isError = block.status === 'error';
    const doneDur = formatDuration(block.durationMs);
    const headDoneBefore = stringWidth(`● ${label} · `);
    const fitDoneTask = truncateToFit(taskSummary, Math.max(0, col - headDoneBefore - 2));

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={toolColor(block.status, dt)}>● </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {fitDoneTask}</Text>
        </Box>
        {skipped > 0 && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>... 以上 {skipped} 步已折叠</Text>
          </Box>
        )}
        {visibleSteps.map((step, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={dt.dim}>├─ {step.toolName}</Text>
            {step.toolArgs &&
              Object.keys(step.toolArgs).length > 0 &&
              (() => {
                const rawLabel = toolArgsLabel(step.toolName, step.toolArgs, step.totalLines);
                if (!rawLabel) return null;
                const stepPreW = stringWidth(`├─ ${step.toolName}`);
                const stepSufW = step.ok !== undefined ? 2 : 0; // " ✓" or " ✗"
                const fitLabel = truncateToFit(
                  rawLabel,
                  Math.max(0, col - 3 - stepPreW - stepSufW - 2),
                );
                return fitLabel ? <Text color={dt.muted}> {fitLabel}</Text> : null;
              })()}
            {step.ok !== undefined && (
              <Text color={step.ok ? dt.success : dt.error}> {step.ok ? '✓' : '✗'}</Text>
            )}
          </Box>
        ))}
        {(() => {
          if (isError) {
            const errText = block.error || 'Error';
            const fitErr = truncateToFit(errText, Math.max(0, col - 3 - 3 - 2));
            return (
              <Box paddingLeft={3}>
                <Text color={dt.error}>└─ {fitErr}</Text>
              </Box>
            );
          }
          // done — show with duration
          const doneLine = `done! (${doneDur})`;
          const fitDone = truncateToFit(doneLine, Math.max(0, col - 3 - 3 - 2));
          return (
            <Box paddingLeft={3}>
              <Text color={dt.dim}>└─ {fitDone}</Text>
            </Box>
          );
        })()}
      </Box>
    );
  }

  return null;
}
