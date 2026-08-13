import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolSet } from 'ai';
import { extractPromptCacheMetrics } from '@/core/cache-metrics';
import { digestCapability } from '@/core/capabilities/catalog';
import {
  canonicalizeCapabilityArguments,
  validateCapabilityArguments,
} from '@/core/capabilities/schema';
import { getFeatureFlags } from '@/core/config/features';
import { ProviderDataAdmissionError } from '@/core/config/provider-data-admission';
import { type ExecutionJournalEntry, isFingerprintExhausted } from '@/core/execution/journal';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import { runApprovedTool } from '@/core/harness/tool-runner';
import type { BaseMessage } from '@/core/messages';
import { humanMessage, isSystemMessage, systemMessage, toolMessage } from '@/core/messages';
import { estimateContextTokens } from '@/core/model/context-budget';
import { serializeToolDescriptors } from '@/core/model/context-projection';
import { createChatModel } from '@/core/model/factory';
import { invokeBoundModel } from '@/core/model/invoke';
import {
  formatProjectInstructionSnapshot,
  resolveProjectInstructionSnapshot,
} from '@/core/model/project-instructions';
import { buildCacheableRuntimeContext } from '@/core/model/runtime-context';
import { isReadOnlyShellCommand } from '@/core/policies/shell-classification';
import { classifyFailure, failureKindForToolParseFailure } from '@/core/runtime/failures';
import { DescendantResourceAdmissionError } from '@/core/runtime/resource-budget-admission';
import { toolExecutionModelContentV1 } from '@/core/runtime/tool-model-content';
import { classifyToolOutcomeV1 } from '@/core/runtime/tool-outcome';
import {
  admitRecoveryAttemptV1,
  advanceToolRecoveryResponseV1,
  createToolRecoveryJournalV1,
  hasUnresolvedToolFailuresV1,
  recordRecoveryExhaustionV1,
  recordRecoveryFailureV1,
  recordRecoveryInvocationV1,
  recordToolOwnedProgressV1,
  toolInvocationFingerprintV1,
} from '@/core/runtime/tool-recovery-journal';
import { classifyToolFailure } from '@/core/session-logger/classifier';
import { countTokens } from '@/core/token-counter';
import { createAgentTools, toolAvailabilityContext } from '@/core/tools/definitions';
import { msys2ToWindowsPath } from '@/core/tools/path-utils';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import { type ShellExecutor, shellTool } from '@/core/tools/shell';
import { getRoleConfig } from './roles';
import type {
  SubAgentContinuation,
  SubAgentResult,
  SubAgentRoleConfig,
  SubAgentRunnerInput,
  SubAgentStepSnapshot,
} from './types';

export type { SubAgentRunnerInput } from './types';

export function deriveSubAgentCompletionV1(
  journal: import('@/core/runtime/tool-recovery-journal').ToolRecoveryJournalV1,
):
  | { ok: false; terminalStatus: 'exhausted' }
  | {
      ok: true;
      terminalStatus: 'completed';
    } {
  if (hasUnresolvedToolFailuresV1(journal) || journal.qualityGuard.blocked) {
    return { ok: false, terminalStatus: 'exhausted' };
  }
  return { ok: true, terminalStatus: 'completed' };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) =>
        b && typeof b === 'object' && 'text' in (b as Record<string, unknown>)
          ? String((b as Record<string, unknown>).text)
          : '',
      )
      .join('');
  }
  return String(content ?? '');
}

function wrapReadOnlyShell(inner: ShellExecutor): ShellExecutor {
  return async (shellInput) => {
    if (!isReadOnlyShellCommand(shellInput.command)) {
      return {
        ok: false,
        command: shellInput.command,
        exitCode: -1,
        stdout: '',
        stderr: `Command rejected: "${shellInput.command}" is not a read-only command. This sub-agent has read-only access only.`,
      };
    }
    return inner(shellInput);
  };
}

let _subAgentCounter = 0;
function nextSubAgentId(): string {
  return `sub-${Date.now().toString(36)}-${_subAgentCounter++}`;
}

function normalizeSubAgentToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> {
  if (
    (toolName !== 'read_file' && toolName !== 'edit_file' && toolName !== 'write_file') ||
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
    binding.schemaDigest !== digestCapability(descriptor.inputSchema)
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
  },
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  continuation: SubAgentContinuation,
) {
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
    continuation,
  };
}

function initialMessages(input: SubAgentRunnerInput): BaseMessage[] {
  const canonicalWorkspace = resolve(input.workspace);
  const cacheableRuntimeCtx = buildCacheableRuntimeContext({ workspace: canonicalWorkspace });
  const taskWithCwd = `<runtime-state source="harness.subagent">
CWD: ${canonicalWorkspace}
</runtime-state>

${input.task}`;

  let systemPrompt = input.role.systemPrompt;
  if (input.role.role === 'code' && input.skills && input.skills.length > 0) {
    const skillLines = input.skills.map((s) => `- ${s.name}: ${s.description}`);
    systemPrompt += [
      '',
      '## Available Skills',
      'Use activate_skill only for a disclosed matching workflow; use read_skill_reference and complete_skill for its lifecycle.',
      ...skillLines,
    ].join('\n');
  }
  systemPrompt += `\n\n${cacheableRuntimeCtx}`;
  const projectContext = getFeatureFlags(input.config).promptContractV2
    ? (input.projectInstructions ??
      resolveProjectInstructionSnapshot({ workspace: input.workspace }))
    : undefined;
  return [
    systemMessage(systemPrompt),
    humanMessage(taskWithCwd),
    ...(projectContext &&
    (projectContext.documents.length > 0 || projectContext.warnings.length > 0)
      ? [humanMessage(formatProjectInstructionSnapshot(projectContext))]
      : []),
  ];
}

