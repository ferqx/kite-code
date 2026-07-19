import type { RuntimeState } from '@/core/runtime/state';
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
  state: Readonly<RuntimeState>;
  preflight: ContextPreflight;
  enabled: boolean;
  recentTurns?: number;
  cooldownTurns?: number;
  minimumReductionRatio?: number;
  maxSummaryTokens?: number;
}): AutomaticCompactionDecision {
  // ── Guard rails ──
  if (!input.enabled || !['compact_due', 'hard_limit'].includes(input.preflight.status)) {
    return { action: 'invoke' };
  }

  // ── Durable hard block ──
  if (input.state.context.hardBlock) {
    return {
      action: 'block',
      reason: `Context is hard-blocked: ${input.state.context.hardBlock.reason}. Use /compact reset or start a new session.`,
    };
  }

  if (input.state.context.pendingCompaction) {
    return {
      action: 'block',
      reason: 'A context compaction request is already pending.',
    };
  }

  const isHardLimit = input.preflight.status === 'hard_limit';
  const boundary = findSafeCompactionBoundary(input.state, {
    recentTurns: input.recentTurns ?? 3,
  });
  if (!boundary.eligible) {
    return isHardLimit
      ? {
          action: 'block',
          reason: `Context hard limit reached without a safe compaction boundary: ${boundary.reason}`,
        }
      : { action: 'invoke' };
  }

  // ── Thrash breaker: stop proactive auto if compacting too frequently ──
  const guard = input.state.context.autoGuard;
  if (guard.disabledUntilManualAction) {
    // Proactive auto disabled — still allow one overflow recovery attempt
    // (overflow recovery is handled separately by the model-controller, not here).
    return isHardLimit
      ? {
          action: 'block',
          reason:
            'Auto-compaction paused (context refilled too quickly). Use /compact with focus instructions or start a new session.',
        }
      : { action: 'invoke' };
  }

  if (!isHardLimit) {
    // ── Cooldown ──
    const lastTurn = input.state.context.lastCompactionTurnIndex;
    if (lastTurn != null && input.state.turn.turnIndex - lastTurn < (input.cooldownTurns ?? 3)) {
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
      const estimatedSummaryTokens = Math.min(
        input.maxSummaryTokens ?? 6_000,
        coveredTokens * 0.25,
      );
      const estimatedReduction = coveredTokens - estimatedSummaryTokens;
      if (totalTokens > 0 && estimatedReduction / totalTokens < minimumReductionRatio) {
        return { action: 'invoke' };
      }
    }
  }

  return {
    action: 'request_compaction',
    reason: isHardLimit ? 'auto_hard' : 'auto_soft',
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
  guard: RuntimeState['context']['autoGuard'],
  event:
    | { kind: 'completed'; turnIndex: number; reductionRatio: number; tokensAfter: number }
    | { kind: 'low_gain' }
    | { kind: 'manual_reset' },
): RuntimeState['context']['autoGuard'] {
  if (event.kind === 'manual_reset') {
    return {
      recentAutomaticCompactions: [],
      consecutiveLowGain: 0,
      disabledUntilManualAction: false,
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
  };
}

// ── Provider overflow error standardization ──

/**
 * Standardized provider context overflow error.
 * Provider adapters should convert raw errors to this type so the Runtime
 * doesn't parse arbitrary error strings.
 */
export class ProviderContextOverflowError extends Error {
  provider: string;
  model: string;
  actualInputTokens?: number;
  limitTokens?: number;

  constructor(input: {
    provider: string;
    model: string;
    message: string;
    actualInputTokens?: number;
    limitTokens?: number;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = 'ProviderContextOverflowError';
    this.provider = input.provider;
    this.model = input.model;
    this.actualInputTokens = input.actualInputTokens;
    this.limitTokens = input.limitTokens;
    if (input.cause) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }
}

export function isProviderContextOverflow(error: unknown): boolean {
  if (error instanceof ProviderContextOverflowError) return true;
  // Legacy detection: fall back to string/status matching for non-standardized errors.
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
