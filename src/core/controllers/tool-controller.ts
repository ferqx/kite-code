import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { createBinding, digestCapability } from '@/core/capabilities/catalog';
import { validateCapabilityArguments } from '@/core/capabilities/schema';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import { ProviderDataAdmissionError } from '@/core/config/provider-data-admission';
import { buildToolApproval } from '@/core/harness/tool-policy';
import {
  isMcpRequest,
  type PendingToolRequest,
  toolRequestFromCall,
} from '@/core/harness/tool-requests';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import { completedTaskExecutionResult, invokeGovernedTool } from '@/core/harness/tool-runner';
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
import {
  type CapabilityArtifactStore,
  defaultCapabilityArtifactStore,
} from '@/core/persistence/capability-artifacts';
import {
  defaultPlanArtifactStore,
  type PlanArtifactStore,
} from '@/core/persistence/plan-artifacts';
import { evaluateToolApproval, isReadOnlyMcpPolicy } from '@/core/policies/approval-policy';
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
import { toolExecutionModelContentV1 } from '@/core/runtime/tool-model-content';
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
import {
  rejectShellOutsideSubAgentRoleCeiling,
  resolveSubAgentShellExecutor,
  resumeSubAgent,
} from '@/core/subagent/runner';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import type { RestoredSubAgentContinuation, SubAgentEventSink } from '@/core/subagent/types';
import { toolAvailabilityContext } from '@/core/tools/definitions';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import { askUserSpec } from '@/core/tools/registry/builtins/ask-user';
import type { ReadMcpResourceInput } from '@/core/tools/registry/builtins/mcp-inventory';
import type { ShellExecutor } from '@/core/tools/shell';
import { verificationRequestForCapability } from '@/core/verification';
import type { InteractionMode } from '@/protocol/events';

type SubagentEvent = Parameters<SubAgentEventSink>[0];

function appendToolRuntimeEvents(
  events: RuntimeEvent[],
  output: { runtimeEvents?: RuntimeEvent[] },
): void {
  events.push(...(output.runtimeEvents ?? []));
}

// ── PR 8: Tool result digest production ──

function computeToolResultDigest(input: {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  status?: 'success' | 'error' | 'rejected' | 'exhausted';
  rawResultDigest?: string;
  truncated?: boolean;
}): {
  contentDigest: string;
  rawResultDigest?: string;
  modelContentDigest: string;
  digestScope: 'raw' | 'projected';
} {
  const modelContentDigest = createHash('sha256')
    .update(toolExecutionModelContentV1(input))
    .digest('hex');
  const completeResultDigest = createHash('sha256')
    .update(
      JSON.stringify({
        stdout: input.stdout,
        stderr: input.stderr,
        exitCode: input.exitCode,
        status: input.status,
      }),
    )
    .digest('hex');
  const rawResultDigest =
    input.rawResultDigest ?? (input.truncated ? undefined : completeResultDigest);
  const digestScope = input.truncated ? ('projected' as const) : ('raw' as const);
  return {
    contentDigest: modelContentDigest,
    ...(rawResultDigest ? { rawResultDigest } : {}),
    modelContentDigest,
    digestScope,
  };
}

