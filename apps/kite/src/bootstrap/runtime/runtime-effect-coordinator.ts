import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
  type SkillCatalogSnapshot,
  toolRequestFromCall,
} from '@kite/builtin-runtime';
import {
  digestProjectionEnvironment,
  type ModelInvocationPersistenceV1,
  resolveAutoReviewConfig,
  resolveModelCapabilities,
} from '@kite/builtin-runtime/model';
import type { SubAgentEventSink } from '@kite/runtime-contract';
import {
  runtimeHostStateDecideAutoReviewV1 as decideAutoReviewV1,
  deferredStateRuntimeEffectV1,
  runtimeHostStateCheckDoomLoopFingerprintV1,
  runtimeHostStateToolDoomLoopFingerprintV1,
  runtimeHostStateToolInvocationFingerprintV1 as toolInvocationFingerprintV1,
} from '@kite/runtime-host';
import { getFeatureFlags } from '#app/config/features';
import { ProviderDataAdmissionError } from '#app/config/provider-data-admission';
import { type ContextCompactor, executeContextCompaction } from './context-compaction-effect';
import { projectPrimaryModelEffectV1 } from './model-effect';
import {
  type RuntimeExecutorDependencies,
  resolveAutoReviewTimeout,
  resolveRuntimeContextProjectionEnvironment,
  reviewerProviderDataAdmission,
  runtimeProviderDataAdmission,
} from './runtime-effect-dependencies';
import { executeAppRuntimeToolsEffectV1 } from './runtime-tool-effect';
import type {
  RuntimeEffect,
  RuntimeEffectExecutor,
  RuntimeEvent,
  RuntimeState,
} from './state-runtime';
import { readPrivateSuspendedSubagentV1 } from './tool-controller-adapter';
import { createAppToolTurnContextV1 } from './tool-turn-context';
import { executeVerificationEffect } from './verification-effect';

function requireModelCoordinatorDependencies(dependencies: RuntimeExecutorDependencies): {
  readonly modelInvocationGateway: NonNullable<
    RuntimeExecutorDependencies['modelInvocationGateway']
  >;
  readonly modelEffectCoordinator: NonNullable<
    RuntimeExecutorDependencies['modelEffectCoordinator']
  >;
  readonly builtinToolCatalog: NonNullable<RuntimeExecutorDependencies['builtinToolCatalog']>;
} {
  const modelInvocationGateway = dependencies.modelInvocationGateway;
  const modelEffectCoordinator = dependencies.modelEffectCoordinator;
  const builtinToolCatalog = dependencies.builtinToolCatalog;
  if (!modelInvocationGateway) {
    throw new Error('Runtime Model invocation Gateway is unavailable.');
  }
  if (!modelEffectCoordinator) {
    throw new Error('Runtime Model effect coordinator is unavailable.');
  }
  if (!builtinToolCatalog) {
    throw new Error('Runtime Builtin tool catalog projection is unavailable.');
  }
  return { modelInvocationGateway, modelEffectCoordinator, builtinToolCatalog };
}

function currentSkillCatalog(
  dependencies: RuntimeExecutorDependencies,
): SkillCatalogSnapshot | undefined {
  return dependencies.skillOptions &&
    getFeatureFlags(dependencies.config).skillWorkflowV1 &&
    getFeatureFlags(dependencies.config).skillActivationV2
    ? refreshSkillCatalog(dependencies.skillOptions, {
        resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
      })
    : undefined;
}

/**
 * App-owned effect coordinator for the State 25 runtime.
 *
 * The Core executor remains the single owner for every remaining effect. Model,
 * auto-review, verification, and compaction effects are deliberately selected
 * before that executor is called, so none can fall through to a second owner or
 * be retried by the remaining-effect path.
 */
