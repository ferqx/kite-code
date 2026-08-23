import type { SkillManifest, SkillScanOptions } from '@kite/builtin-runtime';
import {
  type BuiltinChildRuntimeDriverV1,
  type BuiltinChildRuntimeResumeRegistrationV1,
  type BuiltinChildRuntimeStartRegistrationV1,
  type GovernedSubagentCompositionV1 as BuiltinGovernedSubagentCompositionV1,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  digestCapabilityValueV1,
  getRoleConfig,
  type LocalSubagentDriverResultV1,
  subagentDispatchIntentDigestV1,
  subagentTaskDigestV1,
} from '@kite/builtin-runtime';
import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type { SupportedChatModel } from '@kite/builtin-runtime/model';
import type { ShellExecutor } from '@kite/builtin-runtime/sandbox';
import { canonicalPathForComparison } from '@kite/builtin-runtime/sandbox';
import {
  runtimeHostStateCreateToolRecoveryJournalV1 as createToolRecoveryJournalV1,
  DescendantResourceAdmissionError,
  type DescendantResourceAdmissionV1,
} from '@kite/runtime-host';
import type {
  SubagentDelegationGrantV1,
  SubagentHandleV1,
  SubagentResumeGrantV1,
} from '@kite/runtime-spi';
import type { AgentConfig } from '#app/config/index';
import { computeExecutionBoundaryDigestV1 } from '#app/config/index';
import type {
  SubagentLifecycleArtifactAccessV1,
  SubagentTaskArtifactAccessV1,
} from '#builtin-runtime';
import type { ToolExecutionResult } from '../tool-result';
import {
  serializeSubagentContinuation,
  subagentContinuationCursorIdV1,
} from './continuation-codec';
import { subagentResultFromObservationV1 } from './observation-codec';
import {
  executeSubagentResumeWithCoreToolAdapterV1,
  executeSubagentStartWithCoreToolAdapterV1,
} from './tool-adapter';
import type { SubAgentEventSink, SubAgentResult, SubAgentRunnerInput } from './types';

type GovernedSubagentCompositionV1 = BuiltinGovernedSubagentCompositionV1<
  SubagentLifecycleArtifactAccessV1,
  BuiltinChildRuntimeDriverV1,
  SubagentTaskArtifactAccessV1
>;

interface CoreSubagentResumeToolResultV1 {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolExecutionResult;
}

/** Core State registration adapter over the Builtin lifecycle Driver. */
function createCoreSubagentStartRegistrationV1(input: {
  readonly input: SubAgentRunnerInput;
  readonly expiresAtMs?: number;
}): BuiltinChildRuntimeStartRegistrationV1 {
  return {
    ...registrationIdentityV1(input.input),
    ...(input.expiresAtMs === undefined ? {} : { expiresAtMs: input.expiresAtMs }),
    run: async (grant, task, signal) => {
      const exact = exactInput(input.input, task, grant, signal);
      const result = await governedRun(
        () => executeSubagentStartWithCoreToolAdapterV1(exact),
        exact,
      );
      return toLocalSubagentDriverResultV1(grant.childInvocationId, result);
    },
  };
}

/** Core State resume adapter over the Builtin lifecycle Driver. */
function createCoreSubagentResumeRegistrationV1(input: {
  readonly input: SubAgentRunnerInput;
  readonly continuation: import('./types').RestoredSubAgentContinuation;
  readonly toolResult: CoreSubagentResumeToolResultV1;
  readonly expiresAtMs?: number;
}): BuiltinChildRuntimeResumeRegistrationV1 {
  return {
    ...registrationIdentityV1(input.input),
    ...(input.expiresAtMs === undefined ? {} : { expiresAtMs: input.expiresAtMs }),
    run: async (grant, task, signal) => {
      const snapshot = serializeSubagentContinuation(
        input.continuation,
        input.continuation.blockedTool,
      );
      if (
        grant.continuationId !== subagentContinuationCursorIdV1(snapshot) ||
        grant.continuationDigest !==
          digestCapabilityValueV1({ schema: 'kite.subagent-continuation.v1', snapshot }) ||
        grant.blockedToolCallId !== input.continuation.blockedTool.toolCallId ||
        grant.blockedRuntimeToolCallId !== input.continuation.blockedTool.runtimeToolCallId ||
        grant.blockedToolCallId !== input.toolResult.toolCallId ||
        grant.resumeAttempt !== input.input.subagentGrantContext?.attempt
      ) {
        throw new Error('Child Runtime resume grant does not match its durable continuation.');
      }
      const exact = exactInput(input.input, task, grant, signal);
      const result = await governedRun(
        () =>
          executeSubagentResumeWithCoreToolAdapterV1(exact, input.continuation, input.toolResult),
        exact,
      );
      return toLocalSubagentDriverResultV1(grant.childInvocationId, result);
    },
  };
}