/** Canonical ToolExecutionResult projection into the sole reducer terminal event. */
export function toolFinishedEvent(input: {
  toolCallId: string;
  name: string;
  result: ToolExecutionResult;
  command?: string;
}): RuntimeEvent {
  const { result } = input;
  const ok = result.ok !== false;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.exitCode ?? 0;
  return {
    type: 'tool.finished',
    toolCallId: input.toolCallId,
    name: input.name,
    result: {
      ok,
      command: result.command ?? input.command ?? input.name,
      exitCode,
      stdout,
      stderr,
      ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
      resultMeta: {
        ...result.resultMeta,
        ...(result.path ? { path: result.path } : {}),
        ...(result.totalLines != null ? { totalLines: result.totalLines } : {}),
        ...(result.action?.intent ? { intent: result.action.intent } : {}),
        ...(result.processCleanup
          ? {
              processCleanupConfirmed: result.processCleanup.confirmedExited,
              unconfirmedDescendantCount: result.processCleanup.unconfirmedDescendantCount,
            }
          : {}),
        ...computeToolResultDigest({
          ok,
          stdout,
          stderr,
          exitCode,
          status: result.status,
          rawResultDigest: result.resultMeta?.rawResultDigest,
          truncated: result.resultMeta?.truncated,
        }),
      },
      status:
        result.status === 'exhausted' ? 'exhausted' : result.ok === false ? 'error' : 'success',
    },
    ...(result.classifierAdviceV1 ? { classifierAdviceV1: result.classifierAdviceV1 } : {}),
    ...(result.classifierDiagnostic ? { classifierDiagnostic: result.classifierDiagnostic } : {}),
  };
}

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
  const childShellExecutor = resolveSubAgentShellExecutor(continuation.role, params.shellExecutor);

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
      id: params.toolCallId,
      name: blockedToolName,
      args: blockedToolArgs,
    },
    availCtx,
  );

  let toolResult: ToolExecutionResult;
  const roleDenial =
    blockedParsed?.ok && blockedParsed.request.name === 'shell_execute'
      ? rejectShellOutsideSubAgentRoleCeiling(
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
    const resumedBinding = call?.bindingId
      ? state.capabilities.bindings[call.bindingId]
      : undefined;
    let childReservation:
      | import('@/core/runtime/resource-budget-admission').DescendantBudgetReservationV1
      | undefined;
    try {
      toolResult = await invokeGovernedTool({
        workspace: state.session.workspace,
        request: blockedRequest,
        shellExecutor: childShellExecutor,
        gitBroker: params.gitBroker,
        workspaceAccess: state.workspaceAccess,
        phase: getAgentPhase(getActivePlanning(state)),
        authorization: state.authorization,
        approvedGrant: call?.approvalGrant ?? 'none',
        threadId: state.session.threadId,
        readStateActorId: continuation.id,
        recoveryIdentityKey: state.toolRecovery.identityKey,
        recordFilePreimage: params.recordFilePreimage,
        recordNetworkDecision: params.recordNetworkDecision,
        mcpManager: params.mcpManager,
        ...(resumedBinding
          ? {
              mcpInvocation: {
                capabilityId: resumedBinding.capabilityId,
                expectedRevision: resumedBinding.capabilityRevision,
              },
            }
          : {}),
        skillManifests: params.skillManifests,
        skillOptions: params.skillOptions,
        signal: params.signal,
        interactionMode: getEffectiveInteractionMode(state),
        taskConfig: params.taskConfig,
        taskModel: params.taskModel,
        providerDataAdmission: params.providerDataAdmission,
        descendantResourceAdmission: params.descendantResourceAdmission,
        modelInvocationGateway: params.modelInvocationGateway,
        modelInvocationPersistence: params.modelInvocationPersistence,
        modelInvocationParentId: params.modelInvocationParentId,
        modelInvocationParentToolCallId: params.toolCallId,
        modelInvocationParentReservationId: params.modelInvocationParentReservationId,
        subagentEventSink: params.emitSubagentEvent,
        availabilityContext: availCtx,
        projectInstructionSnapshot: visibleProjectInstructions(
          state,
          call?.modelMessageId,
          params.taskConfig,
        ),
        beforeDispatch: params.descendantResourceAdmission
          ? async () => {
              childReservation = await params.descendantResourceAdmission!.reserveTool({
                invocationKey: `resume-tool:${continuation.toolCallCount}:${blockedRequest.id ?? blockedToolName}`,
                toolKind: blockedToolName,
                shell: blockedToolName === 'shell_execute',
              });
            }
          : undefined,
      });
      if (childReservation) {
        let artifactBytes = 0;
        if (
          (blockedToolName === 'write_file' || blockedToolName === 'edit_file') &&
          toolResult.path
        ) {
          try {
            artifactBytes = statSync(toolResult.path).size;
          } catch {
            artifactBytes = 0;
          }
        }
        await params.descendantResourceAdmission!.reconcileTool({
          reservationId: childReservation.reservationId,
          artifactBytes,
        });
      }
    } catch (error) {
      if (childReservation) {
        if (error instanceof ProviderDataAdmissionError) {
          await params.descendantResourceAdmission!.markLocalProviderAdmissionDenied(
            childReservation.reservationId,
          );
        } else {
          await params.descendantResourceAdmission!.markUnknown(childReservation.reservationId);
        }
      }
      throw error;
    }
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
  const result = await resumeSubAgent(
    {
      config: params.taskConfig!,
      workspace: state.session.workspace,
      role: continuation.role,
      task: continuation.task,
      shellExecutor: params.shellExecutor,
      gitBroker: params.gitBroker,
      mcpManager: params.mcpManager,
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

  const completedResult = completedTaskExecutionResult({
    workspace: state.session.workspace,
    subagentType: forkRole(continuation.role.role),
    task: continuation.task,
    result,
  });
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
  capabilityArtifactStore?: CapabilityArtifactStore;
  /** Runtime sink used to publish tool lifecycle/progress events while execution is running. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  /** RuntimeStore-backed acknowledgement required before an automatic provider replay. */
  persistRuntimeEvent?: (event: RuntimeEvent) => Promise<boolean>;
  /** Current Kernel state used to reject a prepared/leased effect that became unsafe. */
  getRuntimeState?: () => Readonly<RuntimeState>;
  /** 写入前文件原像记录器，透传给工具执行链（ADR-0025 §4）。 */
  recordFilePreimage?: FilePreimageRecorder;
  recordNetworkDecision?: NetworkDecisionRecorderV1;
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
  const capabilityArtifacts = params.capabilityArtifactStore ?? defaultCapabilityArtifactStore;
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
    if (call.recoveryAdmission && call.recoveryAdmission !== 'admitted') {
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason: `Runtime recovery guard blocked this invocation (${call.recoveryAdmission}).`,
        failure: classifyFailure(
          'loop_exhausted',
          `Runtime recovery guard blocked this invocation (${call.recoveryAdmission}).`,
        ),
      });
      continue;
    }
    const productionFlags = params.taskConfig ? getFeatureFlags(params.taskConfig) : undefined;
    if (
      productionFlags?.resourceBudgetV1 &&
      !productionFlags.boundedCancellationV1 &&
      (call.sideEffect ||
        ['task', 'shell_execute', 'write_file', 'edit_file', 'write_plan', 'update_plan'].includes(
          call.name,
        ))
    ) {
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason: 'Bounded cancellation is required before production writer/child dispatch.',
        failure: classifyFailure(
          'mandatory_policy_unavailable',
          'Bounded cancellation is required before production writer/child dispatch.',
        ),
      });
      continue;
    }
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
    const request = parsed.request;
    const ceilingViolation = skillCapabilityCeilingViolation(params.state, call, request);
    if (ceilingViolation) {
      events.push({ type: 'tool.rejected', toolCallId, reason: ceilingViolation });
      continue;
    }
    if (
      params.taskConfig?.executionBoundary &&
      (request.name === 'tool_search' ||
        request.name === 'list_mcp_resources' ||
        request.name === 'list_mcp_tools' ||
        request.name === 'read_mcp_resource' ||
        isMcpRequest(request))
    ) {
      const reason =
        'MCP and capability-search provider access is unavailable under the sealed network boundary until its transport uses per-invocation endpoint admission.';
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason,
        failure: classifyFailure('mandatory_policy_unavailable', reason),
      });
      continue;
    }
    if (isMcpRequest(request)) {
      const flags = params.taskConfig ? getFeatureFlags(params.taskConfig) : undefined;
      const binding = call.bindingId
        ? params.state.capabilities.bindings[call.bindingId]
        : undefined;
      const descriptor = binding
        ? params.mcpManager?.findCapability(binding.capabilityId)
        : undefined;
      const providerId =
        binding?.capabilityId.match(/^mcp:([^/]+)\//)?.[1] ??
        request.name.match(/^mcp__([^_]+)__/u)?.[1] ??
        'unknown';
      const directoryEntry = params.mcpManager
        ?.getProviderDirectorySnapshot()
        .entries.find((entry) => entry.providerId === providerId);
      const invalidFailure =
        !flags?.capabilityCatalogV1 || !flags.mcpRuntimeBindingV1
          ? classifyFailure('tool_invalid_args', 'MCP Runtime binding is disabled by feature flag.')
          : !binding || binding.issuedForTurnId !== call.createdAtTurnId
            ? classifyFailure(
                'tool_invalid_args',
                'MCP tool call has no valid Runtime-issued binding.',
              )
            : !descriptor || descriptor.revision !== binding.capabilityRevision
              ? classifyMcpProviderError(
                  directoryEntry && directoryEntry.status !== 'ready'
                    ? providerErrorFromDirectoryEntry(directoryEntry, providerId)
                    : capabilityChangedProviderError(providerId),
                )
              : descriptor.availability !== 'available'
                ? classifyMcpProviderError(
                    providerErrorFromDirectoryEntry(directoryEntry, providerId),
                  )
                : !descriptor.inputSchema
                  ? classifyFailure(
                      'tool_invalid_args',
                      'MCP capability has no executable input schema.',
                    )
                  : (() => {
                      const reason = validateCapabilityArguments(
                        descriptor.inputSchema,
                        request.args,
                      );
                      return reason ? classifyFailure('tool_invalid_args', reason) : undefined;
                    })();
      if (invalidFailure) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: invalidFailure,
        });
        const providerAction = providerActionRequiredEvent({
          enabled: flags?.mcpProviderActionV1 ?? false,
          providerId,
          toolCallId,
          action: recoveryActionForFailure(invalidFailure),
        });
        if (providerAction) events.push(providerAction);
        continue;
      }
    }
    if (request.name === 'activate_skill') {
      const skillInput = request.args;
      const flags = params.taskConfig ? getFeatureFlags(params.taskConfig) : getFeatureFlags();
      const descriptor = params.skillCatalog?.capabilities.descriptors.find(
        (candidate) => candidate.capabilityId === skillInput.skill_id,
      );
      const disclosure = params.state.capabilities.disclosures[skillInput.skill_id];
      if (
        flags.toolSearchV1 &&
        (!descriptor ||
          !disclosure ||
          disclosure.issuedForTurnId !== params.state.turn.turnId ||
          disclosure.capabilityRevision !== descriptor.revision)
      ) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'Skill is not disclosed for this model turn; search again before activation.',
        });
        continue;
      }
      if (descriptor && call.status !== 'approved') {
        const skillPolicy = {
          effects: descriptor.effectiveEffects,
          minimumApproval: descriptor.policy.minimumApproval,
        };
        const activationDecision = evaluateToolApproval({
          toolName: 'mcp__skill__activation',
          toolArgs: request.args,
          phase: getAgentPhase(getActivePlanning(params.state)),
          workspace: params.state.session.workspace,
          threadId: params.state.session.threadId,
          authorization: params.state.authorization,
          mcpPolicy: skillPolicy,
        });
        if (activationDecision.requiresApproval || descriptor.policy.minimumApproval !== 'none') {
          const approval = buildToolApproval({
            workspace: params.state.session.workspace,
            threadId: params.state.session.threadId,
            request,
            decision: activationDecision,
            capability: {
              capabilityId: descriptor.capabilityId,
              capabilityRevision: descriptor.revision,
              effectiveEffects: descriptor.effectiveEffects,
            },
          });
          if (descriptor.policy.minimumApproval === 'user') {
            events.push({
              type: 'approval.requested',
              interactionId: genInteractionId(),
              toolCallId,
              approval,
            });
            continue;
          }
          const effectiveMode = getEffectiveInteractionMode(params.state);
          const modeDecision = createModePolicy(effectiveMode).shouldApproveTool({
            interactionMode: effectiveMode as InteractionMode,
            phase: getAgentPhase(getActivePlanning(params.state)),
            planKind: getActivePlanning(params.state).kind,
            toolName: request.name,
            toolRisk: activationDecision.risk,
            effects: activationDecision.effects,
            circuitBreakerTripped: params.state.autoReview.circuitBreakerTripped,
          });
          if (modeDecision.kind === 'need_auto_review') {
            events.push({
              type: 'auto_review.requested',
              reviewId: genInteractionId(),
              toolCallId,
              toolName: request.name,
              reason: activationDecision.reason,
              approval,
            });
            continue;
          }
          if (modeDecision.kind !== 'allow') {
            events.push({
              type: 'approval.requested',
              interactionId: genInteractionId(),
              toolCallId,
              approval,
            });
            continue;
          }
        }
      }
    }
    if (request.name === 'ask_user') {
      const effectiveMode = getEffectiveInteractionMode(params.state);
      const modeDecision = createModePolicy(effectiveMode).shouldAskUser({
        interactionMode: effectiveMode as InteractionMode,
        phase: getAgentPhase(getActivePlanning(params.state)),
        planKind: getActivePlanning(params.state).kind,
        toolName: 'ask_user',
      });
      if (modeDecision.kind === 'deny') {
        const reason =
          modeDecision.reason ?? 'The current interaction mode does not allow asking the user.';
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason,
          failure: classifyFailure('policy_denied', reason),
        });
        continue;
      }
      // 中断契约在 spec 闭环：事件载荷经 askUserSpec.createInterrupt 生成
      // （规范模型输入 → 内部 UserInputRequest），Controller 不再二次校验或
      // 手工组装中断内容。
      // The interrupt contract closes in the spec: the event payload is built
      // by askUserSpec.createInterrupt from the already validated canonical
      // model input; the controller does not revalidate or hand-assemble it.
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
            return runTaskSubAgent(
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
                maxDepth: 0,
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
      request.name.startsWith('mcp__') && call.bindingId
        ? params.mcpManager?.findCapability(
            params.state.capabilities.bindings[call.bindingId]?.capabilityId ?? '',
          )
        : undefined;
    const mcpPolicy = mcpDescriptor
      ? {
          effects: mcpDescriptor.effectiveEffects,
          minimumApproval: mcpDescriptor.policy.minimumApproval,
        }
      : undefined;
    const decision = evaluateToolApproval({
      toolName: request.name,
      toolArgs: request.args as Record<string, unknown>,
      phase: getAgentPhase(getActivePlanning(params.state)),
      workspace: params.state.session.workspace,
      threadId: params.state.session.threadId,
      authorization: params.state.authorization,
      ...(mcpPolicy ? { mcpPolicy } : {}),
      capability: builtinToolRegistry.effectsOf(request.name, request.args, availCtx),
    });
    if (!decision.allowed) {
      const deferredUntilBuilding =
        request.name === 'shell_execute' && decision.phaseConstraint === 'planning';
      const deniedByPlanningPhase =
        !deferredUntilBuilding && decision.phaseConstraint === 'planning';
      const reason = deferredUntilBuilding
        ? 'Deferred shell_execute until building phase.'
        : decision.userVisibleSummary;
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason,
        failure: classifyFailure(
          deferredUntilBuilding
            ? 'phase_deferred'
            : deniedByPlanningPhase
              ? 'phase_denied'
              : 'policy_denied',
          reason,
        ),
      });
      continue;
    }
    const requiresEffectReview =
      !isReadOnlyMcpPolicy(mcpPolicy) &&
      params.state.authorization.mode !== 'full_access' &&
      getEffectiveInteractionMode(params.state) !== 'full' &&
      Boolean(
        decision.effects?.network ||
          decision.effects?.externalWrite ||
          decision.effects?.uncertainEffects,
      );
    const requiresDirectMcpApproval = mcpDescriptor?.policy.minimumApproval === 'user';
    if (
      (decision.requiresApproval || requiresEffectReview || requiresDirectMcpApproval) &&
      call.status !== 'approved'
    ) {
      // Delegate mode-specific routing to mode-policy
      const effectiveMode = getEffectiveInteractionMode(params.state);
      const modePolicy = createModePolicy(effectiveMode);
      const modeDecision = modePolicy.shouldApproveTool({
        interactionMode: effectiveMode as InteractionMode,
        phase: getAgentPhase(getActivePlanning(params.state)),
        planKind: getActivePlanning(params.state).kind,
        toolName: request.name,
        toolRisk: decision.risk,
        effects: decision.effects,
        circuitBreakerTripped: params.state.autoReview.circuitBreakerTripped,
      });

      if (requiresDirectMcpApproval) {
        const approval = buildToolApproval({
          workspace: params.state.session.workspace,
          threadId: params.state.session.threadId,
          request,
          decision,
          ...(mcpDescriptor && call.capabilityId && call.capabilityRevision
            ? {
                capability: {
                  capabilityId: call.capabilityId,
                  capabilityRevision: call.capabilityRevision,
                  effectiveEffects: mcpDescriptor.effectiveEffects,
                },
              }
            : {}),
        });
        events.push({
          type: 'approval.requested',
          interactionId: genInteractionId(),
          toolCallId,
          approval,
        });
        continue;
      }
      if (modeDecision.kind === 'deny') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: modeDecision.reason ?? decision.userVisibleSummary,
          failure: classifyFailure(
            'policy_denied',
            modeDecision.reason ?? decision.userVisibleSummary,
          ),
        });
        continue;
      }

      if (modeDecision.kind === 'allow') {
        // Mode policy auto-approves this tool (e.g. accept_edits file edits, full_access)
        // Fall through to direct execution below
      } else if (modeDecision.kind === 'need_auto_review') {
        const approval = buildToolApproval({
          workspace: params.state.session.workspace,
          threadId: params.state.session.threadId,
          request,
          decision,
          ...(mcpDescriptor && call.capabilityId && call.capabilityRevision
            ? {
                capability: {
                  capabilityId: call.capabilityId,
                  capabilityRevision: call.capabilityRevision,
                  effectiveEffects: mcpDescriptor.effectiveEffects,
                },
              }
            : {}),
        });
        events.push({
          type: 'auto_review.requested',
          reviewId: genInteractionId(),
          toolCallId,
          toolName: request.name,
          reason: decision.reason,
          approval,
        });
        continue;
      } else {
        const approval = buildToolApproval({
          workspace: params.state.session.workspace,
          threadId: params.state.session.threadId,
          request,
          decision,
          ...(mcpDescriptor && call.capabilityId && call.capabilityRevision
            ? {
                capability: {
                  capabilityId: call.capabilityId,
                  capabilityRevision: call.capabilityRevision,
                  effectiveEffects: mcpDescriptor.effectiveEffects,
                },
              }
            : {}),
        });
        events.push({
          type: 'approval.requested',
          interactionId: genInteractionId(),
          toolCallId,
          approval,
        });
        continue;
      }
    }

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
          });
          events.push(...resumeEvents);
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
        const result = await invokeGovernedTool({
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
          availabilityContext: availCtx,
          projectInstructionSnapshot: visibleProjectInstructions(
            params.state,
            call.modelMessageId,
            params.taskConfig,
          ),
          onShellProgress: (chunk, stream) =>
            events.push({ type: 'tool.progress', toolCallId, chunk, stream }),
        });

        if (result.subagentResult?.toolRecovery) {
          events.push({
            type: 'subagent.recovery_journal_merged',
            toolCallId,
            journal: result.subagentResult.toolRecovery,
          });
        }

        // ── Sub-agent blocked for approval → surface through Runtime Kernel ──
        if (result.subagentResult?.blocked) {
          const blocked = result.subagentResult.blocked;
          // Serialize continuation into RuntimeState for persistence
          events.push({
            type: 'subagent.suspended',
            toolCallId,
            snapshot: serializeSubagentContinuation(blocked.continuation, {
              reasonCode: blocked.reasonCode,
              toolCallId: blocked.toolCallId,
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

        events.push(
          toolFinishedEvent({
            toolCallId,
            name: request.name,
            result,
            command: request.protectedCommand,
          }),
        );
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
    const invocation = createMcpInvocationRecord({
      state: params.state,
      call,
      descriptor: mcpDescriptor,
      flags: mcpFlags,
      argumentsValue: controllerArguments,
    });
    const snapshotBoundRequest = controllerArgumentSnapshot
      ? ({ ...request, args: controllerArguments } as typeof request)
      : request;
    let executionRequest =
      invocation?.idempotencyKeyArgument && invocation.idempotencyKey
        ? ({
            ...snapshotBoundRequest,
            args: {
              ...controllerArguments,
              [invocation.idempotencyKeyArgument]: invocation.idempotencyKey,
            },
          } as typeof request)
        : snapshotBoundRequest;
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
    if (invocation) events.push(invocation.recorded);
    const executionStartedAt = Date.now();
    events.push({ type: 'tool.started', toolCallId });
    if (invocation) {
      events.push({
        type: 'capability.execution_started',
        invocationId: invocation.invocationId,
        startedAt: new Date().toISOString(),
      });
    }
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
          if (request.name === 'read_mcp_resource') {
            await params.mcpManager?.ensureProviderReady?.(
              (request.args as ReadMcpResourceInput).server,
              30_000,
              params.signal,
            );
          }
          if (mcpDescriptor) {
            await params.mcpManager?.ensureProviderReady?.(
              mcpDescriptor.provider.id,
              30_000,
              params.signal,
            );
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

      let result: ToolExecutionResult | undefined;
      while (!result) {
        try {
          result = await invokeGovernedTool({
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
          });
        } catch (error) {
          if (
            !(await persistAutomaticRetry(error, {
              dispatchState: 'started',
              replaySafety: 'safe_read',
            }))
          ) {
            throw error;
          }
        }
      }
      if (!result) throw new Error('MCP execution completed without a result.');

      appendToolRuntimeEvents(events, result);
      const runtimeOwnedSpec = builtinToolRegistry.get(request.name);
      if (
        result.ok === false &&
        runtimeOwnedSpec &&
        (runtimeOwnedSpec.kind === 'coordination' || runtimeOwnedSpec.kind === 'runtime_action')
      ) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: result.stderr || 'Tool execution was rejected.',
        });
        continue;
      }
      if (result.ok !== false && result.runtimeEvents?.length && !result.stdout && !result.stderr) {
        continue;
      }

      if (invocation) {
        const terminal = invocationTerminalEvent(
          invocation.invocationId,
          result,
          new Date().toISOString(),
          capabilityArtifacts,
        );
        events.push(terminal);
        if (
          terminal.type === 'capability.execution_succeeded' &&
          mcpDescriptor &&
          params.taskConfig &&
          getFeatureFlags(params.taskConfig).verificationV1
        ) {
          events.push(
            verificationRequestForCapability({
              invocationId: invocation.invocationId,
              capabilityId: mcpDescriptor.capabilityId,
              effects: mcpDescriptor.effectiveEffects,
              taskId: call.taskId ?? params.state.activeTaskId ?? undefined,
              externalReferences: terminal.externalReferences,
            }),
          );
        }
      }

      // 文件变更事件 — write_file / edit_file 的结果通知 TUI
      // File change event — notify TUI of write_file / edit_file results
      if (result.ok !== false && (request.name === 'write_file' || request.name === 'edit_file')) {
        const filePath = String(request.args.path ?? '');
        if (filePath) {
          events.push({
            type: 'tool.file_change',
            toolCallId,
            path: filePath,
            kind: request.name === 'edit_file' ? 'edit' : 'add',
            preview: (result.stdout ?? result.stderr ?? '').slice(0, 500) || undefined,
          });
        }
      }

      if (result.processCleanup && !result.processCleanup.confirmedExited) {
        events.push({
          type: 'runtime.cancellation_diagnostic',
          toolCallId,
          failure: classifyFailure(
            'cancel_incomplete',
            'One or more shell descendants could not be confirmed exited after bounded cleanup.',
          ),
          unconfirmedDescendantCount: result.processCleanup.unconfirmedDescendantCount,
        });
      }

      events.push(
        toolFinishedEvent({
          toolCallId,
          name: request.name,
          result,
          command: request.protectedCommand,
        }),
      );
    } catch (error) {
      if (error instanceof DescendantResourceAdmissionError) throw error;
      if (invocation) {
        events.push({
          type: 'capability.execution_failed',
          invocationId: invocation.invocationId,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        });
      }
      const failure = isMcpProviderError(error)
        ? classifyMcpProviderError(error)
        : error instanceof RemoteMcpEgressDeniedError
          ? classifyFailure(
              error.receipt.reason === 'receipt_persistence_failed'
                ? 'persistence_unavailable'
                : 'policy_denied',
              error.message,
            )
          : classifyFailure(
              'tool_runtime_error',
              error instanceof Error ? error.message : String(error),
            );
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure,
      });
      const providerAction = providerActionRequiredEvent({
        enabled: Boolean(
          params.taskConfig && getFeatureFlags(params.taskConfig).mcpProviderActionV1,
        ),
        providerId:
          (isMcpProviderError(error) && error.providerId) ||
          call.capabilityId?.match(/^mcp:([^/]+)\//)?.[1] ||
          request.name.match(/^mcp__([^_]+)__/u)?.[1] ||
          'unknown',
        toolCallId,
        action: isMcpProviderError(error)
          ? error.recoveryAction
          : recoveryActionForFailure(failure),
      });
      if (providerAction) events.push(providerAction);
    }
  }
  return events;
}

