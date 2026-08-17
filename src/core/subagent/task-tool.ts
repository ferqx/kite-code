import { digestCapability } from '@/core/capabilities/catalog';
import type { AgentConfig } from '@/core/config/index';
import { computeExecutionBoundaryDigestV1 } from '@/core/config/index';
import type { McpRuntimeProvider } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import { DescendantResourceAdmissionError } from '@/core/runtime/resource-budget-admission';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import type { ShellExecutor } from '@/core/tools/shell';
import type { GovernedSubagentCompositionV1 } from './composition';
import {
  serializeSubagentContinuation,
  subagentContinuationCursorIdV1,
} from './continuation-codec';
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
  const childInvocationId = `subagent-${digestCapability({
    schema: 'kite.subagent-child-identity.v1',
    parentInvocationId: deps.subagentInvocationIdentity.invocationId,
    parentAttempt: deps.subagentInvocationIdentity.attempt,
    parentToolCallId: deps.modelInvocationParentToolCallId,
    role: role.role,
    task: args.task,
  })}`;
  const { grants: authority, driver, provider } = composition;
  const allowedTools = [...(role.allowedTools ?? [])].sort();
  const bindingIds = (deps.mcpBindings ?? []).map(({ binding }) => binding.bindingId).sort();
  const taskDigest = digestCapability({ schema: 'kite.subagent-task.v1', task: args.task });
  const boundaryDigest = deps.config.executionBoundary
    ? computeExecutionBoundaryDigestV1(deps.config.executionBoundary)
    : digestCapability({ schema: 'kite.execution-boundary.unconfigured.v1' });
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
    taskArtifact: {
      artifactId: digestCapability({ schema: 'kite.subagent-task-artifact.v1', taskDigest }),
      kind: 'subagent_task',
      digest: taskDigest,
      byteLength: Buffer.byteLength(args.task),
    },
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
  const started = await provider.start({ grant, signal: deps.signal });
  if (!started.ok) return failed(started.failure.message);
  const observed = await provider.observe({ handle: started.value, signal: deps.signal });
  if (!observed.ok) {
    if (observed.failure.code === 'recovery_required') {
      await provider.cancel({ handle: started.value, reason: observed.failure.message });
    }
    if (observed.failure.code === 'cancelled') return failed(observed.failure.message);
    throw new SubagentProviderRecoveryRequiredErrorV1(
      `${observed.failure.code}: Subagent Provider outcome requires reconciliation.`,
    );
  }
  return rethrowResourceAdmissionV1(subagentResultFromObservationV1(observed.value, started.value));
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
  const taskDigest = digestCapability({
    schema: 'kite.subagent-task.v1',
    task: continuation.task,
  });
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
    taskArtifact: {
      artifactId: digestCapability({ schema: 'kite.subagent-task-artifact.v1', taskDigest }),
      kind: 'subagent_task' as const,
      digest: taskDigest,
      byteLength: Buffer.byteLength(continuation.task),
    },
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
        : digestCapability({ schema: 'kite.execution-boundary.unconfigured.v1' }),
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
  const resumed = await provider.resume({ grant, signal: deps.signal });
  if (!resumed.ok) return failed(resumed.failure.message);
  const observed = await provider.observe({ handle: resumed.value, signal: deps.signal });
  if (!observed.ok) {
    if (observed.failure.code === 'recovery_required') {
      await provider.cancel({ handle: resumed.value, reason: observed.failure.message });
    }
    if (observed.failure.code === 'cancelled') return failed(observed.failure.message);
    throw new SubagentProviderRecoveryRequiredErrorV1(
      `${observed.failure.code}: Subagent Provider outcome requires reconciliation.`,
    );
  }
  return rethrowResourceAdmissionV1(subagentResultFromObservationV1(observed.value, resumed.value));
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
