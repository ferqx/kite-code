import type { AgentConfig } from '@/core/config';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import { countTokens } from '@/core/token-counter';
import { findSafeCompactionBoundary } from './compaction-v2';
import type { ContextPreflight, ContextTokenEstimate } from './context-budget';
import { preflightModelContext } from './context-budget';
import { buildContextProjection, type ContextProjection } from './context-projection';
import { resolveModelCapabilities } from './model-capabilities';

// TODO(PR5): replace with buildContextProjection() when candidateCheckpoint is wired in.
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
    warningRatio: config.compaction?.warningRatio,
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

// TODO: manual compaction path doesn't have access to live tool schemas
// (tools are created at model-invocation time). Candidate projection
// in the compactor will use whatever tools are stored in pendingCompaction.
// This means manual compaction's post-compaction estimate may slightly
// underestimate context size (missing tool schema tokens). Acceptable for
// manual use; the user can see actual usage via /context.
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

/**
 * Build a human-readable context usage summary for `/context`.
 * Returns a formatted string suitable for TUI display.
 */
export function buildContextStatusReport(
  state: Readonly<RuntimeState>,
  config: AgentConfig,
): {
  projection: ContextProjection;
  preflight: ContextPreflight;
  /** Formatted multi-line status text. */
  text: string;
} {
  const projection = buildContextProjection({ role: 'agent', state });
  const preflight = preflightModelContext({
    estimate: projection.estimate,
    capabilities: resolveModelCapabilities({ config }),
    requestMaxOutputTokens: config.modelCapabilities?.maxOutputTokens,
    softRatio: config.compaction?.softRatio,
    hardRatio: config.compaction?.hardRatio,
    warningRatio: config.compaction?.warningRatio,
    targetRatio: config.compaction?.targetRatio,
  });

  const e = projection.estimate;
  const utilizationPct =
    preflight.utilization != null ? `${(preflight.utilization * 100).toFixed(1)}%` : 'unknown';
  const usable = preflight.usableInputTokens ?? 'unknown';
  const checkpoint = state.context.activeCheckpoint;
  const lastCp = checkpoint
    ? `Active checkpoint: ${checkpoint.compactionId.slice(0, 12)}...  Covered through: ${checkpoint.coveredThroughTurnId}`
    : 'No active checkpoint';
  const autoStatus = state.context.autoGuard?.disabledUntilManualAction
    ? 'paused (thrash breaker)'
    : state.context.hardBlock
      ? `BLOCKED (${state.context.hardBlock.reason})`
      : 'enabled';
  const nextThreshold =
    preflight.usableInputTokens != null
      ? `${Math.floor(preflight.usableInputTokens * (config.compaction?.softRatio ?? 0.88))}`
      : 'N/A';

  const text = [
    `Context usage: ${e.totalInputTokens} / ${usable} usable tokens (${utilizationPct})`,
    ``,
    `System instructions       ${e.systemTokens}`,
    `Tool schemas              ${e.toolSchemaTokens}`,
    `Compacted history         ${e.summaryTokens}`,
    `Live transcript           ${e.transcriptTokens}`,
    `Dynamic runtime           ${e.dynamicRuntimeTokens}`,
    `Provider framing          ${e.framingTokens}`,
    ``,
    `Output reservation        ${preflight.reservedOutputTokens}`,
    `Safety margin             ${preflight.providerSafetyMarginTokens}`,
    ``,
    lastCp,
    checkpoint
      ? `Last reduction: ${checkpoint.inputTokensBefore} → ${checkpoint.inputTokensAfter} (${checkpoint.inputTokensBefore > 0 ? ((1 - checkpoint.inputTokensAfter / checkpoint.inputTokensBefore) * 100).toFixed(1) : 0}%)`
      : '',
    `Auto-compaction: ${autoStatus}`,
    `Next proactive threshold: ${nextThreshold} tokens`,
  ]
    .filter(Boolean)
    .join('\n');

  return { projection, preflight, text };
}

/**
 * Pre-check before `/compact reset`: computes whether resetting the active
 * checkpoint would cause hard overflow (blocking the reset).
 */
export function compactResetPreflight(
  state: Readonly<RuntimeState>,
  config: AgentConfig,
):
  | { safe: true }
  | { safe: false; reason: string; currentUtilization: number; hardThreshold: number } {
  const checkpoint = state.context.activeCheckpoint;
  if (!checkpoint) return { safe: true };

  // Simulate: build projection without the checkpoint.
  const noCpState: RuntimeState = {
    ...state,
    context: { ...state.context, activeCheckpoint: undefined },
  };
  const projection = buildContextProjection({ role: 'agent', state: noCpState });
  const preflight = preflightModelContext({
    estimate: projection.estimate,
    capabilities: resolveModelCapabilities({ config }),
    softRatio: config.compaction?.softRatio,
    hardRatio: config.compaction?.hardRatio,
    warningRatio: config.compaction?.warningRatio,
  });

  const hardThreshold = config.compaction?.hardRatio ?? 0.94;
  if (preflight.utilization != null && preflight.utilization >= hardThreshold) {
    return {
      safe: false,
      reason:
        'Resetting would exceed the hard limit and block the next model call. Clear the session or run /compact first to reduce context before resetting.',
      currentUtilization: preflight.utilization,
      hardThreshold,
    };
  }
  return { safe: true };
}
