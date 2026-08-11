import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import type { ProviderDataAdmissionGateV1 } from '@/core/config/provider-data-admission';
import {
  createApprovedProviderDataAdmissionV1,
  ProviderDataAdmissionError,
  providerPayloadFromModelPromptV1,
} from '@/core/config/provider-data-admission';
import {
  type ContextCompactor,
  executeContextCompaction,
} from '@/core/controllers/compaction-controller';
import {
  invokeRuntimeModel,
  resolveContextProjectionEnvironment,
} from '@/core/controllers/model-controller';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import {
  createAutoReviewModel,
  resolveAutoReviewConfig,
  reviewToolApproval,
  reviewVerificationEvidence,
} from '@/core/execution/reviewer';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import type { McpRuntimeProvider } from '@/core/mcp';
import {
  RemoteMcpEgressDeniedError,
  type RemoteMcpEgressPermitResolverV1,
  reclassifyRemoteMcpEgressReceiptV1,
} from '@/core/mcp/egress-permit';
import type { CompactionReporter } from '@/core/model/compaction-metrics';
import {
  createModelContextSummaryGenerator,
  createNarrativeContextCompactor,
} from '@/core/model/compaction-summary';
import type { PreparedPrimaryContextRequestV2 } from '@/core/model/context-admission-v2';
import { preflightModelContext } from '@/core/model/context-budget';
import {
  type PreparedContextCapabilitySetV2,
  prepareContextCapabilitySetV2,
} from '@/core/model/context-capability-v2';
import type { ContextCompactionProgressPhase } from '@/core/model/context-compaction-presentation';
import {
  CONTEXT_RECLAIM_LIVE_POLICY_V2,
  prepareContextRequestV2,
} from '@/core/model/context-preparation-v2';
import { buildContextProjection } from '@/core/model/context-projection';
import { resolveContextReclaimModeV1 } from '@/core/model/context-reclaim';
import type { ReclaimShadowReporter } from '@/core/model/context-reclaim-shadow';
import type { SupportedChatModel } from '@/core/model/factory';
import { resolveModelCapabilities } from '@/core/model/model-capabilities';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import { committedResourceUsageV1 } from '@/core/runtime/resource-budget';
import {
  createDescendantResourceAdmissionV1,
  DescendantResourceAdmissionError,
} from '@/core/runtime/resource-budget-admission';
import type { SandboxBackend } from '@/core/sandbox/platform';
import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
  type SkillCatalogSnapshot,
} from '@/core/skills';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import type { ShellExecutor } from '@/core/tools/shell';
import { executeVerificationEffect } from '@/core/verification';
import { createFilePreimageRecorder } from './file-checkpoints';
import type { RuntimeEffectExecutor } from './kernel';
import { resourceAdmissionTerminalEventsV1 } from './resource-admission-terminal';
import { RemoteMcpEgressNonceConflictError, type RuntimeStore } from './store';

/** Dependencies owned by the application boundary, never persisted in RuntimeState. */
export interface RuntimeExecutorDependencies {
  config: AgentConfig;
  model: SupportedChatModel;
  shellExecutor?: ShellExecutor;
  sandboxBackend?: SandboxBackend | 'unknown';
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  subagentEventSink?: SubAgentEventSink;
  contextCompactor?: ContextCompactor;
  /** Owned and flushed by the application composition root. */
  compactionReporter?: CompactionReporter;
  /** Independent, bounded in-memory L2 shadow reporter. */
  reclaimShadowReporter?: ReclaimShadowReporter;
  onCompactionProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
  /** 用于记录文件写入前原像（ADR-0042 §4），缺省时工具写入不留原像。 */
  runtimeStore?: RuntimeStore;
  /** Immutable production Provider policy gate. Missing gate fails closed when enabled. */
  providerDataAdmission?: ProviderDataAdmissionGateV1;
  /** Independent user/admin authorization source for one remote MCP invocation. */
  remoteMcpEgressPermitResolver?: RemoteMcpEgressPermitResolverV1;
}

/** Resolve the reviewer timeout while preserving the pre-flag compatibility path. */
export function resolveAutoReviewTimeout(config: AgentConfig): number {
  return getFeatureFlags(config).autoReviewV2 ? (config.autoReview?.timeoutMs ?? 15_000) : 15_000;
}

