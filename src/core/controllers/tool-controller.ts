import { createHash } from 'node:crypto';
import { createBinding, digestCapability } from '@/core/capabilities/catalog';
import { validateCapabilityArguments } from '@/core/capabilities/schema';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import { buildToolApproval } from '@/core/harness/tool-policy';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import { runApprovedTool } from '@/core/harness/tool-runner';
import {
  capabilityChangedProviderError,
  exposedMcpToolName,
  isMcpProviderError,
  type McpProviderRecoveryAction,
  type McpRuntimeProvider,
  providerErrorFromDirectoryEntry,
} from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
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
import { classifyFailure, classifyMcpProviderError } from '@/core/runtime/failures';
import type { FilePreimageRecorder } from '@/core/runtime/file-checkpoints';
import { genInteractionId } from '@/core/runtime/ids';
import type { RuntimeState } from '@/core/runtime/state';
import {
  getActivePlanning,
  getAgentPhase,
  getEffectiveInteractionMode,
} from '@/core/runtime/state';
import type { SkillCatalogSnapshot } from '@/core/skills';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import {
  deserializeSubagentContinuation,
  serializeSubagentContinuation,
} from '@/core/subagent/continuation-codec';
import { resumeSubAgent } from '@/core/subagent/runner';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import type { RestoredSubAgentContinuation, SubAgentEventSink } from '@/core/subagent/types';
import { toolAvailabilityContext } from '@/core/tools/definitions';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import { askUserSpec } from '@/core/tools/registry/builtins/ask-user';
import { readPlanSpec } from '@/core/tools/registry/builtins/read-plan';
import {
  activateSkillSpec,
  completeSkillSpec,
  readSkillReferenceSpec,
} from '@/core/tools/registry/builtins/skill-runtime';
import { taskSpec } from '@/core/tools/registry/builtins/task';
import { toolSearchSpec } from '@/core/tools/registry/builtins/tool-search';
import { updatePlanSpec } from '@/core/tools/registry/builtins/update-plan';
import { writePlanSpec } from '@/core/tools/registry/builtins/write-plan';
import { dispatchRegisteredTool } from '@/core/tools/registry/dispatch';
import type { ProjectedToolResult } from '@/core/tools/registry/spec';
import type { ShellExecutor } from '@/core/tools/shell';
import { verificationRequestForCapability } from '@/core/verification';
import type { InteractionMode } from '@/protocol/events';

type SubagentEvent = Parameters<SubAgentEventSink>[0];

function appendProjectedRuntimeEvents(
  events: RuntimeEvent[],
  projected: ProjectedToolResult,
): void {
  events.push(...(projected.runtimeEvents ?? []));
}

function registeredToolFinishedEvent(input: {
  toolCallId: string;
  name: string;
  projected: ProjectedToolResult;
  command: string;
  includeStatus?: boolean;
}): RuntimeEvent {
  const { projected } = input;
  return {
    type: 'tool.finished',
    toolCallId: input.toolCallId,
    name: input.name,
    result: {
      ok: projected.ok,
      command: input.command,
      exitCode: projected.ok ? 0 : -1,
      stdout: projected.ok ? projected.modelContent : '',
      stderr: projected.ok ? '' : projected.modelContent,
      resultMeta: projected.resultMeta,
      ...(input.includeStatus
        ? {
            status: projected.ok ? ('success' as const) : ('error' as const),
          }
        : {}),
    },
  };
}

// ── PR 8: Tool result digest production ──

