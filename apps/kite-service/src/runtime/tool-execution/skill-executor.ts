import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import type { SubAgentEventSink } from '@kite-ai/runtime-contract';
import { getAgentPhase } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateEffectiveInteractionMode as getEffectiveInteractionMode,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  SubagentInvocationIdentity,
  SubagentInvocationRuntime,
} from '#kite-service/bootstrap/runtime/subagent/task-tool';
import type {
  SubAgentResult,
  SubAgentToolDispatcher,
} from '#kite-service/bootstrap/runtime/subagent/types';
import { visibleProjectInstructions } from '#kite-service/runtime/tool-execution/project-instruction-guard';
import type { executeAppRuntimeTools } from './router';
import { forkRole, forkToolCeiling } from './subagent-executor';

type AppRuntimeToolExecutionInput = Parameters<typeof executeAppRuntimeTools>[0];

export interface AppSkillForkRequest {
  readonly agent: string;
  readonly capabilityCeiling: readonly string[];
  readonly instructions: string;
  readonly workflowInput: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
}

/**
 * The single App owner for a forked Skill's child model invocation. The
 * caller must already hold the exact acknowledged parent identity and the
 * one App-issued runtime; this helper never creates a coordinator or falls
 * back to Core dispatch.
 */
export async function runAppSkillFork(input: {
  readonly params: AppRuntimeToolExecutionInput;
  readonly call: Readonly<import('@kite-ai/runtime-host').StateToolCallRecord>;
  readonly toolCallId: string;
  readonly builtinProjection: import('@kite-ai/builtin-runtime').BuiltinToolCatalogProjection;
  readonly childToolDispatcher: SubAgentToolDispatcher;
  readonly eventSink: SubAgentEventSink;
  readonly subagentRuntime: SubagentInvocationRuntime;
  readonly subagentInvocationIdentity: SubagentInvocationIdentity;
  readonly fork: AppSkillForkRequest;
}): Promise<SubAgentResult | null> {
  const { params, call, toolCallId, fork, subagentInvocationIdentity } = input;
  if (
    !params.taskConfig ||
    !params.taskModel ||
    !params.getRuntimeState ||
    !params.persistRuntimeEvents
  ) {
    return null;
  }
  const currentState = params.getRuntimeState();
  const forkParentInvocation = Object.values(currentState.capabilities.invocations).find(
    (invocation) =>
      invocation.invocationId === subagentInvocationIdentity.invocationId &&
      invocation.toolCallId === toolCallId &&
      invocation.status === 'running' &&
      invocation.attemptsStarted === subagentInvocationIdentity.attempt,
  );
  if (!forkParentInvocation?.admissionDigest) return null;

  const ceiling = forkToolCeiling({
    capabilityCeiling: fork.capabilityCeiling,
    builtinToolCatalog: input.builtinProjection,
    mcpManager: params.mcpManager,
    turnId: currentState.turn.turnId,
  });
  if (!ceiling) return null;
  if (ceiling.mcpBindings.length > 0) {
    const mergedBindings = new Map(
      Object.values(currentState.capabilities.bindings).map((binding) => [
        binding.bindingId,
        binding,
      ]),
    );
    for (const { binding } of ceiling.mcpBindings) {
      const existing = mergedBindings.get(binding.bindingId);
      if (existing && digestCapabilityValue(existing) !== digestCapabilityValue(binding)) {
        return null;
      }
      mergedBindings.set(binding.bindingId, binding);
    }
    const acknowledged = await params.persistRuntimeEvents([
      {
        type: 'capability.bindings_issued',
        catalogRevision:
          params.mcpManager?.getCapabilitySnapshot().revision ??
          currentState.capabilities.catalogRevision,
        bindings: [...mergedBindings.values()],
        disclosures: Object.values(currentState.capabilities.disclosures),
        loadedCapabilities: Object.values(currentState.capabilities.loadedCapabilities),
      },
    ]);
    const durableState = params.getRuntimeState();
    if (
      !acknowledged ||
      ceiling.mcpBindings.some(({ binding }) => {
        const durableBinding = durableState.capabilities.bindings[binding.bindingId];
        return (
          !durableBinding ||
          digestCapabilityValue(durableBinding) !== digestCapabilityValue(binding)
        );
      })
    ) {
      return null;
    }
  }

  return input.subagentRuntime.start(
    {
      builtinToolCatalog: params.builtinToolCatalog,
      config: params.taskConfig,
      workspace: currentState.session.workspace,
      shellExecutor: params.shellExecutor,
      mcpManager: params.mcpManager,
      skills: params.skillManifests,
      skillOptions: params.skillOptions,
      allowedTools: ceiling.allowedTools,
      mcpBindings: ceiling.mcpBindings,
      workspaceAccess: currentState.workspaceAccess,
      phase: getAgentPhase(getActivePlanning(currentState)),
      interactionMode: getEffectiveInteractionMode(currentState),
      projectInstructions: visibleProjectInstructions(currentState, call.modelMessageId),
      threadId: currentState.session.threadId,
      recoveryIdentityKey: currentState.toolRecovery.identityKey,
      eventSink: input.eventSink,
      signal: params.signal,
      model: params.taskModel,
      descendantResourceAdmission: params.descendantResourceAdmission,
      modelEffectCoordinator: params.modelEffectCoordinator,
      modelInvocationPersistence: params.modelInvocationPersistence,
      subagentLifecyclePersistence: {
        getState: params.getRuntimeState,
        persistEvents: params.persistRuntimeEvents,
      },
      modelInvocationParentId: call.modelInvocationId,
      modelInvocationParentToolCallId: toolCallId,
      modelInvocationParentReservationId: params.modelInvocationParentReservationId,
      subagentInvocationIdentity,
      subagentRuntime: input.subagentRuntime,
      toolDispatcher: input.childToolDispatcher,
      maxDepth: 0,
      recordFilePreimage: params.recordFilePreimage,
    },
    {
      name: `Run ${fork.agent} workflow`,
      subagent_type: forkRole(fork.agent),
      task: [
        fork.instructions,
        '## Validated Workflow Input',
        JSON.stringify(fork.workflowInput),
        '## Required completion format',
        'When the work is complete, respond with only one JSON object. Do not add Markdown or commentary.',
        `The object must validate against this output schema: ${JSON.stringify(fork.outputSchema)}`,
      ].join('\n\n'),
    },
  );
}