export interface TaskToolDeps {
  builtinToolCatalog?: import('@kite/builtin-runtime').BuiltinToolCatalogProjectionV1;
  config: AgentConfig;
  workspace: string;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@kite/builtin-runtime/git').GitBrokerV1;
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  allowedTools?: Set<string>;
  mcpBindings?: Array<{
    binding: import('@kite/runtime-contract').CapabilityBinding;
    descriptor: import('@kite/runtime-contract').CapabilityDescriptor;
  }>;
  authorization?: import('@kite/runtime-host').StateAuthorizationStateV1;
  workspaceAccess?: import('@kite/runtime-contract').WorkspaceAccess;
  phase?: import('@kite/runtime-contract').AgentPhase;
  /** Current parent Runtime interaction mode, inherited by the child execution. */
  interactionMode: import('@kite/runtime-contract').InteractionMode;
  projectInstructions?: import('@kite/builtin-runtime/model').ProjectInstructionSnapshot;
  threadId?: string;
  /** Exact live parent Runtime recovery identity; child execution cannot synthesize one. */
  recoveryIdentityKey: string;
  eventSink: SubAgentEventSink;
  signal?: AbortSignal;
  model?: SupportedChatModel;
  providerDataAdmission?: import('#app/config/provider-data-admission').ProviderDataAdmissionGateV1;
  descendantResourceAdmission?: DescendantResourceAdmissionV1;
  modelEffectCoordinator?: import('@kite/builtin-runtime/model').BuiltinModelEffectCoordinatorV1;
  modelInvocationPersistence?: import('@kite/builtin-runtime/model').ModelInvocationPersistenceV1<
    import('@kite/runtime-host').RuntimeState,
    import('@kite/runtime-host').StateRuntimeEventV1
  >;
  /** Outer Runtime lifecycle facts; distinct from ModelInvocationGateway persistence. */
  subagentLifecyclePersistence?: {
    getState(): Readonly<import('@kite/runtime-host').RuntimeState>;
    persistEvents(events: import('@kite/runtime-host').StateRuntimeEventV1[]): Promise<boolean>;
  };
  modelInvocationParentId?: string;
  modelInvocationParentToolCallId?: string;
  modelInvocationParentReservationId?: string;
  subagentInvocationIdentity?: SubagentInvocationIdentityV1;
  /** Pipeline-issued lifecycle runtime. Task adapters cannot compose or select Providers. */
  subagentRuntime?: SubagentInvocationRuntimeV1;
  toolDispatcher?: import('./types').SubAgentToolDispatcherV1;
  maxDepth?: number;
  /** 写入前文件原像记录器，透传给子 agent 的工具执行（ADR-0042 §4）。 */
  recordFilePreimage?: import('@kite/runtime-host/storage').RuntimeHostFilePreimageRecorderV1;
}

export interface SubagentInvocationIdentityV1 {
  invocationId: string;
  attempt: number;
  capabilityRevision: string;
  authorizationDigest: string;
  admissionDigest: string;
  effectiveEffectsDigest: string;
}

export interface SubagentInvocationRuntimeV1 {
  start(
    deps: TaskToolDeps,
    args: { subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string },
  ): Promise<SubAgentResult>;
  resume(
    deps: TaskToolDeps,
    continuation: import('./types').RestoredSubAgentContinuation,
    toolResult: {
      toolCallId: string;
      toolName: string;
      result: import('../tool-result').ToolExecutionResult;
    },
  ): Promise<SubAgentResult>;
}

export class SubagentProviderRecoveryRequiredErrorV1 extends Error {
  readonly code = 'subagent_provider_recovery_required';
  constructor(message: string) {
    super(message);
    this.name = 'SubagentProviderRecoveryRequiredErrorV1';
  }
}

export async function runTaskSubAgent(
  deps: TaskToolDeps,
  args: { subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string },
): Promise<SubAgentResult> {
  if (!deps.subagentRuntime) {
    return failed('Governed Subagent Pipeline runtime is unavailable.');
  }
  return deps.subagentRuntime.start(deps, args);
}

