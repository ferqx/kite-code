// ── Model Controller / 模型控制器 ──
// Kernel 原生模型调用：从 RuntimeState 构建上下文 → 调用模型 → 返回 RuntimeEvent[]。
// 不依赖 LangGraph 状态、不产生副作用。
//
// Kernel-native model invocation: build context from RuntimeState → call model → return RuntimeEvent[].
// No LangGraph state dependency, no side effects.

import type {
  BuiltinModelToolCatalogEntry,
  BuiltinModelToolSet,
  BuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import {
  chooseCapabilityDisclosure,
  createCapabilityBinding,
  failClosedBuiltinToolCapability as failClosedToolCapability,
  projectBuiltinUnknownToolFieldsObservation,
  searchableCapabilitySnapshot,
} from '@kite-ai/builtin-runtime';
import { exposedMcpToolName, type McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import type {
  BuiltinModelEffectCoordinator,
  CompactionReporter,
  SupportedChatModel,
} from '@kite-ai/builtin-runtime/model';
import {
  type ContextProjectionEnvironment,
  type ModelInvocationPersistence,
  resolveModelCapabilities,
  resolveProjectInstructionSnapshot,
  serializeToolDescriptors,
} from '@kite-ai/builtin-runtime/model';
import type { SandboxBackend, ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import type {
  SkillCatalogSnapshot,
  SkillManifest,
  SkillScanOptions,
} from '@kite-ai/builtin-runtime/skills';
import {
  canonicalizeCapabilityArguments,
  skillFrameInvalidationReason,
} from '@kite-ai/builtin-runtime/skills';
import type { SubagentTaskArtifactAccess } from '@kite-ai/builtin-runtime/subagent';
import {
  createBuiltinModelToolSurfaceFromProjection,
  getRoleConfig,
} from '@kite-ai/builtin-runtime/subagent';
import { getAgentPhase, type SubAgentEventSink } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateActiveSkillFrames as activeSkillFramesForCurrentWork,
  runtimeHostStateClassifyFailure as classifyFailure,
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateEffectiveInteractionMode as getEffectiveInteractionMode,
  runtimeHostStateClassifyToolOutcome,
  runtimeHostStateToolInvocationFingerprint as toolInvocationFingerprint,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { CapabilityTurnContext } from '@kite-ai/runtime-spi';
import { getFeatureFlags } from '#kite-service/config/features';
import type { AgentConfig } from '#kite-service/config/index';
import type { RuntimeEvent, RuntimeState } from './state-runtime';
import { createAppToolTurnContext } from './tool-turn-context';

function boundedCancellationTools<T extends Record<string, unknown>>(
  tools: T,
  config: AgentConfig,
  entries: readonly BuiltinModelToolCatalogEntry[],
): T {
  const flags = getFeatureFlags(config);
  if (!flags.resourceBudget || flags.boundedCancellation) return tools;
  // The cancellation surface is derived from the immutable Builtin catalog.
  // It must not grow a second name-based policy table in Core.  Planning
  // reads remain available; planning writes and filesystem writes are bounded
  // because their catalog-declared effects can consume durable resources.
  const boundedNames = new Set(
    entries
      .filter((entry) => {
        if (entry.executionMechanism === 'subagent' || entry.executionMechanism === 'shell') {
          return true;
        }
        if (entry.executionMechanism === 'filesystem') {
          return entry.effects.filesystem === 'write' || entry.effects.filesystem === 'destructive';
        }
        return entry.executionMechanism === 'planning' && entry.effects.filesystem !== 'read';
      })
      .map((entry) => entry.name),
  );
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !boundedNames.has(name))) as T;
}

type DelegatedToolCeiling = Readonly<{
  grantDigest: string;
  role: 'explore' | 'plan' | 'code' | 'review';
  allowedTools: readonly string[];
  denyTools?: true;
}>;

export function delegatedToolSurface<T extends Record<string, unknown>>(
  tools: T,
  state: RuntimeState,
  ceiling?: DelegatedToolCeiling,
): T {
  const origin = state.childSessionOrigin;
  if (!origin) return tools;
  const followup = state.activeFollowupTurn;
  if (
    !ceiling ||
    ceiling.grantDigest !== (followup?.grantDigest ?? origin.grantDigest) ||
    ceiling.role !== origin.role
  )
    throw new Error('Child Session model surface lacks its exact sealed grant ceiling.');
  if (followup) {
    if (
      state.resourceBudget.status !== 'active' ||
      state.resourceBudget.budget.unboundedToolInvocations !== true
    ) {
      if (ceiling.denyTools !== true || ceiling.allowedTools.length !== 0)
        throw new Error('Child followup Model surface must deny every Tool.');
      return {} as T;
    }
    if (ceiling.denyTools === true) {
      if (ceiling.allowedTools.length !== 0)
        throw new Error('Legacy child followup must deny every Tool.');
      return {} as T;
    }
    if (
      ceiling.allowedTools.length === 0 ||
      new Set(ceiling.allowedTools).size !== ceiling.allowedTools.length ||
      ceiling.allowedTools.includes('task')
    )
      throw new Error('Independent child followup lacks an exact Tool grant.');
  }
  const allowed = getRoleConfig(origin.role).allowedTools;
  const unrestrictedCode = origin.role === 'code' && ceiling.allowedTools.length === 0;
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) =>
        name !== 'task' &&
        (!allowed || allowed.has(name)) &&
        (unrestrictedCode || ceiling.allowedTools.includes(name)),
    ),
  ) as T;
}