function reviewerProviderDataAdmission(
  dependencies: RuntimeExecutorDependencies,
  reviewerConfig: AgentConfig,
): ProviderDataAdmissionGateV1 | undefined {
  if (!getFeatureFlags(dependencies.config).providerDataPolicyV1) return undefined;
  const sameRoute =
    reviewerConfig.providerType === dependencies.config.providerType &&
    reviewerConfig.providerName === dependencies.config.providerName &&
    reviewerConfig.modelName === dependencies.config.modelName &&
    reviewerConfig.baseURL === dependencies.config.baseURL;
  return sameRoute
    ? dependencies.providerDataAdmission
    : createApprovedProviderDataAdmissionV1(reviewerConfig);
}

export function resolveRuntimeContextProjectionEnvironment(
  dependencies: RuntimeExecutorDependencies,
  state: import('./state').RuntimeState,
  capabilitySet?: PreparedContextCapabilitySetV2,
) {
  const flags = getFeatureFlags(dependencies.config);
  const skillCatalog =
    dependencies.skillOptions && flags.skillWorkflowV1 && flags.skillActivationV2
      ? refreshSkillCatalog(dependencies.skillOptions, {
          resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
        })
      : dependencies.skillCatalog;
  return resolveContextProjectionEnvironment({
    state,
    config: dependencies.config,
    model: dependencies.model,
    shellExecutor: dependencies.shellExecutor,
    mcpManager: dependencies.mcpManager,
    skills: dependencies.skills,
    skillOptions: dependencies.skillOptions,
    skillCatalog,
    ...(capabilitySet
      ? {
          mcpBindings: [...capabilitySet.mcpBindings],
          disclosedDescriptors: [...capabilitySet.disclosedDescriptors],
        }
      : {}),
    subagentEventSink: dependencies.subagentEventSink,
    signal: dependencies.signal,
    sandboxBackend: dependencies.sandboxBackend,
  });
}

