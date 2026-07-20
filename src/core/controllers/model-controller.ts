// ── Model Controller / 模型控制器 ──
// Kernel 原生模型调用：从 RuntimeState 构建上下文 → 调用模型 → 返回 RuntimeEvent[]。
// 不依赖 LangGraph 状态、不产生副作用。
//
// Kernel-native model invocation: build context from RuntimeState → call model → return RuntimeEvent[].
// No LangGraph state dependency, no side effects.

import { createHash } from 'node:crypto';
import { extractPromptCacheMetrics } from '@/core/cache-metrics';
import { createBinding } from '@/core/capabilities/catalog';
import {
  chooseCapabilityDisclosure,
  searchableCapabilitySnapshot,
} from '@/core/capabilities/search';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import { exposedMcpToolName, type McpRuntimeProvider } from '@/core/mcp';
import type { AIMessage } from '@/core/messages';
import { compactionMetrics } from '@/core/model/compaction-metrics';
import { preflightModelContext } from '@/core/model/context-budget';
import {
  decideAutomaticContextCompaction,
  isProviderContextOverflow,
} from '@/core/model/context-compaction-decision';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
  serializeToolDescriptors,
} from '@/core/model/context-projection';
import type { SupportedChatModel } from '@/core/model/factory';
import { invokeBoundModel } from '@/core/model/invoke';
import { resolveModelCapabilities, usableInputBudget } from '@/core/model/model-capabilities';
import { classifyToolCapability } from '@/core/policies/tool-capabilities';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import { genInteractionId } from '@/core/runtime/ids';
import type { RuntimeState } from '@/core/runtime/state';
import {
  getActivePlanning,
  getAgentPhase,
  getEffectiveInteractionMode,
} from '@/core/runtime/state';
import { skillFrameInvalidationReason } from '@/core/skills/activation';
import type { SkillCatalogSnapshot } from '@/core/skills/catalog';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import { createAgentTools } from '@/core/tools/definitions';
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

/** Convert invalid provider tool arguments into durable queued-and-failed facts. */
export function eventsForInvalidModelToolCalls(
  calls: Array<{ id: string; name: string; args: { _parse_error?: string } }>,
  messageId: string,
  ordinalStart: number,
): RuntimeEvent[] {
  return calls.flatMap((call, index) => [
    {
      type: 'tool.queued' as const,
      toolCallId: call.id,
      name: call.name,
      args: call.args,
      modelMessageId: messageId,
      ordinal: ordinalStart + index,
    },
    {
      type: 'tool.failed' as const,
      toolCallId: call.id,
      failure: classifyFailure(
        'model_invalid_tool_args',
        String(call.args._parse_error ?? 'invalid model tool arguments'),
      ),
    },
  ]);
}

