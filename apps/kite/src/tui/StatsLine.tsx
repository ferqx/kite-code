import { InteractionMode } from '@kite/runtime-contract';
import { Box, Text, useStdout } from 'ink';
import stringWidth from 'string-width';
import { useI18n } from './i18n';
import { useTheme } from './theme';
import type { StatusState } from './types';

interface StatsLineProps {
  status: StatusState;
  running: boolean;
  modelProvider?: string;
  modelName?: string;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  planMode?: boolean;
}

function formatTokens(n: number, formatNumber: (value: number) => string): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return formatNumber(n);
}

export default function StatsLine({ status, interactionMode, planMode }: StatsLineProps) {
  const t = useTheme();
  const { formatNumber, t: translate } = useI18n();
  const { stdout } = useStdout();
  const cacheTotal = status.cacheHitTokens + status.cacheMissTokens;
  const cachePct = cacheTotal > 0 ? (status.cacheHitTokens / cacheTotal) * 100 : 0;
  const cacheColor = cachePct > 50 ? t.success : cachePct > 20 ? t.warning : t.muted;

  const label =
    interactionMode === InteractionMode.Auto
      ? translate('stats.auto')
      : interactionMode === InteractionMode.Full
        ? translate('stats.fullAccess')
        : translate('stats.acceptEdits');
  const labelColor =
    interactionMode === InteractionMode.Auto
      ? t.success
      : interactionMode === InteractionMode.Full
        ? t.warning
        : t.muted;

  const isDeepSeek = status.modelProvider === 'deepseek';
  // The routed provider may be a compatible/custom endpoint even when the
  // selected model supports reasoning. The persisted thinking mode is the
  // authoritative presentation state, not the provider identifier.
  const showThink = status.reasoningEnabled !== false && !!status.thinkingMode;
  const showCache = isDeepSeek && status.totalTokens > 0;

  const contextPct =
    status.contextSnapshot?.utilization != null
      ? translate('stats.context', {
          percent: Math.round(status.contextSnapshot.utilization * 100),
        })
      : null;
  const absoluteContextTokens =
    status.contextSnapshot?.estimate.totalInputTokens ?? status.totalTokens;
  const showTokens = !contextPct && absoluteContextTokens > 0;
  const tokenText = showTokens ? formatTokens(absoluteContextTokens, formatNumber) : undefined;
  const planHint = planMode ? translate('stats.exitPlanMode') : undefined;
  const visibleSegments = [
    status.modelName,
    showThink ? String(status.thinkingMode) : undefined,
    showCache ? `${cachePct.toFixed(0)}% cache` : undefined,
    contextPct ?? tokenText,
    interactionMode ? `[${label}]` : undefined,
  ].filter((segment): segment is string => !!segment);

  const cols = stdout?.columns ?? 80;
  const compact = stringWidth([...visibleSegments, planHint].filter(Boolean).join(' · ')) > cols;

  return (
    <Box>
      {/* Left side: model + config chips */}
      <Text color={t.muted}>{status.modelName}</Text>
      {!compact && showThink && (
        <>
          <Text> </Text>
          <Text color={t.success}>{status.thinkingMode}</Text>
        </>
      )}
      {!compact && showCache && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={cacheColor}>{cachePct.toFixed(0)}%</Text>
          <Text color={cacheColor}> cache</Text>
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
          <Text>{tokenText}</Text>
        </>
      )}
      {interactionMode && (
        <>
          <Text color={t.dim}> · </Text>
          <Text color={labelColor}>[{label}]</Text>
        </>
      )}
      {/* Spacer — push hint to the right */}
      {!compact && planMode && <Box flexGrow={1} />}
      {/* Right side: Shift+Tab to exit hint */}
      {!compact && planHint && <Text color={t.dim}>{planHint}</Text>}
    </Box>
  );
}