export function prepareRuntimeEffectV2(
  effect: import('./effects').RuntimeEffect,
  state: import('./state').RuntimeState,
  dependencies: RuntimeExecutorDependencies,
): import('./runner').RuntimeEffectPreparationV2 {
  if (effect.type === 'compact_context') {
    return { effect, preparationEvents: [] };
  }
  if (effect.type !== 'call_model') {
    return { effect, preparationEvents: [] };
  }
  const flags = getFeatureFlags(dependencies.config);
  // The v2 dispatch contract requires a durable reservation/effect lease.
  // Compatibility runs without the resource ledger retain the legacy path.
  if (!flags.resourceBudgetV1) {
    return { effect, preparationEvents: [] };
  }
  const capabilities = resolveModelCapabilities({
    config: dependencies.config,
    adapter: dependencies.model.capabilityMetadata,
  });
  const skillCatalog =
    dependencies.skillOptions && flags.skillWorkflowV1 && flags.skillActivationV2
      ? refreshSkillCatalog(dependencies.skillOptions, {
          resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
        })
      : dependencies.skillCatalog;
  const capabilityPreparation = prepareContextCapabilitySetV2({
    state,
    config: dependencies.config,
    modelSupportsToolCalls: dependencies.model.supportsToolCalls !== false,
    modelCapabilities: capabilities,
    mcpManager: dependencies.mcpManager,
    skillCatalog,
  });
  if (capabilityPreparation.preparationEvents.length > 0) {
    return {
      effect,
      preparationEvents: capabilityPreparation.preparationEvents,
    };
  }
  const configuredMaxOutput =
    typeof dependencies.config.modelKwargs?.maxOutputTokens === 'number'
      ? dependencies.config.modelKwargs.maxOutputTokens
      : typeof dependencies.config.modelKwargs?.maxTokens === 'number'
        ? dependencies.config.modelKwargs.maxTokens
        : undefined;
  const remainingOutputTokens =
    state.resourceBudget.status === 'active'
      ? state.resourceBudget.budget.maxRunOutputTokens -
        committedResourceUsageV1(state.resourceBudget).counters.outputTokens
      : undefined;
  const requestedMaxOutputTokens = Math.floor(
    Math.min(
      configuredMaxOutput ?? capabilities.maxOutputTokens ?? remainingOutputTokens ?? 0,
      remainingOutputTokens ?? Number.POSITIVE_INFINITY,
    ),
  );
  if (requestedMaxOutputTokens <= 0) {
    throw new Error('Model output admission requires a positive resolved output limit.');
  }
  const environment = resolveRuntimeContextProjectionEnvironment(
    { ...dependencies, skillCatalog },
    state,
    capabilityPreparation.capabilitySet,
  );
  const reclaimMode = resolveContextReclaimModeV1({
    featureEnabled: flags.contextReclaimV1,
    toolResultBudgetEnabled: flags.toolResultBudgetV2,
    configuredMode: dependencies.config.compaction?.reclaimMode,
  });
  const normalPromptAffectingParameters = {
    temperature: 0,
    streaming: capabilities.streaming,
    providerType: dependencies.config.providerType,
    modelName: dependencies.config.modelName,
    maxOutputTokens: requestedMaxOutputTokens,
  };
  const prepared = prepareContextRequestV2({
    purpose: 'normal',
    state,
    environment,
    capabilities,
    requestedMaxOutputTokens,
    promptAffectingParameters: normalPromptAffectingParameters,
    toolResultBudgetPolicyId: flags.toolResultBudgetV2
      ? 'tool-result-budget-registry:v2'
      : 'tool-result-compat-registry:v1',
    reclaimPolicyId: CONTEXT_RECLAIM_LIVE_POLICY_V2.policyId,
    reclaimMode,
    reclaimAfterEstimatedTokens: dependencies.config.compaction?.reclaimAfterEstimatedTokens,
    providerSafetyRatio: dependencies.config.compaction?.providerSafetyRatio,
    compactRatio: dependencies.config.compaction?.compactRatio,
    hardRatio: dependencies.config.compaction?.hardRatio,
    warningRatio: dependencies.config.compaction?.warningRatio,
  });
  if (!('effectiveProjection' in prepared)) {
    throw new Error(
      prepared.next.kind === 'correctness_blocked'
        ? prepared.next.reason
        : `Prepared context is not primary-ready: ${prepared.next.kind}.`,
    );
  }
  if (prepared.next.kind !== 'primary_ready') {
    throw new Error(`Prepared context is not primary-ready: ${prepared.next.kind}.`);
  }
  if (flags.providerDataPolicyV1) {
    const decision = dependencies.providerDataAdmission?.(
      providerPayloadFromModelPromptV1(prepared.effectiveProjection.providerMessages),
      'primary_model',
    ) ?? {
      admitted: false,
      reason: 'mandatory_policy_unavailable' as const,
      routeAlias: 'unresolved',
    };
    if (!decision.admitted) throw new ProviderDataAdmissionError(decision);
  }
  return {
    effect: {
      ...effect,
      resourceEstimate: {
        inputTokens: prepared.effectiveProjection.estimate.totalInputTokens,
        maxOutputTokens: requestedMaxOutputTokens,
      },
      preparedContextV2: prepared as PreparedPrimaryContextRequestV2,
      preparedCapabilitySetV2: capabilityPreparation.capabilitySet,
    },
    preparationEvents: [],
  };
}

/** Prepare the exact model input and bounded output before Runtime reservation. */
export function prepareRuntimeEffectForBudgetV1(
  effect: import('./effects').RuntimeEffect,
  state: import('./state').RuntimeState,
  dependencies: RuntimeExecutorDependencies,
): import('./effects').RuntimeEffect {
  if (effect.type !== 'call_model') return effect;
  const environment = resolveRuntimeContextProjectionEnvironment(dependencies, state);
  const projection = buildContextProjection({
    role: 'agent',
    state,
    serializedTools: environment.serializedTools,
    activeSkillInstructions: environment.activeSkillInstructions,
    workflowSkills: environment.workflowSkills,
    promptContractVersion: environment.promptContractVersion,
    projectInstructions: environment.projectInstructions,
    sandboxBackend: environment.sandboxBackend,
  });
  if (getFeatureFlags(dependencies.config).providerDataPolicyV1) {
    const decision = dependencies.providerDataAdmission?.(
      providerPayloadFromModelPromptV1(projection.providerMessages),
      'primary_model',
    ) ?? {
      admitted: false,
      reason: 'mandatory_policy_unavailable' as const,
      routeAlias: 'unresolved',
    };
    if (!decision.admitted) throw new ProviderDataAdmissionError(decision);
  }
  const capabilities = resolveModelCapabilities({
    config: dependencies.config,
    adapter: dependencies.model.capabilityMetadata,
  });
  const configuredMaxOutput =
    typeof dependencies.config.modelKwargs?.maxOutputTokens === 'number'
      ? dependencies.config.modelKwargs.maxOutputTokens
      : typeof dependencies.config.modelKwargs?.maxTokens === 'number'
        ? dependencies.config.modelKwargs.maxTokens
        : undefined;
  const preflight = preflightModelContext({
    estimate: projection.estimate,
    capabilities,
    requestMaxOutputTokens: configuredMaxOutput,
    providerSafetyRatio: dependencies.config.compaction?.providerSafetyRatio,
    compactRatio: dependencies.config.compaction?.compactRatio,
    hardRatio: dependencies.config.compaction?.hardRatio,
    warningRatio: dependencies.config.compaction?.warningRatio,
  });
  const providerOutputLimit =
    preflight.reservedOutputTokens ?? configuredMaxOutput ?? capabilities.maxOutputTokens;
  const remainingOutputTokens =
    state.resourceBudget.status === 'active'
      ? state.resourceBudget.budget.maxRunOutputTokens -
        committedResourceUsageV1(state.resourceBudget).counters.outputTokens
      : providerOutputLimit;
  if (remainingOutputTokens == null) {
    throw new Error('Model output admission requires a configured Runtime resource budget.');
  }
  return {
    ...effect,
    resourceEstimate: {
      inputTokens: preflight.estimate.totalInputTokens,
      maxOutputTokens: Math.max(
        1,
        Math.min(providerOutputLimit ?? remainingOutputTokens, remainingOutputTokens),
      ),
    },
  };
}

