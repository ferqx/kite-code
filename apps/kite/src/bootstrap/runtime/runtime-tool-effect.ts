import { verifyBuiltinWorkspaceFilesystemTerminal } from '@kite-ai/builtin-runtime';
import { sandboxBackendAvailable } from '@kite-ai/builtin-runtime/sandbox';
import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
  type SkillCatalogSnapshot,
} from '@kite-ai/builtin-runtime/skills';
import { isBuiltinSubagentTaskToolName } from '@kite-ai/builtin-runtime/subagent';
import type { SubAgentEventSink } from '@kite-ai/runtime-contract';
import { createRuntimeHostInteractionId } from '@kite-ai/runtime-host';
import {
  createDescendantResourceAdmission,
  DescendantResourceAdmissionError,
} from '@kite-ai/runtime-host/kernel-adapter';
import { getFeatureFlags } from '#app/config/features';
import { executeAppRuntimeTools } from '../../runtime/tool-execution/router';
import { isConcurrentExploreSubagentBatch } from '../../runtime/tool-execution/subagent-executor';
import { createAppStateToolPipelinePersistence } from '../../runtime/tool-persistence';
import { classifyFailure } from './failures';
import { createFilePreimageRecorder } from './file-checkpoints';
import { ProviderReadinessCoordinator } from './provider-readiness';
import { resourceAdmissionTerminalEvents } from './resource-admission-terminal';
import type { RuntimeExecutorDependencies } from './runtime-effect-dependencies';
import type {
  RuntimeEffect,
  RuntimeEffectExecutor,
  RuntimeEvent,
  RuntimeState,
} from './state-runtime';
import {
  createAppOrdinaryToolPipelineAttemptRuntime,
  createAppToolPipelineAttemptScope,
} from './tool-pipeline-ordinary-attempt';
import { createAppTaskToolPipelineAttemptRuntime } from './tool-pipeline-task-attempt';

function requireBuiltinToolCatalog(dependencies: RuntimeExecutorDependencies) {
  if (!dependencies.builtinToolCatalog) {
    throw new Error('Runtime Builtin tool catalog projection is unavailable.');
  }
  return dependencies.builtinToolCatalog;
}

function requireModelEffectCoordinator(dependencies: RuntimeExecutorDependencies) {
  if (!dependencies.modelEffectCoordinator) {
    throw new Error('Builtin Model effect coordinator is unavailable.');
  }
  return dependencies.modelEffectCoordinator;
}

