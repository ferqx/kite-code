import { Box, Text, useStdout } from 'ink';
import { InteractionMode } from '@/protocol/events';
import { useTheme } from './theme';
import type { StatusState } from './types';

interface StatsLineProps {
  status: StatusState;
  running: boolean;
  modelProvider?: string;
  modelName?: string;
  interactionMode?: 'ask' | 'auto' | 'full';
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** Estimate the visible width of the full stats line. */
function fullWidth(status: StatusState, interactionMode?: string): number {
  let w = status.modelName.length;
  const isDS = status.modelProvider === 'deepseek';
  if (isDS && status.thinkingMode) w += 3 + 7 + String(status.thinkingMode).length; // " · effort: max"
  if (isDS && status.totalTokens > 0) w += 3 + 7 + 3; // " · cache: 0%"
  if (status.totalTokens > 0) w += 3 + 8 + formatTokens(status.totalTokens).length; // " · tokens: 78.4k"
  // Non-default mode: label like " · [自动审批]" (~8 chars)
  if (interactionMode && interactionMode !== 'ask') w += 3 + 6;
  return w;
}

export default function StatsLine({ status, interactionMode }: StatsLineProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const cacheTotal = status.cacheHitTokens + status.cacheMissTokens;
  const cachePct = cacheTotal > 0 ? (status.cacheHitTokens / cacheTotal) * 100 : 0;
  const cacheColor = cachePct > 50 ? t.success : cachePct > 20 ? t.warning : t.muted;

  // Mode label: ask=默认不显示，auto=自动审批，full=完全权限
  const isDefault = !interactionMode || interactionMode === InteractionMode.Ask;
  const label = isDefault
    ? null
    : interactionMode === InteractionMode.Auto
      ? '自动审批'
      : '完全权限';
  const labelColor = interactionMode === InteractionMode.Auto ? t.success : t.warning;

  const isDeepSeek = status.modelProvider === 'deepseek';
  const showThink = isDeepSeek && !!status.thinkingMode;
  const showCache = isDeepSeek && status.totalTokens > 0;
  const showTokens = status.totalTokens > 0;

  // When the full line would exceed the terminal width, render a shorter
  // version to prevent wrapping — wrapping causes Footer height to jump,
  // which triggers input box duplication during resize.
  const cols = stdout?.columns ?? 80;
  const compact = fullWidth(status, interactionMode) > cols;

  return (
    <Box>
      <Text color={t.muted}>{status.modelName}</Text>
      {!compact && showThink && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={t.success}>effort: {status.thinkingMode}</Text>
        </>
      )}
      {!compact && showCache && (
        <>
          <Text color={t.dim}> · </Text>
          <Text>
            <Text color={t.muted}>cache: </Text>
            <Text color={cacheColor}>{cachePct.toFixed(0)}%</Text>
          </Text>
        </>
      )}
      {!compact && showTokens && (
        <>
          <Text color={t.dim}> · </Text>
          <Text>
            <Text color={t.muted}>tokens: </Text>
            <Text>{formatTokens(status.totalTokens)}</Text>
          </Text>
        </>
      )}
      {label && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={labelColor}>[{label}]</Text>
        </>
      )}
    </Box>
  );
}