/** Build the production executor for Kernel effects. */
export function createRuntimeEffectExecutor(
  dependencies: RuntimeExecutorDependencies,
): RuntimeEffectExecutor {
  // Tool definitions need a sink to expose the task tool during model calls.
  // executeRuntimeTools converts the real lifecycle callbacks into durable
  // RuntimeEvents, so this fallback is only a capability marker.
  const subagentEventSink: SubAgentEventSink = dependencies.subagentEventSink ?? (() => {});
  const currentSkillCatalog = (): SkillCatalogSnapshot | undefined =>
    dependencies.skillOptions &&
    getFeatureFlags(dependencies.config).skillWorkflowV1 &&
    getFeatureFlags(dependencies.config).skillActivationV2
      ? refreshSkillCatalog(dependencies.skillOptions, {
          resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
        })
      : undefined;
  const contextCompactor =
    dependencies.contextCompactor ??
    createNarrativeContextCompactor({
      generate: createModelContextSummaryGenerator({
        model: dependencies.model,
        signal: dependencies.signal,
        providerDataAdmission: dependencies.providerDataAdmission,
        providerDataPolicyRequired: getFeatureFlags(dependencies.config).providerDataPolicyV1,
      }),
      maxSummaryTokens: dependencies.config.compaction?.maxSummaryTokens,
      maxSummaryInputTokens: dependencies.config.compaction?.maxSummaryInputTokens,
      maxNarrativeTokens: dependencies.config.compaction?.maxNarrativeTokens,
      modelContextWindowTokens: resolveModelCapabilities({
        config: dependencies.config,
        adapter: dependencies.model.capabilityMetadata,
      }).contextWindowTokens,
      modelMaxOutputTokens: resolveModelCapabilities({
        config: dependencies.config,
        adapter: dependencies.model.capabilityMetadata,
      }).maxOutputTokens,
    });
  return async (effect, state, emit, executionContext) => {
    if (effect.type === 'compact_context') {
      if (
        state.context.pendingCompaction?.reason !== 'manual' ||
        state.context.pendingCompaction.compactionId !== effect.compactionId
      ) {
        return [];
      }
      const leaseOwner = crypto.randomUUID();
      const durableLease = dependencies.runtimeStore;
      const leaseTtlMs = 10 * 60_000;
      if (
        durableLease &&
        !durableLease.tryAcquireEffectLease(
          state.session.threadId,
          effect.compactionId,
          leaseOwner,
          Date.now() + leaseTtlMs,
        )
      ) {
        return [];
      }
      const heartbeat = durableLease
        ? setInterval(() => {
            durableLease.renewEffectLease(
              state.session.threadId,
              effect.compactionId,
              leaseOwner,
              Date.now() + leaseTtlMs,
            );
          }, 30_000)
        : undefined;
      const resolveProjectionEnvironment = () =>
        resolveRuntimeContextProjectionEnvironment({ ...dependencies, subagentEventSink }, state);
      try {
        return await executeContextCompaction({
          state,
          compactionId: effect.compactionId,
          compact: contextCompactor,
          resolveProjectionEnvironment,
          reporter: dependencies.compactionReporter,
          onProgress: dependencies.onCompactionProgress,
        });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        durableLease?.releaseEffectLease(state.session.threadId, effect.compactionId, leaseOwner);
      }
    }
    if (effect.type === 'call_model') {
      return invokeRuntimeModel({
        model: dependencies.model,
        state,
        config: dependencies.config,
        shellExecutor: dependencies.shellExecutor,
        sandboxBackend: dependencies.sandboxBackend,
        mcpManager: dependencies.mcpManager,
        skills: dependencies.skills,
        skillOptions: dependencies.skillOptions,
        skillCatalog: currentSkillCatalog(),
        subagentEventSink,
        signal: dependencies.signal,
        emitRuntimeEvent: emit,
        compactionReporter: dependencies.compactionReporter,
        reclaimShadowReporter: dependencies.reclaimShadowReporter,
        providerDataAdmission: dependencies.providerDataAdmission,
        resourceAdmission: effect.resourceEstimate,
        preparedContextV2: effect.preparedContextV2,
        preparedCapabilitySetV2: effect.preparedCapabilitySetV2,
        effectLeaseId: executionContext?.effectLeaseId,
        reservationIds: executionContext?.reservationIds,
      });
    }
    if (effect.type === 'run_tools') {
      try {
        const execute = async (toolCallIds: string[]) => {
          const taskCallId =
            toolCallIds.length === 1 && state.tools.calls[toolCallIds[0]!]?.name === 'task'
              ? toolCallIds[0]
              : undefined;
          const parentReservationId = taskCallId
            ? executionContext?.reservationIds.find((reservationId) => {
                const budget = state.resourceBudget;
                const reservation =
                  budget.status === 'active' ? budget.reservations[reservationId] : undefined;
                return (
                  reservation?.resourceKind === 'subagent' &&
                  (reservation.invocationId === `tool:${taskCallId}` ||
                    reservation.invocationId.startsWith(`tool:${taskCallId}:resume:`))
                );
              })
            : undefined;
          const descendantResourceAdmission =
            parentReservationId && executionContext
              ? createDescendantResourceAdmissionV1({
                  state: state as import('./state').RuntimeState,
                  parentReservationId,
                  getState: () =>
                    (executionContext.getState?.() ?? state) as import('./state').RuntimeState,
                  persistEvent: executionContext.persistEvent,
                  persistEvents: executionContext.persistEvents,
                  ...(executionContext.persistLateResourceReconciliation
                    ? {
                        persistLateResourceReconciliation:
                          executionContext.persistLateResourceReconciliation,
                      }
                    : {}),
                  signal: dependencies.signal,
                })
              : undefined;
          const terminalEvents: RuntimeEvent[] = [];
          const emitOrDefer = (event: RuntimeEvent) => {
            if (
              event.type === 'tool.file_change' ||
              event.type === 'tool.finished' ||
              event.type === 'tool.failed' ||
              event.type === 'tool.rejected' ||
              event.type === 'tool.cancelled' ||
              event.type === 'capability.execution_succeeded' ||
              event.type === 'capability.execution_failed' ||
              event.type === 'capability.execution_unknown' ||
              event.type === 'provider.action_required' ||
              event.type === 'subagent.completed' ||
              event.type === 'subagent.failed' ||
              event.type === 'verification.requested'
            ) {
              terminalEvents.push(event);
            } else {
              emit?.(event);
            }
          };
          await executeRuntimeTools({
            state,
            toolCallIds,
            shellExecutor: dependencies.shellExecutor,
            mcpManager: dependencies.mcpManager,
            skillManifests: dependencies.skills,
            skillOptions: dependencies.skillOptions,
            skillCatalog: currentSkillCatalog(),
            signal: dependencies.signal,
            taskConfig: dependencies.config,
            taskModel: dependencies.model,
            providerDataAdmission: dependencies.providerDataAdmission,
            remoteMcpEgressPermitResolver: dependencies.remoteMcpEgressPermitResolver,
            descendantResourceAdmission,
            subagentEventSink,
            emitRuntimeEvent: emitOrDefer,
            recordFilePreimage: createFilePreimageRecorder(
              dependencies.runtimeStore,
              state.session.threadId,
            ),
            ...(executionContext
              ? {
                  recordNetworkDecision: async (
                    decision: import('@/core/sandbox/network-enforcer').NetworkDecisionReceiptV1,
                  ) => {
                    const applied = await executionContext.persistEvent({
                      type: 'network.admission_decided',
                      toolCallId: decision.toolCallId,
                      decision,
                    });
                    if (!applied) {
                      throw new Error('Network admission decision became stale before dispatch.');
                    }
                  },
                  recordRemoteMcpEgressDecision: async (
                    decision: import('@/core/mcp/egress-permit').RemoteMcpEgressReceiptV1,
                  ) => {
                    let applied: boolean;
                    try {
                      applied = await executionContext.persistEvent({
                        type: 'mcp.egress_decided',
                        toolCallId: decision.toolCallId,
                        decision,
                      });
                    } catch (error) {
                      if (
                        !(error instanceof RemoteMcpEgressNonceConflictError) ||
                        decision.reason !== 'permit_consumed'
                      ) {
                        throw error;
                      }
                      const replayDecision = reclassifyRemoteMcpEgressReceiptV1(
                        decision,
                        'permit_replayed',
                      );
                      const replayApplied = await executionContext.persistEvent({
                        type: 'mcp.egress_decided',
                        toolCallId: replayDecision.toolCallId,
                        decision: replayDecision,
                      });
                      if (!replayApplied) {
                        throw new Error('Remote MCP replay denial became stale before dispatch.');
                      }
                      throw new RemoteMcpEgressDeniedError(replayDecision);
                    }
                    if (!applied) {
                      throw new Error('Remote MCP egress decision became stale before dispatch.');
                    }
                  },
                }
              : {}),
          });
          return terminalEvents;
        };
        if (effect.toolCallIds.length <= 1) {
          return await execute(effect.toolCallIds);
        }
        const batches = await Promise.all(
          effect.toolCallIds.map((toolCallId) => execute([toolCallId])),
        );
        return batches.flat();
      } catch (error) {
        if (error instanceof DescendantResourceAdmissionError) {
          const currentState =
            (executionContext?.getState?.() as import('./state').RuntimeState | undefined) ?? state;
          return resourceAdmissionTerminalEventsV1(currentState, error.reason);
        }
        const mcpCalls = effect.toolCallIds.flatMap((toolCallId) => {
          const call = state.tools.calls[toolCallId];
          return call?.name.startsWith('mcp__') ? [{ toolCallId, call }] : [];
        });
        if (mcpCalls.length !== effect.toolCallIds.length) throw error;
        return mcpCalls.map(({ toolCallId }) => ({
          type: 'tool.failed' as const,
          toolCallId,
          failure: classifyFailure(
            'tool_runtime_error',
            'The MCP tool failed inside the local execution adapter. The current call was isolated and the conversation can continue.',
          ),
        }));
      }
    }
    if (effect.type === 'run_auto_review') {
      return executeAutoReview(effect, state, dependencies);
    }
    if (
      effect.type === 'run_verification' ||
      effect.type === 'repair_verification' ||
      effect.type === 'run_verification_compensation'
    ) {
      let reviewerModel: SupportedChatModel | undefined;
      return executeVerificationEffect(effect, state, {
        shellExecutor: dependencies.shellExecutor,
        mcpManager: dependencies.mcpManager,
        signal: dependencies.signal,
        reviewer: async (evidence) => {
          const reviewerConfig = resolveAutoReviewConfig(dependencies.config);
          reviewerModel ??= createAutoReviewModel(reviewerConfig);
          return reviewVerificationEvidence({
            model: reviewerModel,
            evidence,
            timeoutMs: dependencies.config.autoReview?.timeoutMs ?? 30_000,
            providerDataAdmission: reviewerProviderDataAdmission(dependencies, reviewerConfig),
            providerDataPolicyRequired: getFeatureFlags(dependencies.config).providerDataPolicyV1,
          });
        },
      });
    }
    if (effect.type === 'subagent.recovery_unavailable') {
      return [
        {
          type: 'subagent.failed',
          subagent: {
            id: effect.subagentId,
            error: effect.reason,
            summary: effect.reason,
            toolCallCount: 0,
            durationMs: 0,
          },
        },
        {
          type: 'tool.finished',
          toolCallId: effect.toolCallId,
          name: 'task',
          result: {
            ok: false,
            command: '',
            exitCode: -1,
            stdout: '',
            stderr: effect.reason,
            status: 'error',
          },
        },
      ];
    }
    return [];
  };
}