export function createAppRuntimeEffectExecutorV1(
  dependencies: RuntimeExecutorDependencies,
): RuntimeEffectExecutor {
  const subagentEventSink: SubAgentEventSink = dependencies.subagentEventSink ?? (() => {});

  const executeContextCompactionV1 = async (
    effect: Extract<RuntimeEffect, { type: 'compact_context' }>,
    state: RuntimeState,
    executionContext?: Parameters<RuntimeEffectExecutor>[3],
  ) => {
    const { modelEffectCoordinator } = requireModelCoordinatorDependencies(dependencies);
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
      return deferredStateRuntimeEffectV1(
        'Context compaction is already owned by another runtime.',
        100,
      );
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const renewLease = (): boolean => {
      if (!durableLease) return true;
      let renewed = false;
      try {
        renewed = durableLease.renewEffectLease(
          state.session.threadId,
          effect.compactionId,
          leaseOwner,
          Date.now() + leaseTtlMs,
        );
      } catch {
        renewed = false;
      }
      return renewed;
    };
    if (durableLease) {
      heartbeat = setInterval(() => {
        if (!renewLease() && heartbeat) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
      }, 30_000);
    }
    try {
      const projectionEnvironment = resolveRuntimeContextProjectionEnvironment(
        { ...dependencies, subagentEventSink },
        state,
      );
      const resolveProjectionEnvironment = () => projectionEnvironment;
      let contextCompactor: ContextCompactor | undefined = dependencies.testContextCompactor;
      if (!contextCompactor) {
        if (!executionContext) {
          throw new Error('Model effect persistence context is unavailable.');
        }
        contextCompactor = modelEffectCoordinator.createContextCompactor({
          config: dependencies.config,
          model: dependencies.model,
          persistence: {
            getState: () =>
              (executionContext.getState?.() ??
                state) as import('@kite/runtime-host').StateRuntimeStateV1,
            persistEvents: executionContext.persistEvents,
          },
          state,
          projectionEnvironmentDigest: digestProjectionEnvironment(projectionEnvironment),
          signal: dependencies.signal,
          providerDataAdmission: runtimeProviderDataAdmission(dependencies),
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
      }
      const leasedCompactor: ContextCompactor = async (input) => {
        if (!renewLease()) throw new Error('Runtime effect lease was lost before dispatch.');
        return contextCompactor(input);
      };
      const events = await executeContextCompaction({
        state,
        compactionId: effect.compactionId,
        compact: leasedCompactor,
        resolveProjectionEnvironment,
        reporter: dependencies.compactionReporter,
        onProgress: dependencies.onCompactionProgress,
      });
      if (durableLease && executionContext && events.length > 0) {
        await executionContext.persistEvents(events, {
          effectId: effect.compactionId,
          ownerId: leaseOwner,
          observedAtMs: Date.now(),
        });
        return [];
      }
      return events;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      durableLease?.releaseEffectLease(state.session.threadId, effect.compactionId, leaseOwner);
    }
  };

  return async (effect, state, emit, executionContext) => {
    if (effect.type === 'run_tools') {
      return executeAppRuntimeToolsEffectV1(
        effect,
        state,
        dependencies,
        emit,
        executionContext,
        subagentEventSink,
      );
    }
    if (effect.type === 'compact_context') {
      return executeContextCompactionV1(effect, state, executionContext);
    }
    if (effect.type === 'run_auto_review') {
      const { modelEffectCoordinator, builtinToolCatalog } =
        requireModelCoordinatorDependencies(dependencies);
      return projectAutoReviewEffectV1(
        effect,
        state,
        dependencies,
        executionContext
          ? {
              getState: () => (executionContext.getState?.() ?? state) as RuntimeState,
              persistEvents: executionContext.persistEvents,
            }
          : undefined,
        builtinToolCatalog,
        modelEffectCoordinator,
      );
    }
    if (
      effect.type === 'run_verification' ||
      effect.type === 'repair_verification' ||
      effect.type === 'run_verification_compensation'
    ) {
      const { modelEffectCoordinator } = requireModelCoordinatorDependencies(dependencies);
      return executeVerificationEffect(effect, state, {
        shellExecutor: dependencies.shellExecutor,
        mcpManager: dependencies.mcpManager,
        artifactStore: dependencies.capabilityArtifactStore,
        signal: dependencies.signal,
        reviewer: async (evidence) => {
          const reviewerConfig = resolveAutoReviewConfig(dependencies.config);
          return modelEffectCoordinator.reviewVerificationEvidence({
            config: reviewerConfig,
            persistence: executionContext
              ? {
                  getState: () => (executionContext.getState?.() ?? state) as RuntimeState,
                  persistEvents: executionContext.persistEvents,
                }
              : undefined,
            evidence,
            timeoutMs: dependencies.config.autoReview?.timeoutMs ?? 30_000,
            providerDataAdmission: reviewerProviderDataAdmission(dependencies, reviewerConfig),
            parentReservationId: executionContext?.reservationIds[0],
          });
        },
      });
    }
    if (effect.type !== 'call_model') {
      throw new Error(`App effect coordinator does not execute ${effect.type}.`);
    }

    const { modelEffectCoordinator, builtinToolCatalog } =
      requireModelCoordinatorDependencies(dependencies);

    const modelInvocationPersistence = executionContext
      ? {
          getState: () => (executionContext.getState?.() ?? state) as RuntimeState,
          persistEvents: executionContext.persistEvents,
        }
      : undefined;

    return projectPrimaryModelEffectV1({
      model: dependencies.model,
      state,
      config: dependencies.config,
      shellExecutor: dependencies.shellExecutor,
      gitBroker: dependencies.gitBroker,
      sandboxBackend: dependencies.sandboxBackend,
      mcpManager: dependencies.mcpManager,
      skills: dependencies.skills,
      skillOptions: dependencies.skillOptions,
      skillCatalog: currentSkillCatalog(dependencies),
      subagentEventSink,
      signal: dependencies.signal,
      emitRuntimeEvent: emit,
      compactionReporter: dependencies.compactionReporter,
      providerDataAdmission: runtimeProviderDataAdmission(dependencies),
      resourceAdmission: effect.resourceEstimate,
      modelEffectCoordinator,
      modelInvocationPersistence,
      subagentTaskRequests: dependencies.subagentTaskRequests,
      builtinToolCatalog,
    });
  };
}

/** State adapter around the Kernel decision and Builtin reviewer coordinator. */
async function projectAutoReviewEffectV1(
  effect: Extract<RuntimeEffect, { type: 'run_auto_review' }>,
  state: Readonly<RuntimeState>,
  dependencies: RuntimeExecutorDependencies,
  modelInvocationPersistence: ModelInvocationPersistenceV1<RuntimeState, RuntimeEvent> | undefined,
  builtinToolCatalog: NonNullable<RuntimeExecutorDependencies['builtinToolCatalog']>,
  modelEffectCoordinator: NonNullable<RuntimeExecutorDependencies['modelEffectCoordinator']>,
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
  let reviewedCall: { id: string; name: string; args: unknown };
  if (subagentId && suspended) {
    try {
      const snapshot = readPrivateSuspendedSubagentV1(
        suspended,
        effect.toolCallId,
        state,
        dependencies.subagentContinuationArtifacts,
      );
      reviewedCall = {
        id: snapshot.blockedTool.toolCallId,
        name: snapshot.blockedTool.toolName,
        args: snapshot.blockedTool.args,
      };
    } catch {
      return [
        {
          type: 'auto_review.completed',
          reviewId: effect.reviewId,
          toolCallId: effect.toolCallId,
          result: {
            ok: true,
            approved: false,
            reason: 'Private Subagent continuation failed exact readback.',
            reviewerModelName: '',
            durationMs: 0,
          },
        },
      ];
    }
  } else {
    reviewedCall = { id: call.toolCallId, name: call.name, args: call.args };
  }
  const parsed = toolRequestFromCall(
    reviewedCall,
    createAppToolTurnContextV1({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
      config: dependencies.config,
      hasGitBroker: Boolean(dependencies.gitBroker),
    }),
    builtinToolCatalog,
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
  const observedAt = Date.now();
  const doomLoop = suspended
    ? runtimeHostStateCheckDoomLoopFingerprintV1(
        state.doomLoop,
        toolInvocationFingerprintV1({
          toolName: request.name,
          parsedArgs: request.args,
          identityRevision: 'subagent-blocked-v1',
        }),
        dependencies.config.autoReview?.doomLoopRepeatThreshold ?? 3,
        60_000,
        observedAt,
      )
    : runtimeHostStateCheckDoomLoopFingerprintV1(
        state.doomLoop,
        runtimeHostStateToolDoomLoopFingerprintV1(request),
        dependencies.config.autoReview?.doomLoopRepeatThreshold ?? 3,
        60_000,
        observedAt,
      );

  const startTime = Date.now();
  try {
    const reviewerConfig = resolveAutoReviewConfig(dependencies.config);
    const activeTask = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;

    const result = await modelEffectCoordinator.reviewToolApproval({
      config: reviewerConfig,
      persistence: modelInvocationPersistence,
      payload: state.interactions.approval,
      request,
      context: {
        ...(activeTask?.userGoal ? { userTask: activeTask.userGoal } : {}),
        isSubAgent: suspended != null,
        ...(suspended ? { subAgentRole: suspended.role } : {}),
        workspaceRoot: state.session.workspace,
        ...(doomLoop.blocked && doomLoop.fingerprint && doomLoop.count
          ? {
              doomLoopInfo: {
                fingerprint: doomLoop.fingerprint,
                count: doomLoop.count,
              },
            }
          : {}),
      },
      // V2 makes the configured reviewer timeout part of the rollout surface;
      // the established path retains the fixed compatibility timeout.
      timeoutMs: resolveAutoReviewTimeout(dependencies.config),
      providerDataAdmission: reviewerProviderDataAdmission(dependencies, reviewerConfig),
      parentInvocationId: call.modelInvocationId,
    });
    const reviewReason = result.suggestion?.reason ?? result.reason;
    const decision = decideAutoReviewV1({
      reviewId: effect.reviewId,
      toolCallId: effect.toolCallId,
      ok: result.ok,
      approved: result.suggestion?.approved ?? false,
      ...(result.suggestion?.grant ? { grant: result.suggestion.grant } : {}),
      ...(reviewReason ? { reason: reviewReason } : {}),
      ...(result.failureType ? { failureType: result.failureType } : {}),
    });
    const accepted = decision.kind === 'accepted_approval';

    const completed: RuntimeEvent = {
      type: 'auto_review.completed',
      reviewId: effect.reviewId,
      toolCallId: effect.toolCallId,
      ...(result.modelInvocationId ? { modelInvocationId: result.modelInvocationId } : {}),
      result: result.ok
        ? {
            ok: true,
            approved: accepted,
            ...(!accepted ? { escalatedToUser: true as const } : {}),
            ...(accepted ? { grant: decision.grant } : {}),
            reason: accepted ? reviewReason : decision.reason,
            reviewerModelName: reviewerConfig.modelName ?? reviewerConfig.providerName ?? 'unknown',
            durationMs: Date.now() - startTime,
          }
        : {
            ok: false,
            approved: false,
            failureType: result.failureType ?? 'technical',
            reason: decision.reason,
            reviewerModelName: reviewerConfig.modelName ?? reviewerConfig.providerName ?? 'unknown',
            durationMs: Date.now() - startTime,
          },
    };
    if (!accepted) {
      return [
        completed,
        {
          type: 'approval.requested',
          interactionId: crypto.randomUUID(),
          toolCallId: effect.toolCallId,
          approval: {
            ...state.interactions.approval,
            reviewFailure: decision.reason,
          },
        },
      ];
    }
    return [completed];
  } catch (error) {
    if (error instanceof ProviderDataAdmissionError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const decision = decideAutoReviewV1({
      reviewId: effect.reviewId,
      toolCallId: effect.toolCallId,
      ok: false,
      approved: false,
      failureType: 'technical',
      ...(reason ? { reason } : {}),
    });
    if (decision.kind !== 'request_user_approval') {
      throw new Error('Kernel accepted a failed auto-review result.');
    }
    return [
      {
        type: 'auto_review.completed',
        reviewId: effect.reviewId,
        toolCallId: effect.toolCallId,
        result: {
          ok: false,
          approved: false,
          failureType: 'technical',
          reason: decision.reason,
          reviewerModelName: dependencies.config.modelName ?? 'unknown',
          durationMs: Date.now() - startTime,
        },
      },
      {
        type: 'approval.requested',
        interactionId: crypto.randomUUID(),
        toolCallId: effect.toolCallId,
        approval: {
          ...state.interactions.approval,
          reviewFailure: decision.reason,
        },
      },
    ];
  }
}