function projectBuiltinUnknownFields(
  entry: BuiltinModelToolCatalogEntry | undefined,
  toolName: string,
  args: unknown,
  context: CapabilityTurnContext,
) {
  if (!entry) {
    return projectBuiltinUnknownToolFieldsObservation({
      toolName,
      unknownFieldCount:
        args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).length : 0,
      schemaRevision: 'unknown',
    });
  }
  const observed = entry.observeUnknownFields(args, context);
  return projectBuiltinUnknownToolFieldsObservation({
    toolName,
    unknownFieldCount: observed.count,
    schemaRevision: entry.descriptor.revision.slice(0, 64),
  });
}

/** Convert invalid provider tool arguments into durable queued-and-failed facts. */
export function eventsForInvalidModelToolCalls(
  calls: Array<{
    id: string;
    name: string;
    args: {
      _raw_invalid_args?: unknown;
      _parse_error?: string;
      _invalid_args_code?: 'invalid_json' | 'invalid_arguments';
      _invalid_args_redacted?: true;
    };
    canonicalInvocationFingerprint?: string;
  }>,
  messageId: string,
  ordinalStart: number,
  modelInvocationId?: string,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const [index, call] of calls.entries()) {
    const parseCode = call.args._invalid_args_code ?? 'invalid_json';
    const invocationFingerprint =
      call.canonicalInvocationFingerprint ??
      toolInvocationFingerprint({
        toolName: call.name,
        parseCode,
        pathCategory: 'unknown',
        unparsedArgs: call.args._raw_invalid_args ?? call.args,
      });
    const opaqueArgs = {
      _invalid_args_code: parseCode,
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
      // Invalid arguments have no trustworthy capability classification; keep
      // the terminal diagnostic standalone rather than reclassifying it from
      // the provider-supplied tool name in the Client projector.
      presentation: 'standalone' as const,
    };
    const failure = classifyFailure(
      'model_invalid_tool_args',
      'Provider returned invalid tool arguments.',
      parseCode,
    );
    events.push(queued, {
      type: 'tool.failed' as const,
      toolCallId: call.id,
      failure,
      outcome: runtimeHostStateClassifyToolOutcome({
        status: 'failed',
        failure,
        authority: {
          dispatchState: 'not_started',
          externalEffects: 'none',
          replaySafety: 'pre_dispatch',
        },
      }),
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
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  subagentEventSink?: SubAgentEventSink;
  agentMailboxAvailable?: boolean;
  agentMailboxQueueOnlyAvailable?: boolean;
  delegatedTaskArtifacts?: Pick<SubagentTaskArtifactAccess, 'read'>;
  subagentTaskRequests?: import('@kite-ai/builtin-runtime/subagent').SubagentTaskRequestArtifactAccess;
  childToolCeiling?: DelegatedToolCeiling;
  signal?: AbortSignal;
  mcpBindings?: Array<{
    binding: import('@kite-ai/runtime-contract').CapabilityBinding;
    descriptor: import('@kite-ai/runtime-contract').CapabilityDescriptor;
  }>;
  disclosedDescriptors?: import('@kite-ai/runtime-contract').CapabilityDescriptor[];
  sandboxBackend?: SandboxBackend | 'unknown';
  builtinToolCatalog: BuiltinToolCatalogProjection;
  projectedTools?: BuiltinModelToolSet;
}): ContextProjectionEnvironment {
  const delegatedTask = (() => {
    const origin = input.state.childSessionOrigin;
    if (!origin) return undefined;
    if (!origin.taskInputAdmitted || !input.delegatedTaskArtifacts) {
      throw new Error('Child Session task input is not durably admitted.');
    }
    const payload = input.delegatedTaskArtifacts.read(origin.taskArtifactRef, {
      parentInvocationId: origin.parentInvocationId,
      parentAttempt: origin.attempt,
      parentToolCallId: origin.parentToolCallId,
      childInvocationId: origin.childInvocationId,
      taskDigest: origin.taskTextDigest,
    });
    return Object.freeze({
      childInvocationId: origin.childInvocationId,
      role: origin.role,
      task: payload.task,
      taskTextDigest: origin.taskTextDigest,
    });
  })();
  const transcriptToolCallArgs: Record<string, Readonly<Record<string, unknown>>> = {};
  const checkpointId = input.state.context.activeCheckpoint?.coveredThroughMessageId;
  const checkpointIndex = checkpointId
    ? input.state.transcript.messages.findIndex((message) => message.messageId === checkpointId)
    : -1;
  for (const message of input.state.transcript.messages.slice(checkpointIndex + 1)) {
    if (message.kind !== 'assistant') continue;
    for (const call of message.toolCalls) {
      const args = call.args;
      if (
        call.name !== 'task' ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        !Object.hasOwn(args, 'taskArtifact')
      )
        continue;
      const durable = input.state.tools.calls[call.id];
      if (
        !input.subagentTaskRequests ||
        !durable?.modelInvocationId ||
        durable.modelMessageId !== message.messageId ||
        durable.name !== call.name
      )
        throw new Error('Private task history could not be restored.');
      const record = args as Record<string, unknown>;
      const restored = input.subagentTaskRequests.read(
        record.taskArtifact as import('@kite-ai/runtime-spi').SubagentTaskRequestArtifact,
        { parentModelInvocationId: durable.modelInvocationId, parentToolCallId: call.id },
      );
      if (restored.name !== record.name || restored.role !== record.subagent_type)
        throw new Error('Private task history identity does not match.');
      transcriptToolCallArgs[call.id] = {
        name: restored.name,
        subagent_type: restored.role,
        task: restored.task,
        ...(typeof record.background === 'boolean' ? { background: record.background } : {}),
        ...(record.result_disposition === 'required' || record.result_disposition === 'after_turn'
          ? { result_disposition: record.result_disposition }
          : {}),
      };
    }
  }
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
  const toolInput = {
    workspace: input.state.session.workspace,
    shellExecutor: input.shellExecutor,
    mcpManager: input.mcpManager,
    mcpBindings: persistedBindings,
    toolSearch: getFeatureFlags(input.config).toolSearch && input.model.supportsToolCalls !== false,
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
    workspaceAccess: input.state.workspaceAccess,
    phase: getAgentPhase(getActivePlanning(input.state)),
    interactionMode: getEffectiveInteractionMode(input.state),
    turnId: input.state.turn.turnId,
    activeTaskId: input.state.activeTaskId ?? undefined,
  };
  const builtinTurnContext = createAppToolTurnContext({
    workspace: toolInput.workspace,
    config: toolInput.config,
    threadId: toolInput.threadId,
    turnId: toolInput.turnId,
    activeTaskId: toolInput.activeTaskId,
    phase: toolInput.phase,
    interactionMode: toolInput.interactionMode,
    hasTaskAdapter: Boolean(toolInput.subagentEventSink && toolInput.config),
    agentMailboxAvailable: input.agentMailboxAvailable,
    agentMailboxQueueOnlyAvailable: input.agentMailboxQueueOnlyAvailable,
    toolSearchEnabled: toolInput.toolSearch,
    activeSkillFrames: toolInput.activeSkillFrames,
    skillCatalog: toolInput.skillCatalog,
  });
  const builtinProjection = input.builtinToolCatalog.forTurn(builtinTurnContext);
  const tools = delegatedToolSurface(
    input.projectedTools ??
      boundedCancellationTools(
        createBuiltinModelToolSurfaceFromProjection({
          projection: builtinProjection,
          turnContext: builtinTurnContext,
          executionCapabilitySurface: input.config.executionCapabilitySurface,
          canSpawnSubagents: input.state.childSessionOrigin === undefined,
          exposeInterrupts: true,
          dynamicMcpBindings: persistedBindings,
        }).tools,
        input.config,
        builtinProjection.entries.filter(
          (entry): entry is BuiltinModelToolCatalogEntry => entry.visibility === 'model',
        ),
      ),
    input.state,
    input.childToolCeiling,
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
    promptContractVersion: 'current',
    projectInstructions: resolveProjectInstructionSnapshot({
      workspace: input.state.session.workspace,
      state: input.state,
    }),
    sandboxBackend: input.sandboxBackend ?? 'unknown',
    ...(delegatedTask ? { delegatedTask } : {}),
    ...(Object.keys(transcriptToolCallArgs).length > 0 ? { transcriptToolCallArgs } : {}),
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
 * State 27 adapter for the Builtin-owned primary Model effect. Dynamic MCP/Skill
 * disclosure and RuntimeEvent projection remain explicit compatibility facts;
 * Context, Prompt, Surface, admission, and dispatch are owned by the coordinator.
 */
export async function projectPrimaryModelEffect(params: {
  model: SupportedChatModel;
  state: RuntimeState;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  sandboxBackend?: SandboxBackend | 'unknown';
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  subagentEventSink?: SubAgentEventSink;
  agentMailboxAvailable?: boolean;
  agentMailboxQueueOnlyAvailable?: boolean;
  delegatedTaskArtifacts?: Pick<SubagentTaskArtifactAccess, 'read'>;
  childToolCeiling?: DelegatedToolCeiling;
  prepareAgentMail?: import('@kite-ai/builtin-runtime/model').BuiltinPrimaryModelEffectInput<
    RuntimeState,
    RuntimeEvent,
    RuntimeEvent[]
  >['prepareAgentMail'];
  signal?: AbortSignal;
  /** Persists bindings before the model can emit a dynamic MCP tool call. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  compactionReporter?: CompactionReporter;
  resourceAdmission?: { inputTokens: number; maxOutputTokens?: number };
  firstAttemptTimeoutMs?: number;
  replaceReservationId?: string;
  /** App-owned coordinator bound to the one Gateway for every Model effect. */
  modelEffectCoordinator: BuiltinModelEffectCoordinator;
  modelInvocationPersistence?: ModelInvocationPersistence<RuntimeState, RuntimeEvent>;
  subagentTaskRequests?: import('@kite-ai/builtin-runtime/subagent').SubagentTaskRequestArtifactAccess;
  builtinToolCatalog: BuiltinToolCatalogProjection;
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
    featureEnabled: flags.toolSearch,
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
    flags.toolSearch && currentSearch
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
    flags.toolSearch
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
  const loadedCapabilities = flags.toolSearch
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
    flags.capabilityCatalog && flags.mcpRuntimeBinding
      ? disclosedDescriptors
          .filter(
            (descriptor) =>
              descriptor.kind === 'mcp_tool' && descriptor.availability === 'available',
          )
          .map((descriptor) => ({
            descriptor,
            binding: createCapabilityBinding({
              capabilityId: descriptor.capabilityId,
              capabilityRevision: descriptor.revision,
              exposedToolName: exposedMcpToolName(descriptor.provider.id, descriptor.displayName),
              inputSchema: descriptor.inputSchema ?? {},
              turnId: state.turn.turnId,
            }),
          }))
      : [];
  const capabilityDisclosures = flags.toolSearch
    ? disclosedDescriptors.map((descriptor) => ({
        capabilityId: descriptor.capabilityId,
        capabilityRevision: descriptor.revision,
        issuedForTurnId: state.turn.turnId,
      }))
    : [];
  const firstCatalogSnapshot =
    state.capabilities.catalogRevision === '' &&
    Object.keys(state.capabilities.bindings).length === 0 &&
    Object.keys(state.capabilities.disclosures).length === 0 &&
    Object.keys(state.capabilities.loadedCapabilities).length === 0;
  if (
    firstCatalogSnapshot ||
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
    mcpManager: params.mcpManager,
    mcpBindings,
    toolSearch: flags.toolSearch && params.model.supportsToolCalls !== false,
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
    workspaceAccess: state.workspaceAccess,
    phase: getAgentPhase(getActivePlanning(state)),
    interactionMode: getEffectiveInteractionMode(state),
    turnId: state.turn.turnId,
    activeTaskId: state.activeTaskId ?? undefined,
  };
  const builtinTurnContext = createAppToolTurnContext({
    workspace: toolInput.workspace,
    config: toolInput.config,
    threadId: toolInput.threadId,
    turnId: toolInput.turnId,
    activeTaskId: toolInput.activeTaskId,
    phase: toolInput.phase,
    interactionMode: toolInput.interactionMode,
    hasTaskAdapter: Boolean(toolInput.subagentEventSink && toolInput.config),
    agentMailboxAvailable: params.agentMailboxAvailable,
    agentMailboxQueueOnlyAvailable: params.agentMailboxQueueOnlyAvailable,
    toolSearchEnabled: toolInput.toolSearch,
    activeSkillFrames: toolInput.activeSkillFrames,
    skillCatalog: toolInput.skillCatalog,
  });
  const builtinProjection = params.builtinToolCatalog.forTurn(builtinTurnContext);
  const tools = delegatedToolSurface(
    boundedCancellationTools(
      createBuiltinModelToolSurfaceFromProjection({
        projection: builtinProjection,
        turnContext: builtinTurnContext,
        executionCapabilitySurface: params.config.executionCapabilitySurface,
        canSpawnSubagents: state.childSessionOrigin === undefined,
        exposeInterrupts: true,
        dynamicMcpBindings: mcpBindings,
      }).tools,
      params.config,
      builtinProjection.entries.filter(
        (entry): entry is BuiltinModelToolCatalogEntry => entry.visibility === 'model',
      ),
    ),
    state,
    params.childToolCeiling,
  );
  const builtinEntriesByName = new Map<string, BuiltinModelToolCatalogEntry>(
    builtinProjection.entries.flatMap((entry) =>
      entry.visibility === 'model' ? ([[entry.name, entry]] as const) : [],
    ),
  );
  const projectionEnvironment = resolveContextProjectionEnvironment({
    state,
    config: params.config,
    model: params.model,
    shellExecutor: params.shellExecutor,
    mcpManager: params.mcpManager,
    skills: params.skills,
    skillOptions: params.skillOptions,
    skillCatalog: params.skillCatalog,
    subagentEventSink: params.subagentEventSink,
    signal: params.signal,
    mcpBindings,
    disclosedDescriptors,
    sandboxBackend: params.sandboxBackend,
    builtinToolCatalog: params.builtinToolCatalog,
    projectedTools: tools,
    delegatedTaskArtifacts: params.delegatedTaskArtifacts,
    subagentTaskRequests: params.subagentTaskRequests,
    childToolCeiling: params.childToolCeiling,
  });
  const result = await params.modelEffectCoordinator.executePrimaryModelEffect({
    state,
    config: params.config,
    model: params.model,
    tools,
    projectionEnvironment,
    capabilityBindingFacts: {
      catalogRevision: capabilitySnapshot.revision,
      bindings: mcpBindings.map(({ binding }) => binding),
      disclosures: capabilityDisclosures,
    },
    autoCompaction: {
      masterEnabled: flags.contextCompaction && flags.contextCompactionAuto,
    },
    resourceAdmission: params.resourceAdmission,
    ...(params.firstAttemptTimeoutMs === undefined
      ? {}
      : { firstAttemptTimeoutMs: params.firstAttemptTimeoutMs }),
    ...(params.replaceReservationId ? { replaceReservationId: params.replaceReservationId } : {}),
    persistence: params.modelInvocationPersistence,
    prepareAgentMail: params.prepareAgentMail,
    compactionReporter: params.compactionReporter,
    signal: params.signal,
    emitEphemeral: params.emitRuntimeEvent,
    finalize: (completion, contextMetricsEvent) => {
      const validToolCalls = completion.toolCalls.filter((call) => {
        const builtinEntry = builtinEntriesByName.get(call.name);
        return (
          builtinEntry?.executionMechanism !== 'subagent' ||
          builtinEntry.parseModelInput(call.args, builtinTurnContext).success
        );
      });
      const invalidToolCalls: Array<{
        id: string;
        name: string;
        canonicalInvocationFingerprint: string;
        args: {
          _invalid_args_code: 'invalid_json' | 'invalid_arguments';
          _invalid_args_redacted: true;
        };
      }> = completion.invalidToolCalls.map((call) => {
        const invocationFingerprint = toolInvocationFingerprint({
          toolName: call.name,
          parseCode: 'invalid_json',
          pathCategory: 'unknown',
          unparsedArgs: call.unparsedArgs,
        });
        return {
          id: call.id,
          name: call.name,
          canonicalInvocationFingerprint: invocationFingerprint,
          args: {
            _invalid_args_code: 'invalid_json' as const,
            _invalid_args_redacted: true as const,
          },
        };
      });
      for (const call of completion.toolCalls) {
        if (validToolCalls.includes(call)) continue;
        invalidToolCalls.push({
          id: call.id,
          name: call.name,
          canonicalInvocationFingerprint: toolInvocationFingerprint({
            toolName: call.name,
            parseCode: 'invalid_arguments',
            pathCategory: 'unknown',
            unparsedArgs: call.args,
          }),
          args: {
            _invalid_args_code: 'invalid_arguments',
            _invalid_args_redacted: true,
          },
        });
      }
      const durableToolCalls = validToolCalls.map((call) => {
        const builtinEntry = builtinEntriesByName.get(call.name);
        if (builtinEntry?.executionMechanism !== 'subagent') return call;
        const name = call.args.name;
        const role = call.args.subagent_type;
        const task = call.args.task;
        if (!params.subagentTaskRequests) {
          throw new Error('Private Subagent task request Artifact storage is unavailable.');
        }
        if (
          typeof name !== 'string' ||
          (role !== 'explore' && role !== 'plan' && role !== 'code' && role !== 'review') ||
          typeof task !== 'string'
        )
          throw new Error('Validated Subagent task arguments are unavailable.');
        return {
          ...call,
          args: {
            name,
            subagent_type: role,
            taskArtifact: params.subagentTaskRequests.write({
              parentModelInvocationId: completion.invocationId,
              parentToolCallId: call.id,
              name,
              role: role as 'explore' | 'plan' | 'code' | 'review',
              task,
            }),
            ...(call.args.background === undefined ? {} : { background: call.args.background }),
            ...(call.args.result_disposition === undefined
              ? {}
              : { result_disposition: call.args.result_disposition }),
          },
        };
      });
      const events: RuntimeEvent[] = [
        contextMetricsEvent,
        {
          type: 'model.responded',
          invocationId: completion.invocationId,
          messageId: completion.messageId,
          durationMs: completion.durationMs,
          toolCalls: [...durableToolCalls, ...invalidToolCalls],
          ...(completion.reasoningText === undefined
            ? {}
            : { reasoningText: completion.reasoningText }),
          ...(completion.text === undefined ? {} : { text: completion.text }),
          ...(completion.inputTokens === undefined ? {} : { inputTokens: completion.inputTokens }),
          ...(completion.outputTokens === undefined
            ? {}
            : { outputTokens: completion.outputTokens }),
        },
      ];

      const cacheMetrics = completion.cacheMetrics;
      if (cacheMetrics && (cacheMetrics.cacheHitTokens > 0 || cacheMetrics.cacheMissTokens > 0)) {
        events.push({
          type: 'model.cache_metrics',
          inputTokens: cacheMetrics.inputTokens,
          cacheHitTokens: cacheMetrics.cacheHitTokens,
          cacheMissTokens: cacheMetrics.cacheMissTokens,
          hitRate: cacheMetrics.hitRate,
        });
      }

      let ordinal = 0;
      for (const [index, call] of validToolCalls.entries()) {
        const durableCall = durableToolCalls[index];
        if (!durableCall) throw new Error('Durable tool-call projection is unavailable.');
        const bindingEntry = mcpBindings.find(
          ({ binding: candidate }) => candidate.exposedToolName === call.name,
        );
        const binding = bindingEntry?.binding;
        const dynamicIdentity = bindingEntry
          ? canonicalizeCapabilityArguments(bindingEntry.descriptor.inputSchema, call.args)
          : undefined;
        const builtinEntry = bindingEntry ? undefined : builtinEntriesByName.get(call.name);
        const parsedIdentity =
          builtinEntry?.availability === 'available'
            ? builtinEntry.parseModelInput(call.args, builtinTurnContext)
            : undefined;
        const capability =
          parsedIdentity?.success && builtinEntry
            ? builtinEntry.classifyEffects(parsedIdentity.data, builtinTurnContext)
            : failClosedToolCapability(call.name);
        const invocationFingerprint = toolInvocationFingerprint({
          toolName: call.name,
          identityRevision:
            binding?.capabilityRevision ?? builtinEntry?.descriptor.revision ?? 'unknown',
          ...(dynamicIdentity?.ok
            ? { parsedArgs: dynamicIdentity.args }
            : parsedIdentity?.success
              ? { parsedArgs: parsedIdentity.data }
              : {
                  parseCode: bindingEntry
                    ? 'invalid_arguments'
                    : builtinEntry && builtinEntry.availability !== 'available'
                      ? 'tool_unavailable'
                      : builtinEntry
                        ? 'invalid_arguments'
                        : 'unknown_tool',
                  pathCategory: 'unknown',
                  unparsedArgs: call.args,
                }),
        });
        const unknownFields = call.name.startsWith('mcp__')
          ? (() => {
              const schema = mcpBindings.find(
                ({ binding: candidate }) => candidate.exposedToolName === call.name,
              )?.descriptor.inputSchema as { properties?: Record<string, unknown> } | undefined;
              const suppliedFields =
                call.args && typeof call.args === 'object' && !Array.isArray(call.args)
                  ? Object.keys(call.args)
                  : [];
              const knownFields = new Set(Object.keys(schema?.properties ?? {}));
              return projectBuiltinUnknownToolFieldsObservation({
                toolName: call.name,
                unknownFieldCount: suppliedFields.filter((field) => !knownFields.has(field)).length,
                schemaRevision: binding?.capabilityRevision.slice(0, 64) ?? 'dynamic',
              });
            })()
          : projectBuiltinUnknownFields(builtinEntry, call.name, call.args, builtinTurnContext);
        events.push({
          type: 'tool.queued',
          toolCallId: call.id,
          modelInvocationId: completion.invocationId,
          taskId: params.state.activeTaskId ?? undefined,
          name: call.name,
          ...(bindingEntry?.descriptor.kind === 'mcp_tool' &&
          bindingEntry.descriptor.displayName.length > 0
            ? { displayLabel: bindingEntry.descriptor.displayName }
            : {}),
          args: durableCall.args,
          modelMessageId: completion.messageId,
          ordinal: ordinal++,
          effectClass: capability.effectClass,
          sideEffect: capability.sideEffect,
          classificationReason: capability.classificationReason,
          // This is the canonical admission fact consumed by the Runtime
          // Client projector. The presentation layer must never rediscover it
          // from a tool name or a namespaced child call id.
          presentation:
            builtinEntry?.kind === 'interrupt' || builtinEntry?.executionMechanism === 'user_input'
              ? ('standalone' as const)
              : capability.effectClass === 'read_only' && capability.sideEffect === false
                ? call.name === 'task'
                  ? ('hidden' as const)
                  : ('exploration' as const)
                : ('standalone' as const),
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
          completion.messageId,
          ordinal,
          completion.invocationId,
        ),
      );
      return { events, value: [] };
    },
  });
  return result.kind === 'automatic_compaction'
    ? [result.contextMetrics, result.terminal]
    : result.value;
}