/** Pipeline-owned implementation; production imports are statically restricted to composition. */
export async function executePipelineIssuedSubagentStartV1(
  composition: GovernedSubagentCompositionV1,
  deps: TaskToolDeps,
  args: { subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string },
): Promise<SubAgentResult> {
  if (
    !deps.subagentInvocationIdentity ||
    !deps.modelEffectCoordinator ||
    !deps.modelInvocationPersistence ||
    !deps.modelInvocationParentId ||
    !deps.modelInvocationParentToolCallId
  ) {
    return failed('Governed Subagent Provider execution context is unavailable.');
  }
  const baseRole = getRoleConfig(args.subagent_type);
  const role = {
    ...baseRole,
    ...(deps.allowedTools
      ? {
          allowedTools: new Set(
            [...deps.allowedTools].filter(
              (toolName) => !baseRole.allowedTools || baseRole.allowedTools.has(toolName),
            ),
          ),
        }
      : {}),
  };
  const { grants: authority, driver, provider } = composition;
  const childInvocationId = authority.issueChildInvocationId({
    parentModelInvocationId: deps.modelInvocationParentId,
    parentAttempt: deps.subagentInvocationIdentity.attempt,
    parentToolCallId: deps.modelInvocationParentToolCallId,
    role: role.role,
  });
  const allowedTools = [...(role.allowedTools ?? [])].sort();
  const bindingIds = (deps.mcpBindings ?? []).map(({ binding }) => binding.bindingId).sort();
  const taskArtifacts = composition.taskArtifacts;
  const publishedTask = taskArtifacts.write({
    owner: {
      parentInvocationId: deps.subagentInvocationIdentity.invocationId,
      parentAttempt: deps.subagentInvocationIdentity.attempt,
      parentToolCallId: deps.modelInvocationParentToolCallId,
      childInvocationId,
    },
    task: args.task,
  });
  const taskDigest = publishedTask.taskDigest;
  const boundaryDigest = deps.config.executionBoundary
    ? computeExecutionBoundaryDigestV1(deps.config.executionBoundary)
    : `sha256:${digestCapabilityValueV1({ schema: 'kite.execution-boundary.unconfigured.v1' })}`;
  const grant = authority.issueStart({
    parentInvocationId: deps.subagentInvocationIdentity.invocationId,
    parentToolCallId: deps.modelInvocationParentToolCallId,
    parentAttempt: deps.subagentInvocationIdentity.attempt,
    capabilityRevision: deps.subagentInvocationIdentity.capabilityRevision,
    admissionDigest: deps.subagentInvocationIdentity.admissionDigest,
    effectiveEffectsDigest: deps.subagentInvocationIdentity.effectiveEffectsDigest,
    childInvocationId,
    role: role.role,
    taskArtifact: publishedTask.ref,
    taskDigest,
    capabilityCeiling: {
      allowedTools,
      bindingIds,
      bindingRevision: digestCapabilityValueV1({
        schema: 'kite.subagent-binding-revision.v1',
        bindings: (deps.mcpBindings ?? []).map(({ binding }) => binding),
      }),
      ceilingDigest: digestCapabilityValueV1({
        schema: 'kite.subagent-capability-ceiling.v1',
        allowedTools,
        bindingIds,
        role: role.role,
      }),
    },
    authorization: {
      authorizationDigest: deps.subagentInvocationIdentity.authorizationDigest,
      interactionMode: deps.interactionMode,
      phase: deps.phase ?? 'building',
      workspaceAccess: deps.workspaceAccess ?? 'write',
    },
    executionBoundary: {
      canonicalWorkspace: canonicalPathForComparison(deps.workspace),
      executionBoundaryDigest: boundaryDigest,
    },
    resource: {
      parentReservationId: deps.modelInvocationParentReservationId ?? null,
      budgetDigest: digestCapabilityValueV1({
        schema: 'kite.subagent-resource-budget.v1',
        budget: stableBudgetCeiling(deps.modelInvocationPersistence.getState().resourceBudget),
      }),
    },
    cancellationCorrelation: deps.modelInvocationParentToolCallId,
    model: {
      parentModelInvocationId: deps.modelInvocationParentId,
      parentToolCallId: deps.modelInvocationParentToolCallId,
    },
  });
  driver.registerStart(
    grant.grantId,
    createCoreSubagentStartRegistrationV1({
      input: {
        config: deps.config,
        builtinToolCatalog: deps.builtinToolCatalog,
        workspace: deps.workspace,
        role,
        task: args.task,
        shellExecutor: deps.shellExecutor,
        gitBroker: deps.gitBroker,
        mcpManager: deps.mcpManager,
        skills: deps.skills,
        skillOptions: deps.skillOptions,
        mcpBindings: deps.mcpBindings,
        authorization: deps.authorization,
        workspaceAccess: deps.workspaceAccess,
        phase: deps.phase,
        interactionMode: deps.interactionMode,
        projectInstructions: deps.projectInstructions,
        threadId: deps.threadId,
        recoveryIdentityKey: deps.recoveryIdentityKey,
        timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
        signal: deps.signal ?? new AbortController().signal,
        eventSink: deps.eventSink,
        model: deps.model,
        providerDataAdmission: deps.providerDataAdmission,
        descendantResourceAdmission: deps.descendantResourceAdmission,
        modelEffectCoordinator: deps.modelEffectCoordinator,
        modelInvocationPersistence: deps.modelInvocationPersistence,
        modelInvocationParentId: deps.modelInvocationParentId,
        modelInvocationParentToolCallId: deps.modelInvocationParentToolCallId,
        modelInvocationParentReservationId: deps.modelInvocationParentReservationId,
        childInvocationId,
        subagentGrantContext: {
          parentInvocationId: deps.subagentInvocationIdentity.invocationId,
          authorizationDigest: deps.subagentInvocationIdentity.authorizationDigest,
          attempt: deps.subagentInvocationIdentity.attempt,
          capabilityRevision: deps.subagentInvocationIdentity.capabilityRevision,
          admissionDigest: deps.subagentInvocationIdentity.admissionDigest,
          effectiveEffectsDigest: deps.subagentInvocationIdentity.effectiveEffectsDigest,
        },
        toolDispatcher: deps.toolDispatcher,
        depth: 1,
        maxDepth: deps.maxDepth ?? 0,
        recordFilePreimage: deps.recordFilePreimage,
      },
      expiresAtMs: grant.expiresAtMs,
    }),
  );
  let registrationOwned = true;
  let preparedHandle: SubagentHandleV1 | undefined;
  try {
    let dispatchIntentDigest: string;
    try {
      dispatchIntentDigest = await recordSubagentDispatchIntentV1(deps, grant);
    } catch (error) {
      driver.abandon(grant);
      throw error;
    }
    const started = await provider.start({ grant, signal: deps.signal });
    if (!started.ok) {
      if (await finalizeUndispatchedSubagentIntentV1(deps, grant, dispatchIntentDigest)) {
        return failed(started.failure.message);
      }
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent preparation failed without durable undispatched cleanup.',
      );
    }
    preparedHandle = started.value;
    if (
      !(await recordSubagentHandleReadyV1(
        composition,
        deps,
        grant,
        started.value,
        dispatchIntentDigest,
      ))
    ) {
      await provider.cancel({ handle: started.value, reason: 'handle_ready_ack_failed' });
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent handle-ready acknowledgement failed before Driver dispatch.',
      );
    }
    const activated = await provider.activate({ handle: started.value, signal: deps.signal });
    if (!activated.ok) {
      const cleanupConfirmed = await finalizeSubagentCleanupV1(
        composition,
        deps,
        grant,
        started.value,
        dispatchIntentDigest,
      );
      if (cleanupConfirmed) return failed(activated.failure.message);
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent activation failed without confirmed cleanup.',
      );
    }
    driver.abandon(grant);
    registrationOwned = false;
    const observed = await provider.observe({ handle: started.value, signal: deps.signal });
    if (!observed.ok) {
      const cleanupConfirmed = await finalizeSubagentCleanupV1(
        composition,
        deps,
        grant,
        started.value,
        dispatchIntentDigest,
      );
      if (observed.failure.code === 'recovery_required') {
        await provider.cancel({ handle: started.value, reason: observed.failure.message });
      }
      if (observed.failure.code === 'cancelled' && cleanupConfirmed)
        return failed(observed.failure.message);
      throw new SubagentProviderRecoveryRequiredErrorV1(
        `${observed.failure.code}: Subagent Provider outcome requires reconciliation.`,
      );
    }
    if (
      !(await recordSubagentObservationV1(deps, grant, dispatchIntentDigest, observed.value.status))
    ) {
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent observation acknowledgement failed after Driver dispatch.',
      );
    }
    if (
      !(await finalizeSubagentCleanupV1(
        composition,
        deps,
        grant,
        started.value,
        dispatchIntentDigest,
      ))
    ) {
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent cleanup acknowledgement requires reconciliation.',
      );
    }
    return subagentResultFromObservationV1(observed.value, started.value, deps.recoveryIdentityKey);
  } finally {
    if (registrationOwned) {
      driver.abandon(grant);
      if (preparedHandle) {
        await provider.cancel({
          handle: preparedHandle,
          reason: 'pre_activation_registration_abandoned',
        });
      }
    }
  }
}

