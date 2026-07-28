import { Box, Text, useStdout } from 'ink';
import type { SandboxBackend } from '@/core/sandbox';
import { InteractionMode } from '@/protocol/events';
import { executionBoundaryLabel } from './interaction-mode';
import { useTheme } from './theme';
import type { StatusState } from './types';

interface StatsLineProps {
  status: StatusState;
  running: boolean;
  modelProvider?: string;
  modelName?: string;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  planMode?: boolean;
  sandboxBackend?: SandboxBackend;
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
  absoluteContextTokens?: number,
  boundaryLabel?: string | null,
): number {
  let w = status.modelName.length;
  const isDS = status.modelProvider === 'deepseek';
  if (isDS && status.thinkingMode) w += 3 + String(status.thinkingMode).length; // " · medium"
  if (isDS && status.totalTokens > 0) w += 3 + 7 + 3; // " · cache: 0%"
  if (contextPct)
    w += 3 + contextPct.length + 8; // " · 30% context"
  else if (absoluteContextTokens != null && absoluteContextTokens > 0)
    w += 3 + formatTokens(absoluteContextTokens).length;
  if (interactionMode) w += 3 + 6;
  if (boundaryLabel) w += 3 + boundaryLabel.length + 2;
  // plan mode adds: "  Shift+Tab to exit" ≈ 19 chars
  if (planMode) w += 19;
  return w;
}

export default function StatsLine({
  status,
  interactionMode,
  planMode,
  sandboxBackend,
}: StatsLineProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const cacheTotal = status.cacheHitTokens + status.cacheMissTokens;
  const cachePct = cacheTotal > 0 ? (status.cacheHitTokens / cacheTotal) * 100 : 0;
  const cacheColor = cachePct > 50 ? t.success : cachePct > 20 ? t.warning : t.muted;

  const label =
    interactionMode === InteractionMode.Auto
      ? '自动审批'
      : interactionMode === InteractionMode.Full
        ? '完全权限'
        : '接受编辑';
  const labelColor =
    interactionMode === InteractionMode.Auto
      ? t.success
      : interactionMode === InteractionMode.Full
        ? t.warning
        : t.muted;

  const isDeepSeek = status.modelProvider === 'deepseek';
  const showThink = isDeepSeek && !!status.thinkingMode;
  const showCache = isDeepSeek && status.totalTokens > 0;

  const contextPct =
    status.contextSnapshot?.utilization != null
      ? `${Math.round(status.contextSnapshot.utilization * 100)}% context`
      : null;
  const absoluteContextTokens =
    status.contextSnapshot?.estimate.totalInputTokens ?? status.totalTokens;
  const showTokens = !contextPct && absoluteContextTokens > 0;
  const boundaryLabel = sandboxBackend
    ? executionBoundaryLabel(process.platform, sandboxBackend)
    : null;

  const cols = stdout?.columns ?? 80;
  const compact =
    fullWidth(
      status,
      interactionMode,
      planMode,
      contextPct ?? undefined,
      absoluteContextTokens,
      boundaryLabel,
    ) > cols;

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
          <Text>{formatTokens(absoluteContextTokens)}</Text>
        </>
      )}
      {interactionMode && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={labelColor}>[{label}]</Text>
        </>
      )}
      {boundaryLabel && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={t.warning}>[{boundaryLabel}]</Text>
        </>
      )}
      {/* Spacer — push hint to the right */}
      {!compact && planMode && <Box flexGrow={1} />}
      {/* Right side: Shift+Tab to exit hint */}
      {!compact && planMode && <Text color={t.dim}>Shift+Tab to exit</Text>}
    </Box>
  );
}
