import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type { SupportedChatModel } from '@kite/builtin-runtime/model';
import type { ShellExecutor } from '@kite/builtin-runtime/sandbox';
import { canonicalPathForComparison } from '@kite/builtin-runtime/sandbox';
import type { SkillManifest, SkillScanOptions } from '@kite/builtin-runtime/skills';
import type {
  SubagentLifecycleArtifactAccess,
  SubagentTaskArtifactAccess,
} from '@kite/builtin-runtime/subagent';
import {
  type BuiltinChildRuntimeDriver,
  type BuiltinChildRuntimeResumeRegistration,
  type BuiltinChildRuntimeStartRegistration,
  type GovernedSubagentComposition as BuiltinGovernedSubagentComposition,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  getRoleConfig,
  type LocalSubagentDriverResult,
  subagentDispatchIntentDigest,
  subagentTaskDigest,
} from '@kite/builtin-runtime/subagent';
import {
  runtimeHostStateCreateToolRecoveryJournal as createToolRecoveryJournal,
  type DescendantResourceAdmission,
  DescendantResourceAdmissionError,
} from '@kite/runtime-host/kernel-adapter';
import type {
  SubagentDelegationGrant,
  SubagentHandle,
  SubagentResumeGrant,
} from '@kite/runtime-spi';
import type { AgentConfig } from '#app/config/index';
import { computeExecutionBoundaryDigest } from '#app/config/index';
import type { ToolExecutionResult } from '../tool-result';
import { serializeSubagentContinuation, subagentContinuationCursorId } from './continuation-codec';
import { subagentResultFromObservation } from './observation-codec';
import {
  executeSubagentResumeWithCoreToolAdapter,
  executeSubagentStartWithCoreToolAdapter,
} from './tool-adapter';
import type { SubAgentEventSink, SubAgentResult, SubAgentRunnerInput } from './types';

type GovernedSubagentComposition = BuiltinGovernedSubagentComposition<
  SubagentLifecycleArtifactAccess,
  BuiltinChildRuntimeDriver,
  SubagentTaskArtifactAccess
>;

interface CoreSubagentResumeToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolExecutionResult;
}

/** Core State registration adapter over the Builtin lifecycle Driver. */
function createCoreSubagentStartRegistration(input: {
  readonly input: SubAgentRunnerInput;
  readonly expiresAtMs?: number;
}): BuiltinChildRuntimeStartRegistration {
  return {
    ...registrationIdentity(input.input),
    ...(input.expiresAtMs === undefined ? {} : { expiresAtMs: input.expiresAtMs }),
    run: async (grant, task, signal) => {
      const exact = exactInput(input.input, task, grant, signal);
      const result = await governedRun(() => executeSubagentStartWithCoreToolAdapter(exact), exact);
      return toLocalSubagentDriverResult(grant.childInvocationId, result);
    },
  };
}

/** Core State resume adapter over the Builtin lifecycle Driver. */
function createCoreSubagentResumeRegistration(input: {
  readonly input: SubAgentRunnerInput;
  readonly continuation: import('./types').RestoredSubAgentContinuation;
  readonly toolResult: CoreSubagentResumeToolResult;
  readonly expiresAtMs?: number;
}): BuiltinChildRuntimeResumeRegistration {
  return {
    ...registrationIdentity(input.input),
    ...(input.expiresAtMs === undefined ? {} : { expiresAtMs: input.expiresAtMs }),
    run: async (grant, task, signal) => {
      const snapshot = serializeSubagentContinuation(
        input.continuation,
        input.continuation.blockedTool,
      );
      if (
        grant.continuationId !== subagentContinuationCursorId(snapshot) ||
        grant.continuationDigest !==
          digestCapabilityValue({ schema: 'kite.subagent-continuation.v1', snapshot }) ||
        grant.blockedToolCallId !== input.continuation.blockedTool.toolCallId ||
        grant.blockedRuntimeToolCallId !== input.continuation.blockedTool.runtimeToolCallId ||
        grant.blockedToolCallId !== input.toolResult.toolCallId ||
        grant.resumeAttempt !== input.input.subagentGrantContext?.attempt
      ) {
        throw new Error('Child Runtime resume grant does not match its durable continuation.');
      }
      const exact = exactInput(input.input, task, grant, signal);
      const result = await governedRun(
        () => executeSubagentResumeWithCoreToolAdapter(exact, input.continuation, input.toolResult),
        exact,
      );
      return toLocalSubagentDriverResult(grant.childInvocationId, result);
    },
  };
}

