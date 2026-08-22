import type { ToolSet } from 'ai';
import { extractPromptCacheMetrics, type PromptCacheMetrics } from './cache-metrics';
import type { CompactionReporter } from './compaction-metrics';
import type { ModelRuntimeConfigV1 } from './config';
import { preflightModelContext } from './context-budget';
import { decideAutomaticContextCompaction } from './context-compaction-decision';
import { resolveContextCompactionRollout } from './context-compaction-rollout';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
} from './context-projection';
import type { SupportedChatModel } from './factory';
import {
  type BuiltinModelEventV1,
  computeModelInvocationPrivateDigestV1,
  type ModelCompletionFinalizationV1,
  type ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
  type ModelInvocationStateViewV1,
  normalizedModelResponseToAIMessageV1,
} from './invocation-gateway';
import { type ResolvedModelCapabilities, resolveModelCapabilities } from './model-capabilities';
import type { ProviderDataAdmissionGateV1 } from './provider-data-admission';
import type { BuiltinRuntimeStateViewV1 } from './runtime-view';
import { compileModelSurfaceV1 } from './surface-compiler';

export type BuiltinPrimaryModelStateV1 = BuiltinRuntimeStateViewV1 & ModelInvocationStateViewV1;

export interface BuiltinPrimaryModelContextMetricsV1 {
  readonly type: 'model.context_metrics';
  readonly modelName: string;
  readonly contextWindowTokens?: number;
  readonly contextWindowSource?: ResolvedModelCapabilities['contextWindowSource'];
  readonly tokenizerSource?: ResolvedModelCapabilities['tokenizerSource'];
  readonly usableInputTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly providerSafetyMarginTokens: number;
  readonly totalInputTokens: number;
  readonly utilization?: number;
  readonly status: 'unknown' | 'normal' | 'warning' | 'compact_due' | 'hard_limit';
  readonly estimate: {
    readonly systemTokens: number;
    readonly toolSchemaTokens: number;
    readonly transcriptTokens: number;
    readonly summaryTokens: number;
    readonly dynamicRuntimeTokens: number;
    readonly framingTokens: number;
    readonly totalInputTokens: number;
  };
}

export interface BuiltinPrimaryContextCompactionRequestedV1 {
  readonly type: 'context.compaction_requested';
  readonly compactionId: string;
  readonly reason: 'auto';
  readonly requestedAtRevision: number;
  readonly requestedAtTurnId: string;
  readonly force: false;
  readonly estimate: BuiltinPrimaryModelContextMetricsV1['estimate'];
}

export interface BuiltinPrimaryToolCallV1 {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface BuiltinPrimaryInvalidToolCallV1 {
  readonly id: string;
  readonly name: string;
  /** Private, in-memory parse fact. A State adapter must never persist this raw value. */
  readonly unparsedArgs: string;
}

/** Provider-neutral facts passed to the synchronous State 25 translation adapter. */
export interface BuiltinPrimaryModelCompletionV1 {
  readonly invocationId: string;
  readonly messageId: string;
  readonly durationMs: number;
  readonly toolCalls: readonly BuiltinPrimaryToolCallV1[];
  readonly invalidToolCalls: readonly BuiltinPrimaryInvalidToolCallV1[];
  readonly text?: string;
  readonly reasoningText?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheMetrics?: Readonly<PromptCacheMetrics>;
}

export type BuiltinPrimaryModelEffectResultV1<Value> =
  | {
      readonly kind: 'automatic_compaction';
      readonly contextMetrics: BuiltinPrimaryModelContextMetricsV1;
      readonly terminal: BuiltinPrimaryContextCompactionRequestedV1;
    }
  | {
      readonly kind: 'completed';
      readonly value: Value;
    };

export interface BuiltinPrimaryAutoCompactionFactsV1 {
  readonly masterEnabled: boolean;
  /** Deterministic test seam; production lets Builtin allocate the request identity. */
  readonly compactionId?: string;
}

export interface BuiltinPrimaryModelResourceAdmissionV1 {
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
}

export interface BuiltinPrimaryCapabilityBindingFactsV1 {
  /** Dynamic MCP + Skill catalog revision only; never the Builtin operation catalog revision. */
  readonly catalogRevision: string;
  readonly bindings: readonly unknown[];
  readonly disclosures: readonly unknown[];
}

export interface BuiltinPrimaryModelEffectInputV1<
  State extends BuiltinPrimaryModelStateV1,
  Event extends BuiltinModelEventV1,
  Value,
> {
  readonly state: Readonly<State>;
  readonly config: ModelRuntimeConfigV1;
  readonly model: SupportedChatModel;
  readonly tools: ToolSet;
  readonly projectionEnvironment: ContextProjectionEnvironment;
  readonly capabilityBindingFacts: BuiltinPrimaryCapabilityBindingFactsV1;
  readonly autoCompaction: BuiltinPrimaryAutoCompactionFactsV1;
  readonly resourceAdmission?: BuiltinPrimaryModelResourceAdmissionV1;
  readonly persistence?: ModelInvocationPersistenceV1<State, Event>;
  readonly providerDataAdmission?: ProviderDataAdmissionGateV1;
  readonly providerDataPolicyRequired: boolean;
  readonly compactionReporter?: CompactionReporter;
  readonly signal?: AbortSignal;
  readonly emitEphemeral?: (event: Event) => void;
  /**
   * Pure State-format translation. Builtin owns normalization and the
   * single-use Gateway completion; the adapter can only contribute the event
   * batch committed atomically with model.invocation_completed.
   */
  readonly finalize: (
    completion: Readonly<BuiltinPrimaryModelCompletionV1>,
    contextMetrics: BuiltinPrimaryModelContextMetricsV1,
  ) => ModelCompletionFinalizationV1<Value, Event>;
  readonly now?: () => number;
  /** Deterministic test seam for Provider calls without an id. */
  readonly nextToolCallId?: () => string;
}

function positiveConfigNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function contextMetricsV1(
  modelCapabilities: ReturnType<typeof resolveModelCapabilities>,
  preflight: ReturnType<typeof preflightModelContext>,
): BuiltinPrimaryModelContextMetricsV1 {
  return Object.freeze({
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
    estimate: Object.freeze({ ...preflight.estimate }),
  });
}

/**
 * Prepare the primary Model effect through the one App-supplied Gateway.
 * Dynamic MCP/Skill discovery stays an independent caller-supplied fact set;
 * it is bound into provenance but never reinterpreted as the Builtin catalog revision.
 */
function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? String((part as { text: unknown }).text)
        : '',
    )
    .join('');
  return text || undefined;
}

