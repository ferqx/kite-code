import { createBinding, createSnapshot, digestCapability } from '@/core/capabilities/catalog';
import { getFeatureFlags } from '@/core/config/features';
import { type AgentConfig, computeExecutionBoundaryDigestV1 } from '@/core/config/index';
import { ProviderDataAdmissionError } from '@/core/config/provider-data-admission';
import {
  admitAuthorizedToolInvocationV1,
  authorizePolicyEvaluatedToolV1,
  classifyValidatedToolInvocationV1,
  commitNormalizedToolReceiptV1,
  completedSubagentToolResultV1,
  confirmedToolDispatchFailureOutcomeV1,
  createToolCallSnapshotV1,
  dispatchAdmittedToolInvocationV1,
  dispatchSubagentForkAdapterV1,
  evaluateClassifiedToolPolicyV1,
  evaluateToolPreResolutionPolicyV1,
  normalizeDispatchedToolOutcomeV1,
  type ProviderReadinessCoordinatorV1,
  ProviderReadinessPersistenceError,
  ProviderReadinessUnknownError,
  planCommittedToolVerificationV1,
  receiptPersistenceUnknownEventV1,
  recordNormalizedToolResultV1,
  rejectSubagentShellOutsideRoleCeilingV1,
  resolveToolInvocationV1,
  resumeSubagentAdapterV1,
  ToolInvocationDispatchErrorV1,
  ToolInvocationPersistenceErrorV1,
  ToolReceiptPersistenceErrorV1,
  toolFinishedEventV1,
  validateResolvedToolInvocationV1,
} from '@/core/execution/tool-pipeline';
import { buildToolApproval } from '@/core/harness/tool-policy';
import {
  isMcpRequest,
  type PendingToolRequest,
  toolRequestFromCall,
} from '@/core/harness/tool-requests';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import {
  capabilityChangedProviderError,
  classifyRemoteMcpArgumentsV1,
  createRemoteMcpEgressReceiptV1,
  exposedMcpToolName,
  hasRemoteMcpContentV1,
  inspectRemoteMcpArgumentsV1,
  isMcpProviderError,
  type McpProviderRecoveryAction,
  type McpRuntimeProvider,
  providerErrorFromDirectoryEntry,
  type RemoteMcpEgressDecisionRecorderV1,
  RemoteMcpEgressDeniedError,
  type RemoteMcpEgressInvocationPolicyV1,
  type RemoteMcpEgressPermitRequestV1,
  type RemoteMcpEgressPermitResolverV1,
  remoteMcpArgumentDigestV1,
  snapshotRemoteMcpArgumentsV1,
} from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import { resolveProjectInstructionSnapshot } from '@/core/model/project-instructions';
import { bestEffortRegularFileSizeV1 } from '@/core/persistence/artifact-metadata';
import type { CapabilityArtifactWriterV1 } from '@/core/persistence/capability-artifacts';
import {
  defaultPlanArtifactStore,
  type PlanArtifactStore,
} from '@/core/persistence/plan-artifacts';
import { evaluateToolApproval } from '@/core/policies/approval-policy';
import { createModePolicy } from '@/core/policies/mode-policy';
import type { RuntimeEvent } from '@/core/runtime/events';
import {
  classifyFailure,
  classifyMcpProviderError,
  failureKindForToolParseFailure,
} from '@/core/runtime/failures';
import type { FilePreimageRecorder } from '@/core/runtime/file-checkpoints';
import { genInteractionId } from '@/core/runtime/ids';
import { DescendantResourceAdmissionError } from '@/core/runtime/resource-budget-admission';
import type { RuntimeState } from '@/core/runtime/state';
import {
  getActivePlanning,
  getAgentPhase,
  getEffectiveInteractionMode,
} from '@/core/runtime/state';
import { classifyToolOutcomeV1 } from '@/core/runtime/tool-outcome';
import {
  isToolRecoveryJournalInvalidV1,
  normalizeToolRecoveryJournalV1,
  toolFailureInstanceIdV1,
  toolInvocationFingerprintV1,
} from '@/core/runtime/tool-recovery-journal';
import { activeSkillFramesForCurrentWork } from '@/core/runtime/work-scope';
import type { NetworkDecisionRecorderV1 } from '@/core/sandbox/network-enforcer';
import type { SkillCatalogSnapshot } from '@/core/skills';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import {
  deserializeSubagentContinuation,
  serializeSubagentContinuation,
} from '@/core/subagent/continuation-codec';
import type {
  RestoredSubAgentContinuation,
  SubAgentEventSink,
  SubAgentToolDispatcherV1,
} from '@/core/subagent/types';
import { toolAvailabilityContext } from '@/core/tools/definitions';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import { askUserSpec } from '@/core/tools/registry/builtins/ask-user';
import type { ReadMcpResourceInput } from '@/core/tools/registry/builtins/mcp-inventory';
import type { ShellExecutor } from '@/core/tools/shell';

type SubagentEvent = Parameters<SubAgentEventSink>[0];

/** Compatibility export; the canonical terminal projection is Pipeline-owned. */
export const toolFinishedEvent = toolFinishedEventV1;

function recoveryActionForFailure(
  failure: import('@/core/runtime/failures').ClassifiedFailure,
): McpProviderRecoveryAction | undefined {
  if (failure.kind === 'provider_auth_required') return 'login';
  if (failure.kind === 'provider_approval_required') return 'approve';
  if (failure.kind === 'provider_unavailable' && failure.retryable) return 'retry';
  return undefined;
}

function providerActionRequiredEvent(input: {
  enabled: boolean;
  providerId: string;
  toolCallId: string;
  action?: McpProviderRecoveryAction;
}): RuntimeEvent | undefined {
  if (!input.enabled || !input.action) return undefined;
  return {
    type: 'provider.action_required',
    interactionId: genInteractionId(),
    providerId: input.providerId,
    action: input.action,
    originatingToolCallId: input.toolCallId,
  };
}

function skillCapabilityCeilingViolation(
  state: RuntimeState,
  call: import('@/core/runtime/state').ToolCallRecord,
  request: import('@/core/harness/tool-requests').PendingToolRequest,
): string | null {
  const frames = Object.values(state.skills.frames).filter(
    (frame) => frame.status === 'active' && frame.taskId === state.activeTaskId,
  );
  if (
    frames.length === 0 ||
    request.name === 'activate_skill' ||
    request.name === 'complete_skill' ||
    request.name === 'read_skill_reference'
  )
    return null;
  const capabilityId = request.name.startsWith('mcp__')
    ? call.capabilityId
    : `builtin:${request.name}`;
  if (!capabilityId || frames.some((frame) => !frame.capabilityCeiling.includes(capabilityId))) {
    return `Skill capability ceiling does not allow '${capabilityId ?? request.name}'.`;
  }
  return null;
}

function forkToolCeiling(input: {
  capabilityCeiling: string[];
  mcpManager?: McpRuntimeProvider;
  turnId: string;
}): {
  allowedTools: Set<string>;
  mcpBindings: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }>;
} | null {
  const tools = new Set<string>();
  const mcpBindings: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }> = [];
  for (const capabilityId of input.capabilityCeiling) {
    if (capabilityId.startsWith('builtin:')) {
      tools.add(capabilityId.slice('builtin:'.length));
      continue;
    }
    const descriptor = input.mcpManager?.findCapability(capabilityId);
    if (
      descriptor?.kind !== 'mcp_tool' ||
      descriptor.availability !== 'available' ||
      !descriptor.inputSchema
    )
      return null;
    const binding = createBinding({
      descriptor,
      exposedToolName: exposedMcpToolName(descriptor.provider.id, descriptor.displayName),
      turnId: input.turnId,
    });
    tools.add(binding.exposedToolName);
    mcpBindings.push({ binding, descriptor });
  }
  return { allowedTools: tools, mcpBindings };
}

function forkRole(agent: string): 'explore' | 'plan' | 'code' | 'review' {
  return agent === 'explore' || agent === 'plan' || agent === 'review' ? agent : 'code';
}