export async function resumeTaskSubAgentV1(
  deps: TaskToolDeps,
  continuation: import('./types').RestoredSubAgentContinuation,
  toolResult: {
    toolCallId: string;
    toolName: string;
    result: import('../tool-result').ToolExecutionResult;
  },
): Promise<SubAgentResult> {
  if (!deps.subagentRuntime) {
    return failed('Governed Subagent Pipeline runtime is unavailable.');
  }
  return deps.subagentRuntime.resume(deps, continuation, toolResult);
}

/** Pipeline-owned implementation; production imports are statically restricted to composition. */
export async function executePipelineIssuedSubagentResumeV1(
  composition: GovernedSubagentCompositionV1,
  deps: TaskToolDeps,
  continuation: import('./types').RestoredSubAgentContinuation,
  toolResult: {
    toolCallId: string;
    toolName: string;
    result: import('../tool-result').ToolExecutionResult;
  },
): Promise<SubAgentResult> {
  if (
    !deps.subagentInvocationIdentity ||
    !deps.modelEffectCoordinator ||
    !deps.modelInvocationPersistence ||
    !deps.modelInvocationParentId ||
    !deps.modelInvocationParentToolCallId ||
    !continuation.blockedTool.runtimeToolCallId
  ) {
    return failed('Governed Subagent resume context is unavailable.');
  }
  const { grants: authority, driver, provider } = composition;
  const allowedTools = [...(continuation.role.allowedTools ?? [])].sort();
  const bindingIds = (deps.mcpBindings ?? []).map(({ binding }) => binding.bindingId).sort();
  const taskArtifacts = composition.taskArtifacts;
  const publishedTask = taskArtifacts.write({
    owner: {
      parentInvocationId: deps.subagentInvocationIdentity.invocationId,
      parentAttempt: deps.subagentInvocationIdentity.attempt,
      parentToolCallId: deps.modelInvocationParentToolCallId,
      childInvocationId: continuation.id,
    },
    task: continuation.task,
  });
  const taskDigest = publishedTask.taskDigest;
  const snapshot = serializeSubagentContinuation(continuation, continuation.blockedTool);
  const continuationId = subagentContinuationCursorIdV1(snapshot);
  const binding = {
    parentInvocationId: deps.subagentInvocationIdentity.invocationId,
    parentToolCallId: deps.modelInvocationParentToolCallId,
    parentAttempt: deps.subagentInvocationIdentity.attempt,
    capabilityRevision: deps.subagentInvocationIdentity.capabilityRevision,
    admissionDigest: deps.subagentInvocationIdentity.admissionDigest,
    effectiveEffectsDigest: deps.subagentInvocationIdentity.effectiveEffectsDigest,
    childInvocationId: continuation.id,
    role: continuation.role.role,
    taskArtifact: publishedTask.ref,
    taskDigest,
    capabilityCeiling: {
      allowedTools,
      bindingIds,
      bindingRevision: digestCapabilityValueV1({
        schema: 'kite.subagent-binding-revision.v1',
        bindings: (deps.mcpBindings ?? []).map(({ binding }) => binding),
      }),
      ceilingDigest: digestCapabilityValueV1({
        schema: 'kite.subagent-capability-ceiling.v1',
        allowedTools,
        bindingIds,
        role: continuation.role.role,
      }),
    },
    authorization: {
      authorizationDigest: deps.subagentInvocationIdentity.authorizationDigest,
      interactionMode: deps.interactionMode,
      phase: deps.phase ?? 'building',
      workspaceAccess: deps.workspaceAccess ?? 'write',
    },
    executionBoundary: {
      canonicalWorkspace: canonicalPathForComparison(deps.workspace),
      executionBoundaryDigest: deps.config.executionBoundary
        ? computeExecutionBoundaryDigestV1(deps.config.executionBoundary)
        : `sha256:${digestCapabilityValueV1({ schema: 'kite.execution-boundary.unconfigured.v1' })}`,
    },
    resource: {
      parentReservationId: deps.modelInvocationParentReservationId ?? null,
      budgetDigest: digestCapabilityValueV1({
        schema: 'kite.subagent-resource-budget.v1',
        budget: stableBudgetCeiling(deps.modelInvocationPersistence.getState().resourceBudget),
      }),
    },
    cancellationCorrelation: deps.modelInvocationParentToolCallId,
    model: {
      parentModelInvocationId: deps.modelInvocationParentId,
      parentToolCallId: deps.modelInvocationParentToolCallId,
    },
  };
  const grant = authority.issueResume({
    ...binding,
    continuationId,
    continuationDigest: digestCapabilityValueV1({
      schema: 'kite.subagent-continuation.v1',
      snapshot,
    }),
    blockedToolCallId: continuation.blockedTool.toolCallId,
    blockedRuntimeToolCallId: continuation.blockedTool.runtimeToolCallId,
    resumeAttempt: deps.subagentInvocationIdentity.attempt,
  });
  driver.registerResume(
    grant.grantId,
    createCoreSubagentResumeRegistrationV1({
      input: {
        config: deps.config,
        builtinToolCatalog: deps.builtinToolCatalog,
        workspace: deps.workspace,
        role: continuation.role,
        task: continuation.task,
        shellExecutor: deps.shellExecutor,
        gitBroker: deps.gitBroker,
        mcpManager: deps.mcpManager,
        skills: deps.skills,
        skillOptions: deps.skillOptions,
        mcpBindings: deps.mcpBindings,
        authorization: deps.authorization,
        workspaceAccess: deps.workspaceAccess,
        phase: deps.phase,
        interactionMode: deps.interactionMode,
        projectInstructions: continuation.projectInstructions ?? deps.projectInstructions,
        threadId: deps.threadId,
        recoveryIdentityKey: deps.recoveryIdentityKey,
        timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
        signal: deps.signal ?? new AbortController().signal,
        eventSink: deps.eventSink,
        model: deps.model,
        providerDataAdmission: deps.providerDataAdmission,
        descendantResourceAdmission: deps.descendantResourceAdmission,
        modelEffectCoordinator: deps.modelEffectCoordinator,
        modelInvocationPersistence: deps.modelInvocationPersistence,
        modelInvocationParentId: deps.modelInvocationParentId,
        modelInvocationParentToolCallId: deps.modelInvocationParentToolCallId,
        modelInvocationParentReservationId: deps.modelInvocationParentReservationId,
        childInvocationId: continuation.id,
        subagentGrantContext: {
          parentInvocationId: deps.subagentInvocationIdentity.invocationId,
          authorizationDigest: deps.subagentInvocationIdentity.authorizationDigest,
          attempt: deps.subagentInvocationIdentity.attempt,
          capabilityRevision: deps.subagentInvocationIdentity.capabilityRevision,
          admissionDigest: deps.subagentInvocationIdentity.admissionDigest,
          effectiveEffectsDigest: deps.subagentInvocationIdentity.effectiveEffectsDigest,
        },
        toolDispatcher: deps.toolDispatcher,
        depth: 1,
        maxDepth: deps.maxDepth ?? 0,
        recordFilePreimage: deps.recordFilePreimage,
      },
      continuation,
      toolResult,
      expiresAtMs: grant.expiresAtMs,
    }),
  );
  let registrationOwned = true;
  let preparedHandle: SubagentHandleV1 | undefined;
  try {
    let dispatchIntentDigest: string;
    try {
      dispatchIntentDigest = await recordSubagentDispatchIntentV1(deps, grant);
    } catch (error) {
      driver.abandon(grant);
      throw error;
    }
    const resumed = await provider.resume({ grant, signal: deps.signal });
    if (!resumed.ok) {
      if (await finalizeUndispatchedSubagentIntentV1(deps, grant, dispatchIntentDigest)) {
        return failed(resumed.failure.message);
      }
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent resume preparation failed without durable undispatched cleanup.',
      );
    }
    preparedHandle = resumed.value;
    if (
      !(await recordSubagentHandleReadyV1(
        composition,
        deps,
        grant,
        resumed.value,
        dispatchIntentDigest,
      ))
    ) {
      await provider.cancel({ handle: resumed.value, reason: 'handle_ready_ack_failed' });
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent resume handle-ready acknowledgement failed before Driver dispatch.',
      );
    }
    const activated = await provider.activate({ handle: resumed.value, signal: deps.signal });
    if (!activated.ok) {
      const cleanupConfirmed = await finalizeSubagentCleanupV1(
        composition,
        deps,
        grant,
        resumed.value,
        dispatchIntentDigest,
      );
      if (cleanupConfirmed) return failed(activated.failure.message);
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent resume activation failed without confirmed cleanup.',
      );
    }
    driver.abandon(grant);
    registrationOwned = false;
    const observed = await provider.observe({ handle: resumed.value, signal: deps.signal });
    if (!observed.ok) {
      const cleanupConfirmed = await finalizeSubagentCleanupV1(
        composition,
        deps,
        grant,
        resumed.value,
        dispatchIntentDigest,
      );
      if (observed.failure.code === 'recovery_required') {
        await provider.cancel({ handle: resumed.value, reason: observed.failure.message });
      }
      if (observed.failure.code === 'cancelled' && cleanupConfirmed)
        return failed(observed.failure.message);
      throw new SubagentProviderRecoveryRequiredErrorV1(
        `${observed.failure.code}: Subagent Provider outcome requires reconciliation.`,
      );
    }
    if (
      !(await recordSubagentObservationV1(deps, grant, dispatchIntentDigest, observed.value.status))
    ) {
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent resume observation acknowledgement failed after Driver dispatch.',
      );
    }
    if (
      !(await finalizeSubagentCleanupV1(
        composition,
        deps,
        grant,
        resumed.value,
        dispatchIntentDigest,
      ))
    ) {
      throw new SubagentProviderRecoveryRequiredErrorV1(
        'Subagent resume cleanup acknowledgement requires reconciliation.',
      );
    }
    return subagentResultFromObservationV1(observed.value, resumed.value, deps.recoveryIdentityKey);
  } finally {
    if (registrationOwned) {
      driver.abandon(grant);
      if (preparedHandle) {
        await provider.cancel({
          handle: preparedHandle,
          reason: 'pre_activation_registration_abandoned',
        });
      }
    }
  }
}

