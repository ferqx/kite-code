import { findSafeCompactionBoundary } from './compaction';
import type { ModelRuntimeConfigV1 } from './config';
import type { ContextPreflight, ContextTokenEstimate } from './context-budget';
import { preflightModelContext } from './context-budget';
import {
  buildContextProjection,
  type ContextProjection,
  type ContextProjectionEnvironment,
} from './context-projection';
import { type ResolvedModelCapabilities, resolveModelCapabilities } from './model-capabilities';
import type { BuiltinRuntimeStateViewV1 } from './runtime-view';
import { countTokens } from './token-counter';

export interface ContextCompactionRequestedEventV1 {
  type: 'context.compaction_requested';
  compactionId: string;
  reason: 'manual';
  requestedAtRevision: number;
  requestedAtTurnId: string;
  force: false;
  estimate: ContextTokenEstimate;
  customInstructions?: string;
}

// Legacy callers without a live projection environment retain a conservative fallback.
function fallbackEstimate(state: Readonly<BuiltinRuntimeStateViewV1>): ContextTokenEstimate {
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

export function currentContextPreflight(
  state: Readonly<BuiltinRuntimeStateViewV1>,
  config: ModelRuntimeConfigV1,
  capabilities: ResolvedModelCapabilities = resolveModelCapabilities({ config }),
  environment?: ContextProjectionEnvironment,
) {
  return preflightModelContext({
    estimate: environment
      ? buildContextProjection({
          role: 'agent',
          state,
          serializedTools: environment.serializedTools,
          activeSkillInstructions: environment.activeSkillInstructions,
          workflowSkills: environment.workflowSkills,
        }).estimate
      : fallbackEstimate(state),
    capabilities,
    requestMaxOutputTokens: config.modelCapabilities?.maxOutputTokens,
    providerSafetyRatio: config.compaction?.providerSafetyRatio,
    compactRatio: config.compaction?.compactRatio,
    hardRatio: config.compaction?.hardRatio,
    warningRatio: config.compaction?.warningRatio,
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
  lastFailure?: BuiltinRuntimeStateViewV1['context']['lastFailure'];
}

export function inspectManualContextCompaction(
  state: Readonly<BuiltinRuntimeStateViewV1>,
  config: ModelRuntimeConfigV1,
  capabilities?: ResolvedModelCapabilities,
  environment?: ContextProjectionEnvironment,
): ManualCompactionStatus {
  const checkpoint = state.context.activeCheckpoint;
  return {
    preflight: currentContextPreflight(state, config, capabilities, environment),
    safeBoundary: findSafeCompactionBoundary(state),
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
  state: Readonly<BuiltinRuntimeStateViewV1>;
  config: ModelRuntimeConfigV1;
  /** Optional user-supplied instructions for the summary model. */
  customInstructions?: string;
  capabilities?: ResolvedModelCapabilities;
  projectionEnvironment?: ContextProjectionEnvironment;
}): ContextCompactionRequestedEventV1 | null {
  if (input.state.context.pendingCompaction) return null;
  return {
    type: 'context.compaction_requested',
    compactionId: crypto.randomUUID(),
    reason: 'manual',
    requestedAtRevision: input.state.revision,
    requestedAtTurnId: input.state.turn.turnId,
    force: false,
    estimate: currentContextPreflight(
      input.state,
      input.config,
      input.capabilities,
      input.projectionEnvironment,
    ).estimate,
    ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
  };
}

/**
 * Build a human-readable context usage summary for `/context`.
 * Returns a formatted string suitable for TUI display.
 */
export function buildContextStatusReport(
  state: Readonly<BuiltinRuntimeStateViewV1>,
  config: ModelRuntimeConfigV1,
  environment?: ContextProjectionEnvironment,
  capabilities: ResolvedModelCapabilities = resolveModelCapabilities({ config }),
): {
  projection: ContextProjection;
  preflight: ContextPreflight;
  /** Formatted multi-line status text. */
  text: string;
} {
  const projection = buildContextProjection({
    role: 'agent',
    state,
    serializedTools: environment?.serializedTools,
    activeSkillInstructions: environment?.activeSkillInstructions,
    workflowSkills: environment?.workflowSkills,
    promptContractVersion: environment?.promptContractVersion,
    projectInstructions: environment?.projectInstructions,
    sandboxBackend: environment?.sandboxBackend,
  });
  const preflight = preflightModelContext({
    estimate: projection.estimate,
    capabilities,
    requestMaxOutputTokens: config.modelCapabilities?.maxOutputTokens,
    providerSafetyRatio: config.compaction?.providerSafetyRatio,
    compactRatio: config.compaction?.compactRatio,
    hardRatio: config.compaction?.hardRatio,
    warningRatio: config.compaction?.warningRatio,
  });

  const e = projection.estimate;
  const utilizationPct =
    preflight.utilization != null ? `${(preflight.utilization * 100).toFixed(1)}%` : 'unknown';
  const usable = preflight.usableInputTokens ?? 'unknown';
  const checkpoint = state.context.activeCheckpoint;
  const lastCp = checkpoint
    ? `Active checkpoint: ${checkpoint.compactionId.slice(0, 12)}...  Covered through: ${checkpoint.coveredThroughTurnId}`
    : 'No active checkpoint';
  const contextCompactionV2 = config.features?.contextCompactionV2 ?? true;
  const contextCompactionAutoV1 = config.features?.contextCompactionAutoV1 ?? false;
  const autoMode =
    contextCompactionV2 && contextCompactionAutoV1 ? (config.compaction?.autoMode ?? 'off') : 'off';
  const autoStatus =
    !contextCompactionV2 || !contextCompactionAutoV1
      ? 'disabled by feature flag'
      : autoMode === 'off'
        ? 'off'
        : autoMode === 'shadow'
          ? 'shadow (observe only)'
          : state.context.autoGuard?.disabledUntilManualAction
            ? 'paused (thrash breaker)'
            : 'enabled';
  const nextThreshold =
    preflight.usableInputTokens != null
      ? `${Math.floor(preflight.usableInputTokens * (config.compaction?.triggerRatio ?? config.compaction?.compactRatio ?? 0.9))}`
      : config.compaction?.compactAfterEstimatedTokens != null
        ? `${config.compaction.compactAfterEstimatedTokens}`
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
    `Output reservation        ${preflight.reservedOutputTokens ?? 'unknown'}`,
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
 * `/compact reset` is never blocked by a local capacity estimate. Provider
 * admission is decided by the next real request.
 */
export function compactResetPreflight(
  _state: Readonly<BuiltinRuntimeStateViewV1>,
  _config: ModelRuntimeConfigV1,
  _environment?: ContextProjectionEnvironment,
  _capabilities?: ResolvedModelCapabilities,
):
  | { safe: true }
  | { safe: false; reason: string; currentUtilization: number; hardThreshold: number } {
  return { safe: true };
}
