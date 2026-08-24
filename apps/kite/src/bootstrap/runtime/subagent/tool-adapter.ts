import { isAbsolute, relative, resolve } from 'node:path';
import type {
  BuiltinModelToolCatalogEntry,
  BuiltinModelToolSet,
  BuiltinToolCatalogProjection,
} from '@kite/builtin-runtime';
import {
  createBuiltinCapabilityTurnContext,
  toolExecutionModelContent,
  toolRequestFromCall,
} from '@kite/builtin-runtime';
import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import type { BaseMessage } from '@kite/builtin-runtime/model';
import { countTokens, toolMessage } from '@kite/builtin-runtime/model';
import { msys2ToWindowsPath } from '@kite/builtin-runtime/sandbox';
import {
  canonicalizeCapabilityArguments,
  validateCapabilityArguments,
} from '@kite/builtin-runtime/skills';
import {
  BuiltinSubagentModelLoopError,
  createBuiltinSubagentModelContext,
  createBuiltinSubagentModelLoopEngine,
  createBuiltinSubagentToolSurface,
  getRoleConfig,
  rejectShellOutsideSubAgentRoleCeiling,
} from '@kite/builtin-runtime/subagent';
import {
  bestEffortRegularFileSize,
  type StateRuntimeEvent as RuntimeEvent,
} from '@kite/runtime-host';
import type { RuntimeState } from '@kite/runtime-host/kernel-adapter';
import {
  runtimeHostStateAdmitRecoveryAttempt as admitRecoveryAttempt,
  runtimeHostStateAdvanceToolRecoveryResponse as advanceToolRecoveryResponse,
  runtimeHostStateClassifyFailure as classifyFailure,
  runtimeHostStateClassifyToolOutcome as classifyToolOutcome,
  committedResourceUsage,
  runtimeHostStateCreateToolRecoveryJournal as createToolRecoveryJournal,
  DescendantResourceAdmissionError,
  runtimeHostStateFailureKindForToolParseFailure as failureKindForToolParseFailure,
  runtimeHostStateRecordRecoveryFailure as recordRecoveryFailure,
  runtimeHostStateRecordRecoveryInvocation as recordRecoveryInvocation,
  runtimeHostStateRecordToolOwnedProgress as recordToolOwnedProgress,
  type StateToolOutcome as ToolOutcome,
  runtimeHostStateToolInvocationFingerprint as toolInvocationFingerprint,
} from '@kite/runtime-host/kernel-adapter';
import type { PersistedExecutionJournalEntry } from '@kite/runtime-spi';
import { getFeatureFlags } from '#app/config/features';
import type { AppApprovalBinding } from '../approval-binding';
import type { ToolExecutionResult } from '../tool-result';
import type {
  SubAgentContinuation,
  SubAgentResult,
  SubAgentRoleConfig,
  SubAgentRunnerInput,
  SubAgentStepSnapshot,
} from './types';

/** State 25 adapter around the Builtin-owned child model loop. */
export type { SubAgentRunnerInput } from './types';

function requireBuiltinToolCatalog(input: SubAgentRunnerInput): BuiltinToolCatalogProjection {
  if (!input.builtinToolCatalog) {
    throw new Error('Sub-agent Builtin tool catalog projection is unavailable.');
  }
  return input.builtinToolCatalog;
}

function createSubagentToolTurnContext(input: {
  workspace: string;
  config: SubAgentRunnerInput['config'];
  gitBroker?: SubAgentRunnerInput['gitBroker'];
  eventSink?: SubAgentRunnerInput['eventSink'];
  toolSearchEnabled?: boolean;
  skillCatalog?: import('@kite/builtin-runtime/skills').SkillCatalogSnapshot;
  activeSkillFrames?: readonly { activationId: string }[];
  phase?: import('@kite/runtime-contract').AgentPhase;
  interactionMode?: import('@kite/runtime-contract').InteractionMode;
  threadId?: string;
  turnId?: string;
  taskId?: string;
}) {
  const featureFlags = getFeatureFlags(input.config);
  const context = createBuiltinCapabilityTurnContext({
    workspace: input.workspace,
    threadId: input.threadId,
    turnId: input.turnId,
    taskId: input.taskId,
    phase: input.phase,
    featureFlags,
    brokeredGitFeatureRevision:
      input.config.executionCapabilitySurface?.brokeredGitFeatureRevision ?? null,
    hasTaskAdapter: Boolean(input.eventSink),
    hasGitBroker: Boolean(input.gitBroker),
    toolSearchEnabled: input.toolSearchEnabled,
    activeSkillFrames: input.activeSkillFrames,
    skillCatalog: input.skillCatalog,
  });
  return Object.freeze({
    ...context,
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
  });
}

function isBuiltinShellEntry(entry: BuiltinModelToolCatalogEntry | undefined): boolean {
  return entry?.executionMechanism === 'shell';
}

function isBuiltinFilesystemMutationEntry(
  entry: BuiltinModelToolCatalogEntry | undefined,
): boolean {
  return (
    entry?.executionMechanism === 'filesystem' &&
    (entry.effects.filesystem === 'write' || entry.effects.filesystem === 'destructive')
  );
}

function isReadOnlyCapability(entry: BuiltinModelToolCatalogEntry | undefined): boolean {
  if (entry?.effects.externalState !== 'none') return false;
  if (entry.executionMechanism === 'filesystem') {
    return entry.effects.filesystem === 'read';
  }
  if (entry.executionMechanism === 'mcp') {
    return entry.effects.network === 'read';
  }
  if (entry.executionMechanism === 'skill' || entry.executionMechanism === 'planning') {
    return entry.effects.filesystem === 'read';
  }
  return false;
}

let _subAgentCounter = 0;
function nextSubAgentId(): string {
  return `sub-${Date.now().toString(36)}-${_subAgentCounter++}`;
}

function normalizeSubAgentToolArgs(
  entry: BuiltinModelToolCatalogEntry | undefined,
  args: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> {
  if (
    entry?.executionMechanism !== 'filesystem' ||
    !(
      entry.operationId === 'builtin:read_file' ||
      entry.operationId === 'builtin:edit_file' ||
      entry.operationId === 'builtin:write_file'
    ) ||
    typeof args.path !== 'string'
  ) {
    return args;
  }

  const rawPath = msys2ToWindowsPath(args.path);
  if (!isAbsolute(rawPath)) return args;

  const workspaceRoot = resolve(workspace);
  const rel = relative(workspaceRoot, rawPath);
  if (rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))) {
    return { ...args, path: rel || '.' };
  }
  return args;
}