function failed(message: string): SubAgentResult {
  return {
    ok: false,
    summary: message,
    error: message,
    terminalStatus: 'failed',
    toolCallCount: 0,
    durationMs: 0,
  };
}

function stableBudgetCeiling(
  state: ReturnType<
    NonNullable<TaskToolDeps['modelInvocationPersistence']>['getState']
  >['resourceBudget'],
): unknown {
  return state?.status === 'active'
    ? {
        status: state.status,
        runId: state.runId,
        deadlineAt: state.deadlineAt,
        budget: state.budget,
      }
    : (state ?? null);
}

async function recordSubagentDispatchIntentV1(
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrantV1
    | import('@kite/runtime-spi').SubagentResumeGrantV1
  >,
): Promise<string> {
  if (!deps.subagentLifecyclePersistence) {
    throw new SubagentProviderRecoveryRequiredErrorV1(
      'Subagent lifecycle persistence is unavailable.',
    );
  }
  const dispatchIntentDigest = subagentDispatchIntentDigestV1(grant);
  const recordedAt = new Date().toISOString();
  const ok = await deps.subagentLifecyclePersistence.persistEvents([
    {
      type: 'capability.subagent_dispatch_intent_recorded',
      invocationId: grant.parentInvocationId,
      attempt: grant.parentAttempt,
      purpose: grant.purpose,
      childInvocationId: grant.childInvocationId,
      taskArtifact: grant.taskArtifact,
      dispatchIntentDigest,
      recordedAt,
    },
  ]);
  const fact =
    deps.subagentLifecyclePersistence.getState().capabilities.invocations[grant.parentInvocationId]
      ?.subagentProviderLifecycle;
  if (
    !ok ||
    fact?.dispatchIntentDigest !== dispatchIntentDigest ||
    fact.status !== 'intent_recorded'
  ) {
    throw new SubagentProviderRecoveryRequiredErrorV1(
      'Subagent dispatch intent acknowledgement failed before Provider preparation.',
    );
  }
  return dispatchIntentDigest;
}

