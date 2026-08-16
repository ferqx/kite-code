// ── Model Controller / 模型控制器 ──
// Kernel 原生模型调用：从 RuntimeState 构建上下文 → 调用模型 → 返回 RuntimeEvent[]。
// 不依赖 LangGraph 状态、不产生副作用。
//
// Kernel-native model invocation: build context from RuntimeState → call model → return RuntimeEvent[].
// No LangGraph state dependency, no side effects.

import { randomBytes } from 'node:crypto';
import { extractPromptCacheMetrics } from '@/core/cache-metrics';
import { createBinding } from '@/core/capabilities/catalog';
import { canonicalizeCapabilityArguments } from '@/core/capabilities/schema';
import {
  chooseCapabilityDisclosure,
  searchableCapabilitySnapshot,
} from '@/core/capabilities/search';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import type { ProviderDataAdmissionGateV1 } from '@/core/config/provider-data-admission';
import { exposedMcpToolName, type McpRuntimeProvider } from '@/core/mcp';
import type { AIMessage } from '@/core/messages';
import type { CompactionReporter } from '@/core/model/compaction-metrics';
import { preflightModelContext } from '@/core/model/context-budget';
import { decideAutomaticContextCompaction } from '@/core/model/context-compaction-decision';
import { resolveContextCompactionRollout } from '@/core/model/context-compaction-rollout';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
  serializeToolDescriptors,
} from '@/core/model/context-projection';
import type { SupportedChatModel } from '@/core/model/factory';
import {
  computeModelInvocationPrivateDigestV1,
  type ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
  normalizedModelResponseToAIMessageV1,
} from '@/core/model/invocation-gateway';
import { resolveModelCapabilities } from '@/core/model/model-capabilities';
import { resolveProjectInstructionSnapshot } from '@/core/model/project-instructions';
import { compileModelSurfaceV1 } from '@/core/model/surface-compiler';
import { classifyToolCapability } from '@/core/policies/tool-capabilities';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import type { RuntimeState } from '@/core/runtime/state';
import {
  getActivePlanning,
  getAgentPhase,
  getEffectiveInteractionMode,
} from '@/core/runtime/state';
import { observeUnknownToolFieldsV1 } from '@/core/runtime/tool-outcome';
import { toolInvocationFingerprintV1 } from '@/core/runtime/tool-recovery-journal';
import { activeSkillFramesForCurrentWork } from '@/core/runtime/work-scope';
import type { SandboxBackend } from '@/core/sandbox/platform';
import { skillFrameInvalidationReason } from '@/core/skills/activation';
import type { SkillCatalogSnapshot } from '@/core/skills/catalog';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import { createAgentTools, toolAvailabilityContext } from '@/core/tools/definitions';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import type { ShellExecutor } from '@/core/tools/shell';

// ── 辅助函数 / Helpers ──

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.length > 0 ? content : undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((block: unknown) => {
        if (block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)) {
          return String((block as Record<string, unknown>).text);
        }
        return '';
      })
      .join('');
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function extractReasoningText(message: AIMessage | undefined): string | undefined {
  const reasoning =
    (message?.additional_kwargs?.reasoning_content as string | undefined) ??
    ((message as unknown as Record<string, unknown> | undefined)?.reasoning_content as
      | string
      | undefined);
  return reasoning && reasoning.length > 0 ? reasoning : undefined;
}

const BOUNDED_CANCELLATION_REQUIRED_TOOLS = new Set([
  'task',
  'shell_execute',
  'write_file',
  'edit_file',
  'write_plan',
  'update_plan',
]);

function boundedCancellationTools<T extends Record<string, unknown>>(
  tools: T,
  config: AgentConfig,
): T {
  const flags = getFeatureFlags(config);
  if (!flags.resourceBudgetV1 || flags.boundedCancellationV1) return tools;
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !BOUNDED_CANCELLATION_REQUIRED_TOOLS.has(name)),
  ) as T;
}