function extractReasoningText(message: ReturnType<typeof normalizedModelResponseToAIMessageV1>) {
  const reasoning =
    typeof message.additional_kwargs?.reasoning_content === 'string'
      ? message.additional_kwargs.reasoning_content
      : undefined;
  return reasoning && reasoning.length > 0 ? reasoning : undefined;
}

export async function executeBuiltinPrimaryModelEffectV1<
  State extends BuiltinPrimaryModelStateV1,
  Event extends BuiltinModelEventV1,
  Value,
>(
  gateway: ModelInvocationGatewayV1,
  input: BuiltinPrimaryModelEffectInputV1<State, Event, Value>,
): Promise<BuiltinPrimaryModelEffectResultV1<Value>> {
  const projectionEnvironment = input.projectionEnvironment;
  const projection = buildContextProjection({
    role: 'agent',
    state: input.state,
    serializedTools: projectionEnvironment.serializedTools,
    activeSkillInstructions: projectionEnvironment.activeSkillInstructions,
    workflowSkills: projectionEnvironment.workflowSkills,
    promptContractVersion: projectionEnvironment.promptContractVersion,
    projectInstructions: projectionEnvironment.projectInstructions,
    sandboxBackend: projectionEnvironment.sandboxBackend,
  });
  const modelCapabilities = resolveModelCapabilities({
    config: input.config,
    adapter: input.model.capabilityMetadata,
  });
  const configuredMaxOutputTokens =
    positiveConfigNumber(input.config.modelKwargs?.maxOutputTokens) ??
    positiveConfigNumber(input.config.modelKwargs?.maxTokens);
  const preflight = preflightModelContext({
    estimate: projection.estimate,
    capabilities: modelCapabilities,
    requestMaxOutputTokens: configuredMaxOutputTokens,
    providerSafetyRatio: input.config.compaction?.providerSafetyRatio,
    compactRatio: input.config.compaction?.compactRatio,
    hardRatio: input.config.compaction?.hardRatio,
    warningRatio: input.config.compaction?.warningRatio,
  });
  const contextMetrics = contextMetricsV1(modelCapabilities, preflight);
  input.compactionReporter?.recordContextFollowUp?.(
    input.state.turn.turnIndex,
    preflight.estimate.totalInputTokens,
  );
  const automaticCompaction = decideAutomaticContextCompaction({
    state: input.state,
    preflight,
    mode: resolveContextCompactionRollout({
      masterEnabled: input.autoCompaction.masterEnabled,
      configuredMode: input.config.compaction?.autoMode,
      cohortSalt: input.config.compaction?.cohortSalt,
      sessionId: input.state.session.threadId,
      livePercentage: input.config.compaction?.livePercentage,
    }),
    triggerRatio: input.config.compaction?.triggerRatio ?? input.config.compaction?.compactRatio,
    compactAfterEstimatedTokens: input.config.compaction?.compactAfterEstimatedTokens,
    cooldownTurns: input.config.compaction?.cooldownTurns,
    minimumReductionRatio: input.config.compaction?.minimumReductionRatio,
    maxSummaryTokens: input.config.compaction?.maxSummaryTokens,
  });
  if (automaticCompaction.action === 'request_compaction') {
    input.compactionReporter?.recordRequested();
    const terminal = Object.freeze({
      type: 'context.compaction_requested' as const,
      compactionId: input.autoCompaction.compactionId ?? automaticCompaction.compactionId,
      reason: automaticCompaction.reason,
      requestedAtRevision: input.state.revision,
      requestedAtTurnId: input.state.turn.turnId,
      force: false as const,
      estimate: contextMetrics.estimate,
    });
    return Object.freeze({
      kind: 'automatic_compaction',
      contextMetrics,
      terminal,
    });
  }
  if (
    input.resourceAdmission &&
    input.resourceAdmission.inputTokens !== preflight.estimate.totalInputTokens
  ) {
    throw new Error(
      'Model request projection changed after resource admission; refusing Provider dispatch.',
    );
  }
  if (!input.persistence) {
    throw new Error('ModelInvocationGateway execution context is unavailable.');
  }
  const now = input.now ?? Date.now;
  const startedAtMs = now();
  const compiled = compileModelSurfaceV1({
    purpose: 'primary_agent',
    config: input.config,
    model: input.model,
    tools: input.tools,
    messages: projection.providerMessages,
    maxOutputTokens:
      input.resourceAdmission?.maxOutputTokens ??
      configuredMaxOutputTokens ??
      modelCapabilities.maxOutputTokens,
    transport: modelCapabilities.streaming ? 'stream' : 'generate',
    estimatedInputTokens: preflight.estimate.totalInputTokens,
  });
  const pending = await gateway.invoke({
    model: input.model,
    compiled,
    persistence: input.persistence,
    provenance: {
      contextCheckpointId: input.state.context.activeCheckpoint?.sourceDigest ?? null,
      promptContractVersion: projectionEnvironment.promptContractVersion ?? 'legacy',
      projectionEnvironmentDigest: computeModelInvocationPrivateDigestV1(
        'kite.model-projection-environment.v1',
        digestProjectionEnvironment(projectionEnvironment),
      ),
      capabilityBindingDigest: computeModelInvocationPrivateDigestV1(
        'kite.model-capability-bindings.v1',
        input.capabilityBindingFacts,
      ),
    },
    providerDataAdmission: input.providerDataAdmission,
    providerDataPolicyRequired: input.providerDataPolicyRequired,
    resourceKind: 'model',
    signal: input.signal,
    emitEphemeral: input.emitEphemeral,
  });
  const value = await pending.commitWith((normalized) => {
    const response = normalizedModelResponseToAIMessageV1(normalized);
    const nextToolCallId = input.nextToolCallId ?? (() => crypto.randomUUID());
    const toolCalls = Object.freeze(
      (response.tool_calls ?? []).map((call) =>
        Object.freeze({
          id: call.id ?? nextToolCallId(),
          name: call.name,
          args: Object.freeze({ ...call.args }),
        }),
      ),
    );
    const toolCallIds = new Set<string>();
    for (const call of toolCalls) {
      if (toolCallIds.has(call.id)) {
        throw new Error(`Model response contains duplicate tool-call id: ${call.id}`);
      }
      toolCallIds.add(call.id);
    }
    const invalidToolCalls = Object.freeze(
      (response.invalid_tool_calls ?? [])
        .filter(
          (call): call is { id?: string; name: string; args: string; error?: string } =>
            typeof call.name === 'string' && typeof call.args === 'string',
        )
        .map((call) =>
          Object.freeze({
            id: call.id ?? nextToolCallId(),
            name: call.name,
            unparsedArgs: call.args,
          }),
        ),
    );
    const providerUsage = response.response_metadata?.usage as
      | {
          input_tokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
        }
      | undefined;
    const providerInputTokens = providerUsage?.input_tokens ?? providerUsage?.prompt_tokens;
    const cacheMetrics = extractPromptCacheMetrics(response);
    const completion = Object.freeze({
      invocationId: pending.invocationId,
      messageId: response.id ?? pending.invocationId,
      durationMs: now() - startedAtMs,
      toolCalls,
      invalidToolCalls,
      ...(extractText(response.content) === undefined
        ? {}
        : { text: extractText(response.content) }),
      ...(extractReasoningText(response) === undefined
        ? {}
        : { reasoningText: extractReasoningText(response) }),
      ...(typeof providerInputTokens === 'number' ? { inputTokens: providerInputTokens } : {}),
      ...(typeof providerUsage?.completion_tokens === 'number'
        ? { outputTokens: providerUsage.completion_tokens }
        : {}),
      ...(cacheMetrics ? { cacheMetrics: Object.freeze({ ...cacheMetrics }) } : {}),
    });
    return input.finalize(completion, contextMetrics);
  });
  return Object.freeze({ kind: 'completed', value });
}