/** Execute auto-review for a pending tool call. */
async function executeAutoReview(
  effect: Extract<import('./effects').RuntimeEffect, { type: 'run_auto_review' }>,
  state: Readonly<import('./state').RuntimeState>,
  dependencies: RuntimeExecutorDependencies,
): Promise<RuntimeEvent[]> {
  const call = state.tools.calls[effect.toolCallId];
  if (!call || state.interactions.kind !== 'awaiting_auto_review') return [];

  const parsed = toolRequestFromCall(
    { id: call.toolCallId, name: call.name, args: call.args },
    { workspace: state.session.workspace, threadId: state.session.threadId },
  );
  if (!parsed?.ok) {
    const reason = 'Unsupported or invalid tool';
    return [
      {
        type: 'auto_review.completed',
        reviewId: effect.reviewId,
        toolCallId: effect.toolCallId,
        result: {
          // An invalid/unsupported tool is an explicit policy decision, not a
          // reviewer transport failure. It must not be escalated to a user
          // approval prompt.
          ok: true,
          approved: false,
          reason,
          reviewerModelName: '',
          durationMs: 0,
        },
      },
      {
        type: 'tool.rejected',
        toolCallId: effect.toolCallId,
        reason,
        failure: classifyFailure('auto_review_rejected', reason),
      },
    ];
  }
  const request = parsed.request;

  const startTime = Date.now();
  try {
    const reviewerConfig = resolveAutoReviewConfig(dependencies.config);
    const reviewerModel = createAutoReviewModel(reviewerConfig);

    const result = await reviewToolApproval({
      model: reviewerModel,
      payload: state.interactions
        .approval as import('@/core/harness/tool-policy').ToolApprovalPayload,
      request,
      // V2 makes the configured reviewer timeout part of the rollout surface;
      // the established path retains the fixed compatibility timeout.
      timeoutMs: resolveAutoReviewTimeout(dependencies.config),
      providerDataAdmission: reviewerProviderDataAdmission(dependencies, reviewerConfig),
      providerDataPolicyRequired: getFeatureFlags(dependencies.config).providerDataPolicyV1,
    });

    const completed: RuntimeEvent = {
      type: 'auto_review.completed',
      reviewId: effect.reviewId,
      toolCallId: effect.toolCallId,
      result: result.ok
        ? {
            ok: true,
            approved: result.suggestion?.approved ?? false,
            grant: result.suggestion?.grant,
            reason: result.suggestion?.reason ?? result.reason,
            reviewerModelName: reviewerConfig.modelName ?? reviewerConfig.providerName ?? 'unknown',
            durationMs: Date.now() - startTime,
          }
        : {
            // Treat a malformed reviewer result without a classified failure
            // conservatively. It is never an implicit review rejection.
            ok: false,
            approved: false,
            failureType: result.failureType ?? 'technical',
            reason: result.reason,
            reviewerModelName: reviewerConfig.modelName ?? reviewerConfig.providerName ?? 'unknown',
            durationMs: Date.now() - startTime,
          },
    };
    if (!result.ok) {
      return [
        completed,
        {
          type: 'approval.requested',
          interactionId: crypto.randomUUID(),
          toolCallId: effect.toolCallId,
          approval: state.interactions.approval,
        },
      ];
    }
    if (completed.type === 'auto_review.completed' && completed.result.approved === false) {
      const reason = completed.result.reason ?? 'auto-review rejected';
      return [
        completed,
        {
          type: 'tool.rejected',
          toolCallId: effect.toolCallId,
          reason,
          failure: classifyFailure('auto_review_rejected', reason),
        },
      ];
    }
    return [completed];
  } catch (error) {
    return [
      {
        type: 'auto_review.completed',
        reviewId: effect.reviewId,
        toolCallId: effect.toolCallId,
        result: {
          ok: false,
          approved: false,
          failureType: 'technical',
          reason: error instanceof Error ? error.message : String(error),
          reviewerModelName: dependencies.config.modelName ?? 'unknown',
          durationMs: Date.now() - startTime,
        },
      },
      {
        type: 'approval.requested',
        interactionId: crypto.randomUUID(),
        toolCallId: effect.toolCallId,
        approval: state.interactions.approval,
      },
    ];
  }
}