export interface TaskToolDeps {
  builtinToolCatalog?: import('@kite/builtin-runtime').BuiltinToolCatalogProjection;
  config: AgentConfig;
  workspace: string;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@kite/builtin-runtime/git').GitBroker;
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  allowedTools?: Set<string>;
  mcpBindings?: Array<{
    binding: import('@kite/runtime-contract').CapabilityBinding;
    descriptor: import('@kite/runtime-contract').CapabilityDescriptor;
  }>;
  authorization?: import('@kite/runtime-host/kernel-adapter').StateAuthorizationState;
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
  descendantResourceAdmission?: DescendantResourceAdmission;
  modelEffectCoordinator?: import('@kite/builtin-runtime/model').BuiltinModelEffectCoordinator;
  modelInvocationPersistence?: import('@kite/builtin-runtime/model').ModelInvocationPersistence<
    import('@kite/runtime-host/kernel-adapter').RuntimeState,
    import('@kite/runtime-host').StateRuntimeEvent
  >;
  /** Outer Runtime lifecycle facts; distinct from ModelInvocationGateway persistence. */
  subagentLifecyclePersistence?: {
    getState(): Readonly<import('@kite/runtime-host/kernel-adapter').RuntimeState>;
    persistEvents(events: import('@kite/runtime-host').StateRuntimeEvent[]): Promise<boolean>;
  };
  modelInvocationParentId?: string;
  modelInvocationParentToolCallId?: string;
  modelInvocationParentReservationId?: string;
  subagentInvocationIdentity?: SubagentInvocationIdentity;
  /** Pipeline-issued lifecycle runtime. Task adapters cannot compose or select Providers. */
  subagentRuntime?: SubagentInvocationRuntime;
  toolDispatcher?: import('./types').SubAgentToolDispatcher;
  maxDepth?: number;
  /** 写入前文件原像记录器，透传给子 agent 的工具执行（ADR-0042 §4）。 */
  recordFilePreimage?: import('@kite/runtime-host/storage').RuntimeHostFilePreimageRecorder;
}

export interface SubagentInvocationIdentity {
  invocationId: string;
  attempt: number;
  capabilityRevision: string;
  authorizationDigest: string;
  admissionDigest: string;
  effectiveEffectsDigest: string;
}

