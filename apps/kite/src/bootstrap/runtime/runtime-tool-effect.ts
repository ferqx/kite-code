import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
  type SkillCatalogSnapshot,
  verifyBuiltinWorkspaceFilesystemTerminalV1,
} from '@kite/builtin-runtime';
import { sandboxSupportsFullModeV1 } from '@kite/builtin-runtime/sandbox';
import type { SubAgentEventSink } from '@kite/runtime-contract';
import {
  createDescendantResourceAdmissionV1,
  createRuntimeHostInteractionIdV1,
  DescendantResourceAdmissionError,
} from '@kite/runtime-host';
import { getFeatureFlags } from '#app/config/features';
import { isBuiltinSubagentTaskToolNameV1 } from '#builtin-runtime';
import { classifyFailure } from './failures';
import { createFilePreimageRecorder } from './file-checkpoints';
import { ProviderReadinessCoordinatorV1 } from './provider-readiness';
import { resourceAdmissionTerminalEventsV1 } from './resource-admission-terminal';
import type { RuntimeExecutorDependencies } from './runtime-effect-dependencies';
import type {
  RuntimeEffect,
  RuntimeEffectExecutor,
  RuntimeEvent,
  RuntimeState,
} from './state-runtime';
import {
  executeAppRuntimeToolsV1,
  serializeConcurrentSubagentApprovalEvents,
} from './tool-controller-adapter';
import {
  createAppOrdinaryToolPipelineAttemptRuntimeV1,
  createAppToolPipelineAttemptScopeV1,
} from './tool-pipeline-ordinary-attempt';
import { createAppStateToolPipelinePersistenceV1 } from './tool-pipeline-state-persistence';
import { createAppTaskToolPipelineAttemptRuntimeV1 } from './tool-pipeline-task-attempt';

function requireBuiltinToolCatalogV1(dependencies: RuntimeExecutorDependencies) {
  if (!dependencies.builtinToolCatalog) {
    throw new Error('Runtime Builtin tool catalog projection is unavailable.');
  }
  return dependencies.builtinToolCatalog;
}

function requireModelEffectCoordinatorV1(dependencies: RuntimeExecutorDependencies) {
  if (!dependencies.modelEffectCoordinator) {
    throw new Error('Builtin Model effect coordinator is unavailable.');
  }
  return dependencies.modelEffectCoordinator;
}

/** Validate the exact App composition before the adapter receives a tool call. */
function resolveToolPipelineAdapterCompositionV1(
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
    getFeatureFlags(dependencies.config).skillWorkflowV1 &&
    getFeatureFlags(dependencies.config).skillActivationV2
    ? refreshSkillCatalog(dependencies.skillOptions, {
        resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
      })
    : undefined;
}

/** App-owned State projection for the one run_tools effect. */
export async function executeAppRuntimeToolsEffectV1(
  effect: Extract<RuntimeEffect, { type: 'run_tools' }>,
  state: Readonly<RuntimeState>,
  dependencies: RuntimeExecutorDependencies,
  emit: Parameters<RuntimeEffectExecutor>[2],
  executionContext: Parameters<RuntimeEffectExecutor>[3],
  subagentEventSink: SubAgentEventSink,
): Promise<RuntimeEvent[]> {
  const providerReadinessCoordinator = new ProviderReadinessCoordinatorV1(dependencies.mcpManager);
  const persistAttemptStartEvents = executionContext?.persistAttemptStartEvents;
  const persistTerminalRecoveryEvents = executionContext?.persistTerminalRecoveryEvents;
  const stateToolPipelinePersistence =
    executionContext &&
    persistAttemptStartEvents &&
    persistTerminalRecoveryEvents &&
    dependencies.capabilityArtifactStore
      ? createAppStateToolPipelinePersistenceV1({
          getState: () => (executionContext.getState?.() ?? state) as RuntimeState,
          persistAttemptStartEvents: (events) => persistAttemptStartEvents(events),
          persistTerminalRecoveryEvents: (events) => persistTerminalRecoveryEvents(events),
          persistReceiptEvents: (events) => executionContext.persistEvents(events),
          now: dependencies.now ?? (() => new Date().toISOString()),
          capabilityArtifactWriter: dependencies.capabilityArtifactStore,
          verifyBuiltinWorkspaceFilesystemTerminal: verifyBuiltinWorkspaceFilesystemTerminalV1,
          providerAction: Object.freeze({
            enabled: getFeatureFlags(dependencies.config).mcpProviderActionV1,
            createInteractionId: createRuntimeHostInteractionIdV1,
          }),
          verificationEnabled: getFeatureFlags(dependencies.config).verificationV1 === true,
        })
      : undefined;
  const toolPipelineAttemptScope = stateToolPipelinePersistence
    ? createAppToolPipelineAttemptScopeV1({ persistence: stateToolPipelinePersistence })
    : undefined;
  const ordinaryToolPipelineAttemptRuntime =
    stateToolPipelinePersistence && toolPipelineAttemptScope
      ? createAppOrdinaryToolPipelineAttemptRuntimeV1({
          persistence: stateToolPipelinePersistence,
          scope: toolPipelineAttemptScope,
        })
      : undefined;
  const taskToolPipelineAttemptRuntime =
    stateToolPipelinePersistence && toolPipelineAttemptScope
      ? createAppTaskToolPipelineAttemptRuntimeV1({
          persistence: stateToolPipelinePersistence,
          scope: toolPipelineAttemptScope,
        })
      : undefined;
  try {
    const parallelSubagentBatch =
      effect.toolCallIds.length > 1 &&
      effect.toolCallIds.every((toolCallId) =>
        isBuiltinSubagentTaskToolNameV1(state.tools.calls[toolCallId]?.name),
      );
    const execute = async (toolCallIds: string[], subagentConcurrencyGroupId?: string) => {
      const taskCallId =
        toolCallIds.length === 1 &&
        isBuiltinSubagentTaskToolNameV1(state.tools.calls[toolCallIds[0]!]?.name)
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
      try {
        const toolPipelineComposition = resolveToolPipelineAdapterCompositionV1(dependencies);
        const returnedEvents = await executeAppRuntimeToolsV1({
          state,
          toolCallIds,
          shellExecutor: dependencies.shellExecutor,
          gitBroker: dependencies.gitBroker,
          mcpManager: dependencies.mcpManager,
          capabilityExecution: dependencies.capabilityExecution,
          builtinToolCatalog: requireBuiltinToolCatalogV1(dependencies),
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
          providerDataAdmission: dependencies.providerDataAdmission,
          descendantResourceAdmission,
          modelEffectCoordinator: requireModelEffectCoordinatorV1(dependencies),
          capabilityArtifactStore: dependencies.capabilityArtifactStore,
          workspaceFilesystemRuntime: dependencies.workspaceFilesystemRuntime,
          sandboxPreparationArtifacts: dependencies.sandboxPreparationArtifacts,
          sandboxAvailable:
            dependencies.sandboxBackend !== 'unknown' &&
            sandboxSupportsFullModeV1(dependencies.sandboxBackend ?? 'none'),
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
                  decision: import('@kite/builtin-runtime/sandbox').NetworkDecisionReceiptV1,
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
        return [
          ...terminalEvents,
          ...resourceAdmissionTerminalEventsV1(currentState, error.reason),
        ];
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
      const currentState = (executionContext?.getState?.() as RuntimeState | undefined) ?? state;
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