function effectiveInteractionMode(
  input: SubAgentRunnerInput,
): import('@/protocol/events').InteractionMode {
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

function subagentModelInputTokens(messages: BaseMessage[], tools: ToolSet): number {
  return estimateContextTokens({
    systemMessages: messages.filter(isSystemMessage),
    transcriptMessages: messages.filter((message) => !isSystemMessage(message)),
    dynamicRuntimeMessages: [],
    serializedTools: serializeToolDescriptors(tools as unknown as Record<string, unknown>),
  }).totalInputTokens;
}

function subagentModelOutputTokens(message: unknown): number {
  if (!message || typeof message !== 'object') return 0;
  const candidate = message as {
    content?: unknown;
    response_metadata?: { usage?: { completion_tokens?: number } };
    usage_metadata?: { output_tokens?: number };
  };
  return Number(
    candidate.response_metadata?.usage?.completion_tokens ??
      candidate.usage_metadata?.output_tokens ??
      countTokens(extractText(candidate.content)),
  );
}

function artifactSizeAfterTool(
  workspace: string,
  toolName: string,
  args: Record<string, unknown>,
): number {
  if ((toolName !== 'write_file' && toolName !== 'edit_file') || typeof args.path !== 'string') {
    return 0;
  }
  const normalized = normalizeSubAgentToolArgs(toolName, args, workspace);
  if (typeof normalized.path !== 'string') return 0;
  try {
    return statSync(resolve(workspace, normalized.path)).size;
  } catch {
    return 0;
  }
}

export async function runSubAgent(input: SubAgentRunnerInput): Promise<SubAgentResult> {
  const id = nextSubAgentId();
  const normalizedInput = {
    ...input,
    workspace: resolve(input.workspace),
    role: normalizeRoleConfig(input.role),
    projectInstructions: getFeatureFlags(input.config).promptContractV2
      ? (input.projectInstructions ??
        resolveProjectInstructionSnapshot({ workspace: input.workspace }))
      : undefined,
  };
  input.eventSink({
    type: 'start',
    data: { id, role: normalizedInput.role.role, task: normalizedInput.task },
  });
  return runSubAgentLoop(normalizedInput, {
    id,
    messages: initialMessages(normalizedInput),
    toolCallCount: 0,
    steps: [],
    executionJournal: [],
    exhaustedFingerprints: {},
    toolRecovery: createToolRecoveryJournalV1(normalizedInput.recoveryIdentityKey),
  });
}

export async function resumeSubAgent(
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
  const toolOutput = toolExecutionModelContentV1(toolResult.result);
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
        ? { failureReason: classifyToolFailure(toolResult.toolName, toolOutput.slice(0, 200)) }
        : {}),
    },
  });

  // Sync step snapshot with actual result — the blocked case didn't set ok,
  // so the last step in the continuation still has ok: undefined.
  // resumeSubAgent is the authority on the actual tool outcome (approved → ok,
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

  const priorRecovery = continuation.toolRecovery ?? createToolRecoveryJournalV1();
  const resumeArgs = continuation.steps.at(-1)?.toolArgs ?? {};
  const resumeBinding = input.mcpBindings?.find(
    (entry) => entry.binding.exposedToolName === toolResult.toolName,
  );
  const resumeDynamicIdentity = resumeBinding
    ? canonicalizeCapabilityArguments(resumeBinding.descriptor.inputSchema, resumeArgs)
    : undefined;
  const resumePreflight = toolRequestFromCall(
    { id: toolResult.toolCallId, name: toolResult.toolName, args: resumeArgs },
    toolAvailabilityContext({
      workspace: input.workspace,
      gitBroker: input.gitBroker,
      config: input.config,
      phase: input.phase,
      threadId: input.threadId,
    }),
  );
  const resumeBuiltinSpec = builtinToolRegistry.get(toolResult.toolName);
  const resumeFingerprint = toolInvocationFingerprintV1({
    key: priorRecovery.identityKey,
    toolName: toolResult.toolName,
    identityRevision:
      resumeBinding?.binding.capabilityRevision ??
      (resumeBuiltinSpec
        ? builtinToolRegistry.descriptorOf(resumeBuiltinSpec).revision
        : 'unknown'),
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
  const resumeOutcome = actualOk
    ? classifyToolOutcomeV1({
        status: 'success',
        authority: { dispatchState: 'started', externalEffects: 'known' },
      })
    : classifyToolOutcomeV1({
        status: toolResult.result.status === 'rejected' ? 'rejected' : 'failed',
        failure: classifyFailure(
          toolResult.result.status === 'rejected' ? 'approval_rejected' : 'tool_runtime_error',
          'Subagent tool recovery failed.',
        ),
        authority: {
          dispatchState: toolResult.result.status === 'rejected' ? 'not_started' : 'started',
          externalEffects: toolResult.result.status === 'rejected' ? 'none' : 'unknown',
          approvalDenied: toolResult.result.status === 'rejected',
        },
        toolAdvice: toolResult.result.classifierAdviceV1,
        classifierDiagnostic: toolResult.result.classifierDiagnostic,
      });
  const resumedRecovery = actualOk
    ? recordToolOwnedProgressV1(priorRecovery, {
        kind: 'receipt',
        referenceId: toolResult.toolCallId,
      })
    : recordRecoveryFailureV1(priorRecovery, {
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        invocationFingerprint: resumeFingerprint,
        modelMessageId: `resume-${continuation.toolCallCount}`,
        outcome: resumeOutcome,
        taskId: continuation.id,
        turnId: continuation.id,
      });
  return runSubAgentLoop(normalizedInput, {
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
    steps: continuation.steps,
    executionJournal: continuation.executionJournal ?? [],
    exhaustedFingerprints: continuation.exhaustedFingerprints ?? {},
    toolRecovery: resumedRecovery,
  });
}

async function runSubAgentLoop(
  input: SubAgentRunnerInput,
  state: {
    id: string;
    messages: BaseMessage[];
    toolCallCount: number;
    steps: SubAgentStepSnapshot[];
    // Phase 5: journal tracking for subagent tool executions
    executionJournal: ExecutionJournalEntry[];
    exhaustedFingerprints: Record<string, true>;
    toolRecovery: import('@/core/runtime/tool-recovery-journal').ToolRecoveryJournalV1;
  },
): Promise<SubAgentResult> {
  const id = state.id;
  const recoveryScopeId = state.id;
  const model = input.role.model ?? input.model ?? createChatModel(input.config);
  const effectiveTimeoutMs = input.role.timeoutMs ?? input.timeoutMs;
  const startTime = Date.now();
  let toolCallCount = state.toolCallCount;
  const steps = state.steps;
  const messages = [...state.messages];
  const executionJournal = state.executionJournal ?? [];
  const exhaustedFingerprints: Record<string, true> = { ...(state.exhaustedFingerprints ?? {}) };
  let toolRecovery = state.toolRecovery ?? createToolRecoveryJournalV1();

  const effectiveShellExecutor = input.role.allowedTools
    ? wrapReadOnlyShell(input.shellExecutor ?? shellTool)
    : input.shellExecutor;

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

  const agentToolInput = {
    workspace: input.workspace,
    shellExecutor: effectiveShellExecutor,
    gitBroker: input.gitBroker,
    mcpManager: input.mcpManager,
    skills: input.skills,
    skillOptions: input.skillOptions,
    mcpBindings: input.mcpBindings,
    config: input.config,
    authorization: input.authorization,
    workspaceAccess: input.workspaceAccess,
    phase: input.phase,
    interactionMode: effectiveInteractionMode(input),
    threadId: input.threadId,
    model,
    subagentEventSink: input.eventSink,
    subagentSignal: combinedSignal,
    signal: combinedSignal,
  } satisfies Parameters<typeof createAgentTools>[0];
  const availabilityContext = toolAvailabilityContext(agentToolInput);
  const allTools = createAgentTools(agentToolInput, availabilityContext);
  const mcpBindings = new Map(
    (input.mcpBindings ?? []).map((entry) => [entry.binding.exposedToolName, entry]),
  );
  const depth = input.depth ?? 0;
  const maxDepth = input.maxDepth ?? 0;
  const canSpawnSubAgents = depth < maxDepth;
  // ToolSet is now Record<string, Tool> — filter by key (tool name)
  const tools: ToolSet = {};
  if (input.role.allowedTools) {
    for (const [name, t] of Object.entries(allTools)) {
      if (input.role.allowedTools.has(name) && (canSpawnSubAgents || name !== 'task')) {
        tools[name] = t;
      }
    }
  } else {
    for (const [name, t] of Object.entries(allTools)) {
      if (canSpawnSubAgents || name !== 'task') {
        tools[name] = t;
      }
    }
  }

  try {
    await new Promise((r) => setTimeout(r, 0));

    while (true) {
      if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
      const modelInputTokens = subagentModelInputTokens(messages, tools);
      const modelReservation = input.descendantResourceAdmission
        ? await input.descendantResourceAdmission.reserveModel({
            invocationKey: `model:${messages.length}:${toolCallCount}`,
            inputTokens: modelInputTokens,
            requestedMaxOutputTokens: configuredSubagentMaxOutputTokens(input),
          })
        : undefined;
      let response: Awaited<ReturnType<typeof invokeBoundModel>>;
      let modelReconciled = false;
      try {
        response = await invokeBoundModel({
          model,
          tools,
          messages,
          signal: combinedSignal,
          providerDataAdmission: input.providerDataAdmission,
          providerDataPolicyRequired: getFeatureFlags(input.config).providerDataPolicyV1,
          providerDispatchPurpose: 'subagent',
          maxOutputTokens:
            modelReservation?.maxOutputTokens ?? configuredSubagentMaxOutputTokens(input),
        });
        if (modelReservation) {
          await input.descendantResourceAdmission!.reconcileModel({
            reservationId: modelReservation.reservationId,
            inputTokens: modelInputTokens,
            outputTokens: subagentModelOutputTokens(response),
          });
          modelReconciled = true;
        }
      } catch (error) {
        if (modelReservation && !modelReconciled) {
          if (error instanceof ProviderDataAdmissionError) {
            await input.descendantResourceAdmission!.markLocalProviderAdmissionDenied(
              modelReservation.reservationId,
            );
          } else {
            await input.descendantResourceAdmission!.markUnknown(modelReservation.reservationId);
          }
        }
        throw error;
      }
      if (combinedSignal.aborted) throw new Error('Sub-agent aborted');

      const cacheMetrics = extractPromptCacheMetrics(response);
      if (cacheMetrics && (cacheMetrics.cacheHitTokens > 0 || cacheMetrics.cacheMissTokens > 0)) {
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

      if (!response.tool_calls || response.tool_calls.length === 0) {
        clearTimeout(timeoutId);
        messages.push(response);
        const summary = extractText(response.content);
        const durationMs = Date.now() - startTime;
        const completion = deriveSubAgentCompletionV1(toolRecovery);
        // Historical rejected steps do not override the canonical recovery journal:
        // a later receipt may have resolved their lineage.
        if (!completion.ok) {
          const error = 'Sub-agent cannot complete while tool recovery evidence is unresolved.';
          input.eventSink({
            type: 'error',
            data: { id, error, summary: summary || error, toolCallCount, durationMs },
          });
          return {
            ok: false,
            summary: summary || error,
            toolCallCount,
            durationMs,
            error,
            terminalStatus: completion.terminalStatus,
            steps,
            executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
            exhaustedFingerprints:
              Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
            toolRecovery,
          };
        }
        input.eventSink({
          type: 'done',
          data: { id, summary, toolCallCount, durationMs },
        });
        return {
          ok: true,
          summary,
          toolCallCount,
          durationMs,
          terminalStatus: completion.terminalStatus,
          steps,
          executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
          exhaustedFingerprints:
            Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
          toolRecovery,
        };
      }

      messages.push(response);
      const responseMessageId = response.id ?? `subagent-model-${messages.length}`;
      toolRecovery = advanceToolRecoveryResponseV1(toolRecovery, {
        taskId: recoveryScopeId,
        turnId: recoveryScopeId,
        modelMessageId: responseMessageId,
        toolCalls: response.tool_calls.flatMap((toolCall) =>
          toolCall.id ? [{ id: toolCall.id, name: toolCall.name }] : [],
        ),
      });
      for (const tc of response.tool_calls) {
        if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
        const tool = tools[tc.name];
        if (!tool) {
          const available = Object.keys(tools).sort().join(', ');
          const errMsg = `Tool "${tc.name}" is not available to this sub-agent. Available tools: ${available}. Use one of the available tools instead.`;
          messages.push(
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
          const fingerprint = toolInvocationFingerprintV1({
            key: toolRecovery.identityKey,
            toolName: tc.name,
            parseCode: 'tool_unavailable',
            pathCategory: 'unknown',
            unparsedArgs: tc.args,
          });
          const modelMessageId = responseMessageId;
          const admission = admitRecoveryAttemptV1(toolRecovery, {
            toolCallId: tc.id ?? `subagent-unavailable-${toolCallCount}`,
            toolName: tc.name,
            invocationFingerprint: fingerprint,
            modelMessageId,
            mode: 'model_correction',
            taskId: recoveryScopeId,
            turnId: recoveryScopeId,
          });
          if (admission.admitted && admission.recoveryOf) {
            toolRecovery = recordRecoveryInvocationV1(toolRecovery, {
              toolCallId: tc.id ?? `subagent-unavailable-${toolCallCount}`,
              recoveryOf: admission.recoveryOf,
              mode: 'model_correction',
            });
          }
          const outcome = classifyToolOutcomeV1({
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
          toolRecovery = recordRecoveryFailureV1(toolRecovery, unavailableFailure);
          continue;
        }

        const toolArgs = normalizeSubAgentToolArgs(tc.name, tc.args ?? {}, input.workspace);
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
            const invocationFingerprint = toolInvocationFingerprintV1({
              key: toolRecovery.identityKey,
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
            const admission = admitRecoveryAttemptV1(toolRecovery, {
              toolCallId,
              toolName: tc.name,
              invocationFingerprint,
              modelMessageId: responseMessageId,
              mode: 'model_correction',
              taskId: recoveryScopeId,
              turnId: recoveryScopeId,
            });
            if (admission.admitted && admission.recoveryOf) {
              toolRecovery = recordRecoveryInvocationV1(toolRecovery, {
                toolCallId,
                recoveryOf: admission.recoveryOf,
                mode: 'model_correction',
              });
            }
            const outcome = classifyToolOutcomeV1({
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
              ...(admission.recoveryOf ? { lineage: { recoveryOf: admission.recoveryOf } } : {}),
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
            toolRecovery = recordRecoveryFailureV1(toolRecovery, bindingFailure);
            const blockedOutput = JSON.stringify({ ok: false, error: bindingError });
            messages.push(
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
        );
        const boundIdentity = mcpBindings.get(tc.name);
        const dynamicIdentity = boundIdentity
          ? canonicalizeCapabilityArguments(boundIdentity.descriptor.inputSchema, toolArgs)
          : undefined;
        const builtinIdentitySpec = builtinToolRegistry.get(tc.name);
        const invocationFingerprint = toolInvocationFingerprintV1({
          key: toolRecovery.identityKey,
          toolName: tc.name,
          identityRevision:
            boundIdentity?.binding.capabilityRevision ??
            (builtinIdentitySpec
              ? builtinToolRegistry.descriptorOf(builtinIdentitySpec).revision
              : 'unknown'),
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
        const recoveryAdmission = admitRecoveryAttemptV1(toolRecovery, {
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
          const exhaustedOutcome = classifyToolOutcomeV1({
            status: 'exhausted',
            failure: classifyFailure('loop_exhausted', 'Subagent recovery ceiling was reached.'),
            authority: { dispatchState: 'not_started', externalEffects: 'none' },
            ...(recoveryOf ? { lineage: { recoveryOf } } : {}),
            toolAdvice: {
              disposition: 'never',
              maximumAdditionalCalls: 0,
              detailCode: recoveryAdmission.detailCode,
            },
          });
          toolRecovery = recordRecoveryFailureV1(toolRecovery, {
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
          messages.push(
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
          toolRecovery = recordRecoveryInvocationV1(toolRecovery, {
            toolCallId: tc.id ?? `subagent-${toolCallCount}`,
            recoveryOf,
            mode: 'model_correction',
          });
        }

        // Phase 5: 预检 — 如果 tool+path 已耗尽，跳过执行
        // Preflight: skip execution if this tool+path is already exhausted.
        const preflightPath = toolArgs.path as string | undefined;
        if (isFingerprintExhausted(exhaustedFingerprints, tc.name, preflightPath)) {
          const exhaustedOutcome = classifyToolOutcomeV1({
            status: 'exhausted',
            failure: classifyFailure('loop_exhausted', 'Legacy subagent exhaustion was restored.'),
            authority: { dispatchState: 'not_started', externalEffects: 'none' },
            toolAdvice: {
              disposition: 'never',
              maximumAdditionalCalls: 0,
              detailCode: 'recovery_exhausted',
            },
          });
          toolRecovery = recordRecoveryExhaustionV1(toolRecovery, {
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
            command: tc.name,
            exitCode: -1,
            stdout: '',
            stderr: `Execution blocked: too many repeated failures for ${tc.name}${preflightPath ? ` on ${preflightPath}` : ''}.`,
            status: 'exhausted' as const,
            failure: {
              message: 'Tool execution failed.' as const,
              tool: tc.name,
              reason: `Execution blocked by exhaustion guard for ${tc.name}.`,
              guidance: 'Stop retrying this operation. Skip this step, replan, or safely finalize.',
            },
          });
          messages.push(
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
              summary: blockedOutput.slice(0, 200),
              durationMs: 0,
              failureReason: 'exhausted',
            },
          });
          continue;
        }

        const toolStart = Date.now();
        let toolOutput: string;
        let ok = true;
        let totalLines: number | undefined;
        let executionResult: ToolExecutionResult | undefined;
        let toolReservation:
          | import('@/core/runtime/resource-budget-admission').DescendantBudgetReservationV1
          | undefined;
        try {
          const parsed = parsedPreflight;
          if (!parsed?.ok) {
            throw new Error(
              `Unknown or invalid tool requested by sub-agent: ${tc.name}${parsed ? ` — ${parsed.request.parseError}` : ''}`,
            );
          }
          const pendingRequest = parsed.request;
          const boundMcpDescriptor = tc.name.startsWith('mcp__')
            ? (() => {
                const binding = mcpBindings.get(tc.name)?.binding;
                return binding ? input.mcpManager?.findCapability(binding.capabilityId) : undefined;
              })()
            : undefined;
          const result = await runApprovedTool({
            workspace: input.workspace,
            request: pendingRequest,
            shellExecutor: effectiveShellExecutor,
            gitBroker: input.gitBroker,
            workspaceAccess: input.workspaceAccess ?? 'write',
            phase: input.phase ?? 'building',
            authorization: input.authorization,
            threadId: input.threadId ?? '',
            readStateActorId: id,
            recordFilePreimage: input.recordFilePreimage,
            mcpManager: input.mcpManager,
            ...(boundMcpDescriptor
              ? {
                  mcpInvocation: {
                    capabilityId: boundMcpDescriptor.capabilityId,
                    expectedRevision: boundMcpDescriptor.revision,
                  },
                  mcpPolicy: {
                    effects: boundMcpDescriptor.effectiveEffects,
                    minimumApproval: boundMcpDescriptor.policy.minimumApproval,
                  },
                }
              : {}),
            skillManifests: input.skills,
            skillOptions: input.skillOptions,
            signal: combinedSignal,
            interactionMode: effectiveInteractionMode(input),
            taskConfig: input.config,
            availabilityContext,
            projectInstructionSnapshot: input.projectInstructions,
            taskModel: model,
            providerDataAdmission: input.providerDataAdmission,
            subagentEventSink: input.eventSink,
            beforeDispatch: input.descendantResourceAdmission
              ? async () => {
                  toolReservation = await input.descendantResourceAdmission!.reserveTool({
                    invocationKey: `tool:${toolCallCount}:${pendingRequest.id ?? tc.id ?? tc.name}`,
                    toolKind: tc.name,
                    shell: tc.name === 'shell_execute',
                    signal: combinedSignal,
                  });
                }
              : undefined,
          });
          executionResult = result;
          if (toolReservation) {
            await input.descendantResourceAdmission!.reconcileTool({
              reservationId: toolReservation.reservationId,
              artifactBytes: artifactSizeAfterTool(input.workspace, tc.name, toolArgs),
            });
            toolReservation = undefined;
          }
          const blocked = approvalRequiredBlock(
            result,
            pendingRequest.id ?? tc.id ?? `subagent-${toolCallCount}`,
            pendingRequest.name,
            toolArgs,
            {
              id,
              role: input.role,
              task: input.task,
              messages: [...messages],
              toolCallCount,
              steps,
              executionJournal: executionJournal.length > 0 ? [...executionJournal] : undefined,
              exhaustedFingerprints:
                Object.keys(exhaustedFingerprints).length > 0
                  ? { ...exhaustedFingerprints }
                  : undefined,
              toolRecovery,
              projectInstructions: input.projectInstructions,
            },
          );
          if (blocked) {
            clearTimeout(timeoutId);
            const totalDurationMs = Date.now() - startTime;

            // 同一 AI message 中可能有多个 tool call，blocked 后剩余的工具
            // 未被处理。必须为它们添加 deferred ToolMessage，否则消息格式不合法
            // （每个 tool_call_id 都需要对应 ToolMessage），resume 后模型调用会 400。
            const currentIndex = response.tool_calls.indexOf(tc);
            for (let i = currentIndex + 1; i < response.tool_calls.length; i++) {
              const remaining = response.tool_calls[i]!;
              messages.push(
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
              task: input.task,
              messages: [...messages],
              toolCallCount,
              steps,
              executionJournal: executionJournal.length > 0 ? [...executionJournal] : undefined,
              exhaustedFingerprints:
                Object.keys(exhaustedFingerprints).length > 0
                  ? { ...exhaustedFingerprints }
                  : undefined,
              toolRecovery,
            };
            // 更新 blocked.continuation 为包含 deferred 消息的新版本
            blocked.continuation = continuation;

            // 子 agent 工具需要审批：标记步骤为 awaiting_approval，暂停子 agent，
            // 将 blocked 结果返回给调用方（tool-controller）以通过 Runtime Kernel
            // 的审批管线处理。Kernel 审批通过后通过 resumeSubAgent 恢复执行。
            // Sub-agent tool needs approval: mark step as awaiting_approval, pause
            // the sub-agent, and return the blocked result to the caller so the
            // Runtime Kernel's approval pipeline can handle it. After approval, the
            // kernel resumes execution via resumeSubAgent.
            stepSnapshot.status = 'awaiting_approval' as const;
            return {
              ok: false,
              summary: JSON.stringify({ ok: false, blocked }),
              toolCallCount,
              durationMs: totalDurationMs,
              error: blocked.message,
              terminalStatus: 'suspended',
              blocked,
              steps,
              executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
              exhaustedFingerprints:
                Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
              toolRecovery,
            };
          }
          toolOutput = toolExecutionModelContentV1(result);
          ok = result.ok !== false;
          if (typeof result.totalLines === 'number') totalLines = result.totalLines;
        } catch (e) {
          if (toolReservation) {
            if (e instanceof ProviderDataAdmissionError) {
              await input.descendantResourceAdmission!.markLocalProviderAdmissionDenied(
                toolReservation.reservationId,
              );
            } else {
              await input.descendantResourceAdmission!.markUnknown(toolReservation.reservationId);
            }
          }
          if (e instanceof DescendantResourceAdmissionError) throw e;
          toolOutput = JSON.stringify({
            ok: false,
            error: 'Sub-agent tool execution failed.',
          });
          ok = false;
        }

        // Parent and child use the same typed, metadata-only recovery journal.
        if (ok) {
          toolRecovery = recordToolOwnedProgressV1(toolRecovery, {
            kind: 'receipt',
            referenceId: tc.id ?? `subagent-${toolCallCount}`,
            ...(recoveryOf ? { resolvesFailureIds: [recoveryOf] } : {}),
          });
        } else {
          const preDispatchFailure = !parsedPreflight?.ok;
          const parseFailureCode = preDispatchFailure
            ? (parsedPreflight?.request.parseFailureCode ?? 'invalid_arguments')
            : undefined;
          const readOnly = /^(read|search|list)_/u.test(tc.name);
          const outcome = classifyToolOutcomeV1({
            status: 'failed',
            failure: classifyFailure(
              parseFailureCode
                ? failureKindForToolParseFailure(parseFailureCode)
                : 'tool_runtime_error',
              'Subagent tool invocation failed.',
              parseFailureCode,
            ),
            authority: {
              dispatchState: preDispatchFailure ? 'not_started' : 'started',
              externalEffects: preDispatchFailure || readOnly ? 'none' : 'unknown',
              replaySafety: preDispatchFailure ? 'pre_dispatch' : readOnly ? 'safe_read' : 'none',
            },
            ...(recoveryOf ? { lineage: { recoveryOf } } : {}),
            toolAdvice: executionResult?.classifierAdviceV1,
            classifierDiagnostic: executionResult?.classifierDiagnostic,
          });
          toolRecovery = recordRecoveryFailureV1(toolRecovery, {
            toolCallId: tc.id ?? `subagent-${toolCallCount}`,
            toolName: tc.name,
            invocationFingerprint,
            modelMessageId,
            outcome,
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
                  failureReason: classifyToolFailure(tc.name, toolOutput.slice(0, 200)),
                }
              : {}),
          },
        });

        messages.push(
          toolMessage({
            content: toolOutput,
            tool_call_id: tc.id ?? '',
            name: tc.name,
            status: ok ? 'success' : 'error',
          }),
        );
      }
    }
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof DescendantResourceAdmissionError) throw e;
    const durationMs = Date.now() - startTime;
    const summary =
      combinedSignal.aborted || (e instanceof Error && e.name === 'AbortError')
        ? 'Cancelled'
        : 'Sub-agent execution failed.';
    input.eventSink({
      type: 'error',
      data: { id, error: summary, summary, toolCallCount, durationMs },
    });
    return {
      ok: false,
      summary,
      toolCallCount,
      durationMs,
      error: summary,
      terminalStatus: combinedSignal.aborted ? 'cancelled' : 'failed',
      steps,
      executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
      exhaustedFingerprints:
        Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
      toolRecovery,
    };
  }
}
