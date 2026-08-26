import { toolRequestFromCall } from '@kite-ai/builtin-runtime';
import {
  digestProjectionEnvironment,
  type ModelInvocationPersistence,
  resolveAutoReviewConfig,
  resolveModelCapabilities,
} from '@kite-ai/builtin-runtime/model';
import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
  type SkillCatalogSnapshot,
} from '@kite-ai/builtin-runtime/skills';
import type { SubAgentEventSink } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateDecideAutoReview as decideAutoReview,
  deferredStateRuntimeEffect,
  runtimeHostStateCheckDoomLoopFingerprint,
  runtimeHostStateToolDoomLoopFingerprint,
  runtimeHostStateToolInvocationFingerprint as toolInvocationFingerprint,
} from '@kite-ai/runtime-host/kernel-adapter';
import { getFeatureFlags } from '#kite-cli/config/features';
import { readPrivateSuspendedSubagent } from '../../runtime/tool-execution/subagent-executor';
import {
  type ContextCompactor,
  executeContextCompaction as runContextCompaction,
} from './context-compaction-effect';
import { projectPrimaryModelEffect } from './model-effect';
import {
  type RuntimeExecutorDependencies,
  resolveAutoReviewTimeout,
  resolveRuntimeContextProjectionEnvironment,
} from './runtime-effect-dependencies';
import { executeAppRuntimeToolsEffect } from './runtime-tool-effect';
import type {
  RuntimeEffect,
  RuntimeEffectExecutor,
  RuntimeEvent,
  RuntimeState,
} from './state-runtime';
import { createAppToolTurnContext } from './tool-turn-context';
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
    getFeatureFlags(dependencies.config).skillWorkflow &&
    getFeatureFlags(dependencies.config).skillActivation
    ? refreshSkillCatalog(dependencies.skillOptions, {
        resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
      })
    : undefined;
}

/**
 * App-owned effect coordinator for the State 27 runtime.
 *
 * The Core executor remains the single owner for every remaining effect. Model,
 * auto-review, verification, and compaction effects are deliberately selected
 * before that executor is called, so none can fall through to a second owner or
 * be retried by the remaining-effect path.
 */
