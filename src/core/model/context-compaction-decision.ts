import type { RuntimeState } from '@/core/runtime/state';
import { countTokens } from '@/core/token-counter';
import { findSafeCompactionBoundary } from './compaction-v2';
import type { ContextPreflight } from './context-budget';

export type AutomaticCompactionDecision =
  | { action: 'invoke' }
  | {
      action: 'request_compaction';
      reason: 'auto_soft' | 'auto_hard';
      compactionId: string;
    }
  | { action: 'block'; reason: string };

export function decideAutomaticContextCompaction(input: {
  state: Readonly<RuntimeState>;
  preflight: ContextPreflight;
  enabled: boolean;
  recentTurns?: number;
  cooldownTurns?: number;
  minimumReductionRatio?: number;
  maxSummaryTokens?: number;
}): AutomaticCompactionDecision {
  if (!input.enabled || !['soft', 'hard'].includes(input.preflight.status)) {
    return { action: 'invoke' };
  }
  if (input.state.context.pendingCompaction) {
    return {
      action: 'block',
      reason: 'A context compaction request is already pending.',
    };
  }
  const hard = input.preflight.status === 'hard';
  const boundary = findSafeCompactionBoundary(input.state, {
    recentTurns: input.recentTurns ?? 3,
  });
  if (!boundary.eligible) {
    return hard
      ? {
          action: 'block',
          reason: `Context hard limit reached without a safe compaction boundary: ${boundary.reason}`,
        }
      : { action: 'invoke' };
  }

  if (!hard) {
    const lastTurn = input.state.context.lastCompactionTurnIndex;
    if (lastTurn != null && input.state.turn.turnIndex - lastTurn < (input.cooldownTurns ?? 3)) {
      return { action: 'invoke' };
    }
    const lastFailure = input.state.context.lastFailure;
    if (
      lastFailure?.reason === 'auto_soft' &&
      input.state.revision <= lastFailure.sourceRevision + 1
    ) {
      return { action: 'invoke' };
    }
    const coveredTokens = countTokens(JSON.stringify(boundary.coveredMessages));
    const estimatedSummaryTokens = Math.min(input.maxSummaryTokens ?? 6_000, coveredTokens * 0.25);
    const estimatedReduction = Math.max(0, coveredTokens - estimatedSummaryTokens);
    if (
      estimatedReduction / Math.max(1, input.preflight.estimate.totalInputTokens) <
      (input.minimumReductionRatio ?? 0.15)
    ) {
      return { action: 'invoke' };
    }
  }

  return {
    action: 'request_compaction',
    reason: hard ? 'auto_hard' : 'auto_soft',
    compactionId: crypto.randomUUID(),
  };
}

export function isProviderContextOverflow(error: unknown): boolean {
  const record =
    error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const status = record?.status ?? record?.statusCode;
  const code = String(record?.code ?? record?.type ?? '').toLowerCase();
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    status === 413 ||
    code.includes('context_length') ||
    code.includes('context_window') ||
    /context (length|window).*(exceed|limit|maximum)|maximum context|too many tokens/.test(message)
  );
}