/** Validate the exact App composition before the adapter receives a tool call. */
function resolveToolPipelineAdapterComposition(
  dependencies: RuntimeExecutorDependencies,
): NonNullable<RuntimeExecutorDependencies['toolPipelineComposition']> {
  const composition = dependencies.toolPipelineComposition;
  if (!composition) {
    throw new Error('Runtime Tool Pipeline composition is unavailable.');
  }
  if (composition.baseProjection !== dependencies.builtinToolCatalog) {
    throw new Error('Runtime Tool Pipeline composition is not bound to the Builtin catalog.');
  }
  return composition;
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

/** App-owned State projection for the one run_tools effect. */
export async function executeAppRuntimeToolsEffect(
  effect: Extract<RuntimeEffect, { type: 'run_tools' }>,
  state: Readonly<RuntimeState>,
  dependencies: RuntimeExecutorDependencies,
  emit: Parameters<RuntimeEffectExecutor>[2],
  executionContext: Parameters<RuntimeEffectExecutor>[3],
  subagentEventSink: SubAgentEventSink,
): Promise<RuntimeEvent[]> {
  const providerReadinessCoordinator = new ProviderReadinessCoordinator(dependencies.mcpManager);
  const persistAttemptStartEvents = executionContext?.persistAttemptStartEvents;
  const persistTerminalRecoveryEvents = executionContext?.persistTerminalRecoveryEvents;
  const stateToolPipelinePersistence =
    executionContext &&
    persistAttemptStartEvents &&
    persistTerminalRecoveryEvents &&
    dependencies.capabilityArtifactStore
      ? createAppStateToolPipelinePersistence({
          getState: () => (executionContext.getState?.() ?? state) as RuntimeState,
          persistAttemptStartEvents: (events) => persistAttemptStartEvents(events),
          persistTerminalRecoveryEvents: (events) => persistTerminalRecoveryEvents(events),
          persistReceiptEvents: (events) => executionContext.persistEvents(events),
          now: dependencies.now ?? (() => new Date().toISOString()),
          capabilityArtifactWriter: dependencies.capabilityArtifactStore,
          verifyBuiltinWorkspaceFilesystemTerminal: verifyBuiltinWorkspaceFilesystemTerminal,
          providerAction: Object.freeze({
            enabled: getFeatureFlags(dependencies.config).mcpProviderAction,
            createInteractionId: createRuntimeHostInteractionId,
          }),
          verificationEnabled: getFeatureFlags(dependencies.config).verification === true,
        })
      : undefined;
  const toolPipelineAttemptScope = stateToolPipelinePersistence
    ? createAppToolPipelineAttemptScope({ persistence: stateToolPipelinePersistence })
    : undefined;
  const ordinaryToolPipelineAttemptRuntime =
    stateToolPipelinePersistence && toolPipelineAttemptScope
      ? createAppOrdinaryToolPipelineAttemptRuntime({
          persistence: stateToolPipelinePersistence,
          scope: toolPipelineAttemptScope,
        })
      : undefined;
  const taskToolPipelineAttemptRuntime =
    stateToolPipelinePersistence && toolPipelineAttemptScope
      ? createAppTaskToolPipelineAttemptRuntime({
          persistence: stateToolPipelinePersistence,
          scope: toolPipelineAttemptScope,
        })
      : undefined;
  try {
    const parallelSubagentBatch =
      effect.toolCallIds.length > 1 &&
      effect.toolCallIds.every((toolCallId) =>
        isBuiltinSubagentTaskToolName(state.tools.calls[toolCallId]?.name),
      );
    const parallelExploreBatch =
      parallelSubagentBatch && isConcurrentExploreSubagentBatch(state, effect.toolCallIds);
    const execute = async (toolCallIds: string[], subagentConcurrencyGroupId?: string) => {
      const taskCallId =
        toolCallIds.length === 1 &&
        isBuiltinSubagentTaskToolName(state.tools.calls[toolCallIds[0]!]?.name)
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
          ? createDescendantResourceAdmission({
              state: state as RuntimeState,
              parentReservationId,
              getState: () => (executionContext.getState?.() ?? state) as RuntimeState,
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
      const emitOrDefer = (rawEvent: RuntimeEvent) => {
        // Approval requests are durable queue facts now.  Do not replace a
        // sibling's canonical request with a local deferred placeholder;
        // Kernel queue ordering/focus is the sole authority.
        const event = rawEvent;
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
      try {
        const toolPipelineComposition = resolveToolPipelineAdapterComposition(dependencies);
        const returnedEvents = await executeAppRuntimeTools({
          state,
          toolCallIds,
          shellExecutor: dependencies.shellExecutor,
          gitBroker: dependencies.gitBroker,
          mcpManager: dependencies.mcpManager,
          capabilityExecution: dependencies.capabilityExecution,
          builtinToolCatalog: requireBuiltinToolCatalog(dependencies),
          toolPipelineComposition,
          ordinaryToolPipelineAttemptRuntime,
          taskToolPipelineAttemptRuntime,
          planArtifactStore: dependencies.planArtifactStore,
          providerReadinessCoordinator,
          skillManifests: dependencies.skills,
          skillOptions: dependencies.skillOptions,
          skillCatalog: currentSkillCatalog(dependencies),
          signal: dependencies.signal,
          taskConfig: dependencies.config,
          taskModel: dependencies.model,
          descendantResourceAdmission,
          modelEffectCoordinator: requireModelEffectCoordinator(dependencies),
          capabilityArtifactStore: dependencies.capabilityArtifactStore,
          workspaceFilesystemRuntime: dependencies.workspaceFilesystemRuntime,
          sandboxPreparationArtifacts: dependencies.sandboxPreparationArtifacts,
          sandboxAvailable:
            dependencies.sandboxBackend !== 'unknown' &&
            sandboxBackendAvailable(dependencies.sandboxBackend ?? 'none'),
          authorizationObservedAt: Date.now(),
          subagentRuntimeFactory: dependencies.subagentRuntimeFactory,
          subagentContinuationArtifacts: dependencies.subagentContinuationArtifacts,
          subagentTaskRequests: dependencies.subagentTaskRequests,
          modelInvocationPersistence: executionContext
            ? {
                getState: () => (executionContext.getState?.() ?? state) as RuntimeState,
                persistEvents: executionContext.persistEvents,
              }
            : undefined,
          modelInvocationParentReservationId: parentReservationId,
          subagentConcurrencyGroupId,
          subagentAutoReviewBatch: parallelExploreBatch,
          subagentEventSink,
          emitRuntimeEvent: emitOrDefer,
          emitTerminalEventBatch: (events) => terminalEvents.push(...events),
          persistRuntimeEvent: executionContext?.persistEvent,
          persistRuntimeEvents: executionContext?.persistEvents,
          getRuntimeState: () => (executionContext?.getState?.() ?? state) as RuntimeState,
          recordFilePreimage: createFilePreimageRecorder(
            dependencies.runtimeStore,
            state.session.threadId,
          ),
          ...(executionContext
            ? {
                recordNetworkDecision: async (
                  decision: import('@kite-ai/builtin-runtime/sandbox').NetworkDecisionReceipt,
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
              }
            : {}),
        });
        for (const event of returnedEvents) emitOrDefer(event);
      } catch (error) {
        if (!(error instanceof DescendantResourceAdmissionError)) throw error;
        const currentState = (executionContext?.getState?.() as RuntimeState | undefined) ?? state;
        return [...terminalEvents, ...resourceAdmissionTerminalEvents(currentState, error.reason)];
      }
      return terminalEvents;
    };
    if (effect.toolCallIds.length <= 1) {
      return await execute([...effect.toolCallIds]);
    }
    const subagentConcurrencyGroupId = parallelSubagentBatch
      ? `subagent-batch:${effect.toolCallIds[0]!}`
      : undefined;
    const batches = await Promise.allSettled(
      effect.toolCallIds.map((toolCallId) => execute([toolCallId], subagentConcurrencyGroupId)),
    );
    const terminalEventBatches: RuntimeEvent[][] = [];
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index]!;
      if (batch.status === 'fulfilled') {
        terminalEventBatches.push(batch.value);
        continue;
      }
      const toolCallId = effect.toolCallIds[index]!;
      const currentState = (executionContext?.getState?.() as RuntimeState | undefined) ?? state;
      if (batch.reason instanceof DescendantResourceAdmissionError) {
        terminalEventBatches.push(
          resourceAdmissionTerminalEvents(currentState, batch.reason.reason),
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
    return terminalEventBatches.flat();
  } catch (error) {
    if (error instanceof DescendantResourceAdmissionError) {
      const currentState = (executionContext?.getState?.() as RuntimeState | undefined) ?? state;
      return resourceAdmissionTerminalEvents(currentState, error.reason);
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