export function createAppRuntimeEffectExecutor(
  dependencies: RuntimeExecutorDependencies,
): RuntimeEffectExecutor {
  const subagentEventSink: SubAgentEventSink = dependencies.subagentEventSink ?? (() => {});

  const executeContextCompaction = async (
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
      !durableLease.effects.tryAcquire(
        state.session.threadId,
        effect.compactionId,
        leaseOwner,
        Date.now() + leaseTtlMs,
      )
    ) {
      return deferredStateRuntimeEffect(
        'Context compaction is already owned by another runtime.',
        100,
      );
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const renewLease = (): boolean => {
      if (!durableLease) return true;
      let renewed = false;
      try {
        renewed = durableLease.effects.renew(
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
                state) as import('@kite-ai/runtime-host').StateRuntimeState,
            persistEvents: executionContext.persistEvents,
          },
          state,
          projectionEnvironmentDigest: digestProjectionEnvironment(projectionEnvironment),
          signal: dependencies.signal,
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
      const events = await runContextCompaction({
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
      durableLease?.effects.release(state.session.threadId, effect.compactionId, leaseOwner);
    }
  };

  return async (effect, state, emit, executionContext) => {
    if (effect.type === 'run_tools') {
      return executeAppRuntimeToolsEffect(
        effect,
        state,
        dependencies,
        emit,
        executionContext,
        subagentEventSink,
      );
    }
    if (effect.type === 'compact_context') {
      return executeContextCompaction(effect, state, executionContext);
    }
    if (effect.type === 'run_auto_review') {
      const { modelEffectCoordinator, builtinToolCatalog } =
        requireModelCoordinatorDependencies(dependencies);
      return projectAutoReviewEffect(
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
      return executeVerificationEffect(effect, state, {
        shellExecutor: dependencies.shellExecutor,
        mcpManager: dependencies.mcpManager,
        artifactStore: dependencies.capabilityArtifactStore,
        signal: dependencies.signal,
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

    return projectPrimaryModelEffect({
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
      resourceAdmission: effect.resourceEstimate,
      modelEffectCoordinator,
      modelInvocationPersistence,
      subagentTaskRequests: dependencies.subagentTaskRequests,
      builtinToolCatalog,
    });
  };
}

function autoReviewCompletionEvents(
  state: Readonly<RuntimeState>,
  completed: Extract<RuntimeEvent, { type: 'auto_review.completed' }>,
  occurredAt: string,
): RuntimeEvent[] {
  const terminalRejection =
    completed.result.approved !== true && completed.result.escalatedToUser !== true;
  if (!terminalRejection) return [completed];

  const reason = completed.result.reason || 'Auto-review rejected the suspended operation.';
  const capabilityTerminals = Object.values(state.capabilities.invocations)
    .filter(
      (invocation) =>
        invocation.toolCallId === completed.toolCallId &&
        (invocation.status === 'recorded' || invocation.status === 'running'),
    )
    .map(
      (invocation): RuntimeEvent => ({
        type: 'capability.reconciliation_resolved',
        invocationId: invocation.invocationId,
        decision: 'confirmed_failure',
        reconciledAt: occurredAt,
        reason,
      }),
    );
  return [...capabilityTerminals, completed];
}

/** State adapter around the Kernel decision and Builtin reviewer coordinator. */
async function projectAutoReviewEffect(
  effect: Extract<RuntimeEffect, { type: 'run_auto_review' }>,
  state: Readonly<RuntimeState>,
  dependencies: RuntimeExecutorDependencies,
  modelInvocationPersistence: ModelInvocationPersistence<RuntimeState, RuntimeEvent> | undefined,
  builtinToolCatalog: NonNullable<RuntimeExecutorDependencies['builtinToolCatalog']>,
  modelEffectCoordinator: NonNullable<RuntimeExecutorDependencies['modelEffectCoordinator']>,
): Promise<RuntimeEvent[]> {
  const call = state.tools.calls[effect.toolCallId];
  if (!call || state.interactions.kind !== 'awaiting_auto_review') return [];

  const pending = state.pendingApprovals.get(effect.reviewId);
  if (!pending || pending.toolCallId !== effect.toolCallId || pending.status !== 'auto_reviewing') {
    return [];
  }
  const pendingGeneration = pending.generation;
  const suspended = state.suspendedSubagents[effect.toolCallId];
  const subagentId = pending.approval.subagentId;
  if (subagentId && (!suspended || suspended.subagentId !== subagentId)) {
    return autoReviewCompletionEvents(
      state,
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
      dependencies.now?.() ?? new Date().toISOString(),
    );
  }
  let reviewedCall: { id: string; name: string; args: unknown };
  if (subagentId && suspended) {
    try {
      const snapshot = readPrivateSuspendedSubagent(
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
      return autoReviewCompletionEvents(
        state,
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
        dependencies.now?.() ?? new Date().toISOString(),
      );
    }
  } else {
    reviewedCall = { id: call.toolCallId, name: call.name, args: call.args };
  }
  const parsed = toolRequestFromCall(
    reviewedCall,
    createAppToolTurnContext({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
      config: dependencies.config,
      hasGitBroker: Boolean(dependencies.gitBroker),
    }),
    builtinToolCatalog,
  );
  if (!parsed?.ok) {
    return autoReviewCompletionEvents(
      state,
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
      dependencies.now?.() ?? new Date().toISOString(),
    );
  }
  const request = parsed.request;
  const observedAt = Date.now();
  const doomLoop = suspended
    ? runtimeHostStateCheckDoomLoopFingerprint(
        state.doomLoop,
        toolInvocationFingerprint({
          toolName: request.name,
          parsedArgs: request.args,
          identityRevision: 'subagent-blocked-v1',
        }),
        dependencies.config.autoReview?.doomLoopRepeatThreshold ?? 3,
        60_000,
        observedAt,
      )
    : runtimeHostStateCheckDoomLoopFingerprint(
        state.doomLoop,
        runtimeHostStateToolDoomLoopFingerprint(request),
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
      timeoutMs: resolveAutoReviewTimeout(dependencies.config),
      parentInvocationId: call.modelInvocationId,
    });
    const reviewReason = result.suggestion?.reason ?? result.reason;
    const decision = decideAutoReview({
      reviewId: effect.reviewId,
      toolCallId: effect.toolCallId,
      ok: result.ok,
      approved: result.suggestion?.approved ?? false,
      ...(result.suggestion?.requiresUserApproval ? { requiresUserApproval: true as const } : {}),
      ...(result.suggestion?.grant ? { grant: result.suggestion.grant } : {}),
      ...(reviewReason ? { reason: reviewReason } : {}),
      ...(result.failureType ? { failureType: result.failureType } : {}),
    });
    const accepted = decision.kind === 'accepted_approval';
    const escalated = decision.kind === 'request_user_approval';

    const completed: Extract<RuntimeEvent, { type: 'auto_review.completed' }> = {
      type: 'auto_review.completed',
      reviewId: effect.reviewId,
      toolCallId: effect.toolCallId,
      ...(result.modelInvocationId ? { modelInvocationId: result.modelInvocationId } : {}),
      result: result.ok
        ? {
            ok: true,
            approved: accepted,
            ...(escalated ? { escalatedToUser: true as const } : {}),
            ...(accepted ? { grant: decision.grant } : {}),
            reason: accepted ? reviewReason : decision.reason,
            reviewerModelName: reviewerConfig.modelName ?? reviewerConfig.providerName ?? 'unknown',
            durationMs: Date.now() - startTime,
          }
        : {
            ok: false,
            approved: false,
            ...(escalated ? { escalatedToUser: true as const } : {}),
            failureType: result.failureType ?? 'technical',
            reason: decision.reason,
            reviewerModelName: reviewerConfig.modelName ?? reviewerConfig.providerName ?? 'unknown',
            durationMs: Date.now() - startTime,
          },
    };
    const currentState = modelInvocationPersistence?.getState() ?? state;
    const currentPending = currentState.pendingApprovals.get(effect.reviewId);
    if (
      !currentPending ||
      currentPending.toolCallId !== effect.toolCallId ||
      currentPending.status !== 'auto_reviewing' ||
      currentPending.generation !== pendingGeneration
    ) {
      return [];
    }
    // The durable queue keeps the same review/interaction identity while an
    // auto review escalates to the user. The Kernel reducer advances that
    // record to awaiting_user from this completion fact; emitting a second
    // approval.requested would duplicate the invocation and lose FIFO identity.
    return autoReviewCompletionEvents(
      currentState,
      completed,
      dependencies.now?.() ?? new Date().toISOString(),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const decision = decideAutoReview({
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
    const currentState = modelInvocationPersistence?.getState() ?? state;
    const currentPending = currentState.pendingApprovals.get(effect.reviewId);
    if (
      !currentPending ||
      currentPending.toolCallId !== effect.toolCallId ||
      currentPending.status !== 'auto_reviewing' ||
      currentPending.generation !== pendingGeneration
    ) {
      return [];
    }
    return [
      {
        type: 'auto_review.completed',
        reviewId: effect.reviewId,
        toolCallId: effect.toolCallId,
        result: {
          ok: false,
          approved: false,
          escalatedToUser: true,
          failureType: 'technical',
          reason: decision.reason,
          reviewerModelName: dependencies.config.modelName ?? 'unknown',
          durationMs: Date.now() - startTime,
        },
      },
    ];
  }
}
