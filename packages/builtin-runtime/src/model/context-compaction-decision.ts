import { findSafeCompactionBoundary } from './compaction';
import { expectedCompactionSourceDigest } from './compaction-summary';
import type { ContextPreflight } from './context-budget';
import type { BuiltinRuntimeStateView } from './runtime-view';

export type AutomaticCompactionDecision =
  | { action: 'invoke' }
  | {
      action: 'request_compaction';
      reason: 'auto';
      compactionId: string;
    };

export function decideAutomaticContextCompaction(input: {
  state: Readonly<BuiltinRuntimeStateView>;
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

  // Retry only after the transcript source changes. Legacy failures without a
  // source digest use their turn identity to avoid an immediate retry loop.
  const lastFailure = input.state.context.lastFailure;
  if (
    lastFailure?.reason === 'auto' &&
    (lastFailure.sourceDigest
      ? lastFailure.sourceDigest ===
        expectedCompactionSourceDigest(
          input.state.context.activeCheckpoint?.sourceDigest,
          input.state.transcript.messages,
        )
      : lastFailure.requestedAtTurnId === input.state.turn.turnId)
  ) {
    return { action: 'invoke' };
  }

  const boundary = findSafeCompactionBoundary(input.state, { protectLatestTurn: true });
  if (!boundary.eligible) {
    return { action: 'invoke' };
  }

  // Repeating the same checkpoint cannot reduce any new transcript content.
  if (boundary.lastMessageId === input.state.context.activeCheckpoint?.coveredThroughMessageId) {
    return { action: 'invoke' };
  }

  return {
    action: 'request_compaction',
    reason: 'auto',
    compactionId: crypto.randomUUID(),
  };
}

// ── Thrash breaker update helpers ──

/**
 * Update the auto guard after a completed or failed compaction.
 * Returns the new guard state (caller should persist via reducer).
 */
export function updateAutoCompactionGuard(
  guard: BuiltinRuntimeStateView['context']['autoGuard'],
  event:
    | { kind: 'completed'; turnIndex: number; reductionRatio: number; tokensAfter: number }
    | { kind: 'low_gain' }
    | { kind: 'manual_reset' },
): BuiltinRuntimeStateView['context']['autoGuard'] {
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
      disabledUntilManualAction: false,
    };
  }

  // completed
  const recent = [
    {
      turnIndex: event.turnIndex,
      reductionRatio: event.reductionRatio,
      tokensAfter: event.tokensAfter,
    },
  ];

  return {
    recentAutomaticCompactions: recent,
    consecutiveLowGain: 0, // reset on successful compaction
    disabledUntilManualAction: false,
    recoveryAttempted: false,
  };
}
export type ContextCompactionAutoMode = 'off' | 'shadow' | 'live';
