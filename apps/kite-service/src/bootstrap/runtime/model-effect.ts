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
import { createBuiltinModelToolSurfaceFromProjection } from '@kite-ai/builtin-runtime/subagent';
import { getAgentPhase, type SubAgentEventSink } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateActiveSkillFrames as activeSkillFramesForCurrentWork,
  runtimeHostStateClassifyFailure as classifyFailure,
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateEffectiveInteractionMode as getEffectiveInteractionMode,
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
      _invalid_args_code?: 'invalid_json';
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
    const invocationFingerprint =
      call.canonicalInvocationFingerprint ??
      toolInvocationFingerprint({
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
      // Invalid arguments have no trustworthy capability classification; keep
      // the terminal diagnostic standalone rather than reclassifying it from
      // the provider-supplied tool name in the Client projector.
      presentation: 'standalone' as const,
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
  gitBroker?: import('@kite-ai/builtin-runtime/git').GitBroker;
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  subagentEventSink?: SubAgentEventSink;
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
    gitBroker: input.gitBroker,
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
    hasGitBroker: Boolean(toolInput.gitBroker),
    toolSearchEnabled: toolInput.toolSearch,
    activeSkillFrames: toolInput.activeSkillFrames,
    skillCatalog: toolInput.skillCatalog,
  });
  const builtinProjection = input.builtinToolCatalog.forTurn(builtinTurnContext);
  const tools =
    input.projectedTools ??
    boundedCancellationTools(
      createBuiltinModelToolSurfaceFromProjection({
        projection: builtinProjection,
        turnContext: builtinTurnContext,
        executionCapabilitySurface: input.config.executionCapabilitySurface,
        canSpawnSubagents: true,
        exposeInterrupts: true,
        dynamicMcpBindings: persistedBindings,
      }).tools,
      input.config,
      builtinProjection.entries.filter(
        (entry): entry is BuiltinModelToolCatalogEntry => entry.visibility === 'model',
      ),
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
  gitBroker?: import('@kite-ai/builtin-runtime/git').GitBroker;
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
  resourceAdmission?: { inputTokens: number; maxOutputTokens: number };
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
    hasGitBroker: Boolean(toolInput.gitBroker),
    toolSearchEnabled: toolInput.toolSearch,
    activeSkillFrames: toolInput.activeSkillFrames,
    skillCatalog: toolInput.skillCatalog,
  });
  const builtinProjection = params.builtinToolCatalog.forTurn(builtinTurnContext);
  const tools = boundedCancellationTools(
    createBuiltinModelToolSurfaceFromProjection({
      projection: builtinProjection,
      turnContext: builtinTurnContext,
      executionCapabilitySurface: params.config.executionCapabilitySurface,
      canSpawnSubagents: true,
      exposeInterrupts: true,
      dynamicMcpBindings: mcpBindings,
    }).tools,
    params.config,
    builtinProjection.entries.filter(
      (entry): entry is BuiltinModelToolCatalogEntry => entry.visibility === 'model',
    ),
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
    builtinToolCatalog: params.builtinToolCatalog,
    projectedTools: tools,
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
    persistence: params.modelInvocationPersistence,
    compactionReporter: params.compactionReporter,
    signal: params.signal,
    emitEphemeral: params.emitRuntimeEvent,
    finalize: (completion, contextMetricsEvent) => {
      const invalidToolCalls = completion.invalidToolCalls.map((call) => {
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
      const durableToolCalls = completion.toolCalls.map((call) => {
        const builtinEntry = builtinEntriesByName.get(call.name);
        if (builtinEntry?.executionMechanism !== 'subagent') return call;
        const name = call.args.name;
        const role = call.args.subagent_type;
        const task = call.args.task;
        if (
          !params.subagentTaskRequests ||
          typeof name !== 'string' ||
          !['explore', 'plan', 'code', 'review'].includes(String(role)) ||
          typeof task !== 'string'
        ) {
          throw new Error('Private Subagent task request Artifact storage is unavailable.');
        }
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
      for (const [index, call] of completion.toolCalls.entries()) {
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
            capability.effectClass === 'read_only' && capability.sideEffect === false
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