/** Convert invalid provider tool arguments into durable queued-and-failed facts. */
export function eventsForInvalidModelToolCalls(
  calls: Array<{
    id: string;
    name: string;
    args: {
      _raw_invalid_args?: unknown;
      _parse_error?: string;
      _invalid_args_code?: 'invalid_json';
      _invalid_args_redacted?: true;
    };
    canonicalInvocationFingerprint?: string;
  }>,
  messageId: string,
  ordinalStart: number,
  recoveryIdentityKey?: string,
  modelInvocationId?: string,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const [index, call] of calls.entries()) {
    const identityKey = recoveryIdentityKey ?? randomBytes(32).toString('hex');
    const invocationFingerprint =
      call.canonicalInvocationFingerprint ??
      toolInvocationFingerprintV1({
        key: identityKey,
        toolName: call.name,
        parseCode: 'invalid_json',
        pathCategory: 'unknown',
        unparsedArgs: call.args._raw_invalid_args ?? call.args,
      });
    const opaqueArgs = {
      _invalid_args_code: 'invalid_json' as const,
      _invalid_args_redacted: true as const,
    };
    const queued = {
      type: 'tool.queued' as const,
      toolCallId: call.id,
      ...(modelInvocationId ? { modelInvocationId } : {}),
      name: call.name,
      args: opaqueArgs,
      modelMessageId: messageId,
      ordinal: ordinalStart + index,
      invocationFingerprint,
    };
    events.push(queued, {
      type: 'tool.failed' as const,
      toolCallId: call.id,
      failure: classifyFailure(
        'model_invalid_tool_args',
        'Provider returned invalid tool arguments.',
        'invalid_json',
      ),
    });
  }
  return events;
}

