import { findSafeCompactionBoundary } from './compaction-v2';
import type { ContextPreflight } from './context-budget';
import type { BuiltinRuntimeStateViewV1 } from './runtime-view';

export type AutomaticCompactionDecision =
  | { action: 'invoke' }
  | {
      action: 'request_compaction';
      reason: 'auto';
      compactionId: string;
    };

/** Thrash breaker configuration. */
export const THRASH_CONFIG = {
  /** Max auto compactions within the window before disabling. */
  maxAutoCompactionsPerWindow: 3,
  /** Window size in turns. */
  autoCompactionWindowTurns: 10,
  /** Consecutive low-gain compactions before disabling. */
  maxConsecutiveLowGain: 2,
} as const;

export function decideAutomaticContextCompaction(input: {
  state: Readonly<BuiltinRuntimeStateViewV1>;
  preflight: ContextPreflight;
  mode: ContextCompactionAutoMode;
  triggerRatio?: number;
  compactAfterEstimatedTokens?: number;
  cooldownTurns?: number;
  minimumReductionRatio?: number;
  maxSummaryTokens?: number;
}): AutomaticCompactionDecision {
  if (input.mode === 'off') {
    return { action: 'invoke' };
  }

  const ratioThreshold = input.triggerRatio ?? 0.9;
  const ratioEligible =
    input.preflight.utilization != null && input.preflight.utilization >= ratioThreshold;
  const tokenEligible =
    input.compactAfterEstimatedTokens != null &&
    input.preflight.estimate.totalInputTokens >= input.compactAfterEstimatedTokens;
  if (!ratioEligible && !tokenEligible) return { action: 'invoke' };

  // Shadow mode computes eligibility only; it never invokes the summary model
  // or writes a checkpoint.
  if (input.mode === 'shadow') return { action: 'invoke' };

  if (input.state.context.pendingCompaction) {
    return { action: 'invoke' };
  }

  const boundary = findSafeCompactionBoundary(input.state, { protectLatestTurn: true });
  if (!boundary.eligible) {
    return { action: 'invoke' };
  }

  // ── Thrash breaker: stop proactive auto if compacting too frequently ──
  const guard = input.state.context.autoGuard;
  const retryingPreviousTurnFailure =
    input.state.context.lastFailure?.reason === 'auto' &&
    input.state.context.lastFailure.retryable &&
    input.state.context.lastFailure.requestedAtTurnId !== input.state.turn.turnId &&
    !guard.recoveryAttempted;
  if (
    input.state.context.lastFailure?.reason === 'auto' &&
    (!input.state.context.lastFailure.retryable || guard.recoveryAttempted)
  ) {
    return { action: 'invoke' };
  }
  if (guard.disabledUntilManualAction && !retryingPreviousTurnFailure) {
    return { action: 'invoke' };
  }

  // ── Cooldown ──
  const lastTurn = input.state.context.lastCompactionTurnIndex;
  if (
    !retryingPreviousTurnFailure &&
    lastTurn != null &&
    input.state.turn.turnIndex - lastTurn < (input.cooldownTurns ?? 3)
  ) {
    return { action: 'invoke' };
  }
  // ── Expected reduction check (coarse, real check runs post-generation) ──
  const minimumReductionRatio = input.minimumReductionRatio ?? 0.15;
  if (minimumReductionRatio > 0 && boundary.coveredMessages.length > 0) {
    const totalTokens = input.preflight.estimate.totalInputTokens;
    const coveredTokens =
      boundary.coveredMessages.reduce(
        (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
        0,
      ) / 4;
    const estimatedSummaryTokens = Math.min(input.maxSummaryTokens ?? 6_000, coveredTokens * 0.25);
    const estimatedReduction = coveredTokens - estimatedSummaryTokens;
    if (totalTokens > 0 && estimatedReduction / totalTokens < minimumReductionRatio) {
      return { action: 'invoke' };
    }
  }

  return {
    action: 'request_compaction',
    reason: 'auto',
    compactionId: crypto.randomUUID(),
  };
}

// ── Thrash breaker update helpers ──

export interface ThrashUpdateInput {
  guard: typeof THRASH_CONFIG extends infer C ? C : never;
  currentTurnIndex: number;
  reductionRatio: number;
  tokensAfter: number;
}

/**
 * Update the auto guard after a completed or failed compaction.
 * Returns the new guard state (caller should persist via reducer).
 */
export function updateAutoCompactionGuard(
  guard: BuiltinRuntimeStateViewV1['context']['autoGuard'],
  event:
    | { kind: 'completed'; turnIndex: number; reductionRatio: number; tokensAfter: number }
    | { kind: 'low_gain' }
    | { kind: 'manual_reset' },
): BuiltinRuntimeStateViewV1['context']['autoGuard'] {
  if (event.kind === 'manual_reset') {
    return {
      recentAutomaticCompactions: [],
      consecutiveLowGain: 0,
      disabledUntilManualAction: false,
      recoveryAttempted: false,
    };
  }

  if (event.kind === 'low_gain') {
    const consecutiveLowGain = guard.consecutiveLowGain + 1;
    return {
      ...guard,
      consecutiveLowGain,
      disabledUntilManualAction: consecutiveLowGain >= THRASH_CONFIG.maxConsecutiveLowGain,
    };
  }

  // completed
  const recent = [
    ...guard.recentAutomaticCompactions,
    {
      turnIndex: event.turnIndex,
      reductionRatio: event.reductionRatio,
      tokensAfter: event.tokensAfter,
    },
  ].filter((entry) => event.turnIndex - entry.turnIndex <= THRASH_CONFIG.autoCompactionWindowTurns);

  const tooFrequent = recent.length >= THRASH_CONFIG.maxAutoCompactionsPerWindow;
  // Check if context refilled within 1 turn after last compaction
  const refilledFast =
    recent.length >= 2 && recent[recent.length - 2]!.turnIndex >= event.turnIndex - 1;

  return {
    recentAutomaticCompactions: recent,
    consecutiveLowGain: 0, // reset on successful compaction
    disabledUntilManualAction: tooFrequent || refilledFast,
    recoveryAttempted: false,
  };
}
export type ContextCompactionAutoMode = 'off' | 'shadow' | 'live';