async function recordSubagentHandleReadyV1(
  composition: GovernedSubagentCompositionV1,
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrantV1
    | import('@kite/runtime-spi').SubagentResumeGrantV1
  >,
  handle: import('@kite/runtime-spi').SubagentHandleV1,
  dispatchIntentDigest: string,
): Promise<boolean> {
  if (!deps.subagentLifecyclePersistence) return false;
  let handleArtifact: import('@kite/runtime-spi').SubagentHandleArtifactRefV1;
  try {
    handleArtifact = composition.lifecycleArtifacts.write(handle, composition.grants.verifier());
  } catch {
    return false;
  }
  const recordedAt = new Date().toISOString();
  const ok = await deps.subagentLifecyclePersistence.persistEvents([
    {
      type: 'capability.subagent_handle_recorded',
      invocationId: grant.parentInvocationId,
      attempt: grant.parentAttempt,
      dispatchIntentDigest,
      handleArtifact,
      handleIntegrityIdentifier: handle.integrityIdentifier,
      recordedAt,
    },
  ]);
  const fact =
    deps.subagentLifecyclePersistence.getState().capabilities.invocations[grant.parentInvocationId]
      ?.subagentProviderLifecycle;
  return Boolean(
    ok &&
      fact?.status === 'handle_recorded' &&
      fact.handleArtifact?.artifactId === handleArtifact.artifactId &&
      fact.handleIntegrityIdentifier === handle.integrityIdentifier,
  );
}

async function recordSubagentObservationV1(
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrantV1
    | import('@kite/runtime-spi').SubagentResumeGrantV1
  >,
  dispatchIntentDigest: string,
  status: import('@kite/runtime-spi').SubagentObservationV1['status'],
): Promise<boolean> {
  if (!deps.modelInvocationPersistence) return false;
  if (!deps.subagentLifecyclePersistence) return false;
  const persisted = await deps.subagentLifecyclePersistence.persistEvents([
    {
      type: 'capability.subagent_observation_recorded',
      invocationId: grant.parentInvocationId,
      attempt: grant.parentAttempt,
      dispatchIntentDigest,
      status,
      observedAt: new Date().toISOString(),
    },
  ]);
  const fact =
    deps.subagentLifecyclePersistence.getState().capabilities.invocations[grant.parentInvocationId]
      ?.subagentProviderLifecycle;
  return Boolean(
    persisted &&
      fact?.attempt === grant.parentAttempt &&
      fact.dispatchIntentDigest === dispatchIntentDigest &&
      fact.status === 'observed' &&
      fact.observationStatus === status,
  );
}