export function activeInlineSkillInstructions(
  state: RuntimeState,
  catalog: SkillCatalogSnapshot | undefined,
): string | undefined {
  if (!catalog) return undefined;
  const sections = activeSkillFramesForCurrentWork(state)
    .filter((frame) => frame.contextMode === 'inline')
    .flatMap((frame) => {
      const entry = catalog.entries.find(
        (candidate) =>
          !candidate.shadowedBy &&
          candidate.descriptor.capabilityId === frame.skillId &&
          candidate.descriptor.revision === frame.skillRevision &&
          candidate.contract,
      );
      return entry?.contract
        ? [
            [
              `## Active Workflow Skill: ${entry.contract.name}`,
              entry.contract.instructions,
              entry.contract.files.some((path) =>
                /^(?:scripts|references|assets|evals)\//.test(path),
              )
                ? `Declared supporting files are not injected. Read one on demand with read_skill_reference using activation ID ${frame.activationId}: ${entry.contract.files.filter((path) => /^(?:scripts|references|assets|evals)\//.test(path)).join(', ')}`
                : '',
              `When finished, call complete_skill with this activation ID: ${frame.activationId}. Its output must match the contract schema.`,
            ]
              .filter(Boolean)
              .join('\n\n'),
          ]
        : [];
    });
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

export function resolveContextProjectionEnvironment(input: {
  state: RuntimeState;
  config: AgentConfig;
  model: SupportedChatModel;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  subagentEventSink?: SubAgentEventSink;
  signal?: AbortSignal;
  mcpBindings?: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }>;
  disclosedDescriptors?: import('@/protocol/capabilities').CapabilityDescriptor[];
  sandboxBackend?: SandboxBackend | 'unknown';
}): ContextProjectionEnvironment {
  const flags = getFeatureFlags(input.config);
  const descriptors = [
    ...(input.mcpManager?.getCapabilitySnapshot().descriptors ?? []),
    ...(input.skillCatalog?.capabilities.descriptors ?? []),
  ];
  const persistedBindings =
    input.mcpBindings ??
    Object.values(input.state.capabilities.bindings).flatMap((binding) => {
      const descriptor = descriptors.find(
        (candidate) =>
          candidate.capabilityId === binding.capabilityId &&
          candidate.revision === binding.capabilityRevision,
      );
      return descriptor ? [{ binding, descriptor }] : [];
    });
  const disclosedDescriptors =
    input.disclosedDescriptors ??
    descriptors.filter((descriptor) => {
      const disclosure = input.state.capabilities.disclosures[descriptor.capabilityId];
      return disclosure?.capabilityRevision === descriptor.revision;
    });
  const tools = boundedCancellationTools(
    createAgentTools({
      workspace: input.state.session.workspace,
      shellExecutor: input.shellExecutor,
      gitBroker: input.gitBroker,
      mcpManager: input.mcpManager,
      mcpBindings: persistedBindings,
      toolSearch:
        getFeatureFlags(input.config).toolSearchV1 && input.model.supportsToolCalls !== false,
      skills: input.skills,
      skillOptions: input.skillOptions,
      skillCatalog: input.skillCatalog,
      activeSkillFrames: activeSkillFramesForCurrentWork(input.state).filter(
        (frame) => frame.contextMode === 'inline',
      ),
      config: input.config,
      subagentEventSink: input.subagentEventSink,
      subagentSignal: input.signal,
      signal: input.signal,
      model: input.model,
      threadId: input.state.session.threadId,
      authorization: input.state.authorization,
      workspaceAccess: input.state.workspaceAccess,
      phase: getAgentPhase(getActivePlanning(input.state)),
      interactionMode: getEffectiveInteractionMode(input.state),
    }),
    input.config,
  );
  return {
    serializedTools: serializeToolDescriptors(tools as unknown as Record<string, unknown>),
    activeSkillInstructions: activeInlineSkillInstructions(input.state, input.skillCatalog),
    workflowSkills: disclosedDescriptors
      .filter((descriptor) => descriptor.kind === 'skill')
      .map((descriptor) => ({
        capabilityId: descriptor.capabilityId,
        description: descriptor.description,
      })),
    promptContractVersion: flags.promptContractV2 ? 'v2' : 'legacy',
    projectInstructions: flags.promptContractV2
      ? resolveProjectInstructionSnapshot({
          workspace: input.state.session.workspace,
          state: input.state,
        })
      : undefined,
    sandboxBackend: input.sandboxBackend ?? 'unknown',
    leaseMetadata: {
      providerName: input.config.providerName,
      modelName: input.config.modelName,
      modelCapabilities: resolveModelCapabilities({
        config: input.config,
        adapter: input.model.capabilityMetadata,
      }),
      estimator: 'countTokens:v1',
      summaryPolicy: input.config.compaction ?? {},
    },
  };
}

function positiveConfigNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Kernel-native model effect.  It uses only RuntimeState and emits all model
 * facts required by the reducer, including transient retry events captured
 * from the model's built-in retry listener.
 */