function mcpBindingError(input: {
  toolName: string;
  args: Record<string, unknown>;
  mcpManager?: SubAgentRunnerInput['mcpManager'];
  bindings: Map<string, NonNullable<SubAgentRunnerInput['mcpBindings']>[number]>;
}): string | null {
  const entry = input.bindings.get(input.toolName);
  if (!entry) return 'MCP tool call has no Runtime-issued binding for this sub-agent.';
  const { binding } = entry;
  const descriptor = input.mcpManager?.findCapability(binding.capabilityId);
  if (
    binding.exposedToolName !== input.toolName ||
    !descriptor ||
    descriptor.revision !== binding.capabilityRevision
  ) {
    return 'MCP capability changed after its binding was issued; request a new Runtime turn.';
  }
  if (
    descriptor.kind !== 'mcp_tool' ||
    descriptor.availability !== 'available' ||
    !descriptor.inputSchema ||
    binding.schemaDigest !== digestCapabilityValue(descriptor.inputSchema)
  ) {
    return 'MCP capability is unavailable for execution.';
  }
  return validateCapabilityArguments(descriptor.inputSchema, input.args);
}

function approvalRequiredBlock(
  result: {
    command?: string;
    status?: string;
    stderr?: string;
    approvalRoute?: 'user' | 'auto_review';
    approvalBinding?: AppApprovalBinding;
  },
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  continuation: SubAgentContinuation,
): NonNullable<SubAgentResult['blocked']> | null {
  if (
    result.status !== 'rejected' ||
    !result.stderr?.includes('requires approval but was not approved')
  ) {
    return null;
  }
  const command = result.command ?? toolName;
  const requiresAutoReview = result.approvalRoute === 'auto_review';
  return {
    reasonCode: requiresAutoReview
      ? ('SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW' as const)
      : ('SUBAGENT_TOOL_REQUIRES_APPROVAL' as const),
    toolCallId,
    toolName,
    command,
    args,
    message: requiresAutoReview
      ? `Sub-agent blocked: ${toolName} requires automatic review before execution.`
      : `Sub-agent blocked: ${toolName} requires main-agent approval before execution.`,
    ...(result.approvalBinding ? { approvalBinding: result.approvalBinding } : {}),
    continuation,
  };
}

function effectiveInteractionMode(
  input: SubAgentRunnerInput,
): import('@kite/runtime-contract').InteractionMode {
  return input.interactionMode ?? 'accept_edits';
}

function normalizeRoleConfig(role: SubAgentRoleConfig): SubAgentRoleConfig {
  if (!role.allowedTools || role.allowedTools instanceof Set) return role;
  const fallback = getRoleConfig(role.role);
  return {
    ...fallback,
    systemPrompt: role.systemPrompt || fallback.systemPrompt,
    model: role.model,
    timeoutMs: role.timeoutMs,
  };
}

function configuredSubagentMaxOutputTokens(input: SubAgentRunnerInput): number | undefined {
  const configured =
    input.config.modelKwargs?.maxOutputTokens ?? input.config.modelKwargs?.maxTokens;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : undefined;
}

function admittedSubagentMaxOutputTokens(input: SubAgentRunnerInput): number | undefined {
  const configured = configuredSubagentMaxOutputTokens(input);
  const budget = input.modelInvocationPersistence?.getState().resourceBudget;
  if (budget?.status !== 'active') return configured;
  const remaining =
    budget.budget.maxRunOutputTokens - committedResourceUsage(budget).counters.outputTokens;
  if (remaining <= 0) throw new DescendantResourceAdmissionError('budget_exhausted');
  return Math.min(configured ?? remaining, remaining);
}

function structuredSubagentFailureReason(result: ToolExecutionResult): string {
  if (result.terminationReason === 'timed_out') return 'timed_out';
  if (result.terminationReason === 'cancelled') return 'cancelled_by_user';
  if (result.terminationReason === 'sandbox_denied') return 'sandbox_denied';
  if (result.status === 'rejected') return 'policy_denied';
  return 'tool_reported_failure';
}