function createMcpInvocationRecord(params: {
  state: RuntimeState;
  call: RuntimeState['tools']['calls'][string];
  descriptor: import('@/protocol/capabilities').CapabilityDescriptor | undefined;
  flags: ReturnType<typeof getFeatureFlags> | undefined;
  argumentsValue?: Record<string, unknown>;
}):
  | {
      invocationId: string;
      idempotencyKey?: string;
      idempotencyKeyArgument?: string;
      recorded: Extract<RuntimeEvent, { type: 'capability.invocation_recorded' }>;
    }
  | undefined {
  if (
    !params.flags?.mcpExecutionRecordV1 ||
    !params.call.name.startsWith('mcp__') ||
    !params.descriptor ||
    !requiresDurableInvocation(params.descriptor.effectiveEffects)
  ) {
    return undefined;
  }
  const argumentsValue = params.argumentsValue ?? params.call.args;
  const invocationId = digestCapability({
    threadId: params.state.session.threadId,
    toolCallId: params.call.toolCallId,
    capabilityId: params.descriptor.capabilityId,
    capabilityRevision: params.descriptor.revision,
    arguments: argumentsValue,
  });
  const planning = getActivePlanning(params.state);
  const planId = 'document' in planning ? planning.document?.planId : undefined;
  const authorizationDigest = digestCapability({
    approvalHash: params.call.approvalHash ?? null,
    approvalGrant: params.call.approvalGrant ?? 'none',
    threadId: params.state.session.threadId,
    taskId: params.call.taskId ?? params.state.activeTaskId ?? null,
  });
  const idempotencyKeyArgument = params.descriptor.execution?.idempotencyKeyArgument;
  const idempotencyKey =
    params.descriptor.execution?.retry === 'idempotency_key' && idempotencyKeyArgument
      ? digestCapability({ invocationId, capabilityId: params.descriptor.capabilityId })
      : undefined;
  return {
    invocationId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(idempotencyKeyArgument ? { idempotencyKeyArgument } : {}),
    recorded: {
      type: 'capability.invocation_recorded',
      invocationId,
      toolCallId: params.call.toolCallId,
      capabilityId: params.descriptor.capabilityId,
      capabilityRevision: params.descriptor.revision,
      ...((params.call.taskId ?? params.state.activeTaskId)
        ? { taskId: params.call.taskId ?? params.state.activeTaskId ?? undefined }
        : {}),
      ...(planId ? { planId } : {}),
      argumentsDigest: digestCapability(argumentsValue),
      authorizationDigest,
      effectiveEffectsDigest: digestCapability(params.descriptor.effectiveEffects),
      effectiveEffects: params.descriptor.effectiveEffects,
      recordedAt: new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

function requiresDurableInvocation(
  effects: import('@/protocol/capabilities').EffectProfile,
): boolean {
  return [effects.filesystem, effects.network, effects.externalState].some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}

function invocationTerminalEvent(
  invocationId: string,
  result: ToolExecutionResult,
  finishedAt: string,
  artifactStore: CapabilityArtifactStore,
): Extract<
  RuntimeEvent,
  { type: 'capability.execution_succeeded' | 'capability.execution_failed' }
> {
  if (
    result.ok === false ||
    !result.capabilityResult ||
    result.capabilityResult.status !== 'success'
  ) {
    return {
      type: 'capability.execution_failed',
      invocationId,
      error:
        result.capabilityResult?.error?.message ??
        result.stderr ??
        'MCP provider did not produce a successful capability result.',
      finishedAt,
    };
  }
  const externalReferences = result.capabilityResult.content.flatMap((content) => {
    const uri = typeof content.uri === 'string' ? content.uri : undefined;
    const nestedUri =
      content.resource &&
      typeof content.resource === 'object' &&
      typeof (content.resource as Record<string, unknown>).uri === 'string'
        ? ((content.resource as Record<string, unknown>).uri as string)
        : undefined;
    return [uri, nestedUri].filter((value): value is string => Boolean(value));
  });
  let artifact: import('@/protocol/capabilities').CapabilityArtifactRef | undefined;
  try {
    artifact = artifactStore.write(invocationId, result.capabilityResult);
  } catch {
    // The result remains available in the current turn, but a receipt never
    // claims evidence that failed to reach the restricted Artifact Store.
  }
  return {
    type: 'capability.execution_succeeded',
    invocationId,
    resultDigest: digestCapability(result.capabilityResult),
    evidenceDigest: digestCapability({
      content: result.capabilityResult.content,
      structuredContent: result.capabilityResult.structuredContent,
    }),
    finishedAt,
    ...(artifact ? { artifact } : {}),
    ...(externalReferences.length > 0 ? { externalReferences } : {}),
  };
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