function computeToolResultDigest(input: {
  stdout: string;
  stderr: string;
  exitCode: number;
  status?: string;
  rawResultDigest?: string;
  truncated?: boolean;
}): {
  contentDigest: string;
  rawResultDigest?: string;
  modelContentDigest: string;
  digestScope: 'raw' | 'projected';
} {
  const modelContentDigest = createHash('sha256')
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
    input.rawResultDigest ?? (input.truncated ? undefined : modelContentDigest);
  const digestScope = input.truncated ? ('projected' as const) : ('raw' as const);
  return {
    contentDigest: modelContentDigest,
    ...(rawResultDigest ? { rawResultDigest } : {}),
    modelContentDigest,
    digestScope,
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

/** Resolve a sub-agent continuation that was rejected (user denied the approval).
 *  Emits subagent.failed + tool.finished so the TUI transitions the sub-agent block
 *  from awaiting_approval to error, and the task tool produces a result for the model.
 *  Called by the runner after approval.rejected is processed. */
export function resolveRejectedSubagentContinuation(
  state: RuntimeState,
  toolCallId: string,
): RuntimeEvent[] {
  const snapshot = state.suspendedSubagents[toolCallId];
  if (!snapshot) return [];
  const continuation = deserializeSubagentContinuation(snapshot);

  const blockedToolName = continuation.blockedTool.toolName;
  const subagentId = continuation.id;
  const rejectionMsg = `Sub-agent tool "${blockedToolName}" was rejected by user.`;

  return [
    {
      type: 'subagent.failed',
      subagent: {
        id: subagentId,
        error: rejectionMsg,
        summary: rejectionMsg,
        toolCallCount: continuation.toolCallCount,
        durationMs: 0,
      },
    } as RuntimeEvent,
    {
      type: 'tool.finished',
      toolCallId,
      name: 'task',
      result: {
        ok: false,
        command: '',
        exitCode: -1,
        stdout: '',
        stderr: rejectionMsg,
        status: 'error',
      },
    },
  ];
}

/** Convert the subagent runner's private callback payload into a durable public fact. */
export function toRuntimeSubagentEvent(event: SubagentEvent): RuntimeEvent {
  switch (event.type) {
    case 'start':
      return { type: 'subagent.started', subagent: event.data };
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

/**
 * Resume a sub-agent after approval: execute the blocked tool with the
 * approved grant, then continue the sub-agent loop from the saved state.
 * Returns all RuntimeEvents produced by the resumed sub-agent execution.
 */
async function handleSubAgentResume(params: {
  state: RuntimeState;
  toolCallId: string;
  continuation: RestoredSubAgentContinuation;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  emitSubagentEvent: SubAgentEventSink;
  recordFilePreimage?: FilePreimageRecorder;
}): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const { continuation } = params;
  const { toolName: blockedToolName, args: blockedToolArgs } = continuation.blockedTool;

  // Execute the previously-blocked tool with the approval grant
  const call = params.state.tools.calls[params.toolCallId];
  const availCtx = toolAvailabilityContext({
    workspace: params.state.session.workspace,
    threadId: params.state.session.threadId,
    config: params.taskConfig,
    subagentEventSink: params.emitSubagentEvent,
    toolSearch: params.taskConfig ? getFeatureFlags(params.taskConfig).toolSearchV1 : false,
    skillCatalog: params.skillCatalog,
    activeSkillFrames: Object.values(params.state.skills.frames).filter(
      (frame) => frame.status === 'active' && frame.contextMode === 'inline',
    ),
    phase: getAgentPhase(getActivePlanning(params.state)),
  });
  const blockedRequest = toolRequestFromCall(
    {
      id: params.toolCallId,
      name: blockedToolName,
      args: blockedToolArgs,
    },
    availCtx,
  );

  let toolResult: ToolExecutionResult;
  if (blockedRequest) {
    const resumedBinding = call?.bindingId
      ? params.state.capabilities.bindings[call.bindingId]
      : undefined;
    toolResult = await runApprovedTool({
      workspace: params.state.session.workspace,
      request: blockedRequest,
      shellExecutor: params.shellExecutor,
      workspaceAccess: params.state.workspaceAccess,
      phase: getAgentPhase(getActivePlanning(params.state)),
      authorization: params.state.authorization,
      approvedGrant: call?.approvalGrant ?? 'none',
      threadId: params.state.session.threadId,
      recordFilePreimage: params.recordFilePreimage,
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
      taskConfig: params.taskConfig,
      taskModel: params.taskModel,
      subagentEventSink: params.emitSubagentEvent,
      availabilityContext: availCtx,
    });
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
      workspace: params.state.session.workspace,
      role: continuation.role,
      task: continuation.task,
      shellExecutor: params.shellExecutor,
      mcpManager: params.mcpManager,
      skills: params.skillManifests,
      skillOptions: params.skillOptions,
      authorization: params.state.authorization,
      workspaceAccess: params.state.workspaceAccess,
      phase: getAgentPhase(getActivePlanning(params.state)),
      threadId: params.state.session.threadId,
      timeoutMs: 30 * 60 * 1000,
      signal: params.signal ?? new AbortController().signal,
      eventSink: params.emitSubagentEvent,
      model: params.taskModel,
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
    const subagentId = blocked.continuation.id;
    events.push({
      type: 'subagent.suspended',
      toolCallId: params.toolCallId,
      snapshot: serializeSubagentContinuation(blocked.continuation, {
        toolCallId: blocked.toolCallId,
        toolName: blocked.toolName,
        args: blocked.args,
        command: blocked.command,
      }),
    });
    const blockedDecision = evaluateToolApproval({
      toolName: blocked.toolName,
      toolArgs: blocked.args,
      phase: getAgentPhase(getActivePlanning(params.state)),
      workspace: params.state.session.workspace,
      threadId: params.state.session.threadId,
      authorization: params.state.authorization,
      capability: builtinToolRegistry.effectsOf(blocked.toolName, blocked.args, availCtx),
    });
    const blockedApproval = buildToolApproval({
      workspace: params.state.session.workspace,
      threadId: params.state.session.threadId,
      request: {
        id: blocked.toolCallId,
        name: blocked.toolName,
        args: blocked.args,
        protectedCommand: blocked.command,
      } as import('@/core/harness/tool-requests').PendingToolRequest,
      decision: blockedDecision,
    }) as import('@/protocol/events').ToolApprovalPayload;
    blockedApproval.subagentId = subagentId;
    events.push({
      type: 'approval.requested',
      interactionId: genInteractionId(),
      toolCallId: params.toolCallId,
      approval: blockedApproval,
    });
    return events;
  }

  // Emit tool.finished for the task tool — the sub-agent has produced its final
  // result.  The payload is taskSpec's projection, the same source the runner's
  // task branch consumes (ADR-0043 §1); the controller no longer hand-builds
  // a second task result format.
  const projected = taskSpec.projectResult(
    { available: true, result },
    {
      workspace: params.state.session.workspace,
      invocationInput: {
        subagent_type: forkRole(continuation.role.role),
        task: continuation.task,
      },
    },
  );
  events.push(
    registeredToolFinishedEvent({
      toolCallId: params.toolCallId,
      name: 'task',
      projected,
      command: 'task',
      includeStatus: true,
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
  mcpManager?: McpRuntimeProvider;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  subagentEventSink?: SubAgentEventSink;
  planArtifactStore?: PlanArtifactStore;
  capabilityArtifactStore?: CapabilityArtifactStore;
  /** Runtime sink used to publish tool lifecycle/progress events while execution is running. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  /** 写入前文件原像记录器，透传给工具执行链（ADR-0025 §4）。 */
  recordFilePreimage?: FilePreimageRecorder;
}): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  // Keep the direct-call API unchanged for tests and legacy callers.  The
  // Runtime runner replaces push with a streaming sink, so events are applied
  // and rendered as soon as they are produced instead of after the tool exits.
  if (params.emitRuntimeEvent) {
    const append = events.push.bind(events);
    events.push = (...items: RuntimeEvent[]) => {
      for (const item of items) params.emitRuntimeEvent?.(item);
      return append();
    };
  }
  const planArtifacts = params.planArtifactStore ?? defaultPlanArtifactStore;
  const capabilityArtifacts = params.capabilityArtifactStore ?? defaultCapabilityArtifactStore;
  const emitSubagentEvent: SubAgentEventSink = (event) => {
    events.push(toRuntimeSubagentEvent(event));
    params.subagentEventSink?.(event);
  };
  const availCtx = toolAvailabilityContext({
    workspace: params.state.session.workspace,
    threadId: params.state.session.threadId,
    config: params.taskConfig,
    subagentEventSink: params.subagentEventSink,
    toolSearch: params.taskConfig ? getFeatureFlags(params.taskConfig).toolSearchV1 : false,
    skillCatalog: params.skillCatalog,
    activeSkillFrames: Object.values(params.state.skills.frames).filter(
      (frame) => frame.status === 'active' && frame.contextMode === 'inline',
    ),
    phase: getAgentPhase(getActivePlanning(params.state)),
  });
  for (const toolCallId of params.toolCallIds) {
    const call = params.state.tools.calls[toolCallId];
    if (!call || (call.status !== 'queued' && call.status !== 'approved')) continue;
    const request = toolRequestFromCall(
      { id: call.toolCallId, name: call.name, args: (call.args ?? {}) as Record<string, unknown> },
      availCtx,
    );
    if (!request) {
      if (builtinToolRegistry.get(call.name)) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure('tool_invalid_args', `Invalid arguments for '${call.name}'.`),
        });
        continue;
      }
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure('tool_not_found', `Unsupported tool '${call.name}'.`),
      });
      continue;
    }
    const ceilingViolation = skillCapabilityCeilingViolation(params.state, call, request);
    if (ceilingViolation) {
      events.push({ type: 'tool.rejected', toolCallId, reason: ceilingViolation });
      continue;
    }
    if (request.name.startsWith('mcp__')) {
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
                        request.args as Record<string, unknown>,
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
    if (request.name === 'tool_search') {
      const flags = params.taskConfig ? getFeatureFlags(params.taskConfig) : getFeatureFlags();
      const dispatched = await dispatchRegisteredTool(toolSearchSpec, request.args, {
        workspace: params.state.session.workspace,
        threadId: params.state.session.threadId,
        signal: params.signal,
        toolSearch: {
          enabled: flags.toolSearchV1,
          mcpManager: params.mcpManager,
          skillCatalog: params.skillCatalog,
          turnId: params.state.turn.turnId,
          toolCallId,
        },
      });
      if (!dispatched.dispatched) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure('tool_invalid_args', dispatched.rejection.error),
        });
        continue;
      }
      if (!dispatched.output.ok) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: dispatched.output.stderr,
        });
        continue;
      }
      appendProjectedRuntimeEvents(events, dispatched.projected);
      events.push(
        registeredToolFinishedEvent({
          toolCallId,
          name: request.name,
          projected: dispatched.projected,
          command: request.name,
        }),
      );
      continue;
    }
    if (request.name === 'activate_skill') {
      const flags = params.taskConfig ? getFeatureFlags(params.taskConfig) : getFeatureFlags();
      const descriptor = params.skillCatalog?.capabilities.descriptors.find(
        (candidate) =>
          candidate.capabilityId === ((request.args as Record<string, unknown>).skill_id as string),
      );
      const disclosure =
        params.state.capabilities.disclosures[
          (request.args as Record<string, unknown>).skill_id as string
        ];
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
          toolArgs: request.args as Record<string, unknown>,
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
          }) as import('@/protocol/events').ToolApprovalPayload;
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
      const runFork =
        params.taskConfig && params.taskModel
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
                  threadId: params.state.session.threadId,
                  eventSink: emitSubagentEvent,
                  signal: params.signal,
                  model: params.taskModel,
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
      const dispatched = await dispatchRegisteredTool(activateSkillSpec, request.args, {
        workspace: params.state.session.workspace,
        threadId: params.state.session.threadId,
        toolCallId,
        signal: params.signal,
        skillRuntime: {
          state: params.state,
          catalog: params.skillCatalog,
          flags,
          verificationEnabled: Boolean(params.taskConfig) && flags.verificationV1,
          runFork,
        },
      });
      if (!dispatched.dispatched) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: dispatched.rejection.error,
        });
        continue;
      }
      appendProjectedRuntimeEvents(events, dispatched.projected);
      if (!dispatched.output.ok && !dispatched.output.stdout) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: dispatched.output.stderr,
        });
        continue;
      }
      events.push(
        registeredToolFinishedEvent({
          toolCallId,
          name: request.name,
          projected: dispatched.projected,
          command: request.name,
          includeStatus: true,
        }),
      );
      continue;
    }
    if (request.name === 'read_skill_reference') {
      const dispatched = await dispatchRegisteredTool(readSkillReferenceSpec, request.args, {
        workspace: params.state.session.workspace,
        threadId: params.state.session.threadId,
        signal: params.signal,
        skillRuntime: {
          state: params.state,
          catalog: params.skillCatalog,
          verificationEnabled: false,
        },
      });
      if (!dispatched.dispatched || !dispatched.output.ok) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: dispatched.dispatched ? dispatched.output.stderr : dispatched.rejection.error,
        });
        continue;
      }
      events.push(
        registeredToolFinishedEvent({
          toolCallId,
          name: request.name,
          projected: dispatched.projected,
          command: request.name,
        }),
      );
      continue;
    }
    if (request.name === 'complete_skill') {
      const dispatched = await dispatchRegisteredTool(completeSkillSpec, request.args, {
        workspace: params.state.session.workspace,
        threadId: params.state.session.threadId,
        signal: params.signal,
        skillRuntime: {
          state: params.state,
          catalog: params.skillCatalog,
          verificationEnabled:
            Boolean(params.taskConfig) && getFeatureFlags(params.taskConfig!).verificationV1,
        },
      });
      if (!dispatched.dispatched || !dispatched.output.ok) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: dispatched.dispatched ? dispatched.output.stderr : dispatched.rejection.error,
        });
        continue;
      }
      appendProjectedRuntimeEvents(events, dispatched.projected);
      events.push(
        registeredToolFinishedEvent({
          toolCallId,
          name: request.name,
          projected: dispatched.projected,
          command: request.name,
        }),
      );
      continue;
    }
    if (request.name === 'ask_user') {
      const hasQuestion =
        (((request.args as Record<string, unknown>).question as string) ?? '').trim().length > 0;
      const hasBatchQuestions =
        (((request.args as Record<string, unknown>).questions as Array<unknown> | undefined)
          ?.length ?? 0) > 0;
      if (!hasQuestion && !hasBatchQuestions) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'tool_invalid_args',
            'ask_user requires a non-empty question or questions array.',
          ),
        });
        continue;
      }
      // 中断契约在 spec 闭环：事件载荷经 askUserSpec.createInterrupt 生成
      // （Schema 规范化结果），Controller 不再手工组装中断内容。
      // The interrupt contract closes in the spec: the event payload is built
      // by askUserSpec.createInterrupt; the controller does not hand-assemble
      // interrupt content.
      events.push({
        type: 'user_input.requested',
        interactionId: genInteractionId(),
        toolCallId,
        request: askUserSpec.createInterrupt(
          request.args as import('@/protocol/events').UserInputRequest,
          {
            workspace: params.state.session.workspace,
            threadId: params.state.session.threadId,
            phase: getAgentPhase(getActivePlanning(params.state)),
          },
        ),
      });
      continue;
    }

    if (request.name === 'read_plan') {
      const dispatched = await dispatchRegisteredTool(readPlanSpec, request.args, {
        workspace: params.state.session.workspace,
        threadId: params.state.session.threadId,
        signal: params.signal,
        planRuntime: { state: params.state, artifacts: planArtifacts },
      });
      if (!dispatched.dispatched || !dispatched.output.ok) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: dispatched.dispatched ? dispatched.output.stderr : dispatched.rejection.error,
        });
        continue;
      }
      events.push(
        registeredToolFinishedEvent({
          toolCallId,
          name: request.name,
          projected: dispatched.projected,
          command: '',
        }),
      );
      continue;
    }

    // ── Plan tools ──

    if (request.name === 'write_plan') {
      const dispatched = await dispatchRegisteredTool(writePlanSpec, request.args, {
        workspace: params.state.session.workspace,
        threadId: params.state.session.threadId,
        toolCallId,
        signal: params.signal,
        planRuntime: {
          state: params.state,
          artifacts: planArtifacts,
          modelMessageId: call.modelMessageId,
          ordinal: call.ordinal,
        },
      });
      if (!dispatched.dispatched || !dispatched.output.ok) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: dispatched.dispatched ? dispatched.output.stderr : dispatched.rejection.error,
        });
        continue;
      }
      appendProjectedRuntimeEvents(events, dispatched.projected);
      if (dispatched.output.stdout) {
        events.push(
          registeredToolFinishedEvent({
            toolCallId,
            name: request.name,
            projected: dispatched.projected,
            command: '',
          }),
        );
      }
      continue;
    }

    if (request.name === 'update_plan') {
      const dispatched = await dispatchRegisteredTool(updatePlanSpec, request.args, {
        workspace: params.state.session.workspace,
        threadId: params.state.session.threadId,
        toolCallId,
        signal: params.signal,
        planRuntime: { state: params.state, artifacts: planArtifacts },
      });
      if (!dispatched.dispatched || !dispatched.output.ok) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: dispatched.dispatched ? dispatched.output.stderr : dispatched.rejection.error,
        });
        continue;
      }
      appendProjectedRuntimeEvents(events, dispatched.projected);
      events.push(
        registeredToolFinishedEvent({
          toolCallId,
          name: request.name,
          projected: dispatched.projected,
          command: '',
        }),
      );
      continue;
    }

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
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason: decision.userVisibleSummary,
        failure: classifyFailure('policy_denied', decision.userVisibleSummary),
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
        }) as import('@/protocol/events').ToolApprovalPayload;
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
        }) as unknown as import('@/protocol/events').ToolApprovalPayload;
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
        }) as unknown as import('@/protocol/events').ToolApprovalPayload;
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
        const restored = deserializeSubagentContinuation(suspended);
        const resumeEvents = await handleSubAgentResume({
          state: params.state,
          toolCallId,
          continuation: restored,
          shellExecutor: params.shellExecutor,
          mcpManager: params.mcpManager,
          skillManifests: params.skillManifests,
          skillOptions: params.skillOptions,
          signal: params.signal,
          taskConfig: params.taskConfig,
          taskModel: params.taskModel,
          emitSubagentEvent,
          recordFilePreimage: params.recordFilePreimage,
        });
        events.push(...resumeEvents);
        continue;
      }

      // ── Normal sub-agent execution ──
      events.push({ type: 'tool.started', toolCallId });
      const progress: RuntimeEvent[] = [];
      try {
        const result = await runApprovedTool({
          workspace: params.state.session.workspace,
          request,
          shellExecutor: params.shellExecutor,
          workspaceAccess: params.state.workspaceAccess,
          phase: getAgentPhase(getActivePlanning(params.state)),
          authorization: params.state.authorization,
          approvedGrant: call.approvalGrant ?? 'none',
          threadId: params.state.session.threadId,
          recordFilePreimage: params.recordFilePreimage,
          mcpManager: params.mcpManager,
          skillManifests: params.skillManifests,
          skillOptions: params.skillOptions,
          signal: params.signal,
          interactionMode: getEffectiveInteractionMode(params.state),
          taskConfig: params.taskConfig,
          taskModel: params.taskModel,
          subagentEventSink: emitSubagentEvent,
          availabilityContext: availCtx,
          onShellProgress: (chunk, stream) =>
            progress.push({ type: 'tool.progress', toolCallId, chunk, stream }),
        });
        events.push(...progress);

        // ── Sub-agent blocked for approval → surface through Runtime Kernel ──
        if (result.subagentResult?.blocked) {
          const blocked = result.subagentResult.blocked;
          const subagentId = blocked.continuation.id;
          // Serialize continuation into RuntimeState for persistence
          events.push({
            type: 'subagent.suspended',
            toolCallId,
            snapshot: serializeSubagentContinuation(blocked.continuation, {
              toolCallId: blocked.toolCallId,
              toolName: blocked.toolName,
              args: blocked.args,
              command: blocked.command,
            }),
          });

          // Build approval payload for the blocked sub-agent tool
          const blockedDecision = evaluateToolApproval({
            toolName: blocked.toolName,
            toolArgs: blocked.args,
            phase: getAgentPhase(getActivePlanning(params.state)),
            workspace: params.state.session.workspace,
            threadId: params.state.session.threadId,
            authorization: params.state.authorization,
            capability: builtinToolRegistry.effectsOf(blocked.toolName, blocked.args, availCtx),
          });
          const blockedApproval = buildToolApproval({
            workspace: params.state.session.workspace,
            threadId: params.state.session.threadId,
            request: {
              id: blocked.toolCallId,
              name: blocked.toolName,
              args: blocked.args,
              protectedCommand: blocked.command,
            } as import('@/core/harness/tool-requests').PendingToolRequest,
            decision: blockedDecision,
          }) as import('@/protocol/events').ToolApprovalPayload;
          blockedApproval.subagentId = subagentId;

          events.push({
            type: 'approval.requested',
            interactionId: genInteractionId(),
            toolCallId,
            approval: blockedApproval,
          });
          // Do NOT emit tool.finished — the task tool is paused, waiting for approval
          continue;
        }

        events.push({
          type: 'tool.finished',
          toolCallId,
          name: request.name,
          result: {
            ok: result.ok !== false,
            command: result.command ?? request.protectedCommand,
            exitCode: result.exitCode ?? 0,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            resultMeta: {
              ...result.resultMeta,
              ...(result.path ? { path: result.path } : {}),
              ...(result.totalLines != null ? { totalLines: result.totalLines } : {}),
              ...(result.action?.intent ? { intent: result.action.intent } : {}),
              ...computeToolResultDigest({
                stdout: result.stdout ?? '',
                stderr: result.stderr ?? '',
                exitCode: result.exitCode ?? 0,
                status: result.status,
                rawResultDigest: result.resultMeta?.rawResultDigest,
                truncated: result.resultMeta?.truncated,
              }),
            },
            status:
              result.status === 'exhausted'
                ? 'exhausted'
                : result.ok === false
                  ? 'error'
                  : 'success',
          },
        });
      } catch (error) {
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

    const invocation = createMcpInvocationRecord({
      state: params.state,
      call,
      descriptor: mcpDescriptor,
      flags: params.taskConfig ? getFeatureFlags(params.taskConfig) : undefined,
    });
    const executionRequest =
      invocation?.idempotencyKeyArgument && invocation.idempotencyKey
        ? ({
            ...request,
            args: {
              ...(request.args as Record<string, unknown>),
              [invocation.idempotencyKeyArgument]: invocation.idempotencyKey,
            },
          } as typeof request)
        : request;
    if (invocation) events.push(invocation.recorded);
    events.push({ type: 'tool.started', toolCallId });
    if (invocation) {
      events.push({
        type: 'capability.execution_started',
        invocationId: invocation.invocationId,
        startedAt: new Date().toISOString(),
      });
    }
    const progress: RuntimeEvent[] = [];
    try {
      if (request.name === 'read_mcp_resource') {
        await params.mcpManager?.ensureProviderReady?.(
          (request.args as Record<string, unknown>).server as string,
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
      const maximumAttempts =
        mcpDescriptor?.execution?.retry === 'safe_read' ||
        (mcpDescriptor?.execution?.retry === 'idempotency_key' &&
          typeof mcpDescriptor.execution.idempotencyKeyArgument === 'string' &&
          typeof (executionRequest.args as Record<string, unknown>)[
            mcpDescriptor.execution.idempotencyKeyArgument
          ] === 'string')
          ? 2
          : 1;
      let result: ToolExecutionResult | undefined;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        try {
          result = await runApprovedTool({
            workspace: params.state.session.workspace,
            request: executionRequest,
            shellExecutor: params.shellExecutor,
            workspaceAccess: params.state.workspaceAccess,
            phase: getAgentPhase(getActivePlanning(params.state)),
            authorization: params.state.authorization,
            approvedGrant: call.approvalGrant ?? 'none',
            threadId: params.state.session.threadId,
            recordFilePreimage: params.recordFilePreimage,
            mcpManager: params.mcpManager,
            ...(mcpDescriptor
              ? {
                  mcpInvocation: {
                    capabilityId: mcpDescriptor.capabilityId,
                    expectedRevision: mcpDescriptor.revision,
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
            onShellProgress: (chunk, stream) =>
              progress.push({ type: 'tool.progress', toolCallId, chunk, stream }),
          });
          break;
        } catch (error) {
          if (attempt + 1 >= maximumAttempts || !isMcpProviderError(error) || !error.retryable) {
            throw error;
          }
        }
      }
      if (!result) throw new Error('MCP execution completed without a result.');
      events.push(...progress);

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
        const filePath = String((request.args as Record<string, unknown>).path ?? '');
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

      events.push({
        type: 'tool.finished',
        toolCallId,
        name: request.name,
        result: {
          ok: result.ok !== false,
          command: result.command ?? request.protectedCommand,
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          resultMeta: {
            ...result.resultMeta,
            ...(result.path ? { path: result.path } : {}),
            ...(result.totalLines != null ? { totalLines: result.totalLines } : {}),
            ...(result.action?.intent ? { intent: result.action.intent } : {}),
            ...computeToolResultDigest({
              stdout: result.stdout ?? '',
              stderr: result.stderr ?? '',
              exitCode: result.exitCode ?? 0,
              status: result.status,
              rawResultDigest: result.resultMeta?.rawResultDigest,
              truncated: result.resultMeta?.truncated,
            }),
          },
          status:
            result.status === 'exhausted' ? 'exhausted' : result.ok === false ? 'error' : 'success',
        },
      });
    } catch (error) {
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
  const invocationId = digestCapability({
    threadId: params.state.session.threadId,
    toolCallId: params.call.toolCallId,
    capabilityId: params.descriptor.capabilityId,
    capabilityRevision: params.descriptor.revision,
    arguments: params.call.args,
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
      argumentsDigest: digestCapability(params.call.args),
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
