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
import {
  executeRuntimeTools,
  serializeConcurrentSubagentApprovalEvents,
} from '@/core/controllers/tool-controller';
import {
  type AutoReviewResult,
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
import { preflightModelContext } from '@/core/model/context-budget';
import type { ContextCompactionProgressPhase } from '@/core/model/context-compaction-presentation';
import { buildContextProjection } from '@/core/model/context-projection';
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
import { toolAvailabilityContext } from '@/core/tools/definitions';
import type { ShellExecutor } from '@/core/tools/shell';
import { executeVerificationEffect } from '@/core/verification';
import { createFilePreimageRecorder } from './file-checkpoints';
import { deferredRuntimeEffect, type RuntimeEffectExecutor } from './kernel';
import { resourceAdmissionTerminalEventsV1 } from './resource-admission-terminal';
import { RemoteMcpEgressNonceConflictError, type RuntimeStore } from './store';

/** Dependencies owned by the application boundary, never persisted in RuntimeState. */
export interface RuntimeExecutorDependencies {
  config: AgentConfig;
  model: SupportedChatModel;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
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

export function shouldEscalateAutoReviewResult(result: AutoReviewResult): boolean {
  return !result.ok || !result.suggestion?.approved;
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
  toolSurface?: 'legacy_plan_recovery',
) {
  const flags = getFeatureFlags(dependencies.config);
  const skillCatalog =
    toolSurface !== 'legacy_plan_recovery' &&
    dependencies.skillOptions &&
    flags.skillWorkflowV1 &&
    flags.skillActivationV2
      ? refreshSkillCatalog(dependencies.skillOptions, {
          resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
        })
      : dependencies.skillCatalog;
  return resolveContextProjectionEnvironment({
    state,
    config: dependencies.config,
    model: dependencies.model,
    shellExecutor: dependencies.shellExecutor,
    gitBroker: dependencies.gitBroker,
    mcpManager: dependencies.mcpManager,
    skills: dependencies.skills,
    skillOptions: dependencies.skillOptions,
    skillCatalog,
    subagentEventSink: dependencies.subagentEventSink,
    signal: dependencies.signal,
    sandboxBackend: dependencies.sandboxBackend,
    toolSurface,
  });
}

/** Prepare the exact model input and bounded output before Runtime reservation. */
export function prepareRuntimeEffectForBudgetV1(
  effect: import('./effects').RuntimeEffect,
  state: import('./state').RuntimeState,
  dependencies: RuntimeExecutorDependencies,
): import('./effects').RuntimeEffect {
  if (effect.type !== 'call_model') return effect;
  const environment = resolveRuntimeContextProjectionEnvironment(
    dependencies,
    state,
    effect.toolSurface,
  );
  const projection = buildContextProjection({
    role: 'agent',
    state,
    serializedTools: environment.serializedTools,
    activeSkillInstructions: environment.activeSkillInstructions,
    workflowSkills: environment.workflowSkills,
    promptContractVersion: environment.promptContractVersion,
    projectInstructions: environment.projectInstructions,
    sandboxBackend: environment.sandboxBackend,
    toolSurface: environment.toolSurface,
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
        return deferredRuntimeEffect(
          'Context compaction is already owned by another runtime.',
          100,
        );
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
        gitBroker: dependencies.gitBroker,
        sandboxBackend: dependencies.sandboxBackend,
        mcpManager: dependencies.mcpManager,
        skills: dependencies.skills,
        skillOptions: dependencies.skillOptions,
        skillCatalog:
          effect.toolSurface === 'legacy_plan_recovery' ? undefined : currentSkillCatalog(),
        subagentEventSink,
        signal: dependencies.signal,
        emitRuntimeEvent: emit,
        compactionReporter: dependencies.compactionReporter,
        providerDataAdmission: dependencies.providerDataAdmission,
        resourceAdmission: effect.resourceEstimate,
        toolSurface: effect.toolSurface,
      });
    }
    if (effect.type === 'run_tools') {
      try {
        const parallelSubagentBatch =
          effect.toolCallIds.length > 1 &&
          effect.toolCallIds.every((toolCallId) => state.tools.calls[toolCallId]?.name === 'task');
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
              event.type === 'verification.requested' ||
              (parallelSubagentBatch &&
                (event.type === 'subagent.suspended' ||
                  event.type === 'approval.requested' ||
                  event.type === 'auto_review.requested'))
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
            gitBroker: dependencies.gitBroker,
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
            persistRuntimeEvent: executionContext?.persistEvent,
            getRuntimeState: () =>
              (executionContext?.getState?.() ?? state) as import('./state').RuntimeState,
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
        const batches = await Promise.allSettled(
          effect.toolCallIds.map((toolCallId) => execute([toolCallId])),
        );
        const terminalEventBatches: RuntimeEvent[][] = [];
        for (let index = 0; index < batches.length; index++) {
          const batch = batches[index]!;
          if (batch.status === 'fulfilled') {
            terminalEventBatches.push(batch.value);
            continue;
          }
          const toolCallId = effect.toolCallIds[index]!;
          const currentState =
            (executionContext?.getState?.() as import('./state').RuntimeState | undefined) ?? state;
          if (batch.reason instanceof DescendantResourceAdmissionError) {
            terminalEventBatches.push(
              resourceAdmissionTerminalEventsV1(currentState, batch.reason.reason),
            );
          } else {
            terminalEventBatches.push([
              {
                type: dependencies.signal?.aborted ? 'tool.cancelled' : 'tool.failed',
                toolCallId,
                ...(dependencies.signal?.aborted
                  ? { reason: 'Runtime tool batch cancelled.' }
                  : {
                      failure: classifyFailure(
                        'tool_runtime_error',
                        'The tool failed inside the local execution adapter.',
                      ),
                    }),
              } as RuntimeEvent,
            ]);
          }
        }
        return parallelSubagentBatch
          ? serializeConcurrentSubagentApprovalEvents(terminalEventBatches)
          : terminalEventBatches.flat();
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

  const suspended = state.suspendedSubagents[effect.toolCallId];
  const subagentId = state.interactions.approval.subagentId;
  if (subagentId && (!suspended || suspended.subagentId !== subagentId)) {
    return [
      {
        type: 'auto_review.completed',
        reviewId: effect.reviewId,
        toolCallId: effect.toolCallId,
        result: {
          ok: true,
          approved: false,
          reason: 'Sub-agent auto-review continuation is unavailable or does not match.',
          reviewerModelName: '',
          durationMs: 0,
        },
      },
    ];
  }
  const reviewedCall =
    subagentId && suspended
      ? {
          id: suspended.blockedTool.toolCallId,
          name: suspended.blockedTool.toolName,
          args: suspended.blockedTool.args,
        }
      : { id: call.toolCallId, name: call.name, args: call.args };
  const parsed = toolRequestFromCall(
    reviewedCall,
    toolAvailabilityContext({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
      config: dependencies.config,
      gitBroker: dependencies.gitBroker,
      mcpManager: dependencies.mcpManager,
    }),
  );
  if (!parsed?.ok) {
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
          reason: 'Unsupported or invalid tool',
          reviewerModelName: '',
          durationMs: 0,
        },
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
            ...(!result.suggestion?.approved ? { escalatedToUser: true as const } : {}),
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
    if (shouldEscalateAutoReviewResult(result)) {
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