async function finalizeUndispatchedSubagentIntentV1(
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrantV1
    | import('@kite/runtime-spi').SubagentResumeGrantV1
  >,
  dispatchIntentDigest: string,
): Promise<boolean> {
  const persistence = deps.subagentLifecyclePersistence;
  if (!persistence) return false;
  const lifecycle =
    persistence.getState().capabilities.invocations[grant.parentInvocationId]
      ?.subagentProviderLifecycle;
  if (
    lifecycle?.status !== 'intent_recorded' ||
    lifecycle.attempt !== grant.parentAttempt ||
    lifecycle.dispatchIntentDigest !== dispatchIntentDigest ||
    lifecycle.handleArtifact !== undefined
  ) {
    return false;
  }
  const cleanupAttempt = (lifecycle.cleanupAttempt ?? 0) + 1;
  const started = await persistence.persistEvents([
    {
      type: 'capability.subagent_cleanup_started',
      invocationId: grant.parentInvocationId,
      attempt: grant.parentAttempt,
      dispatchIntentDigest,
      cleanupAttempt,
      cleanupKind: 'undispatched',
      startedAt: new Date().toISOString(),
    },
  ]);
  let fact =
    persistence.getState().capabilities.invocations[grant.parentInvocationId]
      ?.subagentProviderLifecycle;
  if (
    !started ||
    fact?.status !== 'cleanup_pending' ||
    fact.attempt !== grant.parentAttempt ||
    fact.dispatchIntentDigest !== dispatchIntentDigest ||
    fact.cleanupAttempt !== cleanupAttempt ||
    fact.cleanupKind !== 'undispatched' ||
    fact.handleArtifact !== undefined
  ) {
    return false;
  }
  const completed = await persistence.persistEvents([
    {
      type: 'capability.subagent_cleanup_completed',
      invocationId: grant.parentInvocationId,
      attempt: grant.parentAttempt,
      dispatchIntentDigest,
      cleanupAttempt,
      cleanupKind: 'undispatched',
      cleanupConfirmed: true,
      completedAt: new Date().toISOString(),
    },
  ]);
  fact =
    persistence.getState().capabilities.invocations[grant.parentInvocationId]
      ?.subagentProviderLifecycle;
  return Boolean(
    completed &&
      fact?.status === 'cleanup_completed' &&
      fact.attempt === grant.parentAttempt &&
      fact.dispatchIntentDigest === dispatchIntentDigest &&
      fact.cleanupAttempt === cleanupAttempt &&
      fact.cleanupKind === 'undispatched' &&
      fact.cleanupConfirmed === true,
  );
}

async function finalizeSubagentCleanupV1(
  composition: GovernedSubagentCompositionV1,
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrantV1
    | import('@kite/runtime-spi').SubagentResumeGrantV1
  >,
  handle: import('@kite/runtime-spi').SubagentHandleV1,
  dispatchIntentDigest: string,
): Promise<boolean> {
  if (!deps.modelInvocationPersistence) return false;
  if (!deps.subagentLifecyclePersistence) return false;
  const lifecycle =
    deps.subagentLifecyclePersistence.getState().capabilities.invocations[grant.parentInvocationId]
      ?.subagentProviderLifecycle;
  const cleanupAttempt = (lifecycle?.cleanupAttempt ?? 0) + 1;
  const started = await deps.subagentLifecyclePersistence.persistEvents([
    {
      type: 'capability.subagent_cleanup_started',
      invocationId: grant.parentInvocationId,
      attempt: grant.parentAttempt,
      dispatchIntentDigest,
      cleanupAttempt,
      cleanupKind: 'handle_reconcile',
      startedAt: new Date().toISOString(),
    },
  ]);
  if (!started) return false;
  let fact =
    deps.subagentLifecyclePersistence.getState().capabilities.invocations[grant.parentInvocationId]
      ?.subagentProviderLifecycle;
  if (
    fact?.attempt !== grant.parentAttempt ||
    fact.dispatchIntentDigest !== dispatchIntentDigest ||
    fact.status !== 'cleanup_pending' ||
    fact.cleanupAttempt !== cleanupAttempt
  ) {
    return false;
  }
  const reconciled = await composition.provider.reconcile({ handle });
  const cleanupConfirmed =
    reconciled.ok && reconciled.value.status === 'stopped' && reconciled.value.cleanupConfirmed;
  const completed = await deps.subagentLifecyclePersistence.persistEvents([
    {
      type: 'capability.subagent_cleanup_completed',
      invocationId: grant.parentInvocationId,
      attempt: grant.parentAttempt,
      dispatchIntentDigest,
      cleanupAttempt,
      cleanupKind: 'handle_reconcile',
      cleanupConfirmed,
      completedAt: new Date().toISOString(),
    },
  ]);
  fact =
    deps.subagentLifecyclePersistence.getState().capabilities.invocations[grant.parentInvocationId]
      ?.subagentProviderLifecycle;
  return Boolean(
    completed &&
      cleanupConfirmed &&
      fact?.attempt === grant.parentAttempt &&
      fact.dispatchIntentDigest === dispatchIntentDigest &&
      fact.status === 'cleanup_completed' &&
      fact.cleanupAttempt === cleanupAttempt &&
      fact.cleanupConfirmed === true,
  );
}

function registrationIdentityV1(input: SubAgentRunnerInput): Readonly<{
  childInvocationId: string;
  parentInvocationId: string;
  parentToolCallId: string;
  parentAttempt: number;
}> {
  return {
    childInvocationId: input.childInvocationId ?? '',
    parentInvocationId: input.subagentGrantContext?.parentInvocationId ?? '',
    parentToolCallId: input.modelInvocationParentToolCallId ?? '',
    parentAttempt: input.subagentGrantContext?.attempt ?? 0,
  };
}

