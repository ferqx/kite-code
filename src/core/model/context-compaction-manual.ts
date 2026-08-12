import type { AgentConfig } from '@/core/config';
import { getFeatureFlags } from '@/core/config/features';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import { countTokens } from '@/core/token-counter';
import { findSafeCompactionBoundary } from './compaction-v2';
import type { ContextPreflight, ContextTokenEstimate } from './context-budget';
import { preflightModelContext } from './context-budget';
import {
  CONTEXT_RECLAIM_LIVE_POLICY_V3,
  type PreparedContextRequestReadyV2,
  type ProjectionArtifactV2,
  prepareContextRequestV2,
} from './context-preparation-v2';
import {
  buildContextProjection,
  type ContextProjection,
  type ContextProjectionEnvironment,
} from './context-projection';
import { resolveContextReclaimModeV1 } from './context-reclaim';
import { type ResolvedModelCapabilities, resolveModelCapabilities } from './model-capabilities';
import {
  buildSummarySourceIdentityForCurrentPrefixV1,
  createSummaryRequestedEventV1,
} from './progressive-context-orchestrator';

// Legacy callers without a live projection environment retain a conservative fallback.
function fallbackEstimate(state: Readonly<RuntimeState>): ContextTokenEstimate {
  const checkpoint = state.context.activeCheckpoint;
  // When a checkpoint is active, only count transcript messages past the checkpoint;
  // pre-checkpoint messages are covered by the summary and must not be double-counted.
  const activeMessages = checkpoint
    ? (() => {
        const idx = state.transcript.messages.findIndex(
          (m) =>
            m.messageId ===
            (checkpoint.version === 3
              ? checkpoint.source.coveredThroughMessageId
              : checkpoint.coveredThroughMessageId),
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
  state: Readonly<RuntimeState>,
  config: AgentConfig,
  capabilities: ResolvedModelCapabilities = resolveModelCapabilities({ config }),
  environment?: ContextProjectionEnvironment,
  prepared?: PreparedContextRequestReadyV2,
) {
  if (prepared) return prepared.effectiveProjection.preflight;
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

/** Pure diagnostic entry used by `/context` and manual preflight consumers. */
export function prepareContextInspectionV2(input: {
  state: Readonly<RuntimeState>;
  config: AgentConfig;
  capabilities: ResolvedModelCapabilities;
  environment: ContextProjectionEnvironment;
}): PreparedContextRequestReadyV2 {
  const flags = getFeatureFlags(input.config);
  const requestedMaxOutputTokens =
    input.config.modelCapabilities?.maxOutputTokens ?? input.capabilities.maxOutputTokens ?? 0;
  const prepared = prepareContextRequestV2({
    purpose: 'context_inspection',
    state: input.state,
    environment: input.environment,
    capabilities: input.capabilities,
    requestedMaxOutputTokens,
    promptAffectingParameters: {
      temperature: 0,
      streaming: input.capabilities.streaming,
      providerType: input.config.providerType,
      modelName: input.config.modelName,
    },
    toolResultBudgetPolicyId: flags.toolResultBudgetV2
      ? 'tool-result-budget-registry:v2'
      : 'tool-result-compat-registry:v1',
    reclaimPolicyId: CONTEXT_RECLAIM_LIVE_POLICY_V3.policyId,
    reclaimMode: resolveContextReclaimModeV1({
      featureEnabled: flags.contextReclaimV1,
      toolResultBudgetEnabled: flags.toolResultBudgetV2,
      configuredMode: input.config.compaction?.reclaimMode,
    }),
    reclaimAfterEstimatedTokens: input.config.compaction?.reclaimAfterEstimatedTokens,
    providerSafetyRatio: input.config.compaction?.providerSafetyRatio,
    compactRatio: input.config.compaction?.compactRatio,
    hardRatio: input.config.compaction?.hardRatio,
    warningRatio: input.config.compaction?.warningRatio,
  });
  if (!('effectiveProjection' in prepared)) {
    throw new Error(`Context inspection preparation failed: ${prepared.next.reason}`);
  }
  if (prepared.next.kind !== 'diagnostic_only') {
    throw new Error(`Context inspection produced unexpected next '${prepared.next.kind}'.`);
  }
  return prepared;
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
  capabilities?: ResolvedModelCapabilities,
  environment?: ContextProjectionEnvironment,
  prepared?: PreparedContextRequestReadyV2,
): ManualCompactionStatus {
  const checkpoint = state.context.activeCheckpoint;
  return {
    preflight: currentContextPreflight(state, config, capabilities, environment, prepared),
    safeBoundary: findSafeCompactionBoundary(state),
    ...(state.context.pendingCompaction
      ? { pendingCompactionId: state.context.pendingCompaction.compactionId }
      : {}),
    ...(checkpoint
      ? {
          activeCheckpointId: checkpoint.compactionId,
          coveredThroughMessageId:
            checkpoint.version === 3
              ? checkpoint.source.coveredThroughMessageId
              : checkpoint.coveredThroughMessageId,
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
  capabilities?: ResolvedModelCapabilities;
  projectionEnvironment?: ContextProjectionEnvironment;
  preparedContextV2?: PreparedContextRequestReadyV2;
}): RuntimeEvent | null {
  if (
    input.state.context.pendingCompaction ||
    input.state.context.summaryLifecycle.kind === 'requested' ||
    input.state.context.summaryLifecycle.kind === 'started'
  )
    return null;
  const estimate = currentContextPreflight(
    input.state,
    input.config,
    input.capabilities,
    input.projectionEnvironment,
    input.preparedContextV2,
  ).estimate;
  const sourceIdentity = buildSummarySourceIdentityForCurrentPrefixV1(input.state);
  if (!sourceIdentity) return null;
  if (!input.state.context.lastTranscriptProducingEventCutV1 && !input.state.lastAppliedEventId)
    return null;
  const active = input.state.context.activeCheckpoint;
  if (
    active?.version === 3 &&
    active.source.firstMessageId === sourceIdentity.firstMessageId &&
    active.source.coveredThroughMessageId === sourceIdentity.coveredThroughMessageId &&
    active.source.sourceRangeDigest === sourceIdentity.canonicalSourceDigest
  ) {
    return null;
  }
  return createSummaryRequestedEventV1({
    state: input.state,
    reason: 'manual',
    sourceIdentity,
    estimate,
    ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
  });
}

/**
 * Build a human-readable context usage summary for `/context`.
 * Returns a formatted string suitable for TUI display.
 */
export function buildContextStatusReport(
  state: Readonly<RuntimeState>,
  config: AgentConfig,
  environment?: ContextProjectionEnvironment,
  capabilities: ResolvedModelCapabilities = resolveModelCapabilities({ config }),
  prepared?: PreparedContextRequestReadyV2,
): {
  projection: ContextProjection | Readonly<ProjectionArtifactV2>;
  preflight: ContextPreflight;
  /** Formatted multi-line status text. */
  text: string;
} {
  const projection =
    prepared?.effectiveProjection ??
    buildContextProjection({
      role: 'agent',
      state,
      serializedTools: environment?.serializedTools,
      activeSkillInstructions: environment?.activeSkillInstructions,
      workflowSkills: environment?.workflowSkills,
      promptContractVersion: environment?.promptContractVersion,
      projectInstructions: environment?.projectInstructions,
      sandboxBackend: environment?.sandboxBackend,
    });
  const preflight =
    prepared?.effectiveProjection.preflight ??
    preflightModelContext({
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
    ? `Active checkpoint: ${checkpoint.compactionId.slice(0, 12)}...  Covered through: ${checkpoint.version === 3 ? checkpoint.source.coveredThroughTurnId : checkpoint.coveredThroughTurnId}`
    : 'No active checkpoint';
  const autoStatus = 'unavailable (legacy configuration ignored)';

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
    `Next proactive threshold: N/A`,
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
  _state: Readonly<RuntimeState>,
  _config: AgentConfig,
  _environment?: ContextProjectionEnvironment,
  _capabilities?: ResolvedModelCapabilities,
):
  | { safe: true }
  | { safe: false; reason: string; currentUtilization: number; hardThreshold: number } {
  return { safe: true };
}