function childRuntimeToolCallIdV1(input: {
  parentToolCallId: string;
  subagentId: string;
  modelInvocationId: string;
  modelToolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  return `subagent-tool:${digestCapability({
    schema: 'kite.subagent-runtime-tool-identity.v1',
    parentToolCallId: input.parentToolCallId,
    subagentId: input.subagentId,
    modelInvocationId: input.modelInvocationId,
    modelToolCallId: input.modelToolCallId,
    toolName: input.toolName,
    arguments: input.args,
  })}`;
}

function isCurrentExactChildToolReservationV1(
  state: Readonly<RuntimeState>,
  reservationId: string,
  toolName: string,
): boolean {
  const budget = state.resourceBudget;
  if (budget.status !== 'active') return false;
  const reservation = budget.reservations[reservationId];
  if (
    reservation?.state !== 'dispatch_started' ||
    !reservation.parentReservationId ||
    reservation.resourceKind !== (toolName.startsWith('mcp__') ? 'mcp' : 'tool')
  ) {
    return false;
  }
  const parent = budget.reservations[reservation.parentReservationId];
  return Boolean(
    parent?.resourceKind === 'subagent' &&
      parent.state === 'dispatch_started' &&
      reservation.invocationId.startsWith(`descendant:${parent.invocationId}:`),
  );
}

/**
 * Build a proper PendingToolRequest from a blocked sub-agent tool via the
 * request-adapter layer (Registry → toolRequestFromCall). Falls back to a
 * minimal typed object when the tool is not registered in the builtin Registry
 * (e.g. an MCP tool blocked before binding resolution).
 */
export function buildBlockedToolRequest(
  blocked: { toolCallId: string; toolName: string; args: Record<string, unknown>; command: string },
  availCtx: ReturnType<typeof toolAvailabilityContext>,
): PendingToolRequest {
  const parsed = toolRequestFromCall(
    { id: blocked.toolCallId, name: blocked.toolName, args: blocked.args },
    availCtx,
  );
  if (parsed?.ok) return parsed.request;
  // Fallback: unknown/unavailable tool — construct minimal typed request.
  // MCP tool names use the 'mcp__' prefix; route to the correct variant.
  if (blocked.toolName.startsWith('mcp__')) {
    return {
      source: 'mcp',
      id: blocked.toolCallId,
      name: blocked.toolName as `mcp__${string}`,
      args: blocked.args,
      reason: `Sub-agent MCP tool "${blocked.toolName}" blocked for approval`,
      protectedCommand: blocked.command,
    };
  }
  return {
    source: 'builtin',
    id: blocked.toolCallId,
    name: blocked.toolName,
    args: blocked.args,
    reason: `Sub-agent tool "${blocked.toolName}" blocked for approval`,
    protectedCommand: blocked.command,
  } as PendingToolRequest;
}

export function blockedSubagentReviewEvent(input: {
  state: RuntimeState;
  parentToolCallId: string;
  blocked: NonNullable<import('@/core/subagent/types').SubAgentResult['blocked']>;
  availCtx: ReturnType<typeof toolAvailabilityContext>;
}): RuntimeEvent {
  const { blocked, state } = input;
  const blockedDecision = evaluateToolApproval({
    toolName: blocked.toolName,
    toolArgs: blocked.args,
    phase: getAgentPhase(getActivePlanning(state)),
    workspace: state.session.workspace,
    threadId: state.session.threadId,
    authorization: state.authorization,
    capability: builtinToolRegistry.effectsOf(blocked.toolName, blocked.args, input.availCtx),
  });
  const approval = buildToolApproval({
    workspace: state.session.workspace,
    threadId: state.session.threadId,
    request: buildBlockedToolRequest(blocked, input.availCtx),
    decision: blockedDecision,
  });
  approval.subagentId = blocked.continuation.id;

  const effectiveMode = getEffectiveInteractionMode(state);
  const modeDecision = createModePolicy(effectiveMode).shouldApproveTool({
    interactionMode: effectiveMode,
    phase: getAgentPhase(getActivePlanning(state)),
    planKind: getActivePlanning(state).kind,
    toolName: blocked.toolName,
    toolRisk: blockedDecision.risk,
    effects: blockedDecision.effects,
    circuitBreakerTripped: state.autoReview.circuitBreakerTripped,
  });
  if (
    blocked.reasonCode === 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW' &&
    modeDecision.kind === 'need_auto_review'
  ) {
    return {
      type: 'auto_review.requested',
      reviewId: genInteractionId(),
      toolCallId: input.parentToolCallId,
      toolName: blocked.toolName,
      reason: blockedDecision.reason,
      approval,
    };
  }
  return {
    type: 'approval.requested',
    interactionId: genInteractionId(),
    toolCallId: input.parentToolCallId,
    approval,
  };
}

/** Convert the subagent runner's private callback payload into a durable public fact. */
export function toRuntimeSubagentEvent(
  event: SubagentEvent,
  concurrencyGroupId?: string,
): RuntimeEvent {
  switch (event.type) {
    case 'start':
      return {
        type: 'subagent.started',
        subagent: concurrencyGroupId == null ? event.data : { ...event.data, concurrencyGroupId },
      };
    case 'step':
      return { type: 'subagent.step', subagent: event.data };
    case 'tool_result':
      return { type: 'subagent.tool_result', subagent: event.data };
    case 'done':
      return { type: 'subagent.completed', subagent: event.data };
    case 'error':
      return { type: 'subagent.failed', subagent: event.data };
    case 'cache_metrics':
      return { type: 'subagent.cache_metrics', subagent: event.data };
  }
}

/** Preserve every suspended sibling without overwriting the Runtime's single interaction slot. */
export function serializeConcurrentSubagentApprovalEvents(
  batches: RuntimeEvent[][],
): RuntimeEvent[] {
  let interactionClaimed = false;
  return batches.flatMap((batch) => {
    const request = batch.find(
      (event) => event.type === 'approval.requested' || event.type === 'auto_review.requested',
    );
    if (!request) return batch;
    if (!interactionClaimed) {
      interactionClaimed = true;
      return batch;
    }
    return [
      ...batch.filter(
        (event) => event.type !== 'approval.requested' && event.type !== 'auto_review.requested',
      ),
      { type: 'subagent.approval_deferred', toolCallId: request.toolCallId } as const,
    ];
  });
}

/**
 * Resume a sub-agent after approval: execute the blocked tool with the
 * approved grant, then continue the sub-agent loop from the saved state.
 * Returns all RuntimeEvents produced by the resumed sub-agent execution.
 */
async function handleSubAgentResume(params: {
  state: RuntimeState;
  /** State may have advanced while the approval interaction was pending. */
  getRuntimeState?: () => Readonly<RuntimeState>;
  toolCallId: string;
  continuation: RestoredSubAgentContinuation;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
  mcpManager?: McpRuntimeProvider;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  providerDataAdmission?: import('@/core/config/provider-data-admission').ProviderDataAdmissionGateV1;
  descendantResourceAdmission?: import('@/core/runtime/resource-budget-admission').DescendantResourceAdmissionV1;
  modelInvocationGateway?: import('@/core/model/invocation-gateway').ModelInvocationGatewayV1;
  modelInvocationPersistence?: import('@/core/model/invocation-gateway').ModelInvocationPersistenceV1;
  modelInvocationParentId?: string;
  modelInvocationParentReservationId?: string;
  emitSubagentEvent: SubAgentEventSink;
  recordFilePreimage?: FilePreimageRecorder;
  recordNetworkDecision?: NetworkDecisionRecorderV1;
  admittedInvocation: Readonly<import('@/core/execution/tool-pipeline').AdmittedInvocationV1>;
  invocationRecordContext: import('@/core/execution/tool-pipeline').ToolInvocationRecordContextV1;
  capabilityArtifactStore: CapabilityArtifactWriterV1;
  childToolDispatcher: SubAgentToolDispatcherV1;
}): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  // An approval can outlive the effect lease that originally observed it.  Do
  // not let that stale lease dispatch an external tool or resume a child under
  // a different recovery journal.
  let state = params.getRuntimeState?.() ?? params.state;
  const { continuation } = params;
  const continuationRecovery = normalizeToolRecoveryJournalV1(continuation.toolRecovery);
  if (
    isToolRecoveryJournalInvalidV1(state.toolRecovery) ||
    isToolRecoveryJournalInvalidV1(continuationRecovery) ||
    continuationRecovery.identityKey !== state.toolRecovery.identityKey
  ) {
    const reason = 'Sub-agent continuation recovery journal no longer matches the live runtime.';
    return [
      {
        type: 'tool.rejected',
        toolCallId: params.toolCallId,
        reason,
        failure: classifyFailure('persistence_unavailable', reason),
      },
    ];
  }
  const { toolName: blockedToolName, args: blockedToolArgs } = continuation.blockedTool;
  // Execute the previously-blocked tool with the approval grant
  const call = state.tools.calls[params.toolCallId];
  const availCtx = toolAvailabilityContext({
    workspace: state.session.workspace,
    threadId: state.session.threadId,
    config: params.taskConfig,
    gitBroker: params.gitBroker,
    subagentEventSink: params.emitSubagentEvent,
    toolSearch: params.taskConfig ? getFeatureFlags(params.taskConfig).toolSearchV1 : false,
    skillCatalog: params.skillCatalog,
    activeSkillFrames: activeSkillFramesForCurrentWork(state).filter(
      (frame) => frame.contextMode === 'inline',
    ),
    phase: getAgentPhase(getActivePlanning(state)),
  });
  const blockedParsed = toolRequestFromCall(
    {
      id: continuation.blockedTool.toolCallId,
      name: blockedToolName,
      args: blockedToolArgs,
    },
    availCtx,
  );

  let toolResult: ToolExecutionResult;
  let resumedMcpBindings: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }> = [];
  const roleDenial =
    blockedParsed?.ok && blockedParsed.request.name === 'shell_execute'
      ? rejectSubagentShellOutsideRoleCeilingV1(
          continuation.role,
          String(blockedParsed.request.args.command ?? ''),
        )
      : undefined;
  if (roleDenial) {
    toolResult = roleDenial;
  } else if (blockedParsed?.ok) {
    // Budget admission and approval can yield the event loop. Check again at
    // the last point before an external tool dispatch; an old continuation
    // must never be allowed to act in a newly-restored recovery domain.
    const dispatchState = params.getRuntimeState?.() ?? state;
    const dispatchCall = dispatchState.tools.calls[params.toolCallId];
    if (
      isToolRecoveryJournalInvalidV1(dispatchState.toolRecovery) ||
      dispatchState.toolRecovery.identityKey !== continuationRecovery.identityKey ||
      dispatchCall?.status !== 'approved'
    ) {
      const reason = 'Sub-agent approval became stale before its blocked tool could be dispatched.';
      return [
        {
          type: 'tool.rejected',
          toolCallId: params.toolCallId,
          reason,
          failure: classifyFailure('persistence_unavailable', reason),
        },
      ];
    }
    state = dispatchState as RuntimeState;
    const blockedRequest = blockedParsed.request;
    const runtimeToolCallId = continuation.blockedTool.runtimeToolCallId;
    const childCall = runtimeToolCallId ? state.tools.calls[runtimeToolCallId] : undefined;
    const resumedBinding = childCall?.bindingId
      ? state.capabilities.bindings[childCall.bindingId]
      : undefined;
    const expectedRuntimeToolCallId = childCall?.modelInvocationId
      ? childRuntimeToolCallIdV1({
          parentToolCallId: params.toolCallId,
          subagentId: continuation.id,
          modelInvocationId: childCall.modelInvocationId,
          modelToolCallId: continuation.blockedTool.toolCallId,
          toolName: blockedToolName,
          args: blockedToolArgs,
        })
      : undefined;
    const bindingMatches = childCall?.bindingId
      ? Boolean(
          resumedBinding &&
            continuation.mcpBindingIds?.includes(childCall.bindingId) &&
            childCall.capabilityId === resumedBinding.capabilityId &&
            childCall.capabilityRevision === resumedBinding.capabilityRevision,
        )
      : !childCall?.capabilityId && !childCall?.capabilityRevision;
    resumedMcpBindings = (continuation.mcpBindingIds ?? []).flatMap((bindingId) => {
      const binding = state.capabilities.bindings[bindingId];
      const descriptor = binding
        ? params.mcpManager?.findCapability(binding.capabilityId)
        : undefined;
      return binding && descriptor?.revision === binding.capabilityRevision
        ? [{ binding, descriptor }]
        : [];
    });
    const bindingSurfaceMatches =
      resumedMcpBindings.length === (continuation.mcpBindingIds?.length ?? 0);
    if (
      !runtimeToolCallId ||
      !childCall ||
      childCall.status !== 'queued' ||
      !childCall.modelInvocationId ||
      runtimeToolCallId !== expectedRuntimeToolCallId ||
      childCall.name !== blockedToolName ||
      digestCapability(childCall.args) !== digestCapability(blockedToolArgs) ||
      !bindingMatches ||
      !bindingSurfaceMatches ||
      !call?.approvalGrant
    ) {
      const reason =
        'Sub-agent child Runtime identity or its operation-bound approval is unavailable.';
      return [
        {
          type: 'tool.rejected',
          toolCallId: params.toolCallId,
          reason,
          failure: classifyFailure('persistence_unavailable', reason),
        },
      ];
    }
    let childToolAdmissionAttempt = 0;
    const childReview = blockedSubagentReviewEvent({
      state,
      parentToolCallId: runtimeToolCallId,
      blocked: {
        reasonCode: continuation.blockedTool.reasonCode,
        toolCallId: continuation.blockedTool.toolCallId,
        runtimeToolCallId,
        toolName: blockedToolName,
        args: blockedToolArgs,
        command: continuation.blockedTool.command,
        message: `Sub-agent tool '${blockedToolName}' requires approval.`,
        continuation,
      },
      availCtx,
    });
    if (childReview.type !== 'approval.requested' && childReview.type !== 'auto_review.requested') {
      throw new ToolInvocationPersistenceErrorV1(
        'Child approval policy did not produce an operation-bound review fact.',
      );
    }
    const interactionId = genInteractionId();
    const approvalAcknowledged = await params.invocationRecordContext.persistence.persistEvents([
      {
        type: 'approval.requested',
        interactionId,
        toolCallId: runtimeToolCallId,
        approval: childReview.approval,
      },
      {
        type: 'approval.granted',
        interactionId,
        toolCallId: runtimeToolCallId,
        grant: call.approvalGrant,
      },
    ]);
    if (
      !approvalAcknowledged ||
      params.invocationRecordContext.persistence.getState().tools.calls[runtimeToolCallId]
        ?.status !== 'approved'
    ) {
      throw new ToolInvocationPersistenceErrorV1(
        'Child operation-bound approval could not be durably acknowledged.',
      );
    }
    const dispatched = await params.childToolDispatcher.dispatch({
      subagentId: continuation.id,
      modelInvocationId: childCall.modelInvocationId,
      modelToolCallId: continuation.blockedTool.toolCallId,
      request: blockedRequest,
      signal: params.signal ?? new AbortController().signal,
      ...(resumedBinding ? { binding: resumedBinding } : {}),
      ...(params.descendantResourceAdmission
        ? {
            beforeAdmission: async () => {
              childToolAdmissionAttempt += 1;
              return params.descendantResourceAdmission!.reserveTool({
                invocationKey: `resume-tool:${continuation.toolCallCount}:${runtimeToolCallId}:attempt:${childToolAdmissionAttempt}`,
                toolKind: blockedToolName,
                shell: blockedToolName === 'shell_execute',
              });
            },
            afterDispatch: async ({
              reservationId,
              dispatchState,
              result: attemptResult,
              error,
            }) => {
              if (!reservationId) return;
              if (error) {
                if (
                  dispatchState === 'not_started' ||
                  error instanceof ProviderDataAdmissionError
                ) {
                  await params.descendantResourceAdmission!.markLocalProviderAdmissionDenied(
                    reservationId,
                  );
                } else {
                  await params.descendantResourceAdmission!.markUnknown(reservationId);
                }
                return;
              }
              try {
                await params.descendantResourceAdmission!.reconcileTool({
                  reservationId,
                  artifactBytes:
                    (blockedToolName === 'write_file' || blockedToolName === 'edit_file') &&
                    attemptResult?.path
                      ? bestEffortRegularFileSizeV1(attemptResult.path)
                      : 0,
                });
              } catch (settlementError) {
                await params.descendantResourceAdmission!.markUnknown(reservationId);
                throw settlementError;
              }
            },
          }
        : {}),
    });
    if (dispatched.runtimeToolCallId !== runtimeToolCallId) {
      throw new ToolInvocationPersistenceErrorV1(
        'Resumed child tool identity no longer matches its approved Runtime fact.',
      );
    }
    toolResult = dispatched.result;
  } else {
    toolResult = {
      ok: false,
      command: blockedToolName,
      exitCode: -1,
      stdout: '',
      stderr: `Failed to build tool request for "${blockedToolName}".`,
      status: 'error',
    };
  }

  // Resume the sub-agent with the tool result
  const result = await resumeSubagentAdapterV1(
    {
      config: params.taskConfig!,
      workspace: state.session.workspace,
      role: continuation.role,
      task: continuation.task,
      shellExecutor: params.shellExecutor,
      gitBroker: params.gitBroker,
      mcpManager: params.mcpManager,
      mcpBindings: resumedMcpBindings,
      skills: params.skillManifests,
      skillOptions: params.skillOptions,
      authorization: state.authorization,
      workspaceAccess: state.workspaceAccess,
      phase: getAgentPhase(getActivePlanning(state)),
      interactionMode: getEffectiveInteractionMode(state),
      threadId: state.session.threadId,
      timeoutMs: 30 * 60 * 1000,
      signal: params.signal ?? new AbortController().signal,
      eventSink: params.emitSubagentEvent,
      model: params.taskModel,
      providerDataAdmission: params.providerDataAdmission,
      descendantResourceAdmission: params.descendantResourceAdmission,
      modelInvocationGateway: params.modelInvocationGateway,
      modelInvocationPersistence: params.modelInvocationPersistence,
      modelInvocationParentId: params.modelInvocationParentId,
      modelInvocationParentToolCallId: params.toolCallId,
      modelInvocationParentReservationId: params.modelInvocationParentReservationId,
      toolDispatcher: params.childToolDispatcher,
      depth: 1,
      maxDepth: 0,
    },
    continuation,
    {
      toolCallId: continuation.blockedTool.toolCallId,
      toolName: blockedToolName,
      result: toolResult,
    },
  );

  // 子 agent 恢复后再次 blocked → 上报审批，不发射 tool.finished
  if (result.blocked) {
    const blocked = result.blocked;
    events.push({
      type: 'subagent.suspended',
      toolCallId: params.toolCallId,
      snapshot: serializeSubagentContinuation(blocked.continuation, {
        reasonCode: blocked.reasonCode,
        toolCallId: blocked.toolCallId,
        ...(blocked.runtimeToolCallId ? { runtimeToolCallId: blocked.runtimeToolCallId } : {}),
        toolName: blocked.toolName,
        args: blocked.args,
        command: blocked.command,
      }),
    });
    events.push(
      blockedSubagentReviewEvent({
        state,
        parentToolCallId: params.toolCallId,
        blocked,
        availCtx,
      }),
    );
    return events;
  }

  const completedResult = completedSubagentToolResultV1({
    workspace: state.session.workspace,
    subagentType: forkRole(continuation.role.role),
    task: continuation.task,
    result,
  });
  const parentRequest = toolRequestFromCall(
    { id: params.toolCallId, name: 'task', args: call?.args ?? {} },
    availCtx,
  );
  if (!parentRequest?.ok) {
    return [
      {
        type: 'tool.failed',
        toolCallId: params.toolCallId,
        failure: classifyFailure(
          'tool_invalid_args',
          'The suspended parent task request is unavailable for terminal receipt.',
        ),
      },
    ];
  }
  try {
    const parentDispatch = await dispatchAdmittedToolInvocationV1(
      params.admittedInvocation,
      {
        workspace: state.session.workspace,
        request: parentRequest.request,
        workspaceAccess: state.workspaceAccess,
        phase: getAgentPhase(getActivePlanning(state)),
        authorization: state.authorization,
        approvedGrant: call?.approvalGrant ?? 'none',
        threadId: state.session.threadId,
        recoveryIdentityKey: state.toolRecovery.identityKey,
        signal: params.signal,
        interactionMode: getEffectiveInteractionMode(state),
        taskConfig: params.taskConfig,
        taskModel: params.taskModel,
        subagentEventSink: params.emitSubagentEvent,
        precomputedSubagentResult: result,
        availabilityContext: availCtx,
        projectInstructionSnapshot: visibleProjectInstructions(
          state,
          call?.modelMessageId,
          params.taskConfig,
        ),
      },
      params.invocationRecordContext,
    );
    if (parentDispatch.kind !== 'dispatched') {
      throw new ToolInvocationPersistenceErrorV1(
        'The resumed parent task did not enter its acknowledged terminal dispatch.',
      );
    }
    const receipt = commitNormalizedToolReceiptV1(
      normalizeDispatchedToolOutcomeV1(parentDispatch.value),
      params.capabilityArtifactStore,
    );
    events.push(...receipt.terminalEvents);
  } catch (error) {
    if (!(error instanceof ToolReceiptPersistenceErrorV1)) throw error;
    events.push(receiptPersistenceUnknownEventV1(error), {
      type: 'tool.failed',
      toolCallId: params.toolCallId,
      failure: classifyFailure('persistence_unavailable', error.message),
    });
    return events;
  }
  if (result.toolRecovery) {
    events.push({
      type: 'subagent.recovery_journal_merged',
      toolCallId: params.toolCallId,
      journal: result.toolRecovery,
    });
  }
  events.push(
    toolFinishedEvent({
      toolCallId: params.toolCallId,
      name: 'task',
      result: completedResult,
      command: 'task',
    }),
  );

  return events;
}

