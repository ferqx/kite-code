// ── Model Controller / 模型控制器 ──
// Kernel 原生模型调用：从 RuntimeState 构建上下文 → 调用模型 → 返回 RuntimeEvent[]。
// 不依赖 LangGraph 状态、不产生副作用。
//
// Kernel-native model invocation: build context from RuntimeState → call model → return RuntimeEvent[].
// No LangGraph state dependency, no side effects.

import { extractPromptCacheMetrics } from '@/core/cache-metrics';
import { createBinding } from '@/core/capabilities/catalog';
import {
  chooseCapabilityDisclosure,
  searchableCapabilitySnapshot,
} from '@/core/capabilities/search';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import {
  type ProviderDataAdmissionDecisionV1,
  ProviderDataAdmissionError,
  type ProviderDataAdmissionGateV1,
  providerPayloadFromModelPromptV1,
} from '@/core/config/provider-data-admission';
import { exposedMcpToolName, type McpRuntimeProvider } from '@/core/mcp';
import type { AIMessage } from '@/core/messages';
import type { CompactionReporter } from '@/core/model/compaction-metrics';
import type { PreparedPrimaryContextRequestV2 } from '@/core/model/context-admission-v2';
import { preflightModelContext } from '@/core/model/context-budget';
import type { PreparedContextCapabilitySetV2 } from '@/core/model/context-capability-v2';
import {
  assertPreparedContextCurrentV2,
  CONTEXT_RECLAIM_LIVE_POLICY_V2,
  canonicalContextDigestV2,
} from '@/core/model/context-preparation-v2';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
  serializeToolDescriptors,
} from '@/core/model/context-projection';
import {
  digestRawContextProjection,
  planContextReclaim,
  RECLAIM_POLICY_V1,
  resolveContextReclaimModeV1,
} from '@/core/model/context-reclaim';
import {
  createContextPrimarySuccessBranchV2,
  proposeContextReclaimCommitV1,
} from '@/core/model/context-reclaim-commit';
import type { ReclaimShadowReporter } from '@/core/model/context-reclaim-shadow';
import type { SupportedChatModel } from '@/core/model/factory';
import { invokeBoundModel } from '@/core/model/invoke';
import { resolveModelCapabilities } from '@/core/model/model-capabilities';
import { resolveProjectInstructionSnapshot } from '@/core/model/project-instructions';
import { classifyToolCapability } from '@/core/policies/tool-capabilities';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import { genInteractionId } from '@/core/runtime/ids';
import { createZeroResourceUsageV1 } from '@/core/runtime/resource-budget';
import type { RuntimeState } from '@/core/runtime/state';
import {
  getActivePlanning,
  getAgentPhase,
  getEffectiveInteractionMode,
} from '@/core/runtime/state';
import type { SandboxBackend } from '@/core/sandbox/platform';
import { skillFrameInvalidationReason } from '@/core/skills/activation';
import type { SkillCatalogSnapshot } from '@/core/skills/catalog';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import { createAgentTools, toolAvailabilityContext } from '@/core/tools/definitions';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import {
  freezeRuntimeOutputSchemaV2,
  resolveRuntimeToolResultBudgetV2,
  UTF8_TOOL_RESULT_BUDGET_V2,
} from '@/core/tools/result-budget-v2';
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
      summaryPolicy: {
        ...(input.config.compaction ?? {}),
        contextReclaimV1: {
          featureEnabled: flags.contextReclaimV1,
          toolResultBudgetEnabled: flags.toolResultBudgetV2,
          effectiveMode: resolveContextReclaimModeV1({
            featureEnabled: flags.contextReclaimV1,
            toolResultBudgetEnabled: flags.toolResultBudgetV2,
            configuredMode: input.config.compaction?.reclaimMode,
          }),
          policyId: RECLAIM_POLICY_V1.policyId,
          policyVersion: RECLAIM_POLICY_V1.version,
          estimatorId: RECLAIM_POLICY_V1.estimatorId,
        },
      },
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
  /** Optional process-local shadow sink. Without it reclaim planning is skipped. */
  reclaimShadowReporter?: ReclaimShadowReporter;
  /** Production composition must supply the immutable route-policy gate. */
  providerDataAdmission?: ProviderDataAdmissionGateV1;
  resourceAdmission?: { inputTokens: number; maxOutputTokens: number };
  preparedContextV2?: PreparedPrimaryContextRequestV2;
  preparedCapabilitySetV2?: PreparedContextCapabilitySetV2;
  effectLeaseId?: string;
  reservationIds?: readonly string[];
  primaryRequestId?: string;
}): Promise<RuntimeEvent[]> {
  const { state } = params;
  const requestId = params.primaryRequestId ?? genInteractionId();
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
      !params.preparedContextV2 &&
      params.skillCatalog &&
      params.state.skills.catalogRevision !== params.skillCatalog.revision
    ) {
      params.emitRuntimeEvent?.({
        type: 'skill.catalog_refreshed',
        catalogRevision: params.skillCatalog.revision,
      });
    }
    if (!params.preparedContextV2 && params.skillCatalog) {
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
    const disclosedDescriptors = params.preparedCapabilitySetV2
      ? [...params.preparedCapabilitySetV2.disclosedDescriptors]
      : [...disclosedMcpDescriptors, ...disclosedSkillDescriptors];
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
    const mcpBindings = params.preparedCapabilitySetV2
      ? [...params.preparedCapabilitySetV2.mcpBindings]
      : flags.capabilityCatalogV1 && flags.mcpRuntimeBindingV1
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
      !params.preparedContextV2 &&
      (mcpBindings.length > 0 ||
        capabilityDisclosures.length > 0 ||
        searchToConsume ||
        loadedSetChanged)
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
    };
    const toolAvailCtx = toolAvailabilityContext(toolInput);
    const tools = boundedCancellationTools(
      createAgentTools(toolInput, toolAvailCtx),
      params.config,
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
    });
    const { serializedTools, activeSkillInstructions: activeSkillInstr } = projectionEnvironment;
    const workflowSkillDescriptors = projectionEnvironment.workflowSkills;
    if (params.preparedContextV2) {
      assertPreparedContextCurrentV2(params.preparedContextV2, {
        purpose: 'normal',
        state,
        environment: projectionEnvironment,
        capabilities: modelCapabilities,
        requestedMaxOutputTokens:
          params.resourceAdmission?.maxOutputTokens ??
          params.preparedContextV2.requestIdentity.requestedMaxOutputTokens,
        promptAffectingParameters: {
          temperature: 0,
          streaming: modelCapabilities.streaming,
          providerType: params.config.providerType,
          modelName: params.config.modelName,
          maxOutputTokens:
            params.resourceAdmission?.maxOutputTokens ??
            params.preparedContextV2.requestIdentity.requestedMaxOutputTokens,
        },
        toolResultBudgetPolicyId: params.preparedContextV2.sourceIdentity.toolResultBudgetPolicyId,
        reclaimPolicyId: CONTEXT_RECLAIM_LIVE_POLICY_V2.policyId,
      });
    }

    const projection = params.preparedContextV2
      ? {
          frames: [...params.preparedContextV2.effectiveProjection.frames],
          providerMessages: [...params.preparedContextV2.effectiveProjection.providerMessages],
          estimate: params.preparedContextV2.effectiveProjection.estimate,
        }
      : buildContextProjection({
          role: 'agent',
          state,
          serializedTools,
          activeSkillInstructions: activeSkillInstr,
          skills: undefined,
          workflowSkills: workflowSkillDescriptors,
          promptContractVersion: projectionEnvironment.promptContractVersion,
          projectInstructions: projectionEnvironment.projectInstructions,
          sandboxBackend: projectionEnvironment.sandboxBackend,
          projectionEnvironment,
          contextWindowTokens: modelCapabilities.contextWindowTokens,
        });
    const preflight = params.preparedContextV2
      ? params.preparedContextV2.effectiveProjection.preflight
      : preflightModelContext({
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
    const reclaimMode = resolveContextReclaimModeV1({
      featureEnabled: flags.contextReclaimV1,
      toolResultBudgetEnabled: flags.toolResultBudgetV2,
      configuredMode: params.config.compaction?.reclaimMode,
    });
    if (
      reclaimMode === 'shadow' &&
      params.reclaimShadowReporter &&
      preflight.status !== 'unknown' &&
      preflight.status !== 'normal'
    ) {
      const startedAt = Date.now();
      try {
        const environmentDigest = digestProjectionEnvironment(projectionEnvironment);
        const checkpointBoundary =
          state.context.activeCheckpoint?.version === 3
            ? state.context.activeCheckpoint.source.coveredThroughMessageId
            : undefined;
        const rawProjectionDigest = digestRawContextProjection({
          providerMessages: projection.providerMessages,
          estimate: projection.estimate,
          environmentDigest,
          pressure: {
            status: preflight.status,
            ...(preflight.utilization != null ? { utilization: preflight.utilization } : {}),
            ...(preflight.usableInputTokens != null
              ? { usableInputTokens: preflight.usableInputTokens }
              : {}),
          },
          ...(checkpointBoundary ? { checkpointBoundary } : {}),
        });
        const reclaimPlan = planContextReclaim({
          frames: projection.frames,
          rawProjectionDigest,
          environmentDigest,
          pressure: preflight.status,
          ...(checkpointBoundary ? { checkpointBoundary } : {}),
          ...(state.turn.status === 'active' ? { activeTurnId: state.turn.turnId } : {}),
        });
        params.reclaimShadowReporter.record({
          policyId: RECLAIM_POLICY_V1.policyId,
          policyVersion: RECLAIM_POLICY_V1.version,
          mode: 'shadow',
          rawInputTokens: preflight.estimate.totalInputTokens,
          candidateBlockCount: reclaimPlan.selectedBlockCount,
          candidateCallCount: reclaimPlan.selected.length,
          estimatedSavedChars: reclaimPlan.estimatedSavedChars,
          estimatedSavedTokens: reclaimPlan.estimatedSavedTokens,
          rejectionCounts: reclaimPlan.rejectionCounts,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // Shadow evidence must never change scheduling, payload, or Provider dispatch.
      }
    }
    params.compactionReporter?.recordContextFollowUp?.(
      state.turn.turnIndex,
      preflight.estimate.totalInputTokens,
    );
    if (
      params.resourceAdmission &&
      params.resourceAdmission.inputTokens !== preflight.estimate.totalInputTokens
    ) {
      throw new Error(
        'Model request projection changed after resource admission; refusing Provider dispatch.',
      );
    }
    let finalProviderAdmission: ProviderDataAdmissionDecisionV1 | undefined;
    let admittedRequestDigest: string | undefined;
    const primaryReservationId = params.reservationIds?.[0];
    if (params.preparedContextV2) {
      if (!params.effectLeaseId || !primaryReservationId || params.reservationIds?.length !== 1) {
        throw new Error('Prepared primary dispatch requires one effect lease and reservation.');
      }
      finalProviderAdmission = flags.providerDataPolicyV1
        ? (params.providerDataAdmission?.(
            providerPayloadFromModelPromptV1(projection.providerMessages),
            'primary_model',
          ) ?? {
            admitted: false,
            reason: 'mandatory_policy_unavailable' as const,
            routeAlias: 'unresolved',
          })
        : {
            admitted: true,
            reason: 'feature_disabled',
            routeAlias: 'feature_disabled',
          };
      if (!finalProviderAdmission.admitted) {
        throw new ProviderDataAdmissionError(finalProviderAdmission);
      }
      admittedRequestDigest = canonicalContextDigestV2('admitted-context-request:v2', {
        preparedDigest: params.preparedContextV2.preparedDigest,
        sourceIdentity: params.preparedContextV2.sourceIdentity,
        requestIdentity: params.preparedContextV2.requestIdentity,
        requestId,
        effectLeaseId: params.effectLeaseId,
        reservationIds: params.reservationIds,
        providerAdmission: finalProviderAdmission,
      });
      params.emitRuntimeEvent?.(contextMetricsEvent);
    }
    // model.requested 必须在 await 之前即时发出，而不是响应完成后与
    // model.responded 一起补发——消费方（TUI）需要它作为"新一轮模型调用
    // 已开始"的时机信号（例如 settle 上一轮的 Thought 聚合块，避免最终
    // 回复生成期间块一直显示运行中）。compaction 提前返回分支不发此事件
    // （该分支不发起模型调用）。
    // Emit model.requested at request time, not back-filled alongside
    // model.responded after the response completes — consumers (the TUI)
    // need it as the "a new model call began" timing signal (e.g. to settle
    // the previous round's Thought block so it stops showing as running
    // while the final answer is being generated). The compaction early-return
    // above does not emit it (no model call happens on that path).
    params.emitRuntimeEvent?.({ type: 'model.requested', requestId });
    const callStartedAt = Date.now();
    const response = await invokeBoundModel({
      model: params.model,
      tools,
      messages: projection.providerMessages,
      signal: params.signal,
      maxOutputTokens:
        params.resourceAdmission?.maxOutputTokens ??
        positiveConfigNumber(params.config.modelKwargs?.maxOutputTokens) ??
        modelCapabilities.maxOutputTokens,
      streaming: modelCapabilities.streaming,
      onTextDelta: (text) => params.emitRuntimeEvent?.({ type: 'model.text_delta', text }),
      onReasoningDelta: (text, segmentId) =>
        params.emitRuntimeEvent?.({
          type: 'model.reasoning_delta',
          segmentId,
          text,
        }),
      onReasoningCompleted: (text, segmentId) =>
        params.emitRuntimeEvent?.({
          type: 'model.reasoning_completed',
          segmentId,
          text,
        }),
      onRetry: (attempt, maxAttempts, error, delayMs) => {
        params.emitRuntimeEvent?.({
          type: 'model.retry',
          attempt,
          maxAttempts,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
          delayMs,
        });
      },
      providerDataAdmission: params.providerDataAdmission,
      providerDataPolicyRequired: flags.providerDataPolicyV1 && !params.preparedContextV2,
      providerDispatchPurpose: 'primary_model',
    });
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
          invalid_tool_calls?: Array<{
            id?: string;
            name?: string;
            args?: string;
            error?: string;
          }>;
        }
      ).invalid_tool_calls ?? []
    )
      .filter(
        (
          call,
        ): call is {
          id?: string;
          name: string;
          args: string;
          error?: string;
        } => typeof call.name === 'string' && typeof call.args === 'string',
      )
      .map((call) => ({
        id: call.id ?? crypto.randomUUID(),
        name: call.name,
        args: {
          _parse_error: call.error ?? 'invalid JSON arguments',
        },
      }));
    const providerUsage = response.response_metadata?.usage as
      | {
          input_tokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
        }
      | undefined;
    const providerInputTokens = providerUsage?.input_tokens ?? providerUsage?.prompt_tokens;
    const messageId = response.id ?? requestId;
    const queuedToolEvents: Array<Extract<RuntimeEvent, { type: 'tool.queued' }>> = toolCalls.map(
      (call, ordinal) => {
        const capability =
          builtinToolRegistry.effectsOf(call.name, call.args, toolAvailCtx) ??
          classifyToolCapability(call.name, call.args);
        const bindingEntry = mcpBindings.find(
          ({ binding: candidate }) => candidate.exposedToolName === call.name,
        );
        const binding = bindingEntry?.binding;
        return {
          type: 'tool.queued',
          toolCallId: call.id,
          taskId: params.state.activeTaskId ?? undefined,
          name: call.name,
          args: call.args,
          modelMessageId: messageId,
          ordinal,
          effectClass: capability.effectClass,
          sideEffect: capability.sideEffect,
          classificationReason: capability.classificationReason,
          ...(binding
            ? {
                bindingId: binding.bindingId,
                capabilityId: binding.capabilityId,
                capabilityRevision: binding.capabilityRevision,
                resultBudgetV2: resolveRuntimeToolResultBudgetV2({
                  toolIdentity: binding.capabilityId,
                  catalogRevision: capabilitySnapshot.revision,
                  bindingRevision: binding.capabilityRevision,
                  budget: UTF8_TOOL_RESULT_BUDGET_V2,
                  outputSchema: freezeRuntimeOutputSchemaV2(bindingEntry.descriptor.outputSchema),
                }),
              }
            : {}),
        };
      },
    );
    const responseEvent: Extract<RuntimeEvent, { type: 'model.responded' }> = {
      type: 'model.responded',
      messageId: response.id ?? requestId,
      durationMs,
      toolCalls: [...toolCalls, ...invalidToolCalls],
      reasoningText: extractReasoningText(response),
      text: extractText(response.content),
      ...(typeof providerInputTokens === 'number' ? { inputTokens: providerInputTokens } : {}),
      ...(typeof providerUsage?.completion_tokens === 'number'
        ? { outputTokens: providerUsage.completion_tokens }
        : {}),
      ...(params.preparedContextV2 && invalidToolCalls.length === 0
        ? { ownedToolQueue: queuedToolEvents }
        : {}),
    };
    const cacheMetrics = extractPromptCacheMetrics(response);
    let primaryBranch: RuntimeEvent[] | undefined;
    if (
      params.preparedContextV2 &&
      params.effectLeaseId &&
      primaryReservationId &&
      admittedRequestDigest &&
      invalidToolCalls.length === 0
    ) {
      const proposedCommit = params.preparedContextV2.proposedReclaimPlan
        ? proposeContextReclaimCommitV1({
            state,
            prepared: params.preparedContextV2,
            plan: params.preparedContextV2.proposedReclaimPlan,
          })
        : undefined;
      const terminalBatchId = canonicalContextDigestV2('context-primary-terminal-batch:v2', {
        requestId,
        responseMessageId: responseEvent.messageId,
        admittedRequestDigest,
      });
      primaryBranch = createContextPrimarySuccessBranchV2({
        prepared: params.preparedContextV2,
        requestId,
        effectLeaseId: params.effectLeaseId,
        reservationId: primaryReservationId,
        admittedRequestDigest,
        response: responseEvent,
        reconciliation: {
          type: 'resource_budget.reconciled',
          reservationId: primaryReservationId,
          actual: createZeroResourceUsageV1(),
        },
        terminalBatchId,
        previousCommit: state.context.reclaimCommit,
        ...(proposedCommit ? { proposedCommit } : {}),
      }).slice(0, proposedCommit ? 2 : 1);
    }
    const events: RuntimeEvent[] = primaryBranch ?? [
      ...retryEvents,
      contextMetricsEvent,
      responseEvent,
    ];

    if (cacheMetrics && (cacheMetrics.cacheHitTokens > 0 || cacheMetrics.cacheMissTokens > 0)) {
      const cacheEvent: RuntimeEvent = {
        type: 'model.cache_metrics',
        inputTokens: cacheMetrics.inputTokens,
        cacheHitTokens: cacheMetrics.cacheHitTokens,
        cacheMissTokens: cacheMetrics.cacheMissTokens,
        hitRate: cacheMetrics.hitRate,
      };
      if (primaryBranch) params.emitRuntimeEvent?.(cacheEvent);
      else events.push(cacheEvent);
    }

    if (!primaryBranch) events.push(...queuedToolEvents);
    events.push(
      ...eventsForInvalidModelToolCalls(invalidToolCalls, messageId, queuedToolEvents.length),
    );
    return events;
  } finally {
    params.model.setRetryListener(null);
  }
}
