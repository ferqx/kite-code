import { digestCapability } from '@/core/capabilities/catalog';
import type { AgentConfig } from '@/core/config/index';
import { computeExecutionBoundaryDigestV1 } from '@/core/config/index';
import type { McpRuntimeProvider } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import { DescendantResourceAdmissionError } from '@/core/runtime/resource-budget-admission';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import type { ShellExecutor } from '@/core/tools/shell';
import type { SubagentHandleV1 } from '@/protocol/subagent-provider';
import type { GovernedSubagentCompositionV1 } from './composition';
import {
  serializeSubagentContinuation,
  subagentContinuationCursorIdV1,
} from './continuation-codec';
import { subagentDispatchIntentDigestV1 } from './lifecycle-evidence';
import { subagentResultFromObservationV1 } from './observation-codec';
import { subagentReplayContextDigestV1 } from './replay-context';
import { DEFAULT_SUBAGENT_TIMEOUT_MS, getRoleConfig } from './roles';
import type { SubAgentEventSink, SubAgentResult } from './types';

export interface TaskToolDeps {
  config: AgentConfig;
  workspace: string;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  allowedTools?: Set<string>;
  mcpBindings?: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }>;
  authorization?: import('@/core/types').ThreadAuthorizationState;
  workspaceAccess?: import('@/protocol/events').WorkspaceAccess;
  phase?: import('@/protocol/events').AgentPhase;
  /** Current parent Runtime interaction mode, inherited by the child execution. */
  interactionMode: import('@/protocol/events').InteractionMode;
  projectInstructions?: import('@/core/model/project-instructions').ProjectInstructionSnapshot;
  threadId?: string;
  recoveryIdentityKey?: string;
  eventSink: SubAgentEventSink;
  signal?: AbortSignal;
  model?: SupportedChatModel;
  providerDataAdmission?: import('@/core/config/provider-data-admission').ProviderDataAdmissionGateV1;
  descendantResourceAdmission?: import('@/core/runtime/resource-budget-admission').DescendantResourceAdmissionV1;
  modelInvocationGateway?: import('@/core/model/invocation-gateway').ModelInvocationGatewayV1;
  modelInvocationPersistence?: import('@/core/model/invocation-gateway').ModelInvocationPersistenceV1;
  /** Outer Runtime lifecycle facts; distinct from ModelInvocationGateway persistence. */
  subagentLifecyclePersistence?: {
    getState(): Readonly<import('@/core/runtime/state').RuntimeState>;
    persistEvents(events: import('@/core/runtime/events').RuntimeEvent[]): Promise<boolean>;
  };
  modelInvocationParentId?: string;
  modelInvocationParentToolCallId?: string;
  modelInvocationParentReservationId?: string;
  modelReplayBinding?: (
    logicalInvocationOrdinal: number,
  ) => import('@/protocol/model-surface').ModelReplayInvocationBindingV1;
  modelReplayContextDigest?: string;
  subagentInvocationIdentity?: SubagentInvocationIdentityV1;
  /** Pipeline-issued lifecycle runtime. Task adapters cannot compose or select Providers. */
  subagentRuntime?: SubagentInvocationRuntimeV1;
  toolDispatcher?: import('./types').SubAgentToolDispatcherV1;
  maxDepth?: number;
  /** 写入前文件原像记录器，透传给子 agent 的工具执行（ADR-0042 §4）。 */
  recordFilePreimage?: import('@/core/runtime/file-checkpoints').FilePreimageRecorder;
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
      result: import('@/core/harness/tool-result').ToolExecutionResult;
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
    !deps.modelInvocationGateway ||
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
    parentInvocationId: deps.subagentInvocationIdentity.invocationId,
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
    : `sha256:${digestCapability({ schema: 'kite.execution-boundary.unconfigured.v1' })}`;
  const responseSourceMode = deps.modelInvocationGateway.responseSourceModeV1();
  const replayContextDigest = subagentReplayContextDigestV1(
    responseSourceMode,
    deps.modelReplayBinding?.(1),
  );
  if (deps.modelReplayContextDigest && deps.modelReplayContextDigest !== replayContextDigest) {
    return failed('Governed Subagent replay authority digest is stale.');
  }
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
      bindingRevision: digestCapability({
        schema: 'kite.subagent-binding-revision.v1',
        bindings: (deps.mcpBindings ?? []).map(({ binding }) => binding),
      }),
      ceilingDigest: digestCapability({
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
      budgetDigest: digestCapability({
        schema: 'kite.subagent-resource-budget.v1',
        budget: stableBudgetCeiling(deps.modelInvocationPersistence.getState().resourceBudget),
      }),
    },
    cancellationCorrelation: deps.modelInvocationParentToolCallId,
    model: {
      parentModelInvocationId: deps.modelInvocationParentId,
      parentToolCallId: deps.modelInvocationParentToolCallId,
      responseSourceMode,
      replayContextDigest,
    },
  });
  driver.registerStart(grant.grantId, {
    input: {
      config: deps.config,
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
      modelInvocationGateway: deps.modelInvocationGateway,
      modelInvocationPersistence: deps.modelInvocationPersistence,
      modelInvocationParentId: deps.modelInvocationParentId,
      modelInvocationParentToolCallId: deps.modelInvocationParentToolCallId,
      modelInvocationParentReservationId: deps.modelInvocationParentReservationId,
      modelReplayBinding: deps.modelReplayBinding,
      childInvocationId,
      subagentGrantContext: {
        parentInvocationId: deps.subagentInvocationIdentity.invocationId,
        authorizationDigest: deps.subagentInvocationIdentity.authorizationDigest,
        replayContextDigest,
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
  });
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
    return rethrowResourceAdmissionV1(
      subagentResultFromObservationV1(observed.value, started.value),
    );
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
    result: import('@/core/harness/tool-result').ToolExecutionResult;
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
    result: import('@/core/harness/tool-result').ToolExecutionResult;
  },
): Promise<SubAgentResult> {
  if (
    !deps.subagentInvocationIdentity ||
    !deps.modelInvocationGateway ||
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
  const responseSourceMode = deps.modelInvocationGateway.responseSourceModeV1();
  const snapshot = serializeSubagentContinuation(continuation, continuation.blockedTool);
  const continuationId = subagentContinuationCursorIdV1(snapshot);
  const nextModelOrdinal = (continuation.modelInvocationOrdinal ?? 0) + 1;
  const replayContextDigest = subagentReplayContextDigestV1(
    responseSourceMode,
    deps.modelReplayBinding?.(nextModelOrdinal),
  );
  if (deps.modelReplayContextDigest && deps.modelReplayContextDigest !== replayContextDigest) {
    return failed('Governed Subagent replay authority digest is stale.');
  }
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
      bindingRevision: digestCapability({
        schema: 'kite.subagent-binding-revision.v1',
        bindings: (deps.mcpBindings ?? []).map(({ binding }) => binding),
      }),
      ceilingDigest: digestCapability({
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
        : `sha256:${digestCapability({ schema: 'kite.execution-boundary.unconfigured.v1' })}`,
    },
    resource: {
      parentReservationId: deps.modelInvocationParentReservationId ?? null,
      budgetDigest: digestCapability({
        schema: 'kite.subagent-resource-budget.v1',
        budget: stableBudgetCeiling(deps.modelInvocationPersistence.getState().resourceBudget),
      }),
    },
    cancellationCorrelation: deps.modelInvocationParentToolCallId,
    model: {
      parentModelInvocationId: deps.modelInvocationParentId,
      parentToolCallId: deps.modelInvocationParentToolCallId,
      responseSourceMode,
      replayContextDigest,
    },
  };
  const grant = authority.issueResume({
    ...binding,
    continuationId,
    continuationDigest: digestCapability({
      schema: 'kite.subagent-continuation.v1',
      snapshot,
    }),
    blockedToolCallId: continuation.blockedTool.toolCallId,
    blockedRuntimeToolCallId: continuation.blockedTool.runtimeToolCallId,
    resumeAttempt: deps.subagentInvocationIdentity.attempt,
  });
  driver.registerResume(grant.grantId, {
    input: {
      config: deps.config,
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
      modelInvocationGateway: deps.modelInvocationGateway,
      modelInvocationPersistence: deps.modelInvocationPersistence,
      modelInvocationParentId: deps.modelInvocationParentId,
      modelInvocationParentToolCallId: deps.modelInvocationParentToolCallId,
      modelInvocationParentReservationId: deps.modelInvocationParentReservationId,
      modelReplayBinding: deps.modelReplayBinding,
      childInvocationId: continuation.id,
      subagentGrantContext: {
        parentInvocationId: deps.subagentInvocationIdentity.invocationId,
        authorizationDigest: deps.subagentInvocationIdentity.authorizationDigest,
        replayContextDigest,
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
  });
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
    return rethrowResourceAdmissionV1(
      subagentResultFromObservationV1(observed.value, resumed.value),
    );
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

function rethrowResourceAdmissionV1(result: SubAgentResult): SubAgentResult {
  if (result.resourceAdmissionFailure) {
    throw new DescendantResourceAdmissionError(
      result.resourceAdmissionFailure.reason,
      result.resourceAdmissionFailure.message,
    );
  }
  return result;
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
    | import('@/protocol/subagent-provider').SubagentDelegationGrantV1
    | import('@/protocol/subagent-provider').SubagentResumeGrantV1
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
    | import('@/protocol/subagent-provider').SubagentDelegationGrantV1
    | import('@/protocol/subagent-provider').SubagentResumeGrantV1
  >,
  handle: import('@/protocol/subagent-provider').SubagentHandleV1,
  dispatchIntentDigest: string,
): Promise<boolean> {
  if (!deps.subagentLifecyclePersistence) return false;
  let handleArtifact: import('@/protocol/subagent-provider').SubagentHandleArtifactRefV1;
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
    | import('@/protocol/subagent-provider').SubagentDelegationGrantV1
    | import('@/protocol/subagent-provider').SubagentResumeGrantV1
  >,
  dispatchIntentDigest: string,
  status: import('@/protocol/subagent-provider').SubagentObservationV1['status'],
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
    | import('@/protocol/subagent-provider').SubagentDelegationGrantV1
    | import('@/protocol/subagent-provider').SubagentResumeGrantV1
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
    | import('@/protocol/subagent-provider').SubagentDelegationGrantV1
    | import('@/protocol/subagent-provider').SubagentResumeGrantV1
  >,
  handle: import('@/protocol/subagent-provider').SubagentHandleV1,
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
