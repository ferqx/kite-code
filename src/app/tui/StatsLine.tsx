import { Box, Text, useStdout } from 'ink';
import { listAvailableModels } from '@/core/config';
import { InteractionMode } from '@/protocol/events';
import { useTheme } from './theme';
import type { StatusState } from './types';

interface StatsLineProps {
  status: StatusState;
  running: boolean;
  modelProvider?: string;
  modelName?: string;
  interactionMode?: 'ask' | 'auto' | 'full';
  planMode?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** Estimate the visible width of the full stats line. */
function fullWidth(
  status: StatusState,
  interactionMode?: string,
  planMode?: boolean,
  contextPct?: string,
): number {
  let w = status.modelName.length;
  const isDS = status.modelProvider === 'deepseek';
  if (isDS && status.thinkingMode) w += 3 + String(status.thinkingMode).length; // " · medium"
  if (isDS && status.totalTokens > 0) w += 3 + 7 + 3; // " · cache: 0%"
  if (contextPct)
    w += 3 + contextPct.length + 8; // " · 30% context"
  else if (status.totalTokens > 0) w += 3 + 8 + formatTokens(status.totalTokens).length; // " · tokens: 78.4k"
  if (interactionMode && interactionMode !== 'ask') w += 3 + 6;
  // plan mode adds: "  Shift+Tab to exit" ≈ 19 chars
  if (planMode) w += 19;
  return w;
}

export default function StatsLine({ status, interactionMode, planMode }: StatsLineProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const cacheTotal = status.cacheHitTokens + status.cacheMissTokens;
  const cachePct = cacheTotal > 0 ? (status.cacheHitTokens / cacheTotal) * 100 : 0;
  const cacheColor = cachePct > 50 ? t.success : cachePct > 20 ? t.warning : t.muted;

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

  // Look up context window from model config; compute percentage if available
  const models = listAvailableModels();
  const currentModel = models.find(
    (m) => m.provider === (status.modelProvider || 'deepseek') && m.name === status.modelName,
  );
  const cw = currentModel?.contextWindow;
  const contextPct =
    cw && cw > 0 ? `${Math.round((status.totalTokens / cw) * 100)}% context` : null;
  const showTokens = !contextPct && status.totalTokens > 0;

  const cols = stdout?.columns ?? 80;
  const compact = fullWidth(status, interactionMode, planMode, contextPct ?? undefined) > cols;

  return (
    <Box>
      {/* Left side: model + config chips */}
      <Text color={t.muted}>{status.modelName}</Text>
      {!compact && showThink && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={t.success}>{status.thinkingMode}</Text>
        </>
      )}
      {!compact && showCache && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={cacheColor}>{cachePct.toFixed(0)}%</Text>
          <Text color={t.muted}> cache</Text>
        </>
      )}
      {!compact && contextPct && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={t.muted}>{contextPct}</Text>
        </>
      )}
      {!compact && showTokens && (
        <>
          <Text color={t.dim}> · </Text>
          <Text>{formatTokens(status.totalTokens)}</Text>
        </>
      )}
      {label && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={labelColor}>[{label}]</Text>
        </>
      )}
      {/* Spacer — push hint to the right */}
      {!compact && planMode && <Box flexGrow={1} />}
      {/* Right side: Shift+Tab to exit hint */}
      {!compact && planMode && <Text color={t.dim}>Shift+Tab to exit</Text>}
    </Box>
  );
}