export function activeInlineSkillInstructions(
  state: RuntimeState,
  catalog: SkillCatalogSnapshot | undefined,
): string | undefined {
  if (!catalog) return undefined;
  const sections = Object.values(state.skills.frames)
    .filter((frame) => frame.status === 'active' && frame.contextMode === 'inline')
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
  signal?: AbortSignal;
  mcpBindings?: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }>;
  disclosedDescriptors?: import('@/protocol/capabilities').CapabilityDescriptor[];
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
  const tools = createAgentTools({
    workspace: input.state.session.workspace,
    shellExecutor: input.shellExecutor,
    mcpManager: input.mcpManager,
    mcpBindings: persistedBindings,
    toolSearch:
      getFeatureFlags(input.config).toolSearchV1 && input.model.supportsToolCalls !== false,
    skills: input.skills,
    skillOptions: input.skillOptions,
    skillCatalog: input.skillCatalog,
    activeSkillFrames: Object.values(input.state.skills.frames).filter(
      (frame) => frame.status === 'active' && frame.contextMode === 'inline',
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
  });
  return {
    serializedTools: serializeToolDescriptors(tools as unknown as Record<string, unknown>),
    activeSkillInstructions: activeInlineSkillInstructions(input.state, input.skillCatalog),
    workflowSkills: disclosedDescriptors
      .filter((descriptor) => descriptor.kind === 'skill')
      .map((descriptor) => ({
        capabilityId: descriptor.capabilityId,
        description: descriptor.description,
      })),
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
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  subagentEventSink?: SubAgentEventSink;
  signal?: AbortSignal;
  /** Persists bindings before the model can emit a dynamic MCP tool call. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
}): Promise<RuntimeEvent[]> {
  const { state } = params;
  const requestId = genInteractionId();
  const retryEvents: RuntimeEvent[] = [];

  // 注册 retry listener — 模型通过 transientRetryMiddleware 实现重试，
  // 通过 setRetryListener 回调来收集重试事件为 RuntimeEvent。
  // Register retry listener — the model retries via transientRetryMiddleware,
  // we collect retry events as RuntimeEvents through the listener callback.
  params.model.setRetryListener((attempt, maxAttempts, error, delayMs) => {
    retryEvents.push({
      type: 'model.retry',
      attempt,
      maxAttempts,
      error: typeof error === 'string' ? error : String(error).slice(0, 200),
      delayMs,
    });
  });

  try {
    const flags = getFeatureFlags(params.config);
    if (
      params.skillCatalog &&
      params.state.skills.catalogRevision !== params.skillCatalog.revision
    ) {
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
      budgetTokens: positiveConfigNumber(
        params.config.modelKwargs?.capabilityDisclosureBudgetTokens,
      ),
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
    const previousLoadedCapabilities = Object.values(state.capabilities.loadedCapabilities ?? {});
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
    const tools = createAgentTools({
      workspace: state.session.workspace,
      shellExecutor: params.shellExecutor,
      mcpManager: params.mcpManager,
      mcpBindings,
      toolSearch: flags.toolSearchV1 && params.model.supportsToolCalls !== false,
      skills: params.skills,
      skillOptions: params.skillOptions,
      skillCatalog: params.skillCatalog,
      activeSkillFrames: Object.values(state.skills.frames).filter(
        (frame) => frame.status === 'active' && frame.contextMode === 'inline',
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
    });
    const inputBudget = usableInputBudget(
      modelCapabilities,
      positiveConfigNumber(params.config.modelKwargs?.maxOutputTokens) ??
        positiveConfigNumber(params.config.modelKwargs?.maxTokens),
      params.config.compaction?.providerSafetyRatio,
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
    });
    const { serializedTools, activeSkillInstructions: activeSkillInstr } = projectionEnvironment;
    const workflowSkillDescriptors = projectionEnvironment.workflowSkills;

    const projection = buildContextProjection({
      role: 'agent',
      state,
      serializedTools,
      contextBudget: {
        ...(inputBudget.usableInputTokens ? { maxTokens: inputBudget.usableInputTokens } : {}),
        recentTurns: params.config.compaction?.recentTurns ?? 3,
      },
      activeSkillInstructions: activeSkillInstr,
      skills: undefined,
      workflowSkills: workflowSkillDescriptors,
    });
    const preflight = preflightModelContext({
      estimate: projection.estimate,
      capabilities: modelCapabilities,
      requestMaxOutputTokens:
        positiveConfigNumber(params.config.modelKwargs?.maxOutputTokens) ??
        positiveConfigNumber(params.config.modelKwargs?.maxTokens),
      providerSafetyRatio: params.config.compaction?.providerSafetyRatio,
      compactRatio: params.config.compaction?.compactRatio ?? params.config.compaction?.softRatio,
      hardRatio: params.config.compaction?.hardRatio,
      warningRatio: params.config.compaction?.warningRatio,
      targetRatio: params.config.compaction?.targetRatio,
    });
    const contextMetricsEvent: RuntimeEvent = {
      type: 'model.context_metrics',
      modelName: modelCapabilities.modelName,
      ...(modelCapabilities.contextWindowTokens
        ? { contextWindowTokens: modelCapabilities.contextWindowTokens }
        : {}),
      ...(preflight.usableInputTokens ? { usableInputTokens: preflight.usableInputTokens } : {}),
      reservedOutputTokens: preflight.reservedOutputTokens,
      providerSafetyMarginTokens: preflight.providerSafetyMarginTokens,
      ...(preflight.targetTokens ? { targetTokens: preflight.targetTokens } : {}),
      totalInputTokens: preflight.estimate.totalInputTokens,
      ...(preflight.utilization != null ? { utilization: preflight.utilization } : {}),
      status: preflight.status,
      estimate: preflight.estimate,
    };
    const automaticCompaction = decideAutomaticContextCompaction({
      state,
      preflight,
      enabled: flags.contextCompactionV2 && flags.contextCompactionAutoV1,
      recentTurns: params.config.compaction?.recentTurns,
      cooldownTurns: params.config.compaction?.cooldownTurns,
      minimumReductionRatio: params.config.compaction?.minimumReductionRatio,
      maxSummaryTokens: params.config.compaction?.maxSummaryTokens,
    });
    if (automaticCompaction.action === 'block') {
      throw new Error(automaticCompaction.reason);
    }
    if (automaticCompaction.action === 'request_compaction') {
      compactionMetrics.recordRequested();
      const envDigest = digestProjectionEnvironment({
        serializedTools,
        activeSkillInstructions: activeSkillInstr,
        workflowSkills: workflowSkillDescriptors,
      });
      return [
        ...retryEvents,
        contextMetricsEvent,
        {
          type: 'context.compaction_requested',
          compactionId: automaticCompaction.compactionId,
          reason: automaticCompaction.reason,
          requestedAtRevision: state.revision,
          requestedAtTurnId: state.turn.turnId,
          force: false,
          estimate: preflight.estimate,
          projectionEnvironmentDigest: envDigest,
        },
      ];
    }
    let response: Awaited<ReturnType<typeof invokeBoundModel>>;
    try {
      response = await invokeBoundModel({
        model: params.model,
        tools,
        messages: projection.providerMessages,
        signal: params.signal,
        maxOutputTokens:
          positiveConfigNumber(params.config.modelKwargs?.maxOutputTokens) ??
          modelCapabilities.maxOutputTokens,
      });
    } catch (error) {
      if (
        flags.contextCompactionV2 &&
        flags.contextCompactionAutoV1 &&
        isProviderContextOverflow(error) &&
        state.context.overflowRecoveryTurnId !== state.turn.turnId
      ) {
        compactionMetrics.recordRequested();
        compactionMetrics.recordOverflowRecovery();
        const envDigest = digestProjectionEnvironment({
          serializedTools,
          activeSkillInstructions: activeSkillInstr,
          workflowSkills: workflowSkillDescriptors,
        });
        return [
          ...retryEvents,
          contextMetricsEvent,
          {
            type: 'context.compaction_requested',
            compactionId: crypto.randomUUID(),
            reason: 'overflow_recovery',
            requestedAtRevision: state.revision,
            requestedAtTurnId: state.turn.turnId,
            force: true,
            estimate: preflight.estimate,
            projectionEnvironmentDigest: envDigest,
          },
        ];
      }
      if (
        flags.contextCompactionV2 &&
        flags.contextCompactionAutoV1 &&
        isProviderContextOverflow(error) &&
        state.context.overflowRecoveryTurnId === state.turn.turnId
      ) {
        // PR 6: Emit a durable hard_blocked event instead of a plain Error.
        // REVIEW-FIX: Use a proper SHA-256 content digest, not a token count.
        const blockDigest = createHash('sha256')
          .update(
            JSON.stringify({
              reason: 'overflow_recovery_failed',
              turnId: state.turn.turnId,
              totalInputTokens: preflight.estimate?.totalInputTokens ?? 0,
            }),
          )
          .digest('hex');
        return [
          ...retryEvents,
          contextMetricsEvent,
          {
            type: 'context.hard_blocked' as const,
            reason: 'overflow_recovery_failed' as const,
            sourceDigest: blockDigest,
            message:
              'Provider context overflow persisted after compaction recovery. Use /compact reset or start a new session.',
            createdAtTurnId: state.turn.turnId,
          },
        ];
      }
      throw error;
    }
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
      .map((call) => ({
        id: call.id ?? crypto.randomUUID(),
        name: call.name,
        args: {
          _raw_invalid_args: call.args,
          _parse_error: call.error ?? 'invalid JSON arguments',
        },
      }));
    const events: RuntimeEvent[] = [
      ...retryEvents,
      contextMetricsEvent,
      { type: 'model.requested', requestId },
      {
        type: 'model.responded',
        messageId: response.id ?? requestId,
        toolCalls: [...toolCalls, ...invalidToolCalls],
        reasoningText: extractReasoningText(response),
        text: extractText(response.content),
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

    const messageId = response.id ?? requestId;
    let ordinal = 0;
    for (const call of toolCalls) {
      const capability = classifyToolCapability(call.name, call.args);
      const binding = mcpBindings.find(
        ({ binding: candidate }) => candidate.exposedToolName === call.name,
      )?.binding;
      events.push({
        type: 'tool.queued',
        toolCallId: call.id,
        taskId: params.state.activeTaskId ?? undefined,
        name: call.name,
        args: call.args,
        modelMessageId: messageId,
        ordinal: ordinal++,
        effectClass: capability.effectClass,
        sideEffect: capability.sideEffect,
        classificationReason: capability.classificationReason,
        ...(binding
          ? {
              bindingId: binding.bindingId,
              capabilityId: binding.capabilityId,
              capabilityRevision: binding.capabilityRevision,
            }
          : {}),
      });
    }
    events.push(...eventsForInvalidModelToolCalls(invalidToolCalls, messageId, ordinal));
    return events;
  } finally {
    params.model.setRetryListener(null);
  }
}