/**
 * Kernel-native tool effect.  It derives the execution request from the
 * persisted call record and returns facts only; it never creates a ToolMessage
 * or mutates a graph channel.
 */
export async function executeRuntimeTools(params: {
  state: RuntimeState;
  toolCallIds: string[];
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
  mcpManager?: McpRuntimeProvider;
  providerReadinessCoordinator?: ProviderReadinessCoordinatorV1;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  providerDataAdmission?: import('@/core/config/provider-data-admission').ProviderDataAdmissionGateV1;
  remoteMcpEgressPermitResolver?: RemoteMcpEgressPermitResolverV1;
  recordRemoteMcpEgressDecision?: RemoteMcpEgressDecisionRecorderV1;
  descendantResourceAdmission?: import('@/core/runtime/resource-budget-admission').DescendantResourceAdmissionV1;
  modelInvocationGateway?: import('@/core/model/invocation-gateway').ModelInvocationGatewayV1;
  modelInvocationPersistence?: import('@/core/model/invocation-gateway').ModelInvocationPersistenceV1;
  /** Parent reservation for a task/skill child model step. */
  modelInvocationParentReservationId?: string;
  subagentEventSink?: SubAgentEventSink;
  /** Identity supplied by the scheduler/executor only for one admitted parallel task batch. */
  subagentConcurrencyGroupId?: string;
  planArtifactStore?: PlanArtifactStore;
  capabilityArtifactStore?: CapabilityArtifactWriterV1;
  workspaceFilesystemRuntime?: import('@/core/execution/tool-pipeline/workspace-filesystem').WorkspaceFilesystemRuntimeV1;
  sandboxPreparationArtifacts?: import('@/core/persistence/sandbox-preparation-artifacts').SandboxPreparationArtifactStoreV1;
  /** Runtime sink used to publish tool lifecycle/progress events while execution is running. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  /** RuntimeStore-backed acknowledgement required before an automatic provider replay. */
  persistRuntimeEvent?: (event: RuntimeEvent) => Promise<boolean>;
  /** Atomic RuntimeStore acknowledgement for invocation intent + attempt. */
  persistRuntimeEvents?: (events: RuntimeEvent[]) => Promise<boolean>;
  /** Defers a complete terminal batch to the Kernel's atomic effect commit. */
  emitTerminalEventBatch?: (events: RuntimeEvent[]) => void;
  /** Current Kernel state used to reject a prepared/leased effect that became unsafe. */
  getRuntimeState?: () => Readonly<RuntimeState>;
  /** 写入前文件原像记录器，透传给工具执行链（ADR-0025 §4）。 */
  recordFilePreimage?: FilePreimageRecorder;
  recordNetworkDecision?: NetworkDecisionRecorderV1;
  /** Actor identities for nested child calls; absent top-level calls use parent. */
  toolActorIds?: Readonly<Record<string, string>>;
  /** Child-only exact reservation prepared after authorization and before admission. */
  beforeAdmissionByToolCallId?: Readonly<
    Record<
      string,
      () => Promise<
        import('@/core/runtime/resource-budget-admission').DescendantBudgetReservationV1
      >
    >
  >;
  /** Child resource admission hook entered only after invocation acknowledgement. */
  beforeDispatchByToolCallId?: Readonly<
    Record<string, (attempt: number, reservationId?: string) => Promise<void>>
  >;
  /** Per-attempt child resource settlement after adapter completion or uncertainty. */
  afterDispatchByToolCallId?: Readonly<
    Record<
      string,
      (input: {
        attempt?: number;
        reservationId?: string;
        dispatchState: 'not_started' | 'started';
        result?: ToolExecutionResult;
        error?: unknown;
      }) => Promise<void>
    >
  >;
}): Promise<RuntimeEvent[]> {
  const approvedParallelShellBatch =
    params.toolCallIds.length > 1 &&
    params.toolCallIds.every((toolCallId) => {
      const call = params.state.tools.calls[toolCallId];
      return call?.name === 'shell_execute' && call.status === 'approved';
    });
  const parallelSubagentBatch =
    params.toolCallIds.length > 1 &&
    params.toolCallIds.every((toolCallId) => {
      const call = params.state.tools.calls[toolCallId];
      return call?.name === 'task' && call.status === 'queued';
    });
  if (approvedParallelShellBatch) {
    const batches = await Promise.all(
      params.toolCallIds.map((toolCallId) =>
        executeRuntimeTools({
          ...params,
          toolCallIds: [toolCallId],
        }),
      ),
    );
    return batches.flat();
  }
  if (parallelSubagentBatch) {
    const concurrencyGroupId =
      params.subagentConcurrencyGroupId ?? `subagent-batch:${params.toolCallIds[0]!}`;
    const deferredInteractions = params.toolCallIds.map(() => [] as RuntimeEvent[]);
    const batches = await Promise.all(
      params.toolCallIds.map((toolCallId, index) =>
        executeRuntimeTools({
          ...params,
          toolCallIds: [toolCallId],
          subagentConcurrencyGroupId: concurrencyGroupId,
          ...(params.emitRuntimeEvent
            ? {
                emitRuntimeEvent: (event: RuntimeEvent) => {
                  if (
                    event.type === 'subagent.suspended' ||
                    event.type === 'approval.requested' ||
                    event.type === 'auto_review.requested'
                  ) {
                    deferredInteractions[index]!.push(event);
                  } else {
                    params.emitRuntimeEvent?.(event);
                  }
                },
              }
            : {}),
        }),
      ),
    );
    const serialized = serializeConcurrentSubagentApprovalEvents(
      batches.map((batch, index) => [...deferredInteractions[index]!, ...batch]),
    );
    if (!params.emitRuntimeEvent) return serialized;
    for (const event of serialized) params.emitRuntimeEvent(event);
    return [];
  }
  const events: RuntimeEvent[] = [];
  // Direct invocations collect the returned facts. The Runtime runner replaces
  // push with a streaming sink, so events are applied
  // and rendered as soon as they are produced instead of after the tool exits.
  if (params.emitRuntimeEvent) {
    const append = events.push.bind(events);
    events.push = (...items: RuntimeEvent[]) => {
      for (const item of items) params.emitRuntimeEvent?.(item);
      return append();
    };
  }
  const currentState = params.getRuntimeState?.() ?? params.state;
  if (isToolRecoveryJournalInvalidV1(currentState.toolRecovery)) {
    const reason = 'Runtime tool recovery journal is invalid; tool dispatch is blocked.';
    for (const toolCallId of params.toolCallIds) {
      const call = currentState.tools.calls[toolCallId] ?? params.state.tools.calls[toolCallId];
      if (!call || (call.status !== 'queued' && call.status !== 'approved')) continue;
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason,
        failure: classifyFailure('persistence_unavailable', reason),
      });
    }
    return events;
  }
  const planArtifacts = params.planArtifactStore ?? defaultPlanArtifactStore;
  const capabilityArtifacts = params.capabilityArtifactStore;
  const emitSubagentEvent: SubAgentEventSink = (event) => {
    events.push(toRuntimeSubagentEvent(event, params.subagentConcurrencyGroupId));
    params.subagentEventSink?.(event);
  };
  const availCtx = toolAvailabilityContext({
    workspace: params.state.session.workspace,
    threadId: params.state.session.threadId,
    config: params.taskConfig,
    gitBroker: params.gitBroker,
    subagentEventSink: emitSubagentEvent,
    toolSearch: params.taskConfig ? getFeatureFlags(params.taskConfig).toolSearchV1 : false,
    skillCatalog: params.skillCatalog,
    activeSkillFrames: activeSkillFramesForCurrentWork(params.state).filter(
      (frame) => frame.contextMode === 'inline',
    ),
    phase: getAgentPhase(getActivePlanning(params.state)),
  });
  for (const toolCallId of params.toolCallIds) {
    const call = params.state.tools.calls[toolCallId];
    if (!call || (call.status !== 'queued' && call.status !== 'approved')) continue;
    const productionFlags = params.taskConfig ? getFeatureFlags(params.taskConfig) : undefined;
    const parsed = toolRequestFromCall(
      { id: call.toolCallId, name: call.name, args: call.args },
      availCtx,
    );
    if (!parsed) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure('tool_not_found', `Unsupported tool '${call.name}'.`),
      });
      continue;
    }
    if (!parsed.ok) {
      const parseFailureCode = parsed.request.parseFailureCode ?? 'invalid_arguments';
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          failureKindForToolParseFailure(parseFailureCode),
          parsed.request.parseError,
          parseFailureCode,
        ),
      });
      continue;
    }
    let request = parsed.request;
    if (
      isMcpRequest(request) &&
      (!productionFlags?.capabilityCatalogV1 || !productionFlags.mcpRuntimeBindingV1)
    ) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          'tool_invalid_args',
          'MCP Runtime binding is disabled by feature flag.',
        ),
      });
      continue;
    }
    const snapshotResult = createToolCallSnapshotV1({
      toolCallId,
      name: call.name,
      rawArguments: call.args,
      createdAtTurnId: call.createdAtTurnId,
      bindingId: call.bindingId,
      capabilityId: call.capabilityId,
      capabilityRevision: call.capabilityRevision,
    });
    if (!snapshotResult.ok) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure('tool_invalid_args', snapshotResult.failure.code),
      });
      continue;
    }
    const preResolutionTerminal = evaluateToolPreResolutionPolicyV1(snapshotResult.value, {
      providerAccess: params.taskConfig?.executionBoundary ? 'blocked' : 'admitted',
    });
    if (preResolutionTerminal?.kind === 'reject') {
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason: preResolutionTerminal.reason,
        failure: classifyFailure(preResolutionTerminal.failureKind, preResolutionTerminal.reason),
      });
      continue;
    }
    const mcpSnapshot = params.mcpManager?.getCapabilitySnapshot();
    const skillSnapshot = params.skillCatalog?.capabilities;
    const boundDescriptor = call.capabilityId
      ? params.mcpManager?.findCapability(call.capabilityId)
      : undefined;
    const pipelineDescriptors = [
      ...(mcpSnapshot?.descriptors ?? []),
      ...(boundDescriptor &&
      !mcpSnapshot?.descriptors.some(
        (descriptor) => descriptor.capabilityId === boundDescriptor.capabilityId,
      )
        ? [boundDescriptor]
        : []),
      ...(skillSnapshot?.descriptors ?? []),
    ];
    const resolutionResult = resolveToolInvocationV1(snapshotResult.value, {
      currentTurnId: params.state.turn.turnId,
      catalogRevision: createSnapshot(pipelineDescriptors).revision,
      availabilityContext: availCtx,
      bindings: Object.values(params.state.capabilities.bindings),
      descriptors: pipelineDescriptors,
      disclosures: Object.values(params.state.capabilities.disclosures),
    });
    if (!resolutionResult.ok) {
      const providerId =
        call.capabilityId?.match(/^mcp:([^/]+)\//u)?.[1] ??
        request.name.match(/^mcp__([^_]+)__/u)?.[1];
      const directoryEntry = providerId
        ? params.mcpManager
            ?.getProviderDirectorySnapshot()
            .entries.find((entry) => entry.providerId === providerId)
        : undefined;
      const failure =
        providerId &&
        (resolutionResult.failure.code === 'descriptor_missing' ||
          resolutionResult.failure.code === 'descriptor_unavailable' ||
          resolutionResult.failure.code === 'descriptor_revision_mismatch')
          ? classifyMcpProviderError(
              directoryEntry && directoryEntry.status !== 'ready'
                ? providerErrorFromDirectoryEntry(directoryEntry, providerId)
                : capabilityChangedProviderError(providerId),
            )
          : classifyFailure(
              resolutionResult.failure.code === 'unknown_tool' ||
                resolutionResult.failure.code === 'tool_unavailable'
                ? 'tool_not_found'
                : 'tool_invalid_args',
              `Tool Pipeline resolve failed: ${resolutionResult.failure.code}.`,
            );
      events.push({ type: 'tool.failed', toolCallId, failure });
      if (providerId) {
        const providerAction = providerActionRequiredEvent({
          enabled: productionFlags?.mcpProviderActionV1 ?? false,
          providerId,
          toolCallId,
          action: recoveryActionForFailure(failure),
        });
        if (providerAction) events.push(providerAction);
      }
      continue;
    }
    const validationResult = validateResolvedToolInvocationV1(resolutionResult.value);
    if (!validationResult.ok) {
      if (
        validationResult.failure.code === 'disclosure_missing' ||
        validationResult.failure.code === 'disclosure_stale'
      ) {
        const reason =
          'Skill is not disclosed for this model turn; search again before activation.';
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason,
          failure: classifyFailure('policy_denied', reason),
        });
        continue;
      }
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          'tool_invalid_args',
          `Tool Pipeline validation failed: ${validationResult.failure.code}.`,
        ),
      });
      continue;
    }
    const classificationResult = classifyValidatedToolInvocationV1(validationResult.value);
    if (!classificationResult.ok) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          'mandatory_policy_unavailable',
          `Tool Pipeline classification failed: ${classificationResult.failure.code}.`,
        ),
      });
      continue;
    }
    const classifiedInvocation = classificationResult.value;
    if (request.source === 'mcp') {
      request = {
        ...request,
        args: classifiedInvocation.validated.request.arguments,
      } as typeof request;
    }
    const ceilingViolation = skillCapabilityCeilingViolation(params.state, call, request);
    const writerOrChild =
      classifiedInvocation.sideEffect ||
      ['task', 'shell_execute', 'write_file', 'edit_file', 'write_plan', 'update_plan'].includes(
        request.name,
      );
    const sealedProviderPath =
      Boolean(params.taskConfig?.executionBoundary) &&
      (request.name === 'tool_search' ||
        request.name === 'list_mcp_resources' ||
        request.name === 'list_mcp_tools' ||
        request.name === 'read_mcp_resource' ||
        isMcpRequest(request));
    const policyContext = {
      phase: getAgentPhase(getActivePlanning(params.state)),
      workspace: params.state.session.workspace,
      threadId: params.state.session.threadId,
      authorization: params.state.authorization,
      interactionMode: getEffectiveInteractionMode(params.state),
      planKind: getActivePlanning(params.state).kind,
      circuitBreakerTripped: params.state.autoReview.circuitBreakerTripped,
      // A child approval resumes the already-admitted outer task invocation;
      // it must not rewrite that task's authorization identity into an
      // approved_call merely because the nested child received a grant.
      callStatus:
        request.name === 'task' && params.state.suspendedSubagents[toolCallId]
          ? 'queued'
          : call.status,
      gates: {
        recoveryAdmission:
          !call.recoveryAdmission || call.recoveryAdmission === 'admitted'
            ? ('admitted' as const)
            : ('blocked' as const),
        boundedCancellation:
          productionFlags?.resourceBudgetV1 &&
          !productionFlags.boundedCancellationV1 &&
          writerOrChild
            ? ('blocked' as const)
            : ('admitted' as const),
        executionBoundary: sealedProviderPath ? ('blocked' as const) : ('admitted' as const),
        skillCapabilityCeiling: ceilingViolation ? ('blocked' as const) : ('admitted' as const),
      },
    };
    const policyResult = evaluateClassifiedToolPolicyV1(classifiedInvocation, policyContext);
    if (policyResult.kind === 'terminal') {
      const terminal = policyResult.terminal;
      if (terminal.kind !== 'reject') {
        throw new Error('Tool policy emitted an invalid pre-authorization terminal.');
      }
      const reason = ceilingViolation ?? terminal.reason;
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason,
        failure: classifyFailure(terminal.failureKind, reason),
      });
      continue;
    }
    const authorizationResult = authorizePolicyEvaluatedToolV1(policyResult.value, policyContext);
    if (authorizationResult.kind === 'terminal') {
      const terminal = authorizationResult.terminal;
      if (terminal.kind === 'reject') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: terminal.reason,
          failure: classifyFailure(terminal.failureKind, terminal.reason),
        });
        continue;
      }
      if (terminal.kind === 'request_user_input') {
        if (request.name !== 'ask_user') {
          throw new Error('Tool authorization emitted user input for a non-interrupt tool.');
        }
        events.push({
          type: 'user_input.requested',
          interactionId: genInteractionId(),
          toolCallId,
          request: askUserSpec.createInterrupt(request.args, {
            workspace: params.state.session.workspace,
            threadId: params.state.session.threadId,
            phase: getAgentPhase(getActivePlanning(params.state)),
          }),
        });
        continue;
      }
      const governingDescriptor =
        classifiedInvocation.validated.nestedCapability?.descriptor ??
        (classifiedInvocation.validated.resolved.target.executionFamily === 'mcp'
          ? classifiedInvocation.validated.resolved.target.descriptor
          : undefined);
      const approval = buildToolApproval({
        workspace: params.state.session.workspace,
        threadId: params.state.session.threadId,
        request,
        decision: terminal.decision,
        ...(governingDescriptor
          ? {
              capability: {
                capabilityId: governingDescriptor.capabilityId,
                capabilityRevision: governingDescriptor.revision,
                effectiveEffects: governingDescriptor.effectiveEffects,
              },
            }
          : {}),
      });
      if (terminal.kind === 'request_auto_review') {
        events.push({
          type: 'auto_review.requested',
          reviewId: genInteractionId(),
          toolCallId,
          toolName: request.name,
          reason: terminal.decision.reason,
          approval,
        });
      } else {
        events.push({
          type: 'approval.requested',
          interactionId: genInteractionId(),
          toolCallId,
          approval,
        });
      }
      continue;
    }
    const prepareChildReservation = params.beforeAdmissionByToolCallId?.[toolCallId];
    const settleChildReservation = params.afterDispatchByToolCallId?.[toolCallId];
    let preparedChildReservationId: string | undefined;
    const prepareAdmission = async () => {
      let liveState = params.getRuntimeState?.() ?? currentState;
      let budget = liveState.resourceBudget;
      let reservationIds: string[];
      preparedChildReservationId = undefined;
      if (prepareChildReservation) {
        const prepared = await prepareChildReservation();
        liveState = params.getRuntimeState?.() ?? liveState;
        budget = liveState.resourceBudget;
        if (
          budget.status === 'active' &&
          !isCurrentExactChildToolReservationV1(liveState, prepared.reservationId, request.name)
        ) {
          throw new DescendantResourceAdmissionError(
            'reconciliation_required',
            'Child Tool Pipeline reservation is not the current exact durable child reservation.',
          );
        }
        preparedChildReservationId = prepared.reservationId;
        reservationIds = budget.status === 'active' ? [prepared.reservationId] : [];
      } else {
        reservationIds =
          budget.status === 'active'
            ? Object.values(budget.reservations)
                .filter((reservation) => reservation.invocationId.startsWith(`tool:${toolCallId}`))
                .map((reservation) => reservation.reservationId)
            : [];
      }
      return admitAuthorizedToolInvocationV1(authorizationResult.value, {
        reservationRequired: budget.status === 'active',
        reservationIds,
        freshness: 'current',
      });
    };
    let admissionResult = await prepareAdmission();
    if (admissionResult.kind === 'terminal') {
      const terminal = admissionResult.terminal;
      if (terminal.kind !== 'reject') {
        throw new Error('Tool admission emitted an invalid terminal.');
      }
      if (preparedChildReservationId && settleChildReservation) {
        await settleChildReservation({
          reservationId: preparedChildReservationId,
          dispatchState: 'not_started',
          error: new DescendantResourceAdmissionError('reconciliation_required', terminal.reason),
        });
      }
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason: terminal.reason,
        failure: classifyFailure(terminal.failureKind, terminal.reason),
      });
      continue;
    }
    let admittedInvocation = admissionResult.value;
    if (!params.persistRuntimeEvents || !params.getRuntimeState || !capabilityArtifacts) {
      const error = new ToolInvocationPersistenceErrorV1(
        'Tool invocation acknowledgement and private receipt storage are required before dispatch.',
      );
      if (preparedChildReservationId && settleChildReservation) {
        await settleChildReservation({
          reservationId: preparedChildReservationId,
          dispatchState: 'not_started',
          error,
        });
      }
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure('persistence_unavailable', error.message),
      });
      continue;
    }
    const capabilityArtifactStore = capabilityArtifacts;
    const getToolRuntimeState = params.getRuntimeState;
    const persistToolRuntimeEvents = params.persistRuntimeEvents;
    const toolInvocationRecordContext = () => {
      const planning = getActivePlanning(getToolRuntimeState() as RuntimeState);
      const planId = 'document' in planning ? planning.document?.planId : undefined;
      return {
        threadId: params.state.session.threadId,
        toolCallId,
        ...((call.taskId ?? params.state.activeTaskId)
          ? { taskId: call.taskId ?? params.state.activeTaskId ?? undefined }
          : {}),
        ...(planId ? { planId } : {}),
        persistence: {
          getState: getToolRuntimeState,
          persistEvents: persistToolRuntimeEvents,
        },
        filesystemRuntime: params.workspaceFilesystemRuntime,
        sandboxPreparationArtifacts: params.sandboxPreparationArtifacts,
      };
    };
    const emitTerminalBatch = (batch: RuntimeEvent[]) => {
      if (params.emitTerminalEventBatch) params.emitTerminalEventBatch(batch);
      else events.push(...batch);
    };

    const childToolDispatcher: SubAgentToolDispatcherV1 = {
      dispatch: async (childInput) => {
        const runtimeToolCallId = childRuntimeToolCallIdV1({
          parentToolCallId: toolCallId,
          subagentId: childInput.subagentId,
          modelInvocationId: childInput.modelInvocationId,
          modelToolCallId: childInput.modelToolCallId,
          toolName: childInput.request.name,
          args: childInput.request.args,
        });
        const failClosed = (message: string): ToolExecutionResult => ({
          ok: false,
          command: childInput.request.protectedCommand,
          exitCode: -1,
          stdout: '',
          stderr: message,
          status: 'error',
          classifierAdviceV1: {
            detailCode: 'persistence_unavailable',
            disposition: 'never',
            maximumAdditionalCalls: 0,
            requiresNewModelResponse: false,
            safeAutomaticRetry: false,
          },
        });
        const beforeQueue = params.getRuntimeState?.();
        if (!beforeQueue || !params.persistRuntimeEvents) {
          return {
            runtimeToolCallId,
            result: failClosed('Runtime persistence is unavailable for child tool dispatch.'),
          };
        }
        const getChildRuntimeState = params.getRuntimeState!;
        const persistChildRuntimeEvents = params.persistRuntimeEvents!;
        if (childInput.binding) {
          const durableBinding = beforeQueue.capabilities.bindings[childInput.binding.bindingId];
          if (
            !durableBinding ||
            digestCapability(durableBinding) !== digestCapability(childInput.binding)
          ) {
            return {
              runtimeToolCallId,
              result: failClosed(
                'Child MCP binding was not durably acknowledged before model tool dispatch.',
              ),
            };
          }
        }
        const existing = beforeQueue.tools.calls[runtimeToolCallId];
        let executionState: Readonly<RuntimeState>;
        if (existing) {
          const sameCall =
            existing.name === childInput.request.name &&
            digestCapability(existing.args) === digestCapability(childInput.request.args);
          if (!sameCall || existing.status !== 'approved') {
            return {
              runtimeToolCallId,
              result: failClosed(
                sameCall
                  ? 'A child Runtime tool identity was already consumed.'
                  : 'A child Runtime tool identity collided with different arguments.',
              ),
            };
          }
          executionState = beforeQueue;
        } else {
          const queued = await persistChildRuntimeEvents([
            {
              type: 'tool.queued',
              toolCallId: runtimeToolCallId,
              modelInvocationId: childInput.modelInvocationId,
              ...(call.taskId ? { taskId: call.taskId } : {}),
              name: childInput.request.name,
              args: childInput.request.args,
              modelMessageId: childInput.modelInvocationId,
              ordinal: 0,
              ...(childInput.binding
                ? {
                    bindingId: childInput.binding.bindingId,
                    capabilityId: childInput.binding.capabilityId,
                    capabilityRevision: childInput.binding.capabilityRevision,
                  }
                : {}),
            },
          ]);
          const queuedState = getChildRuntimeState();
          if (!queued || queuedState.tools.calls[runtimeToolCallId]?.status !== 'queued') {
            return {
              runtimeToolCallId,
              result: failClosed('Child tool queue acknowledgement became stale.'),
            };
          }
          executionState = queuedState;
        }

        const childEvents = await executeRuntimeTools({
          ...params,
          state: executionState as RuntimeState,
          toolCallIds: [runtimeToolCallId],
          signal: childInput.signal,
          emitRuntimeEvent: undefined,
          emitTerminalEventBatch: undefined,
          toolActorIds: {
            ...(params.toolActorIds ?? {}),
            [runtimeToolCallId]: childInput.subagentId,
          },
          beforeAdmissionByToolCallId: {
            ...(params.beforeAdmissionByToolCallId ?? {}),
            ...(childInput.beforeAdmission
              ? { [runtimeToolCallId]: childInput.beforeAdmission }
              : {}),
          },
          beforeDispatchByToolCallId: {
            ...(params.beforeDispatchByToolCallId ?? {}),
            ...(childInput.beforeDispatch
              ? { [runtimeToolCallId]: childInput.beforeDispatch }
              : {}),
          },
          afterDispatchByToolCallId: {
            ...(params.afterDispatchByToolCallId ?? {}),
            ...(childInput.afterDispatch ? { [runtimeToolCallId]: childInput.afterDispatch } : {}),
          },
        });
        const approval = childEvents.find(
          (event) => event.type === 'approval.requested' || event.type === 'auto_review.requested',
        );
        if (approval) {
          return {
            runtimeToolCallId,
            result: {
              ok: false,
              command: childInput.request.protectedCommand,
              exitCode: -1,
              stdout: '',
              stderr: `${childInput.request.name} requires approval but was not approved.`,
              status: 'rejected',
              approvalRoute: approval.type === 'auto_review.requested' ? 'auto_review' : 'user',
            },
          };
        }
        if (childEvents.length === 0 || !(await persistChildRuntimeEvents(childEvents))) {
          return {
            runtimeToolCallId,
            result: failClosed('Child tool terminal receipt could not be durably persisted.'),
          };
        }
        if (childEvents.some((event) => event.type === 'capability.execution_unknown')) {
          throw new ToolInvocationPersistenceErrorV1(
            'Child tool effect is unknown after its acknowledged dispatch attempt.',
          );
        }
        const acknowledged = getChildRuntimeState().tools.calls[runtimeToolCallId];
        const finished = childEvents.find(
          (event): event is Extract<RuntimeEvent, { type: 'tool.finished' }> =>
            event.type === 'tool.finished' && event.toolCallId === runtimeToolCallId,
        );
        if (
          finished &&
          acknowledged &&
          ['succeeded', 'failed', 'exhausted'].includes(acknowledged.status)
        ) {
          return {
            runtimeToolCallId,
            result: {
              ...finished.result,
              ...(typeof finished.result.resultMeta?.path === 'string'
                ? { path: finished.result.resultMeta.path }
                : {}),
              classifierAdviceV1: finished.classifierAdviceV1,
              classifierDiagnostic: finished.classifierDiagnostic,
            },
          };
        }
        const rejected = childEvents.find(
          (event): event is Extract<RuntimeEvent, { type: 'tool.rejected' }> =>
            event.type === 'tool.rejected' && event.toolCallId === runtimeToolCallId,
        );
        const failed = childEvents.find(
          (event): event is Extract<RuntimeEvent, { type: 'tool.failed' }> =>
            event.type === 'tool.failed' && event.toolCallId === runtimeToolCallId,
        );
        const reason = rejected?.reason ?? failed?.failure.message;
        if (
          reason &&
          acknowledged &&
          ['rejected', 'failed', 'exhausted'].includes(acknowledged.status)
        ) {
          return {
            runtimeToolCallId,
            result: {
              ok: false,
              command: childInput.request.protectedCommand,
              exitCode: -1,
              stdout: '',
              stderr: reason,
              status: rejected ? 'rejected' : 'error',
            },
          };
        }
        return {
          runtimeToolCallId,
          result: failClosed('Child tool terminal acknowledgement is incomplete.'),
        };
      },
    };

    const runtimeFlags = params.taskConfig ? getFeatureFlags(params.taskConfig) : getFeatureFlags();
    const toolSearchContext =
      request.name === 'tool_search'
        ? {
            enabled: runtimeFlags.toolSearchV1,
            mcpManager: params.mcpManager,
            skillCatalog: params.skillCatalog,
            turnId: params.state.turn.turnId,
            toolCallId,
          }
        : undefined;
    const runSkillFork =
      request.name === 'activate_skill' && params.taskConfig && params.taskModel
        ? async (fork: {
            agent: string;
            capabilityCeiling: string[];
            instructions: string;
            workflowInput: Record<string, unknown>;
            outputSchema: Record<string, unknown>;
          }) => {
            const ceiling = forkToolCeiling({
              capabilityCeiling: fork.capabilityCeiling,
              mcpManager: params.mcpManager,
              turnId: params.state.turn.turnId,
            });
            if (!ceiling) return null;
            if (ceiling.mcpBindings.length > 0) {
              const bindingState = getToolRuntimeState();
              const mergedBindings = new Map(
                Object.values(bindingState.capabilities.bindings).map((binding) => [
                  binding.bindingId,
                  binding,
                ]),
              );
              for (const { binding } of ceiling.mcpBindings) {
                const existing = mergedBindings.get(binding.bindingId);
                if (existing && digestCapability(existing) !== digestCapability(binding)) {
                  return null;
                }
                mergedBindings.set(binding.bindingId, binding);
              }
              const acknowledged = await persistToolRuntimeEvents([
                {
                  type: 'capability.bindings_issued',
                  catalogRevision:
                    params.mcpManager?.getCapabilitySnapshot().revision ??
                    bindingState.capabilities.catalogRevision,
                  bindings: [...mergedBindings.values()],
                  disclosures: Object.values(bindingState.capabilities.disclosures),
                  loadedCapabilities: Object.values(bindingState.capabilities.loadedCapabilities),
                },
              ]);
              const durableState = getToolRuntimeState();
              if (
                !acknowledged ||
                ceiling.mcpBindings.some(({ binding }) => {
                  const durableBinding = durableState.capabilities.bindings[binding.bindingId];
                  return (
                    !durableBinding ||
                    digestCapability(durableBinding) !== digestCapability(binding)
                  );
                })
              ) {
                return null;
              }
            }
            return dispatchSubagentForkAdapterV1(
              {
                config: params.taskConfig!,
                workspace: params.state.session.workspace,
                shellExecutor: params.shellExecutor,
                mcpManager: params.mcpManager,
                skills: params.skillManifests,
                skillOptions: params.skillOptions,
                allowedTools: ceiling.allowedTools,
                mcpBindings: ceiling.mcpBindings,
                authorization: params.state.authorization,
                workspaceAccess: params.state.workspaceAccess,
                phase: getAgentPhase(getActivePlanning(params.state)),
                interactionMode: getEffectiveInteractionMode(params.state),
                projectInstructions: visibleProjectInstructions(
                  params.state,
                  call.modelMessageId,
                  params.taskConfig!,
                ),
                threadId: params.state.session.threadId,
                recoveryIdentityKey: currentState.toolRecovery.identityKey,
                eventSink: emitSubagentEvent,
                signal: params.signal,
                model: params.taskModel,
                providerDataAdmission: params.providerDataAdmission,
                descendantResourceAdmission: params.descendantResourceAdmission,
                modelInvocationGateway: params.modelInvocationGateway,
                modelInvocationPersistence: params.modelInvocationPersistence,
                modelInvocationParentId: call.modelInvocationId,
                modelInvocationParentToolCallId: toolCallId,
                modelInvocationParentReservationId: params.modelInvocationParentReservationId,
                toolDispatcher: childToolDispatcher,
                maxDepth: 0,
                recordFilePreimage: params.recordFilePreimage,
              },
              {
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
        : undefined;
    const skillRuntimeContext =
      request.name === 'activate_skill' ||
      request.name === 'read_skill_reference' ||
      request.name === 'complete_skill'
        ? {
            state: params.state,
            catalog: params.skillCatalog,
            flags: runtimeFlags,
            verificationEnabled:
              request.name !== 'read_skill_reference' &&
              Boolean(params.taskConfig) &&
              runtimeFlags.verificationV1,
            ...(runSkillFork ? { runFork: runSkillFork } : {}),
          }
        : undefined;
    const planRuntimeContext =
      request.name === 'read_plan' ||
      request.name === 'write_plan' ||
      request.name === 'update_plan'
        ? {
            state: params.state,
            artifacts: planArtifacts,
            ...(request.name === 'write_plan'
              ? { modelMessageId: call.modelMessageId, ordinal: call.ordinal }
              : {}),
          }
        : undefined;

    const mcpDescriptor =
      classifiedInvocation.validated.resolved.target.executionFamily === 'mcp'
        ? classifiedInvocation.validated.resolved.target.descriptor
        : undefined;
    const mcpPolicy = mcpDescriptor
      ? {
          effects: mcpDescriptor.effectiveEffects,
          minimumApproval: mcpDescriptor.policy.minimumApproval,
        }
      : undefined;
    if (request.name === 'task') {
      // ── Sub-agent approval resume path ──
      // When a sub-agent paused for approval, the task tool call was set to
      // 'approved' by the reducer.  Instead of starting a fresh sub-agent,
      // execute the blocked tool with the approved grant and resume.
      const suspended = params.state.suspendedSubagents[toolCallId];
      if (suspended && call.status === 'approved') {
        try {
          const restored = deserializeSubagentContinuation(suspended);
          const resumeEvents = await handleSubAgentResume({
            state: params.state,
            getRuntimeState: params.getRuntimeState,
            toolCallId,
            continuation: restored,
            shellExecutor: params.shellExecutor,
            gitBroker: params.gitBroker,
            mcpManager: params.mcpManager,
            skillManifests: params.skillManifests,
            skillOptions: params.skillOptions,
            signal: params.signal,
            taskConfig: params.taskConfig,
            taskModel: params.taskModel,
            providerDataAdmission: params.providerDataAdmission,
            descendantResourceAdmission: params.descendantResourceAdmission,
            modelInvocationGateway: params.modelInvocationGateway,
            modelInvocationPersistence: params.modelInvocationPersistence,
            modelInvocationParentId: call.modelInvocationId,
            modelInvocationParentReservationId: params.modelInvocationParentReservationId,
            emitSubagentEvent,
            recordFilePreimage: params.recordFilePreimage,
            recordNetworkDecision: params.recordNetworkDecision,
            admittedInvocation,
            invocationRecordContext: toolInvocationRecordContext(),
            capabilityArtifactStore,
            childToolDispatcher,
          });
          if (
            resumeEvents.some(
              (event) =>
                event.type === 'tool.finished' ||
                event.type === 'tool.failed' ||
                event.type === 'tool.cancelled',
            )
          ) {
            emitTerminalBatch(resumeEvents);
          } else {
            events.push(...resumeEvents);
          }
        } catch (error) {
          if (error instanceof DescendantResourceAdmissionError) throw error;
          events.push({
            type: 'tool.failed',
            toolCallId,
            failure: classifyFailure(
              'tool_runtime_error',
              error instanceof Error ? error.message : String(error),
            ),
          });
        }
        continue;
      }
      if (suspended && call.status === 'queued') {
        const restored = deserializeSubagentContinuation(suspended);
        events.push(
          blockedSubagentReviewEvent({
            state: params.state,
            parentToolCallId: toolCallId,
            blocked: {
              reasonCode: restored.blockedTool.reasonCode,
              toolCallId: restored.blockedTool.toolCallId,
              toolName: restored.blockedTool.toolName,
              command: restored.blockedTool.command,
              args: restored.blockedTool.args,
              message: `Sub-agent tool '${restored.blockedTool.toolName}' requires approval.`,
              continuation: restored,
            },
            availCtx,
          }),
        );
        continue;
      }

      // ── Normal sub-agent execution ──
      events.push({ type: 'tool.started', toolCallId });
      try {
        const dispatch = await dispatchAdmittedToolInvocationV1(
          admittedInvocation,
          {
            workspace: params.state.session.workspace,
            request,
            shellExecutor: params.shellExecutor,
            gitBroker: params.gitBroker,
            workspaceAccess: params.state.workspaceAccess,
            phase: getAgentPhase(getActivePlanning(params.state)),
            authorization: params.state.authorization,
            approvedGrant: call.approvalGrant ?? 'none',
            threadId: params.state.session.threadId,
            // Keep the child journal in the same HMAC domain as the live parent
            // state; merging a child seeded from a stale snapshot is fail-closed.
            recoveryIdentityKey: currentState.toolRecovery.identityKey,
            recordFilePreimage: params.recordFilePreimage,
            recordNetworkDecision: params.recordNetworkDecision,
            mcpManager: params.mcpManager,
            skillManifests: params.skillManifests,
            skillOptions: params.skillOptions,
            signal: params.signal,
            interactionMode: getEffectiveInteractionMode(params.state),
            taskConfig: params.taskConfig,
            taskModel: params.taskModel,
            providerDataAdmission: params.providerDataAdmission,
            descendantResourceAdmission: params.descendantResourceAdmission,
            modelInvocationGateway: params.modelInvocationGateway,
            modelInvocationPersistence: params.modelInvocationPersistence,
            modelInvocationParentId: call.modelInvocationId,
            modelInvocationParentToolCallId: toolCallId,
            modelInvocationParentReservationId: params.modelInvocationParentReservationId,
            subagentEventSink: emitSubagentEvent,
            subagentToolDispatcher: childToolDispatcher,
            availabilityContext: availCtx,
            projectInstructionSnapshot: visibleProjectInstructions(
              params.state,
              call.modelMessageId,
              params.taskConfig,
            ),
            onShellProgress: (chunk, stream) =>
              events.push({ type: 'tool.progress', toolCallId, chunk, stream }),
          },
          toolInvocationRecordContext(),
        );
        const result = dispatch.kind === 'dispatched' ? dispatch.value.result : dispatch.result;

        const subagentRecoveryEvent: RuntimeEvent | undefined = result.subagentResult?.toolRecovery
          ? {
              type: 'subagent.recovery_journal_merged',
              toolCallId,
              journal: result.subagentResult.toolRecovery,
            }
          : undefined;

        // ── Sub-agent blocked for approval → surface through Runtime Kernel ──
        if (result.subagentResult?.blocked) {
          const blocked = result.subagentResult.blocked;
          // Serialize continuation into RuntimeState for persistence
          if (subagentRecoveryEvent) events.push(subagentRecoveryEvent);
          events.push({
            type: 'subagent.suspended',
            toolCallId,
            snapshot: serializeSubagentContinuation(blocked.continuation, {
              reasonCode: blocked.reasonCode,
              toolCallId: blocked.toolCallId,
              ...(blocked.runtimeToolCallId
                ? { runtimeToolCallId: blocked.runtimeToolCallId }
                : {}),
              toolName: blocked.toolName,
              args: blocked.args,
              command: blocked.command,
            }),
          });

          events.push(
            blockedSubagentReviewEvent({
              state: params.state,
              parentToolCallId: toolCallId,
              blocked,
              availCtx,
            }),
          );
          // Do NOT emit tool.finished — the task tool is paused, waiting for approval
          continue;
        }

        const terminalBatch: RuntimeEvent[] = [];
        if (subagentRecoveryEvent) terminalBatch.push(subagentRecoveryEvent);
        if (dispatch.kind === 'dispatched') {
          try {
            const receipt = commitNormalizedToolReceiptV1(
              normalizeDispatchedToolOutcomeV1(dispatch.value),
              capabilityArtifactStore,
            );
            terminalBatch.push(...receipt.terminalEvents);
          } catch (error) {
            if (!(error instanceof ToolReceiptPersistenceErrorV1)) throw error;
            terminalBatch.push(receiptPersistenceUnknownEventV1(error), {
              type: 'tool.failed',
              toolCallId,
              failure: classifyFailure('persistence_unavailable', error.message),
            });
            emitTerminalBatch(terminalBatch);
            continue;
          }
        }
        terminalBatch.push(
          toolFinishedEvent({
            toolCallId,
            name: request.name,
            result,
            command: request.protectedCommand,
          }),
        );
        emitTerminalBatch(terminalBatch);
      } catch (error) {
        const cause = error instanceof ToolInvocationDispatchErrorV1 ? error.causeValue : error;
        if (cause instanceof DescendantResourceAdmissionError) {
          if (error instanceof ToolInvocationDispatchErrorV1 && error.recorded) {
            const failure = classifyFailure(
              'resource_saturated',
              `Subagent execution stopped at descendant resource admission: ${cause.reason}.`,
            );
            try {
              const receipt = commitNormalizedToolReceiptV1(
                normalizeDispatchedToolOutcomeV1(
                  confirmedToolDispatchFailureOutcomeV1(error.recorded, {
                    status: 'error',
                    command: request.protectedCommand,
                    failure,
                  }),
                ),
                capabilityArtifactStore,
              );
              emitTerminalBatch([
                ...receipt.terminalEvents,
                { type: 'tool.failed', toolCallId, failure },
              ]);
            } catch (receiptError) {
              if (!(receiptError instanceof ToolReceiptPersistenceErrorV1)) throw receiptError;
              emitTerminalBatch([
                receiptPersistenceUnknownEventV1(receiptError),
                {
                  type: 'tool.failed',
                  toolCallId,
                  failure: classifyFailure('persistence_unavailable', receiptError.message),
                },
              ]);
            }
          }
          throw cause;
        }
        const terminalBatch: RuntimeEvent[] = [];
        if (error instanceof ToolInvocationDispatchErrorV1 && error.recorded) {
          terminalBatch.push({
            type: 'capability.execution_unknown',
            invocationId: error.recorded.invocationId,
            reason: 'Subagent adapter threw after its dispatch attempt was acknowledged.',
            finishedAt: new Date().toISOString(),
          });
        }
        terminalBatch.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            error instanceof ToolInvocationPersistenceErrorV1
              ? 'persistence_unavailable'
              : 'tool_runtime_error',
            error instanceof Error ? error.message : String(error),
          ),
        });
        emitTerminalBatch(terminalBatch);
      }
      continue;
    }

    const mcpFlags = params.taskConfig ? getFeatureFlags(params.taskConfig) : undefined;
    const mcpRoute = mcpDescriptor
      ? params.mcpManager?.getCapabilityRoute?.(mcpDescriptor.capabilityId)
      : undefined;
    const controllerArgumentSnapshot =
      mcpRoute?.transport === 'http'
        ? snapshotRemoteMcpArgumentsV1(request.args as Record<string, unknown>)
        : undefined;
    const controllerArguments =
      controllerArgumentSnapshot?.ok === true
        ? controllerArgumentSnapshot.arguments
        : controllerArgumentSnapshot
          ? Object.freeze({ invalidArgumentShape: true })
          : (request.args as Record<string, unknown>);
    const snapshotBoundRequest = controllerArgumentSnapshot
      ? ({ ...request, args: controllerArguments } as typeof request)
      : request;
    let executionRequest = snapshotBoundRequest;
    let remoteEgress: RemoteMcpEgressInvocationPolicyV1 | undefined;
    let remoteEgressPreflightFailure: import('@/core/mcp').RemoteMcpEgressReceiptV1 | undefined;
    let remoteEgressPersistenceUnavailable = false;
    if (mcpDescriptor) {
      const flags = mcpFlags;
      const route = mcpRoute;
      if (route?.transport === 'http') {
        const argumentSnapshot =
          controllerArgumentSnapshot?.ok === false
            ? controllerArgumentSnapshot
            : snapshotRemoteMcpArgumentsV1(executionRequest.args as Record<string, unknown>);
        const finalArguments = argumentSnapshot.ok
          ? argumentSnapshot.arguments
          : Object.freeze({ invalidArgumentShape: true });
        if (argumentSnapshot.ok) {
          executionRequest = {
            ...executionRequest,
            args: argumentSnapshot.arguments,
          } as typeof executionRequest;
        }
        const content = classifyRemoteMcpArgumentsV1(finalArguments);
        const egressRequest: RemoteMcpEgressPermitRequestV1 = {
          ...route,
          invocationId: digestCapability({
            threadId: params.state.session.threadId,
            toolCallId,
            capabilityId: mcpDescriptor.capabilityId,
            toolRevision: mcpDescriptor.revision,
            arguments: finalArguments,
          }),
          toolCallId,
          argumentDigest: remoteMcpArgumentDigestV1(finalArguments),
          content,
        };
        if (!params.recordRemoteMcpEgressDecision) {
          remoteEgressPersistenceUnavailable = true;
        } else {
          const enabled = flags?.remoteMcpEgressPolicyV1 === true;
          const contentInspection = argumentSnapshot.ok
            ? inspectRemoteMcpArgumentsV1(finalArguments, {
                knownSecrets: [params.taskConfig?.apiKey],
              })
            : 'unknown';
          const permit =
            enabled && hasRemoteMcpContentV1(content) && contentInspection === 'clear'
              ? await params.remoteMcpEgressPermitResolver?.(Object.freeze(egressRequest))
              : undefined;
          const preflight = createRemoteMcpEgressReceiptV1({
            enabled,
            request: egressRequest,
            permit,
            ...(contentInspection === 'secret'
              ? { reason: 'secret_detected' as const }
              : contentInspection === 'unknown'
                ? { reason: 'content_inspection_unknown' as const }
                : {}),
          });
          if (!preflight.admitted) {
            remoteEgressPreflightFailure = preflight;
          } else {
            remoteEgress = {
              enabled,
              invocationId: egressRequest.invocationId,
              toolCallId,
              content,
              ...(permit ? { permit } : {}),
              recordDecision: params.recordRemoteMcpEgressDecision,
            };
          }
        }
      } else if (flags && !route) {
        const argumentSnapshot = snapshotRemoteMcpArgumentsV1(
          executionRequest.args as Record<string, unknown>,
        );
        const finalArguments = argumentSnapshot.ok
          ? argumentSnapshot.arguments
          : Object.freeze({ invalidArgumentShape: true });
        const content = classifyRemoteMcpArgumentsV1(finalArguments);
        if (hasRemoteMcpContentV1(content)) {
          const receipt = createRemoteMcpEgressReceiptV1({
            enabled: true,
            request: {
              transport: 'http',
              serverIdentity: mcpDescriptor.provider.id,
              endpointRevision: 'unavailable',
              toolRevision: mcpDescriptor.revision,
              invocationId: digestCapability({
                threadId: params.state.session.threadId,
                toolCallId,
                capabilityId: mcpDescriptor.capabilityId,
              }),
              toolCallId,
              argumentDigest: remoteMcpArgumentDigestV1(finalArguments),
              content,
            },
            reason: 'route_unavailable',
          });
          remoteEgressPreflightFailure = receipt;
        }
      }
    }
    if (remoteEgressPersistenceUnavailable) {
      const reason = 'Remote MCP egress decision persistence is required before dispatch.';
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure('persistence_unavailable', reason),
      });
      continue;
    }
    if (remoteEgressPreflightFailure) {
      if (!params.recordRemoteMcpEgressDecision) {
        const reason = 'Remote MCP egress decision persistence is required before dispatch.';
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure('persistence_unavailable', reason),
        });
        continue;
      }
      try {
        await params.recordRemoteMcpEgressDecision(remoteEgressPreflightFailure);
      } catch {
        const reason = 'Remote MCP egress decision could not be persisted before dispatch.';
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure('persistence_unavailable', reason),
        });
        continue;
      }
      const denied = new RemoteMcpEgressDeniedError(remoteEgressPreflightFailure);
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason: denied.message,
        failure: classifyFailure('policy_denied', denied.message),
      });
      continue;
    }
    const executionStartedAt = Date.now();
    try {
      // Automatic replay is limited to a proven safe read. Merely attaching an
      // idempotency key is not an idempotency receipt and therefore cannot authorize replay.
      const automaticRetryEligible = mcpDescriptor?.execution?.retry === 'safe_read';
      let automaticRetryConsumed = false;
      const persistAutomaticRetry = async (
        error: unknown,
        authority: {
          dispatchState: 'not_started' | 'started';
          replaySafety: 'pre_dispatch' | 'safe_read';
        },
      ): Promise<boolean> => {
        if (
          automaticRetryConsumed ||
          !automaticRetryEligible ||
          !isMcpProviderError(error) ||
          !error.retryable
        ) {
          return false;
        }
        const failure = classifyMcpProviderError(error);
        const invocationFingerprint =
          call.invocationFingerprint ??
          toolInvocationFingerprintV1({
            key: params.state.toolRecovery.identityKey,
            toolName: call.name,
            parsedArgs: call.args,
          });
        const baseOutcome = classifyToolOutcomeV1({
          status: 'failed',
          failure,
          authority: {
            dispatchState: authority.dispatchState,
            externalEffects: 'none',
            replaySafety: authority.replaySafety,
          },
          toolAdvice: {
            disposition: 'retry_once',
            maximumAdditionalCalls: 1,
            safeAutomaticRetry: true,
          },
          timing: {
            executionMs: Math.max(0, Date.now() - executionStartedAt),
            totalActiveMs: Math.max(0, Date.now() - executionStartedAt),
          },
        });
        if (!baseOutcome.recovery.safeAutomaticRetry) return false;
        const recoveryOf = toolFailureInstanceIdV1({
          toolCallId,
          invocationFingerprint,
          outcome: baseOutcome,
        });
        const retryRecorded: RuntimeEvent = {
          type: 'tool.retry_recorded',
          toolCallId,
          failure,
          outcomeV1: {
            ...baseOutcome,
            lineage: { failureInstanceId: recoveryOf },
          },
          recoveryOf,
          retryAttempt: 1,
        };
        if (!params.persistRuntimeEvent) {
          throw new Error('Automatic retry requires a durable RuntimeStore acknowledgement.');
        }
        let persisted = false;
        try {
          persisted = await params.persistRuntimeEvent(retryRecorded);
        } catch {
          throw new Error('Automatic retry evidence could not be durably persisted.');
        }
        if (!persisted) {
          throw new Error('Automatic retry evidence became stale before durable persistence.');
        }
        automaticRetryConsumed = true;
        return true;
      };

      while (true) {
        try {
          const readinessProviderId =
            request.name === 'read_mcp_resource'
              ? (request.args as ReadMcpResourceInput).server
              : mcpDescriptor?.provider.id;
          if (readinessProviderId) {
            if (
              !params.providerReadinessCoordinator ||
              !params.persistRuntimeEvent ||
              !params.getRuntimeState
            ) {
              throw new ProviderReadinessPersistenceError(
                'Provider readiness coordinator and RuntimeStore acknowledgement are required.',
              );
            }
            const providerDirectoryRevision =
              params.mcpManager?.getProviderDirectorySnapshot().revision ??
              'provider-directory-unavailable';
            const routeRevision =
              (mcpDescriptor
                ? params.mcpManager?.getCapabilityRoute?.(mcpDescriptor.capabilityId)
                    ?.endpointRevision
                : undefined) ?? providerDirectoryRevision;
            const executionBoundaryDigest = params.taskConfig?.executionBoundary
              ? computeExecutionBoundaryDigestV1(params.taskConfig.executionBoundary)
              : digestCapability({ schema: 'kite.unsealed-execution-boundary.v1' });
            await params.providerReadinessCoordinator.ensureReady(
              {
                providerId: readinessProviderId,
                routeRevision,
                executionBoundaryDigest,
                toolCallId,
                retryAuthorized: automaticRetryConsumed,
                signal: params.signal,
              },
              {
                getState: params.getRuntimeState,
                persistEvent: params.persistRuntimeEvent,
              },
            );
          }
          if (mcpDescriptor) {
            const currentDescriptor = params.mcpManager?.findCapability(mcpDescriptor.capabilityId);
            if (!currentDescriptor || currentDescriptor.revision !== mcpDescriptor.revision) {
              throw capabilityChangedProviderError(mcpDescriptor.provider.id);
            }
          }
          break;
        } catch (error) {
          if (
            !(await persistAutomaticRetry(error, {
              dispatchState: 'not_started',
              replaySafety: 'pre_dispatch',
            }))
          ) {
            throw error;
          }
        }
      }

      events.push({ type: 'tool.started', toolCallId });

      let result: ToolExecutionResult | undefined;
      let dispatchedOutcome:
        | import('@/core/execution/tool-pipeline').DispatchedOutcomeV1
        | undefined;
      while (!result) {
        try {
          const dispatch = await dispatchAdmittedToolInvocationV1(
            admittedInvocation,
            {
              workspace: params.state.session.workspace,
              request: executionRequest,
              shellExecutor: params.shellExecutor,
              gitBroker: params.gitBroker,
              workspaceAccess: params.state.workspaceAccess,
              phase: getAgentPhase(getActivePlanning(params.state)),
              authorization: params.state.authorization,
              approvedGrant: call.approvalGrant ?? 'none',
              threadId: params.state.session.threadId,
              // Re-read at dispatch: provider readiness/retries may have advanced
              // the durable state since this effect was leased.
              recoveryIdentityKey: (params.getRuntimeState?.() ?? currentState).toolRecovery
                .identityKey,
              recordFilePreimage: params.recordFilePreimage,
              recordNetworkDecision: params.recordNetworkDecision,
              mcpManager: params.mcpManager,
              ...(mcpDescriptor
                ? {
                    mcpInvocation: {
                      capabilityId: mcpDescriptor.capabilityId,
                      expectedRevision: mcpDescriptor.revision,
                      ...(remoteEgress ? { remoteEgress } : {}),
                    },
                  }
                : {}),
              ...(mcpPolicy ? { mcpPolicy } : {}),
              skillManifests: params.skillManifests,
              skillOptions: params.skillOptions,
              signal: params.signal,
              interactionMode: getEffectiveInteractionMode(params.state),
              taskConfig: params.taskConfig,
              taskModel: params.taskModel,
              subagentEventSink: emitSubagentEvent,
              readStateActorId: params.toolActorIds?.[toolCallId],
              beforeAttemptDispatch: params.beforeDispatchByToolCallId?.[toolCallId]
                ? (attempt) =>
                    params.beforeDispatchByToolCallId![toolCallId]!(
                      attempt,
                      preparedChildReservationId,
                    )
                : undefined,
              afterAttemptDispatch: settleChildReservation
                ? (attempt) =>
                    settleChildReservation({
                      ...attempt,
                      reservationId: preparedChildReservationId,
                      dispatchState: 'started',
                    })
                : undefined,
              availabilityContext: availCtx,
              toolSearch: toolSearchContext,
              skillRuntime: skillRuntimeContext,
              planRuntime: planRuntimeContext,
              projectInstructionSnapshot: visibleProjectInstructions(
                params.state,
                call.modelMessageId,
                params.taskConfig,
              ),
              onShellProgress: (chunk, stream) =>
                events.push({ type: 'tool.progress', toolCallId, chunk, stream }),
            },
            toolInvocationRecordContext(),
          );
          if (dispatch.kind === 'dispatched') {
            dispatchedOutcome = dispatch.value;
            result = dispatch.value.result;
          } else {
            result = dispatch.result;
          }
        } catch (error) {
          const attemptWasAcknowledged =
            error instanceof ToolInvocationDispatchErrorV1 && error.recorded != null;
          if (preparedChildReservationId && settleChildReservation && !attemptWasAcknowledged) {
            await settleChildReservation({
              reservationId: preparedChildReservationId,
              dispatchState: 'not_started',
              error,
            });
          }
          const retryError =
            error instanceof ToolInvocationDispatchErrorV1 ? error.causeValue : error;
          if (
            !(await persistAutomaticRetry(retryError, {
              dispatchState: 'started',
              replaySafety: 'safe_read',
            }))
          ) {
            throw error;
          }
          admissionResult = await prepareAdmission();
          if (admissionResult.kind === 'terminal') {
            const reason =
              admissionResult.terminal.kind === 'reject'
                ? admissionResult.terminal.reason
                : 'Child Tool Pipeline retry admission emitted an invalid terminal.';
            throw new DescendantResourceAdmissionError('reconciliation_required', reason);
          }
          admittedInvocation = admissionResult.value;
        }
      }
      if (!result) throw new Error('MCP execution completed without a result.');

      // Interaction-producing control adapters are durably suspended rather
      // than terminal. Their Runtime events move the call to an awaiting state;
      // a later action owns the terminal batch.
      if (result.ok !== false && result.runtimeEvents?.length && !result.stdout && !result.stderr) {
        const suspendedBatch: RuntimeEvent[] = [];
        if (dispatchedOutcome) {
          try {
            suspendedBatch.push(
              recordNormalizedToolResultV1(
                normalizeDispatchedToolOutcomeV1(dispatchedOutcome),
                capabilityArtifactStore,
              ),
            );
          } catch (error) {
            if (!(error instanceof ToolReceiptPersistenceErrorV1)) throw error;
            emitTerminalBatch([
              receiptPersistenceUnknownEventV1(error),
              {
                type: 'tool.failed',
                toolCallId,
                failure: classifyFailure('persistence_unavailable', error.message),
              },
            ]);
            continue;
          }
        }
        suspendedBatch.push(...result.runtimeEvents);
        emitTerminalBatch(suspendedBatch);
        continue;
      }

      const terminalBatch: RuntimeEvent[] = [];
      let verificationEvents: RuntimeEvent[] = [];
      if (dispatchedOutcome) {
        try {
          const receipt = commitNormalizedToolReceiptV1(
            normalizeDispatchedToolOutcomeV1(dispatchedOutcome),
            capabilityArtifactStore,
          );
          terminalBatch.push(...receipt.terminalEvents);
          const taskId = call.taskId ?? params.state.activeTaskId ?? undefined;
          const verification = planCommittedToolVerificationV1(receipt, {
            enabled: Boolean(
              params.taskConfig && getFeatureFlags(params.taskConfig).verificationV1,
            ),
            ...(taskId ? { taskId } : {}),
          });
          if (verification.kind === 'planned') {
            verificationEvents = [...verification.value.verificationEvents];
          }
        } catch (error) {
          if (!(error instanceof ToolReceiptPersistenceErrorV1)) throw error;
          terminalBatch.push(receiptPersistenceUnknownEventV1(error), {
            type: 'tool.failed',
            toolCallId,
            failure: classifyFailure('persistence_unavailable', error.message),
          });
          emitTerminalBatch(terminalBatch);
          continue;
        }
      }
      terminalBatch.push(...(result.runtimeEvents ?? []));
      const runtimeOwnedSpec = builtinToolRegistry.get(request.name);
      if (
        result.ok === false &&
        runtimeOwnedSpec &&
        (runtimeOwnedSpec.kind === 'coordination' || runtimeOwnedSpec.kind === 'runtime_action')
      ) {
        terminalBatch.push({
          type: 'tool.rejected',
          toolCallId,
          reason: result.stderr || 'Tool execution was rejected.',
        });
        emitTerminalBatch(terminalBatch);
        continue;
      }

      terminalBatch.push(...verificationEvents);

      // 文件变更事件 — write_file / edit_file 的结果通知 TUI
      // File change event — notify TUI of write_file / edit_file results
      if (result.ok !== false && (request.name === 'write_file' || request.name === 'edit_file')) {
        const filePath = String(request.args.path ?? '');
        if (filePath) {
          terminalBatch.push({
            type: 'tool.file_change',
            toolCallId,
            path: filePath,
            kind: request.name === 'edit_file' ? 'edit' : 'add',
            preview: (result.stdout ?? result.stderr ?? '').slice(0, 500) || undefined,
          });
        }
      }

      if (result.processCleanup && !result.processCleanup.confirmedExited) {
        terminalBatch.push({
          type: 'runtime.cancellation_diagnostic',
          toolCallId,
          failure: classifyFailure(
            'cancel_incomplete',
            'One or more shell descendants could not be confirmed exited after bounded cleanup.',
          ),
          unconfirmedDescendantCount: result.processCleanup.unconfirmedDescendantCount,
        });
      }

      terminalBatch.push(
        toolFinishedEvent({
          toolCallId,
          name: request.name,
          result,
          command: request.protectedCommand,
        }),
      );
      emitTerminalBatch(terminalBatch);
    } catch (error) {
      const cause = error instanceof ToolInvocationDispatchErrorV1 ? error.causeValue : error;
      if (cause instanceof DescendantResourceAdmissionError) {
        if (error instanceof ToolInvocationDispatchErrorV1 && error.recorded) {
          const failure = classifyFailure(
            cause.reason === 'budget_exhausted' ? 'budget_exceeded' : 'resource_saturated',
            `Child tool execution stopped at descendant resource admission: ${cause.reason}.`,
          );
          try {
            const receipt = commitNormalizedToolReceiptV1(
              normalizeDispatchedToolOutcomeV1(
                confirmedToolDispatchFailureOutcomeV1(error.recorded, {
                  status: 'error',
                  command: request.protectedCommand,
                  failure,
                }),
              ),
              capabilityArtifactStore,
            );
            emitTerminalBatch([
              ...receipt.terminalEvents,
              { type: 'tool.failed', toolCallId, failure },
            ]);
          } catch (receiptError) {
            if (!(receiptError instanceof ToolReceiptPersistenceErrorV1)) throw receiptError;
            emitTerminalBatch([
              receiptPersistenceUnknownEventV1(receiptError),
              {
                type: 'tool.failed',
                toolCallId,
                failure: classifyFailure('persistence_unavailable', receiptError.message),
              },
            ]);
          }
        }
        throw cause;
      }
      const terminalBatch: RuntimeEvent[] = [];
      const failure = isMcpProviderError(cause)
        ? classifyMcpProviderError(cause)
        : cause instanceof ProviderReadinessPersistenceError ||
            cause instanceof ProviderReadinessUnknownError ||
            cause instanceof ToolInvocationPersistenceErrorV1
          ? classifyFailure('persistence_unavailable', cause.message)
          : cause instanceof RemoteMcpEgressDeniedError
            ? classifyFailure(
                cause.receipt.reason === 'receipt_persistence_failed'
                  ? 'persistence_unavailable'
                  : 'policy_denied',
                cause.message,
              )
            : classifyFailure(
                'tool_runtime_error',
                cause instanceof Error ? cause.message : String(cause),
              );
      if (error instanceof ToolInvocationDispatchErrorV1 && error.recorded) {
        const confirmedAdapterFailure =
          error.recorded.admitted.authorized.policy.classified.requirements.receipt ===
            'observation_receipt' ||
          (isMcpProviderError(cause) &&
            (cause.kind === 'provider_auth_required' ||
              cause.kind === 'provider_approval_required'));
        if (confirmedAdapterFailure) {
          try {
            const receipt = commitNormalizedToolReceiptV1(
              normalizeDispatchedToolOutcomeV1(
                confirmedToolDispatchFailureOutcomeV1(error.recorded, {
                  status: 'error',
                  command: request.protectedCommand,
                  failure,
                }),
              ),
              capabilityArtifactStore,
            );
            terminalBatch.push(...receipt.terminalEvents);
          } catch (receiptError) {
            if (!(receiptError instanceof ToolReceiptPersistenceErrorV1)) throw receiptError;
            terminalBatch.push(receiptPersistenceUnknownEventV1(receiptError));
          }
        } else {
          terminalBatch.push({
            type: 'capability.execution_unknown',
            invocationId: error.recorded.invocationId,
            reason: 'Tool adapter threw after its dispatch attempt was durably acknowledged.',
            finishedAt: new Date().toISOString(),
          });
        }
      }
      terminalBatch.push({
        type: 'tool.failed',
        toolCallId,
        failure,
      });
      const providerAction = providerActionRequiredEvent({
        enabled: Boolean(
          params.taskConfig && getFeatureFlags(params.taskConfig).mcpProviderActionV1,
        ),
        providerId:
          (isMcpProviderError(cause) && cause.providerId) ||
          call.capabilityId?.match(/^mcp:([^/]+)\//)?.[1] ||
          request.name.match(/^mcp__([^_]+)__/u)?.[1] ||
          'unknown',
        toolCallId,
        action: isMcpProviderError(cause)
          ? cause.recoveryAction
          : recoveryActionForFailure(failure),
      });
      if (providerAction) terminalBatch.push(providerAction);
      emitTerminalBatch(terminalBatch);
    }
  }
  return events;
}

function visibleProjectInstructions(
  state: RuntimeState,
  modelMessageId: string | undefined,
  config: AgentConfig | undefined,
) {
  if (!config || !getFeatureFlags(config).promptContractV2) return undefined;
  return resolveProjectInstructionSnapshot({
    workspace: state.session.workspace,
    state,
    excludeModelMessageId: modelMessageId,
  });
}
