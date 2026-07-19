import type { AgentConfig } from '@/core/config';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import { countTokens } from '@/core/token-counter';
import { findSafeCompactionBoundary } from './compaction-v2';
import type { ContextTokenEstimate } from './context-budget';
import { preflightModelContext } from './context-budget';
import { resolveModelCapabilities } from './model-capabilities';

function fallbackEstimate(state: Readonly<RuntimeState>): ContextTokenEstimate {
  const checkpoint = state.context.activeCheckpoint;
  // When a checkpoint is active, only count transcript messages past the checkpoint;
  // pre-checkpoint messages are covered by the summary and must not be double-counted.
  const activeMessages = checkpoint
    ? (() => {
        const idx = state.transcript.messages.findIndex(
          (m) => m.messageId === checkpoint.coveredThroughMessageId,
        );
        return idx >= 0 ? state.transcript.messages.slice(idx + 1) : state.transcript.messages;
      })()
    : state.transcript.messages;
  const transcriptTokens = countTokens(JSON.stringify(activeMessages));
  const summaryTokens = checkpoint ? countTokens(JSON.stringify(checkpoint.summary)) : 0;
  return {
    systemTokens: 0,
    toolSchemaTokens: 0,
    transcriptTokens,
    summaryTokens,
    dynamicRuntimeTokens: 0,
    framingTokens: activeMessages.length * 4,
    totalInputTokens: transcriptTokens + summaryTokens + activeMessages.length * 4,
  };
}

export function currentContextPreflight(state: Readonly<RuntimeState>, config: AgentConfig) {
  if (state.context.lastPreflight) return state.context.lastPreflight;
  return preflightModelContext({
    estimate: fallbackEstimate(state),
    capabilities: resolveModelCapabilities({ config }),
    requestMaxOutputTokens: config.modelCapabilities?.maxOutputTokens,
    softRatio: config.compaction?.softRatio,
    hardRatio: config.compaction?.hardRatio,
    targetRatio: config.compaction?.targetRatio,
  });
}

export interface ManualCompactionStatus {
  preflight: ReturnType<typeof currentContextPreflight>;
  safeBoundary: ReturnType<typeof findSafeCompactionBoundary>;
  pendingCompactionId?: string;
  activeCheckpointId?: string;
  coveredThroughMessageId?: string;
  inputTokensBefore?: number;
  inputTokensAfter?: number;
  lastFailure?: RuntimeState['context']['lastFailure'];
}

export function inspectManualContextCompaction(
  state: Readonly<RuntimeState>,
  config: AgentConfig,
): ManualCompactionStatus {
  const checkpoint = state.context.activeCheckpoint;
  return {
    preflight: currentContextPreflight(state, config),
    safeBoundary: findSafeCompactionBoundary(state, {
      recentTurns: config.compaction?.recentTurns,
    }),
    ...(state.context.pendingCompaction
      ? { pendingCompactionId: state.context.pendingCompaction.compactionId }
      : {}),
    ...(checkpoint
      ? {
          activeCheckpointId: checkpoint.compactionId,
          coveredThroughMessageId: checkpoint.coveredThroughMessageId,
          inputTokensBefore: checkpoint.inputTokensBefore,
          inputTokensAfter: checkpoint.inputTokensAfter,
        }
      : {}),
    ...(state.context.lastFailure ? { lastFailure: state.context.lastFailure } : {}),
  };
}

export function manualContextCompactionEvent(input: {
  state: Readonly<RuntimeState>;
  config: AgentConfig;
  /** Optional user-supplied instructions for the summary model. */
  customInstructions?: string;
}): RuntimeEvent | null {
  if (input.state.context.pendingCompaction) return null;
  return {
    type: 'context.compaction_requested',
    compactionId: crypto.randomUUID(),
    reason: 'manual',
    requestedAtRevision: input.state.revision,
    requestedAtTurnId: input.state.turn.turnId,
    force: false,
    estimate: currentContextPreflight(input.state, input.config).estimate,
    ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
  };
}