export async function invokeRuntimeModel(params: {
  model: SupportedChatModel;
  state: RuntimeState;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
  sandboxBackend?: SandboxBackend | 'unknown';
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  subagentEventSink?: SubAgentEventSink;
  signal?: AbortSignal;
  /** Persists bindings before the model can emit a dynamic MCP tool call. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  compactionReporter?: CompactionReporter;
  /** Production composition must supply the immutable route-policy gate. */
  providerDataAdmission?: ProviderDataAdmissionGateV1;
  resourceAdmission?: { inputTokens: number; maxOutputTokens: number };
  /** Required on every dispatching path; optional only for pre-dispatch unit branches. */
  modelInvocationGateway?: ModelInvocationGatewayV1;
  modelInvocationPersistence?: ModelInvocationPersistenceV1;
}): Promise<RuntimeEvent[]> {
  const { state } = params;
  const flags = getFeatureFlags(params.config);
  if (params.skillCatalog && params.state.skills.catalogRevision !== params.skillCatalog.revision) {
    params.emitRuntimeEvent?.({
      type: 'skill.catalog_refreshed',
      catalogRevision: params.skillCatalog.revision,
    });
  }
  if (params.skillCatalog) {
    for (const frame of Object.values(params.state.skills.frames)) {
      if (frame.status !== 'active') continue;
      const reason = skillFrameInvalidationReason(frame, params.skillCatalog);
      if (reason) {
        params.emitRuntimeEvent?.({
          type: 'skill.frame_closed',
          activationId: frame.activationId,
          status: 'invalidated',
          reason,
          closedAt: new Date().toISOString(),
        });
      }
    }
  }
  const capabilitySnapshot = searchableCapabilitySnapshot({
    mcp: params.mcpManager?.getCapabilitySnapshot(),
    skills: params.skillCatalog?.capabilities,
  });
  const modelCapabilities = resolveModelCapabilities({
    config: params.config,
    adapter: params.model.capabilityMetadata,
  });
  const disclosure = chooseCapabilityDisclosure({
    featureEnabled: flags.toolSearchV1,
    providerSupportsToolCalls: params.model.supportsToolCalls !== false,
    descriptors: capabilitySnapshot.descriptors,
    contextWindowTokens: modelCapabilities.contextWindowTokens,
    budgetTokens: positiveConfigNumber(params.config.modelKwargs?.capabilityDisclosureBudgetTokens),
  });
  const pendingSearch = state.capabilities.pendingSearch;
  const searchToConsume = pendingSearch;
  const currentSearch =
    pendingSearch?.requestedAtTurnId === state.turn.turnId &&
    pendingSearch.catalogRevision === capabilitySnapshot.revision
      ? pendingSearch
      : undefined;
  const searchedDescriptors =
    flags.toolSearchV1 && currentSearch
      ? currentSearch.candidates.flatMap((candidate) => {
          const descriptor = capabilitySnapshot.descriptors.find(
            (item) =>
              item.capabilityId === candidate.capabilityId &&
              item.revision === candidate.capabilityRevision,
          );
          return descriptor ? [descriptor] : [];
        })
      : [];
  const loadedMcpDescriptors = Object.values(state.capabilities.loadedCapabilities ?? {}).flatMap(
    (loaded) => {
      const descriptor = capabilitySnapshot.descriptors.find(
        (item) =>
          item.kind === 'mcp_tool' &&
          item.capabilityId === loaded.capabilityId &&
          item.revision === loaded.capabilityRevision,
      );
      return descriptor ? [descriptor] : [];
    },
  );
  const searchedMcpDescriptors = searchedDescriptors.filter(
    (descriptor) => descriptor.kind === 'mcp_tool',
  );
  const disclosedMcpDescriptors = (
    flags.toolSearchV1
      ? disclosure.mode === 'all'
        ? capabilitySnapshot.descriptors.filter((descriptor) => descriptor.kind === 'mcp_tool')
        : [...loadedMcpDescriptors, ...searchedMcpDescriptors]
      : capabilitySnapshot.descriptors.filter((descriptor) => descriptor.kind === 'mcp_tool')
  ).filter(
    (descriptor, index, all) =>
      all.findIndex((candidate) => candidate.capabilityId === descriptor.capabilityId) === index,
  );
  const effectiveSkillMode = disclosure.skillMode ?? disclosure.mode;
  const disclosedSkillDescriptors =
    effectiveSkillMode === 'all'
      ? capabilitySnapshot.descriptors.filter((descriptor) => descriptor.kind === 'skill')
      : effectiveSkillMode === 'search'
        ? searchedDescriptors.filter((descriptor) => descriptor.kind === 'skill')
        : [];
  const disclosedDescriptors = [...disclosedMcpDescriptors, ...disclosedSkillDescriptors];
  const previousLoadedCapabilities = Object.values(state.capabilities.loadedCapabilities ?? {});
  const loadedCapabilities = flags.toolSearchV1
    ? disclosedMcpDescriptors.map((descriptor) => {
        const existing = state.capabilities.loadedCapabilities?.[descriptor.capabilityId];
        return {
          capabilityId: descriptor.capabilityId,
          capabilityRevision: descriptor.revision,
          firstLoadedAtTurnId: existing?.firstLoadedAtTurnId ?? state.turn.turnId,
        };
      })
    : [];
  const loadedSetChanged =
    previousLoadedCapabilities.length !== loadedCapabilities.length ||
    loadedCapabilities.some((loaded) => {
      const previous = state.capabilities.loadedCapabilities?.[loaded.capabilityId];
      return previous?.capabilityRevision !== loaded.capabilityRevision;
    });
  const mcpBindings =
    flags.capabilityCatalogV1 && flags.mcpRuntimeBindingV1
      ? disclosedDescriptors
          .filter(
            (descriptor) =>
              descriptor.kind === 'mcp_tool' && descriptor.availability === 'available',
          )
          .map((descriptor) => ({
            descriptor,
            binding: createBinding({
              descriptor,
              exposedToolName: exposedMcpToolName(descriptor.provider.id, descriptor.displayName),
              turnId: state.turn.turnId,
            }),
          }))
      : [];
  const capabilityDisclosures = flags.toolSearchV1
    ? disclosedDescriptors.map((descriptor) => ({
        capabilityId: descriptor.capabilityId,
        capabilityRevision: descriptor.revision,
        issuedForTurnId: state.turn.turnId,
      }))
    : [];
  if (
    mcpBindings.length > 0 ||
    capabilityDisclosures.length > 0 ||
    searchToConsume ||
    loadedSetChanged
  ) {
    params.emitRuntimeEvent?.({
      type: 'capability.bindings_issued',
      catalogRevision: capabilitySnapshot.revision,
      bindings: mcpBindings.map(({ binding }) => binding),
      disclosures: capabilityDisclosures,
      loadedCapabilities,
      ...(searchToConsume ? { searchId: searchToConsume.searchId } : {}),
    });
  }
  const toolInput = {
    workspace: state.session.workspace,
    shellExecutor: params.shellExecutor,
    gitBroker: params.gitBroker,
    mcpManager: params.mcpManager,
    mcpBindings,
    toolSearch: flags.toolSearchV1 && params.model.supportsToolCalls !== false,
    skills: params.skills,
    skillOptions: params.skillOptions,
    skillCatalog: params.skillCatalog,
    activeSkillFrames: activeSkillFramesForCurrentWork(state).filter(
      (frame) => frame.contextMode === 'inline',
    ),
    config: params.config,
    subagentEventSink: params.subagentEventSink,
    subagentSignal: params.signal,
    signal: params.signal,
    model: params.model,
    threadId: state.session.threadId,
    authorization: state.authorization,
    workspaceAccess: state.workspaceAccess,
    phase: getAgentPhase(getActivePlanning(state)),
    interactionMode: getEffectiveInteractionMode(state),
  };
  const toolAvailCtx = toolAvailabilityContext(toolInput);
  const tools = boundedCancellationTools(createAgentTools(toolInput, toolAvailCtx), params.config);
  const projectionEnvironment = resolveContextProjectionEnvironment({
    state,
    config: params.config,
    model: params.model,
    shellExecutor: params.shellExecutor,
    gitBroker: params.gitBroker,
    mcpManager: params.mcpManager,
    skills: params.skills,
    skillOptions: params.skillOptions,
    skillCatalog: params.skillCatalog,
    subagentEventSink: params.subagentEventSink,
    signal: params.signal,
    mcpBindings,
    disclosedDescriptors,
    sandboxBackend: params.sandboxBackend,
  });
  const { serializedTools, activeSkillInstructions: activeSkillInstr } = projectionEnvironment;
  const workflowSkillDescriptors = projectionEnvironment.workflowSkills;

  const projection = buildContextProjection({
    role: 'agent',
    state,
    serializedTools,
    activeSkillInstructions: activeSkillInstr,
    skills: undefined,
    workflowSkills: workflowSkillDescriptors,
    promptContractVersion: projectionEnvironment.promptContractVersion,
    projectInstructions: projectionEnvironment.projectInstructions,
    sandboxBackend: projectionEnvironment.sandboxBackend,
  });
  const preflight = preflightModelContext({
    estimate: projection.estimate,
    capabilities: modelCapabilities,
    requestMaxOutputTokens:
      positiveConfigNumber(params.config.modelKwargs?.maxOutputTokens) ??
      positiveConfigNumber(params.config.modelKwargs?.maxTokens),
    providerSafetyRatio: params.config.compaction?.providerSafetyRatio,
    compactRatio: params.config.compaction?.compactRatio,
    hardRatio: params.config.compaction?.hardRatio,
    warningRatio: params.config.compaction?.warningRatio,
  });
  const contextMetricsEvent: RuntimeEvent = {
    type: 'model.context_metrics',
    modelName: modelCapabilities.modelName,
    ...(modelCapabilities.contextWindowTokens
      ? { contextWindowTokens: modelCapabilities.contextWindowTokens }
      : {}),
    ...(modelCapabilities.contextWindowSource
      ? { contextWindowSource: modelCapabilities.contextWindowSource }
      : {}),
    ...(modelCapabilities.tokenizerSource
      ? { tokenizerSource: modelCapabilities.tokenizerSource }
      : {}),
    ...(preflight.usableInputTokens ? { usableInputTokens: preflight.usableInputTokens } : {}),
    reservedOutputTokens: preflight.reservedOutputTokens,
    providerSafetyMarginTokens: preflight.providerSafetyMarginTokens,
    totalInputTokens: preflight.estimate.totalInputTokens,
    ...(preflight.utilization != null ? { utilization: preflight.utilization } : {}),
    status: preflight.status,
    estimate: preflight.estimate,
  };
  params.compactionReporter?.recordContextFollowUp?.(
    state.turn.turnIndex,
    preflight.estimate.totalInputTokens,
  );
  const automaticCompaction = decideAutomaticContextCompaction({
    state,
    preflight,
    mode: resolveContextCompactionRollout({
      masterEnabled: flags.contextCompactionV2 && flags.contextCompactionAutoV1,
      configuredMode: params.config.compaction?.autoMode,
      cohortSalt: params.config.compaction?.cohortSalt,
      sessionId: state.session.threadId,
      livePercentage: params.config.compaction?.livePercentage,
    }),
    triggerRatio: params.config.compaction?.triggerRatio ?? params.config.compaction?.compactRatio,
    compactAfterEstimatedTokens: params.config.compaction?.compactAfterEstimatedTokens,
    cooldownTurns: params.config.compaction?.cooldownTurns,
    minimumReductionRatio: params.config.compaction?.minimumReductionRatio,
    maxSummaryTokens: params.config.compaction?.maxSummaryTokens,
  });
  if (automaticCompaction.action === 'request_compaction') {
    params.compactionReporter?.recordRequested();
    return [
      contextMetricsEvent,
      {
        type: 'context.compaction_requested',
        compactionId: automaticCompaction.compactionId,
        reason: automaticCompaction.reason,
        requestedAtRevision: state.revision,
        requestedAtTurnId: state.turn.turnId,
        force: false,
        estimate: preflight.estimate,
      },
    ];
  }
  if (
    params.resourceAdmission &&
    params.resourceAdmission.inputTokens !== preflight.estimate.totalInputTokens
  ) {
    throw new Error(
      'Model request projection changed after resource admission; refusing Provider dispatch.',
    );
  }
  const callStartedAt = Date.now();
  if (!params.modelInvocationGateway || !params.modelInvocationPersistence) {
    throw new Error('ModelInvocationGateway execution context is unavailable.');
  }
  const compiled = compileModelSurfaceV1({
    purpose: 'primary_agent',
    config: params.config,
    model: params.model,
    tools,
    messages: projection.providerMessages,
    maxOutputTokens:
      params.resourceAdmission?.maxOutputTokens ??
      positiveConfigNumber(params.config.modelKwargs?.maxOutputTokens) ??
      modelCapabilities.maxOutputTokens,
    transport: modelCapabilities.streaming ? 'stream' : 'generate',
    estimatedInputTokens: preflight.estimate.totalInputTokens,
  });
  const pending = await params.modelInvocationGateway.invoke({
    model: params.model,
    compiled,
    persistence: params.modelInvocationPersistence,
    provenance: {
      contextCheckpointId: state.context.activeCheckpoint?.sourceDigest ?? null,
      promptContractVersion: projectionEnvironment.promptContractVersion ?? 'legacy',
      projectionEnvironmentDigest: computeModelInvocationPrivateDigestV1(
        'kite.model-projection-environment.v1',
        digestProjectionEnvironment(projectionEnvironment),
      ),
      capabilityBindingDigest: computeModelInvocationPrivateDigestV1(
        'kite.model-capability-bindings.v1',
        {
          catalogRevision: capabilitySnapshot.revision,
          bindings: mcpBindings.map(({ binding }) => binding),
          disclosures: capabilityDisclosures,
        },
      ),
    },
    providerDataAdmission: params.providerDataAdmission,
    providerDataPolicyRequired: flags.providerDataPolicyV1,
    resourceKind: 'model',
    signal: params.signal,
    emitEphemeral: params.emitRuntimeEvent,
  });
  return pending.commitWith((normalized) => {
    const response = normalizedModelResponseToAIMessageV1(normalized);
    const durationMs = Date.now() - callStartedAt;
    const toolCalls =
      response.tool_calls?.map((call) => ({
        id: call.id ?? crypto.randomUUID(),
        name: call.name,
        args: call.args,
      })) ?? [];
    const invalidToolCalls = (
      (
        response as unknown as {
          invalid_tool_calls?: Array<{ id?: string; name?: string; args?: string; error?: string }>;
        }
      ).invalid_tool_calls ?? []
    )
      .filter(
        (call): call is { id?: string; name: string; args: string; error?: string } =>
          typeof call.name === 'string' && typeof call.args === 'string',
      )
      .map((call) => {
        const invocationFingerprint = toolInvocationFingerprintV1({
          key: params.state.toolRecovery.identityKey,
          toolName: call.name,
          parseCode: 'invalid_json',
          pathCategory: 'unknown',
          unparsedArgs: call.args,
        });
        return {
          id: call.id ?? crypto.randomUUID(),
          name: call.name,
          canonicalInvocationFingerprint: invocationFingerprint,
          args: {
            _invalid_args_code: 'invalid_json' as const,
            _invalid_args_redacted: true as const,
          },
        };
      });
    const providerUsage = response.response_metadata?.usage as
      | {
          input_tokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
        }
      | undefined;
    const providerInputTokens = providerUsage?.input_tokens ?? providerUsage?.prompt_tokens;
    const events: RuntimeEvent[] = [
      contextMetricsEvent,
      {
        type: 'model.responded',
        invocationId: pending.invocationId,
        messageId: response.id ?? pending.invocationId,
        durationMs,
        toolCalls: [...toolCalls, ...invalidToolCalls],
        reasoningText: extractReasoningText(response),
        text: extractText(response.content),
        ...(typeof providerInputTokens === 'number' ? { inputTokens: providerInputTokens } : {}),
        ...(typeof providerUsage?.completion_tokens === 'number'
          ? { outputTokens: providerUsage.completion_tokens }
          : {}),
      },
    ];

    const cacheMetrics = extractPromptCacheMetrics(response);
    if (cacheMetrics && (cacheMetrics.cacheHitTokens > 0 || cacheMetrics.cacheMissTokens > 0)) {
      events.push({
        type: 'model.cache_metrics',
        inputTokens: cacheMetrics.inputTokens,
        cacheHitTokens: cacheMetrics.cacheHitTokens,
        cacheMissTokens: cacheMetrics.cacheMissTokens,
        hitRate: cacheMetrics.hitRate,
      });
    }

    const messageId = response.id ?? pending.invocationId;
    let ordinal = 0;
    for (const call of toolCalls) {
      const capability =
        builtinToolRegistry.effectsOf(call.name, call.args, toolAvailCtx) ??
        classifyToolCapability(call.name, call.args);
      const bindingEntry = mcpBindings.find(
        ({ binding: candidate }) => candidate.exposedToolName === call.name,
      );
      const binding = bindingEntry?.binding;
      const dynamicIdentity = bindingEntry
        ? canonicalizeCapabilityArguments(bindingEntry.descriptor.inputSchema, call.args)
        : undefined;
      const parsedIdentity = bindingEntry
        ? undefined
        : builtinToolRegistry.parseToolCall(call, toolAvailCtx);
      const invocationFingerprint = toolInvocationFingerprintV1({
        key: params.state.toolRecovery.identityKey,
        toolName: call.name,
        identityRevision:
          binding?.capabilityRevision ??
          (() => {
            const spec = builtinToolRegistry.get(call.name);
            return spec ? builtinToolRegistry.descriptorOf(spec).revision : 'unknown';
          })(),
        ...(dynamicIdentity?.ok
          ? { parsedArgs: dynamicIdentity.args }
          : parsedIdentity?.ok
            ? { parsedArgs: parsedIdentity.args }
            : {
                parseCode: bindingEntry
                  ? 'invalid_arguments'
                  : parsedIdentity?.code === 'unknown_tool'
                    ? 'unknown_tool'
                    : parsedIdentity?.code === 'tool_unavailable'
                      ? 'tool_unavailable'
                      : 'invalid_arguments',
                pathCategory: 'unknown',
                unparsedArgs: call.args,
              }),
      });
      const unknownFields = call.name.startsWith('mcp__')
        ? (() => {
            const schema = mcpBindings.find(
              ({ binding: candidate }) => candidate.exposedToolName === call.name,
            )?.descriptor.inputSchema as { properties?: Record<string, unknown> } | undefined;
            return observeUnknownToolFieldsV1({
              toolName: call.name,
              args: call.args,
              knownFields: Object.keys(schema?.properties ?? {}),
              schemaRevision: binding?.capabilityRevision.slice(0, 64) ?? 'dynamic',
            });
          })()
        : builtinToolRegistry.unknownFieldsOf(call.name, call.args, toolAvailCtx);
      events.push({
        type: 'tool.queued',
        toolCallId: call.id,
        modelInvocationId: pending.invocationId,
        taskId: params.state.activeTaskId ?? undefined,
        name: call.name,
        args: call.args,
        modelMessageId: messageId,
        ordinal: ordinal++,
        effectClass: capability.effectClass,
        sideEffect: capability.sideEffect,
        classificationReason: capability.classificationReason,
        invocationFingerprint,
        unknownFields,
        ...(binding
          ? {
              bindingId: binding.bindingId,
              capabilityId: binding.capabilityId,
              capabilityRevision: binding.capabilityRevision,
            }
          : {}),
      });
    }
    events.push(
      ...eventsForInvalidModelToolCalls(
        invalidToolCalls,
        messageId,
        ordinal,
        params.state.toolRecovery.identityKey,
        pending.invocationId,
      ),
    );
    return { events, value: [] };
  });
}