function exactInput(
  input: SubAgentRunnerInput,
  task: string,
  grant: Readonly<SubagentDelegationGrantV1 | SubagentResumeGrantV1>,
  signal: AbortSignal,
): SubAgentRunnerInput {
  if (
    input.role.role !== grant.role ||
    input.task.length === 0 ||
    input.task !== task ||
    input.modelInvocationParentId !== grant.model.parentModelInvocationId ||
    input.modelInvocationParentToolCallId !== grant.parentToolCallId ||
    (input.modelInvocationParentReservationId ?? null) !== grant.resource.parentReservationId
  ) {
    throw new Error('Child Runtime execution context does not match its sealed grant.');
  }
  const allowedTools = [...(input.role.allowedTools ?? [])].sort();
  const bindingIds = (input.mcpBindings ?? []).map(({ binding }) => binding.bindingId).sort();
  const taskDigest = subagentTaskDigestV1(input.task);
  const boundaryDigest = input.config.executionBoundary
    ? computeExecutionBoundaryDigestV1(input.config.executionBoundary)
    : `sha256:${digestCapabilityValueV1({ schema: 'kite.execution-boundary.unconfigured.v1' })}`;
  const expectedBudgetDigest = digestCapabilityValueV1({
    schema: 'kite.subagent-resource-budget.v1',
    budget: input.modelInvocationPersistence
      ? stableBudgetCeiling(input.modelInvocationPersistence.getState().resourceBudget)
      : null,
  });
  const expectedBindingRevision = digestCapabilityValueV1({
    schema: 'kite.subagent-binding-revision.v1',
    bindings: (input.mcpBindings ?? []).map(({ binding }) => binding),
  });
  const expectedCeilingDigest = digestCapabilityValueV1({
    schema: 'kite.subagent-capability-ceiling.v1',
    allowedTools,
    bindingIds,
    role: input.role.role,
  });
  if (
    taskDigest !== grant.taskDigest ||
    JSON.stringify(grant.capabilityCeiling.allowedTools) !== JSON.stringify(allowedTools) ||
    JSON.stringify(grant.capabilityCeiling.bindingIds) !== JSON.stringify(bindingIds) ||
    grant.capabilityCeiling.bindingRevision !== expectedBindingRevision ||
    grant.capabilityCeiling.ceilingDigest !== expectedCeilingDigest ||
    grant.authorization.interactionMode !== (input.interactionMode ?? 'accept_edits') ||
    grant.authorization.phase !== (input.phase ?? 'building') ||
    grant.authorization.workspaceAccess !== (input.workspaceAccess ?? 'write') ||
    grant.executionBoundary.canonicalWorkspace !== canonicalPathForComparison(input.workspace) ||
    grant.executionBoundary.executionBoundaryDigest !== boundaryDigest ||
    grant.resource.budgetDigest !== expectedBudgetDigest ||
    grant.cancellationCorrelation !== grant.parentToolCallId ||
    grant.model.parentToolCallId !== grant.parentToolCallId
  ) {
    throw new Error('Child Runtime grant facts do not match the registered execution context.');
  }
  if (
    input.subagentGrantContext?.parentInvocationId !== grant.parentInvocationId ||
    input.subagentGrantContext.authorizationDigest !== grant.authorization.authorizationDigest ||
    input.subagentGrantContext.attempt !== grant.parentAttempt ||
    input.subagentGrantContext.capabilityRevision !== grant.capabilityRevision ||
    input.subagentGrantContext.admissionDigest !== grant.admissionDigest ||
    input.subagentGrantContext.effectiveEffectsDigest !== grant.effectiveEffectsDigest
  ) {
    throw new Error('Child Runtime parent authorization facts are stale.');
  }
  return {
    ...input,
    childInvocationId: grant.childInvocationId,
    signal,
  };
}

function toLocalSubagentDriverResultV1(
  childInvocationId: string,
  result: SubAgentResult,
): LocalSubagentDriverResultV1 {
  return {
    childInvocationId,
    status: result.blocked
      ? 'blocked'
      : result.terminalStatus === 'cancelled'
        ? 'cancelled'
        : result.terminalStatus === 'exhausted'
          ? 'exhausted'
          : result.ok
            ? 'completed'
            : 'failed',
    summary: result.summary,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    privatePayload: toPrivatePayload(result),
  };
}

function toPrivatePayload(result: SubAgentResult): import('@kite/runtime-spi').JsonObject {
  const payload = {
    ok: result.ok,
    summary: result.summary,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    terminalStatus: result.terminalStatus ?? null,
    error: result.error ?? null,
    resourceAdmissionFailure: result.resourceAdmissionFailure ?? null,
    steps: result.steps ?? [],
    executionJournal: result.executionJournal ?? [],
    exhaustedFingerprints: result.exhaustedFingerprints ?? {},
    toolRecovery: result.toolRecovery ?? {},
    blocked: result.blocked
      ? serializeSubagentContinuation(result.blocked.continuation, {
          reasonCode: result.blocked.reasonCode,
          toolCallId: result.blocked.toolCallId,
          ...(result.blocked.runtimeToolCallId
            ? { runtimeToolCallId: result.blocked.runtimeToolCallId }
            : {}),
          toolName: result.blocked.toolName,
          args: result.blocked.args,
          command: result.blocked.command,
          ...(result.blocked.approvalBinding
            ? { approvalBinding: result.blocked.approvalBinding }
            : {}),
        })
      : null,
  };
  return JSON.parse(JSON.stringify(payload)) as import('@kite/runtime-spi').JsonObject;
}

async function governedRun(
  run: () => Promise<SubAgentResult>,
  input: SubAgentRunnerInput,
): Promise<SubAgentResult> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof DescendantResourceAdmissionError)) throw error;
    return {
      ok: false,
      summary: error.message,
      error: error.message,
      terminalStatus: 'failed',
      toolCallCount: 0,
      durationMs: 0,
      steps: [],
      executionJournal: [],
      exhaustedFingerprints: {},
      toolRecovery: createToolRecoveryJournalV1(input.recoveryIdentityKey),
      resourceAdmissionFailure: {
        reason: error.reason,
        message: error.message,
        parentInvocationId: input.subagentGrantContext?.parentInvocationId ?? '',
        parentToolCallId: input.modelInvocationParentToolCallId ?? '',
        childInvocationId: input.childInvocationId ?? '',
      },
    };
  }
}