export interface SubagentInvocationRuntime {
  start(
    deps: TaskToolDeps,
    args: { name: string; subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string },
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

export class SubagentProviderRecoveryRequiredError extends Error {
  readonly code = 'subagent_provider_recovery_required';
  constructor(message: string) {
    super(message);
    this.name = 'SubagentProviderRecoveryRequiredError';
  }
}

export async function runTaskSubAgent(
  deps: TaskToolDeps,
  args: { name: string; subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string },
): Promise<SubAgentResult> {
  if (!deps.subagentRuntime) {
    return failed('Governed Subagent Pipeline runtime is unavailable.');
  }
  return deps.subagentRuntime.start(deps, args);
}

/** Pipeline-owned implementation; production imports are statically restricted to composition. */
export async function executePipelineIssuedSubagentStart(
  composition: GovernedSubagentComposition,
  deps: TaskToolDeps,
  args: { name: string; subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string },
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
    ? computeExecutionBoundaryDigest(deps.config.executionBoundary)
    : `sha256:${digestCapabilityValue({ schema: 'kite.execution-boundary.unconfigured.v1' })}`;
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
      bindingRevision: digestCapabilityValue({
        schema: 'kite.subagent-binding-revision.v1',
        bindings: (deps.mcpBindings ?? []).map(({ binding }) => binding),
      }),
      ceilingDigest: digestCapabilityValue({
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
      budgetDigest: digestCapabilityValue({
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
    createCoreSubagentStartRegistration({
      input: {
        config: deps.config,
        builtinToolCatalog: deps.builtinToolCatalog,
        workspace: deps.workspace,
        role,
        name: args.name,
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
  let preparedHandle: SubagentHandle | undefined;
  try {
    let dispatchIntentDigest: string;
    try {
      dispatchIntentDigest = await recordSubagentDispatchIntent(deps, grant);
    } catch (error) {
      driver.abandon(grant);
      throw error;
    }
    const started = await provider.start({ grant, signal: deps.signal });
    if (!started.ok) {
      if (await finalizeUndispatchedSubagentIntent(deps, grant, dispatchIntentDigest)) {
        return failed(started.failure.message);
      }
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent preparation failed without durable undispatched cleanup.',
      );
    }
    preparedHandle = started.value;
    if (
      !(await recordSubagentHandleReady(
        composition,
        deps,
        grant,
        started.value,
        dispatchIntentDigest,
      ))
    ) {
      await provider.cancel({ handle: started.value, reason: 'handle_ready_ack_failed' });
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent handle-ready acknowledgement failed before Driver dispatch.',
      );
    }
    const activated = await provider.activate({ handle: started.value, signal: deps.signal });
    if (!activated.ok) {
      const cleanupConfirmed = await finalizeSubagentCleanup(
        composition,
        deps,
        grant,
        started.value,
        dispatchIntentDigest,
      );
      if (cleanupConfirmed) return failed(activated.failure.message);
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent activation failed without confirmed cleanup.',
      );
    }
    driver.abandon(grant);
    registrationOwned = false;
    const observed = await provider.observe({ handle: started.value, signal: deps.signal });
    if (!observed.ok) {
      const cleanupConfirmed = await finalizeSubagentCleanup(
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
      throw new SubagentProviderRecoveryRequiredError(
        `${observed.failure.code}: Subagent Provider outcome requires reconciliation.`,
      );
    }
    if (
      !(await recordSubagentObservation(deps, grant, dispatchIntentDigest, observed.value.status))
    ) {
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent observation acknowledgement failed after Driver dispatch.',
      );
    }
    if (
      !(await finalizeSubagentCleanup(
        composition,
        deps,
        grant,
        started.value,
        dispatchIntentDigest,
      ))
    ) {
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent cleanup acknowledgement requires reconciliation.',
      );
    }
    return subagentResultFromObservation(observed.value, started.value, deps.recoveryIdentityKey);
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

export async function resumeTaskSubAgent(
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
export async function executePipelineIssuedSubagentResume(
  composition: GovernedSubagentComposition,
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
  const continuationId = subagentContinuationCursorId(snapshot);
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
      bindingRevision: digestCapabilityValue({
        schema: 'kite.subagent-binding-revision.v1',
        bindings: (deps.mcpBindings ?? []).map(({ binding }) => binding),
      }),
      ceilingDigest: digestCapabilityValue({
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
        ? computeExecutionBoundaryDigest(deps.config.executionBoundary)
        : `sha256:${digestCapabilityValue({ schema: 'kite.execution-boundary.unconfigured.v1' })}`,
    },
    resource: {
      parentReservationId: deps.modelInvocationParentReservationId ?? null,
      budgetDigest: digestCapabilityValue({
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
    continuationDigest: digestCapabilityValue({
      schema: 'kite.subagent-continuation.v1',
      snapshot,
    }),
    blockedToolCallId: continuation.blockedTool.toolCallId,
    blockedRuntimeToolCallId: continuation.blockedTool.runtimeToolCallId,
    resumeAttempt: deps.subagentInvocationIdentity.attempt,
  });
  driver.registerResume(
    grant.grantId,
    createCoreSubagentResumeRegistration({
      input: {
        config: deps.config,
        builtinToolCatalog: deps.builtinToolCatalog,
        workspace: deps.workspace,
        role: continuation.role,
        name: continuation.name ?? 'Delegated task',
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
  let preparedHandle: SubagentHandle | undefined;
  try {
    let dispatchIntentDigest: string;
    try {
      dispatchIntentDigest = await recordSubagentDispatchIntent(deps, grant);
    } catch (error) {
      driver.abandon(grant);
      throw error;
    }
    const resumed = await provider.resume({ grant, signal: deps.signal });
    if (!resumed.ok) {
      if (await finalizeUndispatchedSubagentIntent(deps, grant, dispatchIntentDigest)) {
        return failed(resumed.failure.message);
      }
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent resume preparation failed without durable undispatched cleanup.',
      );
    }
    preparedHandle = resumed.value;
    if (
      !(await recordSubagentHandleReady(
        composition,
        deps,
        grant,
        resumed.value,
        dispatchIntentDigest,
      ))
    ) {
      await provider.cancel({ handle: resumed.value, reason: 'handle_ready_ack_failed' });
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent resume handle-ready acknowledgement failed before Driver dispatch.',
      );
    }
    const activated = await provider.activate({ handle: resumed.value, signal: deps.signal });
    if (!activated.ok) {
      const cleanupConfirmed = await finalizeSubagentCleanup(
        composition,
        deps,
        grant,
        resumed.value,
        dispatchIntentDigest,
      );
      if (cleanupConfirmed) return failed(activated.failure.message);
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent resume activation failed without confirmed cleanup.',
      );
    }
    driver.abandon(grant);
    registrationOwned = false;
    const observed = await provider.observe({ handle: resumed.value, signal: deps.signal });
    if (!observed.ok) {
      const cleanupConfirmed = await finalizeSubagentCleanup(
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
      throw new SubagentProviderRecoveryRequiredError(
        `${observed.failure.code}: Subagent Provider outcome requires reconciliation.`,
      );
    }
    if (
      !(await recordSubagentObservation(deps, grant, dispatchIntentDigest, observed.value.status))
    ) {
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent resume observation acknowledgement failed after Driver dispatch.',
      );
    }
    if (
      !(await finalizeSubagentCleanup(
        composition,
        deps,
        grant,
        resumed.value,
        dispatchIntentDigest,
      ))
    ) {
      throw new SubagentProviderRecoveryRequiredError(
        'Subagent resume cleanup acknowledgement requires reconciliation.',
      );
    }
    return subagentResultFromObservation(observed.value, resumed.value, deps.recoveryIdentityKey);
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

async function recordSubagentDispatchIntent(
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrant
    | import('@kite/runtime-spi').SubagentResumeGrant
  >,
): Promise<string> {
  if (!deps.subagentLifecyclePersistence) {
    throw new SubagentProviderRecoveryRequiredError(
      'Subagent lifecycle persistence is unavailable.',
    );
  }
  const dispatchIntentDigest = subagentDispatchIntentDigest(grant);
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
    throw new SubagentProviderRecoveryRequiredError(
      'Subagent dispatch intent acknowledgement failed before Provider preparation.',
    );
  }
  return dispatchIntentDigest;
}

async function recordSubagentHandleReady(
  composition: GovernedSubagentComposition,
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrant
    | import('@kite/runtime-spi').SubagentResumeGrant
  >,
  handle: import('@kite/runtime-spi').SubagentHandle,
  dispatchIntentDigest: string,
): Promise<boolean> {
  if (!deps.subagentLifecyclePersistence) return false;
  let handleArtifact: import('@kite/runtime-spi').SubagentHandleArtifactRef;
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

async function recordSubagentObservation(
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrant
    | import('@kite/runtime-spi').SubagentResumeGrant
  >,
  dispatchIntentDigest: string,
  status: import('@kite/runtime-spi').SubagentObservation['status'],
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

async function finalizeUndispatchedSubagentIntent(
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrant
    | import('@kite/runtime-spi').SubagentResumeGrant
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

async function finalizeSubagentCleanup(
  composition: GovernedSubagentComposition,
  deps: TaskToolDeps,
  grant: Readonly<
    | import('@kite/runtime-spi').SubagentDelegationGrant
    | import('@kite/runtime-spi').SubagentResumeGrant
  >,
  handle: import('@kite/runtime-spi').SubagentHandle,
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

function registrationIdentity(input: SubAgentRunnerInput): Readonly<{
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
  grant: Readonly<SubagentDelegationGrant | SubagentResumeGrant>,
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
  const taskDigest = subagentTaskDigest(input.task);
  const boundaryDigest = input.config.executionBoundary
    ? computeExecutionBoundaryDigest(input.config.executionBoundary)
    : `sha256:${digestCapabilityValue({ schema: 'kite.execution-boundary.unconfigured.v1' })}`;
  const expectedBudgetDigest = digestCapabilityValue({
    schema: 'kite.subagent-resource-budget.v1',
    budget: input.modelInvocationPersistence
      ? stableBudgetCeiling(input.modelInvocationPersistence.getState().resourceBudget)
      : null,
  });
  const expectedBindingRevision = digestCapabilityValue({
    schema: 'kite.subagent-binding-revision.v1',
    bindings: (input.mcpBindings ?? []).map(({ binding }) => binding),
  });
  const expectedCeilingDigest = digestCapabilityValue({
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

function toLocalSubagentDriverResult(
  childInvocationId: string,
  result: SubAgentResult,
): LocalSubagentDriverResult {
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
    failureDiagnostic: result.failureDiagnostic ?? null,
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
    const result = await run();
    await settleDanglingFailedModelInvocation(input, result);
    return result;
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
      toolRecovery: createToolRecoveryJournal(input.recoveryIdentityKey),
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

async function settleDanglingFailedModelInvocation(
  input: SubAgentRunnerInput,
  result: SubAgentResult,
): Promise<void> {
  const invocationId = result.failureDiagnostic?.modelInvocationId;
  const persistence = input.modelInvocationPersistence;
  if (result.ok || !invocationId || !persistence) return;
  const invocation = persistence.getState().modelInvocations[invocationId];
  if (!invocation || (invocation.status !== 'prepared' && invocation.status !== 'dispatching')) {
    return;
  }
  const applied = await persistence.persistEvents([
    {
      type: 'model.invocation_interrupted',
      invocationId,
      dispatchCertainty: invocation.attempts > 0 ? 'attempted' : 'none',
      reasonCode: 'provider_failure',
    },
  ]);
  if (!applied) {
    throw new Error('Failed child model invocation could not be terminalized.');
  }
}