export async function executeSubagentStartWithCoreToolAdapter(
  input: SubAgentRunnerInput,
): Promise<SubAgentResult> {
  const id = input.childInvocationId ?? nextSubAgentId();
  const role = normalizeRoleConfig(input.role);
  const modelContext = createBuiltinSubagentModelContext({
    workspace: input.workspace,
    task: input.task,
    role: role.role,
    systemPrompt: role.systemPrompt,
    ...(input.projectInstructions ? { projectInstructions: input.projectInstructions } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
  });
  const normalizedInput = {
    ...input,
    workspace: modelContext.workspace,
    role,
    projectInstructions: modelContext.projectInstructions,
  };
  input.eventSink({
    type: 'start',
    data: {
      id,
      role: normalizedInput.role.role,
      name: input.name,
    },
  });
  return executeCoreSubagentToolAdapter(normalizedInput, {
    id,
    messages: [...modelContext.messages],
    toolCallCount: 0,
    modelInvocationOrdinal: 0,
    steps: [],
    executionJournal: [],
    exhaustedFingerprints: {},
    toolRecovery: createToolRecoveryJournal(normalizedInput.recoveryIdentityKey),
  });
}

export async function executeSubagentResumeWithCoreToolAdapter(
  input: SubAgentRunnerInput,
  continuation: SubAgentContinuation,
  toolResult: {
    toolCallId: string;
    toolName: string;
    result: ToolExecutionResult;
  },
): Promise<SubAgentResult> {
  const normalizedInput = {
    ...input,
    workspace: resolve(input.workspace),
    role: normalizeRoleConfig(input.role),
    projectInstructions: continuation.projectInstructions ?? input.projectInstructions,
  };
  const toolOutput = toolExecutionModelContent(toolResult.result);
  const actualOk = toolResult.result.ok !== false;
  normalizedInput.eventSink({
    type: 'tool_result',
    data: {
      id: continuation.id,
      toolName: toolResult.toolName,
      ok: actualOk,
      summary: toolOutput.slice(0, 200),
      durationMs: 0,
      ...(typeof toolResult.result.totalLines === 'number'
        ? { totalLines: toolResult.result.totalLines }
        : {}),
      toolTokenCount: countTokens(toolOutput),
      ...(toolResult.result.ok === false
        ? { failureReason: structuredSubagentFailureReason(toolResult.result) }
        : {}),
    },
  });

  // Sync step snapshot with actual result — the blocked case didn't set ok,
  // so the last step in the continuation still has ok: undefined.
  // The Core receipt adapter is the authority on the actual tool outcome (approved → ok,
  // rejected → !ok), so update the snapshot here before the loop continues.
  const lastStep = continuation.steps[continuation.steps.length - 1];
  if (lastStep && lastStep.toolName === toolResult.toolName) {
    lastStep.ok = actualOk;
    lastStep.status = actualOk
      ? 'success'
      : toolResult.result.status === 'rejected'
        ? 'rejected'
        : 'error';
  }

  const priorRecovery = continuation.toolRecovery;
  const resumeArgs = continuation.steps.at(-1)?.toolArgs ?? {};
  const resumeBinding = input.mcpBindings?.find(
    (entry) => entry.binding.exposedToolName === toolResult.toolName,
  );
  const resumeDynamicIdentity = resumeBinding
    ? canonicalizeCapabilityArguments(resumeBinding.descriptor.inputSchema, resumeArgs)
    : undefined;
  const resumeAvailability = createSubagentToolTurnContext({
    workspace: input.workspace,
    gitBroker: input.gitBroker,
    config: input.config,
    phase: input.phase,
    threadId: input.threadId,
    eventSink: input.eventSink,
    taskId: continuation.id,
  });
  const resumeProjection = requireBuiltinToolCatalog(input).forTurn(resumeAvailability);
  const resumeBuiltinEntry = resumeProjection.entries.find(
    (entry): entry is BuiltinModelToolCatalogEntry =>
      entry.visibility === 'model' && entry.name === toolResult.toolName,
  );
  const resumePreflight = toolRequestFromCall(
    { id: toolResult.toolCallId, name: toolResult.toolName, args: resumeArgs },
    resumeAvailability,
    resumeProjection,
  );
  const resumeFingerprint = toolInvocationFingerprint({
    toolName: toolResult.toolName,
    identityRevision:
      resumeBinding?.binding.capabilityRevision ??
      resumeBuiltinEntry?.descriptor.revision ??
      'unknown',
    ...(resumeDynamicIdentity?.ok
      ? { parsedArgs: resumeDynamicIdentity.args }
      : resumePreflight?.ok
        ? { parsedArgs: resumePreflight.request.args }
        : {
            parseCode: resumeBinding
              ? ('invalid_arguments' as const)
              : resumePreflight
                ? resumePreflight.request.parseFailureCode === 'unknown_tool'
                  ? ('unknown_tool' as const)
                  : resumePreflight.request.parseFailureCode === 'tool_unavailable'
                    ? ('tool_unavailable' as const)
                    : ('invalid_arguments' as const)
                : ('unknown_tool' as const),
            pathCategory: 'unknown' as const,
            unparsedArgs: resumeArgs,
          }),
  });
  const resumeRejected = !actualOk && toolResult.result.status === 'rejected';
  const resumePolicyDenied =
    resumeRejected && toolResult.result.classifierAdvice?.detailCode === 'policy_denied';
  const resumeOutcome = actualOk
    ? classifyToolOutcome({
        status: 'success',
        authority: { dispatchState: 'started', externalEffects: 'known' },
      })
    : classifyToolOutcome({
        status: resumeRejected ? 'rejected' : 'failed',
        failure: classifyFailure(
          resumePolicyDenied
            ? 'policy_denied'
            : resumeRejected
              ? 'approval_rejected'
              : 'tool_runtime_error',
          'Subagent tool recovery failed.',
        ),
        authority: {
          dispatchState: resumeRejected ? 'not_started' : 'started',
          externalEffects: resumeRejected ? 'none' : 'unknown',
          ...(resumePolicyDenied
            ? { policyDenied: true }
            : resumeRejected
              ? { approvalDenied: true }
              : {}),
        },
        toolAdvice: toolResult.result.classifierAdvice,
        classifierDiagnostic: toolResult.result.classifierDiagnostic,
      });
  const resumedRecovery = actualOk
    ? recordToolOwnedProgress(priorRecovery, {
        kind: 'receipt',
        referenceId: toolResult.toolCallId,
      })
    : recordRecoveryFailure(priorRecovery, {
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        invocationFingerprint: resumeFingerprint,
        modelMessageId: `resume-${continuation.toolCallCount}`,
        outcome: resumeOutcome,
        taskId: continuation.id,
        turnId: continuation.id,
      });
  return executeCoreSubagentToolAdapter(normalizedInput, {
    id: continuation.id,
    messages: [
      ...continuation.messages,
      toolMessage({
        content: toolOutput,
        tool_call_id: toolResult.toolCallId,
        name: toolResult.toolName,
        status: toolResult.result.ok === false ? 'error' : 'success',
      }),
    ],
    toolCallCount: continuation.toolCallCount,
    modelInvocationOrdinal: continuation.modelInvocationOrdinal ?? 0,
    steps: continuation.steps,
    executionJournal: continuation.executionJournal ?? [],
    exhaustedFingerprints: continuation.exhaustedFingerprints ?? {},
    toolRecovery: resumedRecovery,
  });
}

async function executeCoreSubagentToolAdapter(
  input: SubAgentRunnerInput,
  state: {
    id: string;
    messages: BaseMessage[];
    toolCallCount: number;
    modelInvocationOrdinal: number;
    steps: SubAgentStepSnapshot[];
    // Phase 5: journal tracking for subagent tool executions
    executionJournal: PersistedExecutionJournalEntry[];
    exhaustedFingerprints: Record<string, true>;
    toolRecovery: import('@kite/runtime-host/kernel-adapter').StateToolRecoveryJournal;
  },
): Promise<SubAgentResult> {
  const id = state.id;
  const recoveryScopeId = state.id;
  const model = input.role.model ?? input.model;
  if (!model) {
    throw new Error('Subagent Model execution context is unavailable.');
  }
  const effectiveTimeoutMs = input.role.timeoutMs ?? input.timeoutMs;
  const startTime = Date.now();
  let toolCallCount = state.toolCallCount;
  const steps = state.steps;
  const messages = [...state.messages];
  const executionJournal = state.executionJournal ?? [];
  const exhaustedFingerprints: Record<string, true> = { ...(state.exhaustedFingerprints ?? {}) };
  let toolRecovery = state.toolRecovery;
  let modelInvocationOrdinal = state.modelInvocationOrdinal;
  let lastModelInvocationId: string | undefined;
  let adapterFailureStage: NonNullable<SubAgentResult['failureDiagnostic']>['stage'] =
    'initialization';

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), effectiveTimeoutMs);
  // 手动合并信号，避免 AbortSignal.any 的跨运行时兼容性问题
  const combinedController = new AbortController();
  const onAbort = () => combinedController.abort();
  if (input.signal.aborted) {
    combinedController.abort(input.signal.reason);
  } else {
    input.signal.addEventListener('abort', onAbort, { once: true });
  }
  if (timeoutController.signal.aborted) {
    combinedController.abort(timeoutController.signal.reason);
  } else {
    timeoutController.signal.addEventListener('abort', onAbort, { once: true });
  }
  const combinedSignal = combinedController.signal;

  const availabilityContext = createSubagentToolTurnContext({
    workspace: input.workspace,
    gitBroker: input.gitBroker,
    config: input.config,
    phase: input.phase,
    interactionMode: effectiveInteractionMode(input),
    threadId: input.threadId,
    eventSink: input.eventSink,
    taskId: state.id,
  });
  const builtinTurnContext = availabilityContext;
  const depth = input.depth ?? 0;
  const maxDepth = input.maxDepth ?? 0;
  const subagentToolSurface = createBuiltinSubagentToolSurface({
    catalog: requireBuiltinToolCatalog(input),
    turnContext: builtinTurnContext,
    ...(input.config.executionCapabilitySurface
      ? { executionCapabilitySurface: input.config.executionCapabilitySurface }
      : {}),
    ...(input.role.allowedTools ? { allowedTools: input.role.allowedTools } : {}),
    canSpawnSubagents: depth < maxDepth,
    ...(input.mcpBindings ? { dynamicMcpBindings: input.mcpBindings } : {}),
  });
  const builtinProjection = subagentToolSurface.projection;
  const tools: BuiltinModelToolSet = subagentToolSurface.tools;
  const builtinEntriesByName = new Map<string, BuiltinModelToolCatalogEntry>(
    subagentToolSurface.builtinEntries.map((entry) => [entry.name, entry]),
  );
  const mcpBindings = new Map(
    (input.mcpBindings ?? []).map((entry) => [entry.binding.exposedToolName, entry]),
  );

  try {
    await new Promise((r) => setTimeout(r, 0));
    if (!input.modelEffectCoordinator || !input.modelInvocationPersistence) {
      throw new Error('ModelInvocationGateway execution context is unavailable.');
    }
    const modelLoop = createBuiltinSubagentModelLoopEngine<
      RuntimeState,
      RuntimeEvent,
      SubAgentResult
    >({
      coordinator: input.modelEffectCoordinator,
      initialMessages: messages,
      startModelInvocationOrdinal: modelInvocationOrdinal,
      model,
      config: input.config,
      tools,
      persistence: input.modelInvocationPersistence,
      provenance: {
        parentInvocationId: input.modelInvocationParentId ?? null,
        parentToolCallId: input.modelInvocationParentToolCallId ?? null,
        contextCheckpointId:
          input.modelInvocationPersistence.getState().context.activeCheckpoint?.sourceDigest ??
          null,
        promptContractVersion: 'current',
        projectionEnvironment: {
          role: input.role.role,
          projectInstructions: input.projectInstructions ?? null,
          workspaceAccess: input.workspaceAccess ?? 'write',
          phase: input.phase ?? 'building',
        },
        capabilityBindings: (input.mcpBindings ?? []).map(({ binding }) => binding),
      },
      resource: {
        parentReservationId: input.modelInvocationParentReservationId,
        maxOutputTokens: () => admittedSubagentMaxOutputTokens(input),
      },
      signal: combinedSignal,
      consumer: {
        consume: async ({
          transcript,
          response,
          invocationId,
          modelInvocationOrdinal: currentInvocationOrdinal,
          cacheMetrics,
          append,
        }) => {
          lastModelInvocationId = invocationId;
          // Provider/test implementations may settle entirely in the microtask
          // queue. Yield once per child step so timeout/cancellation timers retain
          // authority over a model that repeatedly returns an unusable tool call.
          await new Promise((resolveStep) => setTimeout(resolveStep, 0));
          if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
          modelInvocationOrdinal = currentInvocationOrdinal;
          const appendedMessages: import('@kite/builtin-runtime/model').ToolMessage[] = [];
          const appendToolMessage = (
            message: import('@kite/builtin-runtime/model').ToolMessage,
          ): void => {
            append([message]);
            appendedMessages.push(message);
          };
          if (
            cacheMetrics &&
            (cacheMetrics.cacheHitTokens > 0 || cacheMetrics.cacheMissTokens > 0)
          ) {
            input.eventSink({
              type: 'cache_metrics',
              data: {
                subagentId: id,
                cacheHitTokens: cacheMetrics.cacheHitTokens,
                cacheMissTokens: cacheMetrics.cacheMissTokens,
                inputTokens: cacheMetrics.inputTokens,
              },
            });
          }

          const responseMessageId = response.id ?? `subagent-model-${transcript.length}`;
          const responseToolCalls = response.tool_calls;
          if (!responseToolCalls || responseToolCalls.length === 0) {
            throw new Error('Builtin subagent model loop invoked its tool consumer without calls.');
          }
          toolRecovery = advanceToolRecoveryResponse(toolRecovery, {
            taskId: recoveryScopeId,
            turnId: recoveryScopeId,
            modelMessageId: responseMessageId,
            toolCalls: responseToolCalls.flatMap((toolCall) =>
              toolCall.id ? [{ id: toolCall.id, name: toolCall.name }] : [],
            ),
          });
          for (const tc of responseToolCalls) {
            if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
            const tool = tools[tc.name];
            if (!tool) {
              const available = Object.keys(tools).sort().join(', ');
              const errMsg = `Tool "${tc.name}" is not available to this sub-agent. Available tools: ${available}. Use one of the available tools instead.`;
              appendToolMessage(
                toolMessage({
                  content: JSON.stringify({ ok: false, error: errMsg }),
                  tool_call_id: tc.id ?? '',
                  name: tc.name,
                  status: 'error',
                }),
              );
              input.eventSink({
                type: 'tool_result',
                data: {
                  id,
                  toolName: tc.name,
                  ok: false,
                  summary: errMsg.slice(0, 200),
                  durationMs: 0,
                  failureReason: 'tool_not_available',
                },
              });
              steps.push({
                toolName: tc.name,
                toolArgs: tc.args ?? {},
                status: 'error' as const,
                ok: false,
              });
              const fingerprint = toolInvocationFingerprint({
                toolName: tc.name,
                parseCode: 'tool_unavailable',
                pathCategory: 'unknown',
                unparsedArgs: tc.args,
              });
              const modelMessageId = responseMessageId;
              const admission = admitRecoveryAttempt(toolRecovery, {
                toolCallId: tc.id ?? `subagent-unavailable-${toolCallCount}`,
                toolName: tc.name,
                invocationFingerprint: fingerprint,
                modelMessageId,
                mode: 'model_correction',
                taskId: recoveryScopeId,
                turnId: recoveryScopeId,
              });
              if (admission.admitted && admission.recoveryOf) {
                toolRecovery = recordRecoveryInvocation(toolRecovery, {
                  toolCallId: tc.id ?? `subagent-unavailable-${toolCallCount}`,
                  recoveryOf: admission.recoveryOf,
                  mode: 'model_correction',
                });
              }
              const outcome = classifyToolOutcome({
                status: admission.admitted ? 'failed' : 'exhausted',
                failure: classifyFailure('tool_not_found', 'Subagent tool is unavailable.'),
                authority: {
                  dispatchState: 'not_started',
                  externalEffects: 'none',
                  replaySafety: 'pre_dispatch',
                },
                ...(admission.recoveryOf ? { lineage: { recoveryOf: admission.recoveryOf } } : {}),
                ...(!admission.admitted
                  ? {
                      toolAdvice: {
                        detailCode: admission.detailCode,
                        disposition: 'never' as const,
                        maximumAdditionalCalls: 0,
                      },
                    }
                  : {}),
              });
              const unavailableFailure = {
                toolCallId: tc.id ?? `subagent-unavailable-${toolCallCount}`,
                toolName: tc.name,
                invocationFingerprint: fingerprint,
                modelMessageId,
                outcome,
                taskId: recoveryScopeId,
                turnId: recoveryScopeId,
              };
              toolRecovery = recordRecoveryFailure(toolRecovery, unavailableFailure);
              continue;
            }

            const builtinEntry = builtinEntriesByName.get(tc.name);
            const toolArgs = normalizeSubAgentToolArgs(
              builtinEntry,
              tc.args ?? {},
              input.workspace,
            );
            const stepSnapshot: SubAgentStepSnapshot = {
              toolName: tc.name,
              toolArgs,
              status: 'pending',
            };
            steps.push(stepSnapshot);
            input.eventSink({
              type: 'step',
              data: {
                id,
                modelInvocationId: invocationId,
                toolName: tc.name,
                toolArgs,
              },
            });

            if (tc.name.startsWith('mcp__')) {
              const bindingError = mcpBindingError({
                toolName: tc.name,
                args: toolArgs,
                mcpManager: input.mcpManager,
                bindings: mcpBindings,
              });
              if (bindingError) {
                const bindingEntry = mcpBindings.get(tc.name);
                const canonicalArgs = bindingEntry
                  ? canonicalizeCapabilityArguments(bindingEntry.descriptor.inputSchema, toolArgs)
                  : undefined;
                const invocationFingerprint = toolInvocationFingerprint({
                  toolName: tc.name,
                  identityRevision: bindingEntry?.binding.capabilityRevision ?? 'unknown',
                  ...(canonicalArgs?.ok
                    ? { parsedArgs: canonicalArgs.args }
                    : {
                        parseCode: bindingEntry
                          ? ('invalid_arguments' as const)
                          : ('unknown_tool' as const),
                        pathCategory: 'unknown' as const,
                        unparsedArgs: toolArgs,
                      }),
                });
                const toolCallId = tc.id ?? `subagent-mcp-binding-${toolCallCount}`;
                const admission = admitRecoveryAttempt(toolRecovery, {
                  toolCallId,
                  toolName: tc.name,
                  invocationFingerprint,
                  modelMessageId: responseMessageId,
                  mode: 'model_correction',
                  taskId: recoveryScopeId,
                  turnId: recoveryScopeId,
                });
                if (admission.admitted && admission.recoveryOf) {
                  toolRecovery = recordRecoveryInvocation(toolRecovery, {
                    toolCallId,
                    recoveryOf: admission.recoveryOf,
                    mode: 'model_correction',
                  });
                }
                const outcome = classifyToolOutcome({
                  status: admission.admitted ? 'failed' : 'exhausted',
                  failure: classifyFailure(
                    admission.admitted ? 'tool_invalid_args' : 'loop_exhausted',
                    'Subagent MCP binding validation failed.',
                  ),
                  authority: {
                    dispatchState: 'not_started',
                    externalEffects: 'none',
                    replaySafety: 'pre_dispatch',
                  },
                  ...(admission.recoveryOf
                    ? { lineage: { recoveryOf: admission.recoveryOf } }
                    : {}),
                  ...(!admission.admitted
                    ? {
                        toolAdvice: {
                          disposition: 'never' as const,
                          maximumAdditionalCalls: 0 as const,
                          detailCode: admission.detailCode,
                        },
                      }
                    : {}),
                });
                const bindingFailure = {
                  toolCallId,
                  toolName: tc.name,
                  invocationFingerprint,
                  modelMessageId: responseMessageId,
                  outcome,
                  taskId: recoveryScopeId,
                  turnId: recoveryScopeId,
                };
                toolRecovery = recordRecoveryFailure(toolRecovery, bindingFailure);
                const blockedOutput = JSON.stringify({ ok: false, error: bindingError });
                appendToolMessage(
                  toolMessage({
                    content: blockedOutput,
                    tool_call_id: tc.id ?? '',
                    name: tc.name,
                    status: 'error',
                  }),
                );
                stepSnapshot.ok = false;
                stepSnapshot.status = 'error';
                input.eventSink({
                  type: 'tool_result',
                  data: {
                    id,
                    toolName: tc.name,
                    ok: false,
                    summary: bindingError,
                    durationMs: 0,
                    failureReason: 'invalid_mcp_binding',
                  },
                });
                continue;
              }
            }

            toolCallCount++;

            const parsedPreflight = toolRequestFromCall(
              {
                id: tc.id ?? `subagent-${toolCallCount}`,
                name: tc.name,
                args: toolArgs,
              },
              availabilityContext,
              builtinProjection,
            );
            const boundIdentity = mcpBindings.get(tc.name);
            const dynamicIdentity = boundIdentity
              ? canonicalizeCapabilityArguments(boundIdentity.descriptor.inputSchema, toolArgs)
              : undefined;
            const builtinIdentityEntry = builtinEntriesByName.get(tc.name);
            const invocationFingerprint = toolInvocationFingerprint({
              toolName: tc.name,
              identityRevision:
                boundIdentity?.binding.capabilityRevision ??
                builtinIdentityEntry?.descriptor.revision ??
                'unknown',
              ...(dynamicIdentity?.ok
                ? { parsedArgs: dynamicIdentity.args }
                : parsedPreflight?.ok
                  ? { parsedArgs: parsedPreflight.request.args }
                  : {
                      parseCode: boundIdentity
                        ? 'invalid_arguments'
                        : parsedPreflight
                          ? parsedPreflight.request.parseFailureCode === 'unknown_tool'
                            ? 'unknown_tool'
                            : parsedPreflight.request.parseFailureCode === 'tool_unavailable'
                              ? 'tool_unavailable'
                              : 'invalid_arguments'
                          : 'unknown_tool',
                      pathCategory: 'unknown' as const,
                      unparsedArgs: toolArgs,
                    }),
            });
            const modelMessageId = responseMessageId;
            const recoveryAdmission = admitRecoveryAttempt(toolRecovery, {
              toolCallId: tc.id ?? `subagent-${toolCallCount}`,
              toolName: tc.name,
              invocationFingerprint,
              modelMessageId,
              mode: 'model_correction',
              taskId: recoveryScopeId,
              turnId: recoveryScopeId,
            });
            const recoveryOf = recoveryAdmission.recoveryOf;
            if (!recoveryAdmission.admitted) {
              const exhaustedOutcome = classifyToolOutcome({
                status: 'exhausted',
                failure: classifyFailure(
                  'loop_exhausted',
                  'Subagent recovery ceiling was reached.',
                ),
                authority: { dispatchState: 'not_started', externalEffects: 'none' },
                ...(recoveryOf ? { lineage: { recoveryOf } } : {}),
                toolAdvice: {
                  disposition: 'never',
                  maximumAdditionalCalls: 0,
                  detailCode: recoveryAdmission.detailCode,
                },
              });
              toolRecovery = recordRecoveryFailure(toolRecovery, {
                toolCallId: tc.id ?? `subagent-${toolCallCount}`,
                toolName: tc.name,
                invocationFingerprint,
                modelMessageId,
                outcome: exhaustedOutcome,
                taskId: recoveryScopeId,
                turnId: recoveryScopeId,
              });
              const blockedOutput = JSON.stringify({
                ok: false,
                status: 'exhausted',
                failure: {
                  kind: 'loop_exhausted',
                  detail_code: recoveryAdmission.detailCode,
                  retryable: false,
                  model_fixable: false,
                },
                next_step: 'Replan, skip the blocked step, or safely finalize.',
              });
              appendToolMessage(
                toolMessage({
                  content: blockedOutput,
                  tool_call_id: tc.id ?? '',
                  name: tc.name,
                  status: 'exhausted',
                }),
              );
              stepSnapshot.ok = false;
              stepSnapshot.status = 'error';
              input.eventSink({
                type: 'tool_result',
                data: {
                  id,
                  toolName: tc.name,
                  ok: false,
                  summary: blockedOutput,
                  durationMs: 0,
                  failureReason: recoveryAdmission.detailCode,
                },
              });
              continue;
            }
            if (recoveryOf) {
              toolRecovery = recordRecoveryInvocation(toolRecovery, {
                toolCallId: tc.id ?? `subagent-${toolCallCount}`,
                recoveryOf,
                mode: 'model_correction',
              });
            }

            const toolStart = Date.now();
            let toolOutput: string;
            let ok = true;
            let totalLines: number | undefined;
            let executionResult: ToolExecutionResult | undefined;
            let failureOutcome: ToolOutcome | undefined;
            let roleCeilingDenied = false;
            try {
              const parsed = parsedPreflight;
              if (!parsed?.ok) {
                throw new Error(
                  `Unknown or invalid tool requested by sub-agent: ${tc.name}${parsed ? ` — ${parsed.request.parseError}` : ''}`,
                );
              }
              const pendingRequest = parsed.request;
              const roleDenial = isBuiltinShellEntry(builtinEntry)
                ? rejectShellOutsideSubAgentRoleCeiling(
                    input.role,
                    String((pendingRequest.args as { readonly command?: unknown }).command ?? ''),
                  )
                : undefined;
              roleCeilingDenied = roleDenial != null;
              let runtimeToolCallId: string | undefined;
              let childToolAdmissionAttempt = 0;
              const result = roleDenial
                ? roleDenial
                : input.toolDispatcher
                  ? await input.toolDispatcher
                      .dispatch({
                        subagentId: id,
                        modelInvocationId: invocationId,
                        modelToolCallId: tc.id ?? `subagent-${toolCallCount}`,
                        request: pendingRequest,
                        signal: combinedSignal,
                        ...(input.descendantResourceAdmission
                          ? {
                              beforeAdmission: async () => {
                                childToolAdmissionAttempt += 1;
                                return input.descendantResourceAdmission!.reserveTool({
                                  invocationKey: `tool:${toolCallCount}:${pendingRequest.id ?? tc.id ?? tc.name}:attempt:${childToolAdmissionAttempt}`,
                                  toolKind: tc.name,
                                  shell: isBuiltinShellEntry(builtinEntry),
                                  signal: combinedSignal,
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
                                  if (dispatchState === 'not_started') {
                                    await input.descendantResourceAdmission!.markLocalProviderAdmissionDenied(
                                      reservationId,
                                    );
                                  } else {
                                    await input.descendantResourceAdmission!.markUnknown(
                                      reservationId,
                                    );
                                  }
                                  return;
                                }
                                try {
                                  await input.descendantResourceAdmission!.reconcileTool({
                                    reservationId,
                                    artifactBytes:
                                      isBuiltinFilesystemMutationEntry(builtinEntry) &&
                                      attemptResult?.path
                                        ? bestEffortRegularFileSize(attemptResult.path)
                                        : 0,
                                  });
                                } catch (settlementError) {
                                  await input.descendantResourceAdmission!.markUnknown(
                                    reservationId,
                                  );
                                  throw settlementError;
                                }
                              },
                            }
                          : {}),
                        ...(mcpBindings.get(tc.name)?.binding
                          ? { binding: mcpBindings.get(tc.name)!.binding }
                          : {}),
                      })
                      .then((dispatched) => {
                        runtimeToolCallId = dispatched.runtimeToolCallId;
                        return dispatched.result;
                      })
                  : {
                      ok: false,
                      command: pendingRequest.protectedCommand,
                      exitCode: -1,
                      stdout: '',
                      stderr:
                        'Runtime child tool dispatcher is unavailable; child tool execution is fail-closed.',
                      status: 'error' as const,
                    };
              executionResult = result;
              const blocked = approvalRequiredBlock(
                result,
                pendingRequest.id ?? tc.id ?? `subagent-${toolCallCount}`,
                pendingRequest.name,
                toolArgs,
                {
                  id,
                  role: input.role,
                  name: input.name,
                  task: input.task,
                  messages: [...transcript, ...appendedMessages],
                  toolCallCount,
                  modelInvocationOrdinal,
                  steps,
                  executionJournal: executionJournal.length > 0 ? [...executionJournal] : undefined,
                  exhaustedFingerprints:
                    Object.keys(exhaustedFingerprints).length > 0
                      ? { ...exhaustedFingerprints }
                      : undefined,
                  toolRecovery,
                  projectInstructions: input.projectInstructions,
                  ...(input.role.allowedTools
                    ? { allowedTools: [...input.role.allowedTools].sort() }
                    : {}),
                  ...(input.mcpBindings
                    ? {
                        mcpBindingIds: input.mcpBindings
                          .map(({ binding }) => binding.bindingId)
                          .sort(),
                      }
                    : {}),
                },
              );
              if (blocked && runtimeToolCallId) blocked.runtimeToolCallId = runtimeToolCallId;
              if (blocked) {
                clearTimeout(timeoutId);
                const totalDurationMs = Date.now() - startTime;

                // 同一 AI message 中可能有多个 tool call，blocked 后剩余的工具
                // 未被处理。必须为它们添加 deferred ToolMessage，否则消息格式不合法
                // （每个 tool_call_id 都需要对应 ToolMessage），resume 后模型调用会 400。
                const currentIndex = responseToolCalls.indexOf(tc);
                for (let i = currentIndex + 1; i < responseToolCalls.length; i++) {
                  const remaining = responseToolCalls[i]!;
                  appendToolMessage(
                    toolMessage({
                      content: JSON.stringify({
                        ok: false,
                        deferred: true,
                        error: `Execution deferred: sub-agent paused for ${tc.name} approval before this tool could run.`,
                      }),
                      tool_call_id: remaining.id ?? `subagent-deferred-${i}`,
                      name: remaining.name,
                      status: 'error',
                    }),
                  );
                }

                // 重建 continuation，包含 deferred ToolMessages
                // Rebuild continuation WITH deferred messages so resumed state is valid
                const continuation: SubAgentContinuation = {
                  id,
                  role: input.role,
                  name: input.name,
                  task: input.task,
                  messages: [...transcript, ...appendedMessages],
                  toolCallCount,
                  modelInvocationOrdinal,
                  steps,
                  executionJournal: executionJournal.length > 0 ? [...executionJournal] : undefined,
                  exhaustedFingerprints:
                    Object.keys(exhaustedFingerprints).length > 0
                      ? { ...exhaustedFingerprints }
                      : undefined,
                  toolRecovery,
                  projectInstructions: input.projectInstructions,
                  ...(input.role.allowedTools
                    ? { allowedTools: [...input.role.allowedTools].sort() }
                    : {}),
                  ...(input.mcpBindings
                    ? {
                        mcpBindingIds: input.mcpBindings
                          .map(({ binding }) => binding.bindingId)
                          .sort(),
                      }
                    : {}),
                };
                // 更新 blocked.continuation 为包含 deferred 消息的新版本
                blocked.continuation = continuation;

                // 子 agent 工具需要审批：标记步骤为 awaiting_approval，暂停子 agent，
                // 将 blocked 结果返回给调用方（tool-controller）以通过 Runtime Kernel
                // 的审批管线处理。Kernel 审批通过后通过 Core receipt adapter 恢复执行。
                // Sub-agent tool needs approval: mark step as awaiting_approval, pause
                // the sub-agent, and return the blocked result to the caller so the
                // Runtime Kernel's approval pipeline can handle it. After approval, the
                // Kernel resumes execution through the Core receipt adapter.
                stepSnapshot.status = 'awaiting_approval' as const;
                return {
                  kind: 'terminal' as const,
                  value: {
                    ok: false,
                    summary: JSON.stringify({ ok: false, blocked }),
                    toolCallCount,
                    durationMs: totalDurationMs,
                    error: blocked.message,
                    terminalStatus: 'suspended' as const,
                    blocked,
                    steps,
                    ...(executionJournal.length > 0 ? { executionJournal } : {}),
                    ...(Object.keys(exhaustedFingerprints).length > 0
                      ? { exhaustedFingerprints }
                      : {}),
                    toolRecovery,
                  },
                };
              }
              toolOutput = toolExecutionModelContent(result);
              ok = result.ok !== false;
              if ('totalLines' in result && typeof result.totalLines === 'number') {
                totalLines = result.totalLines;
              }
            } catch (e) {
              if (e instanceof DescendantResourceAdmissionError) {
                const parentInvocationId = input.subagentGrantContext?.parentInvocationId;
                const parentToolCallId = input.modelInvocationParentToolCallId;
                const childInvocationId = input.childInvocationId;
                if (!parentInvocationId || !parentToolCallId || !childInvocationId) throw e;
                clearTimeout(timeoutId);
                const durationMs = Date.now() - startTime;
                input.eventSink({
                  type: 'error',
                  data: {
                    id,
                    error: e.message,
                    summary: e.message,
                    toolCallCount,
                    durationMs,
                  },
                });
                return {
                  kind: 'terminal' as const,
                  value: {
                    ok: false,
                    summary: e.message,
                    error: e.message,
                    terminalStatus: 'failed' as const,
                    toolCallCount,
                    durationMs,
                    resourceAdmissionFailure: {
                      reason: e.reason,
                      message: e.message,
                      parentInvocationId,
                      parentToolCallId,
                      childInvocationId,
                    },
                    steps,
                    ...(executionJournal.length > 0 ? { executionJournal } : {}),
                    ...(Object.keys(exhaustedFingerprints).length > 0
                      ? { exhaustedFingerprints }
                      : {}),
                    toolRecovery,
                  },
                };
              }
              toolOutput = JSON.stringify({
                ok: false,
                error: 'Sub-agent tool execution failed.',
              });
              ok = false;
            }

            // Parent and child use the same typed, metadata-only recovery journal.
            if (ok) {
              toolRecovery = recordToolOwnedProgress(toolRecovery, {
                kind: 'receipt',
                referenceId: tc.id ?? `subagent-${toolCallCount}`,
                ...(recoveryOf ? { resolvesFailureIds: [recoveryOf] } : {}),
              });
            } else {
              const preDispatchFailure = !parsedPreflight?.ok || roleCeilingDenied;
              const parseFailureCode = !parsedPreflight?.ok
                ? (parsedPreflight?.request.parseFailureCode ?? 'invalid_arguments')
                : undefined;
              const readOnly = isReadOnlyCapability(builtinEntry);
              failureOutcome = classifyToolOutcome({
                status: roleCeilingDenied ? 'rejected' : 'failed',
                failure: classifyFailure(
                  parseFailureCode
                    ? failureKindForToolParseFailure(parseFailureCode)
                    : roleCeilingDenied
                      ? 'policy_denied'
                      : 'tool_runtime_error',
                  'Subagent tool invocation failed.',
                  parseFailureCode,
                ),
                authority: {
                  dispatchState: preDispatchFailure ? 'not_started' : 'started',
                  externalEffects: preDispatchFailure || readOnly ? 'none' : 'unknown',
                  replaySafety: preDispatchFailure
                    ? 'pre_dispatch'
                    : readOnly
                      ? 'safe_read'
                      : 'none',
                  ...(roleCeilingDenied ? { policyDenied: true } : {}),
                },
                ...(recoveryOf ? { lineage: { recoveryOf } } : {}),
                toolAdvice: executionResult?.classifierAdvice,
                classifierDiagnostic: executionResult?.classifierDiagnostic,
              });
              toolRecovery = recordRecoveryFailure(toolRecovery, {
                toolCallId: tc.id ?? `subagent-${toolCallCount}`,
                toolName: tc.name,
                invocationFingerprint,
                modelMessageId,
                outcome: failureOutcome,
                taskId: recoveryScopeId,
                turnId: recoveryScopeId,
              });
            }

            const durationMs = Date.now() - toolStart;
            stepSnapshot.ok = ok;
            stepSnapshot.status = ok ? 'success' : 'error';
            if (totalLines != null) stepSnapshot.totalLines = totalLines;

            const toolTokenCount = countTokens(toolOutput);
            input.eventSink({
              type: 'tool_result',
              data: {
                id,
                toolName: tc.name,
                ok,
                summary: toolOutput.slice(0, 200),
                durationMs,
                ...(totalLines != null ? { totalLines } : {}),
                ...(toolTokenCount > 0 ? { toolTokenCount } : {}),
                ...(!ok
                  ? {
                      failureReason: failureOutcome?.failure?.detailCode ?? 'unknown',
                    }
                  : {}),
              },
            });

            appendToolMessage(
              toolMessage({
                content: toolOutput,
                tool_call_id: tc.id ?? '',
                name: tc.name,
                status: ok ? 'success' : 'error',
              }),
            );
          }
          return { kind: 'continue' as const };
        },
      },
    });
    const modelLoopResult = await modelLoop.run();
    if (modelLoopResult.kind === 'terminal') return modelLoopResult.value;

    adapterFailureStage = 'terminal_projection';
    clearTimeout(timeoutId);
    modelInvocationOrdinal = modelLoopResult.modelInvocationOrdinal;
    const durationMs = Date.now() - startTime;
    // Step failures remain in toolRecovery for parent-level recovery and
    // observability, but a child that returns a final model response has
    // completed its own lifecycle successfully.
    input.eventSink({
      type: 'done',
      data: {
        id,
        modelInvocationId: modelLoopResult.invocationId,
        summary: modelLoopResult.summary,
        toolCallCount,
        durationMs,
      },
    });
    return {
      ok: true,
      summary: modelLoopResult.summary,
      toolCallCount,
      durationMs,
      terminalStatus: 'completed',
      steps,
      executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
      exhaustedFingerprints:
        Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
      toolRecovery,
    };
  } catch (e) {
    if (e instanceof DescendantResourceAdmissionError) throw e;
    const durationMs = Date.now() - startTime;
    const timedOut = timeoutController.signal.aborted && !input.signal.aborted;
    const cancelled =
      !timedOut &&
      (input.signal.aborted ||
        combinedSignal.aborted ||
        (e instanceof Error && e.name === 'AbortError') ||
        (e instanceof BuiltinSubagentModelLoopError && e.code === 'aborted'));
    const summary = timedOut
      ? 'Sub-agent execution timed out.'
      : cancelled
        ? 'Cancelled'
        : 'Sub-agent execution failed.';
    const diagnostic: NonNullable<SubAgentResult['failureDiagnostic']> = {
      code: timedOut
        ? 'timed_out'
        : cancelled
          ? 'aborted'
          : e instanceof BuiltinSubagentModelLoopError
            ? e.code
            : 'internal_error',
      stage: e instanceof BuiltinSubagentModelLoopError ? e.stage : adapterFailureStage,
      ...(e instanceof BuiltinSubagentModelLoopError && e.modelInvocationId
        ? { modelInvocationId: e.modelInvocationId }
        : lastModelInvocationId
          ? { modelInvocationId: lastModelInvocationId }
          : {}),
    };
    input.eventSink({
      type: 'error',
      data: { id, error: summary, summary, toolCallCount, durationMs, diagnostic },
    });
    return {
      ok: false,
      summary,
      toolCallCount,
      durationMs,
      error: summary,
      terminalStatus: cancelled ? 'cancelled' : 'failed',
      failureDiagnostic: diagnostic,
      steps,
      executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
      exhaustedFingerprints:
        Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
      toolRecovery,
    };
  } finally {
    clearTimeout(timeoutId);
    input.signal.removeEventListener('abort', onAbort);
    timeoutController.signal.removeEventListener('abort', onAbort);
  }
}
