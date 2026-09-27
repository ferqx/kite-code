import type { PrivateArtifactRef } from '@kite-ai/runtime-spi';
import type { ToolSet } from 'ai';
import { extractPromptCacheMetrics, type PromptCacheMetrics } from './cache-metrics';
import type { CompactionReporter } from './compaction-metrics';
import type { ModelRuntimeConfig } from './config';
import { estimateContextTokens, preflightModelContext } from './context-budget';
import { decideAutomaticContextCompaction } from './context-compaction-decision';
import { resolveContextCompactionRollout } from './context-compaction-rollout';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
} from './context-projection';
import { primaryModelProviderOptions, type SupportedChatModel } from './factory';
import {
  type BuiltinModelEvent,
  computeModelInvocationPrivateDigest,
  type ModelCompletionFinalization,
  type ModelInvocationGateway,
  type ModelInvocationPersistence,
  type ModelInvocationStateView,
  type ModelPreparedResumeStateView,
  normalizedModelResponseToAIMessage,
  type PendingModelCompletion,
} from './invocation-gateway';
import type { BaseMessage } from './messages';
import { type ResolvedModelCapabilities, resolveModelCapabilities } from './model-capabilities';
import type { BuiltinRuntimeStateView } from './runtime-view';
import { compileModelSurface } from './surface-compiler';

export type BuiltinPrimaryModelState = BuiltinRuntimeStateView & ModelInvocationStateView;

export interface BuiltinPrimaryModelContextMetrics {
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

export interface BuiltinPrimaryContextCompactionRequested {
  readonly type: 'context.compaction_requested';
  readonly compactionId: string;
  readonly reason: 'auto';
  readonly requestedAtRevision: number;
  readonly requestedAtTurnId: string;
  readonly force: false;
  readonly estimate: BuiltinPrimaryModelContextMetrics['estimate'];
}

export interface BuiltinPrimaryToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface BuiltinPrimaryInvalidToolCall {
  readonly id: string;
  readonly name: string;
  /** Private, in-memory parse fact. A State adapter must never persist this raw value. */
  readonly unparsedArgs: string;
}

/** Provider-neutral facts passed to the synchronous State 27 translation adapter. */
export interface BuiltinPrimaryModelCompletion {
  readonly invocationId: string;
  readonly messageId: string;
  readonly durationMs: number;
  readonly toolCalls: readonly BuiltinPrimaryToolCall[];
  readonly invalidToolCalls: readonly BuiltinPrimaryInvalidToolCall[];
  readonly text?: string;
  readonly reasoningText?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheMetrics?: Readonly<PromptCacheMetrics>;
}

export type BuiltinPrimaryModelEffectResult<Value> =
  | {
      readonly kind: 'automatic_compaction';
      readonly contextMetrics: BuiltinPrimaryModelContextMetrics;
      readonly terminal: BuiltinPrimaryContextCompactionRequested;
    }
  | {
      readonly kind: 'completed';
      readonly value: Value;
    };

export interface BuiltinPrimaryAutoCompactionFacts {
  readonly masterEnabled: boolean;
  /** Deterministic test seam; production lets Builtin allocate the request identity. */
  readonly compactionId?: string;
}

export interface BuiltinPrimaryModelResourceAdmission {
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
}

export interface BuiltinPrimaryCapabilityBindingFacts {
  /** Dynamic MCP + Skill catalog revision only; never the Builtin operation catalog revision. */
  readonly catalogRevision: string;
  readonly bindings: readonly unknown[];
  readonly disclosures: readonly unknown[];
}

export interface BuiltinPrimaryModelEffectInput<
  State extends BuiltinPrimaryModelState,
  Event extends BuiltinModelEvent,
  Value,
> {
  readonly state: Readonly<State>;
  readonly config: ModelRuntimeConfig;
  readonly model: SupportedChatModel;
  readonly tools: ToolSet;
  readonly projectionEnvironment: ContextProjectionEnvironment;
  readonly capabilityBindingFacts: BuiltinPrimaryCapabilityBindingFacts;
  readonly autoCompaction: BuiltinPrimaryAutoCompactionFacts;
  readonly resourceAdmission?: BuiltinPrimaryModelResourceAdmission;
  /** Accepted cross-Session child funding binds one hard Provider attempt timeout. */
  readonly firstAttemptTimeoutMs?: number;
  /** Same-ledger after-turn placeholder replaced by the exact primary Surface reservation. */
  readonly replaceReservationId?: string;
  readonly persistence?: ModelInvocationPersistence<State, Event>;
  readonly compactionReporter?: CompactionReporter;
  readonly signal?: AbortSignal;
  readonly emitEphemeral?: (event: Event) => void;
  /** A trusted App owner reads a bounded private inbox at the exact Gateway identity. */
  readonly prepareAgentMail?: (input: {
    readonly invocationId: string;
    readonly existingMessages: readonly BaseMessage[];
  }) => Promise<
    Readonly<{
      readonly frames: readonly BaseMessage[];
      readonly preparationId?: string;
    }>
  >;
  /**
   * Pure State-format translation. Builtin owns normalization and the
   * single-use Gateway completion; the adapter can only contribute the event
   * batch committed atomically with model.invocation_completed.
   */
  readonly finalize: (
    completion: Readonly<BuiltinPrimaryModelCompletion>,
    contextMetrics: BuiltinPrimaryModelContextMetrics,
  ) => ModelCompletionFinalization<Value, Event>;
  readonly now?: () => number;
  /** Deterministic test seam for Provider calls without an id. */
  readonly nextToolCallId?: () => string;
}

/** The target owner supplies one durable route/funding gate for an existing primary request. */
export interface BuiltinPreparedPrimaryModelResumeInput<
  State extends ModelPreparedResumeStateView,
  Event extends BuiltinModelEvent,
> {
  readonly model: SupportedChatModel;
  readonly persistence: ModelInvocationPersistence<State, Event>;
  readonly invocationId: string;
  readonly expectedStateRevision: number;
  readonly expectedTurnId: string;
  readonly expectedRouteFingerprint: string;
  readonly surfaceArtifact: PrivateArtifactRef & { kind: 'model_surface' };
  readonly surfaceIntegrityIdentifier: string;
  readonly hardAttemptTimeoutMs: number;
  readonly beforeDispatch: Parameters<
    ModelInvocationGateway['resumePrepared']
  >[0]['beforeDispatch'];
  readonly signal?: AbortSignal;
  readonly emitEphemeral?: (event: Event) => void;
}

/** Returns the original completion handle; callers reuse their existing pure finalizer. */
export function resumeBuiltinPreparedPrimaryModelEffect<
  State extends ModelPreparedResumeStateView,
  Event extends BuiltinModelEvent,
>(
  gateway: ModelInvocationGateway,
  input: BuiltinPreparedPrimaryModelResumeInput<State, Event>,
): Promise<PendingModelCompletion<Event>> {
  return gateway.resumePrepared(input);
}

function positiveConfigNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function contextMetrics(
  modelCapabilities: ReturnType<typeof resolveModelCapabilities>,
  preflight: ReturnType<typeof preflightModelContext>,
): BuiltinPrimaryModelContextMetrics {
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

function extractReasoningText(message: ReturnType<typeof normalizedModelResponseToAIMessage>) {
  const reasoning =
    typeof message.additional_kwargs?.reasoning_content === 'string'
      ? message.additional_kwargs.reasoning_content
      : undefined;
  return reasoning && reasoning.length > 0 ? reasoning : undefined;
}

export async function executeBuiltinPrimaryModelEffect<
  State extends BuiltinPrimaryModelState,
  Event extends BuiltinModelEvent,
  Value,
>(
  gateway: ModelInvocationGateway,
  input: BuiltinPrimaryModelEffectInput<State, Event, Value>,
): Promise<BuiltinPrimaryModelEffectResult<Value>> {
  const projectionEnvironment = input.projectionEnvironment;
  const projection = buildContextProjection({
    role: 'agent',
    state: input.state,
    serializedTools: projectionEnvironment.serializedTools,
    activeSkillInstructions: projectionEnvironment.activeSkillInstructions,
    workflowSkills: projectionEnvironment.workflowSkills,
    projectInstructions: projectionEnvironment.projectInstructions,
    sandboxBackend: projectionEnvironment.sandboxBackend,
    delegatedTask: projectionEnvironment.delegatedTask,
    transcriptToolCallArgs: projectionEnvironment.transcriptToolCallArgs,
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
  const metrics = contextMetrics(modelCapabilities, preflight);
  let effectiveMetrics = metrics;
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
      estimate: metrics.estimate,
    });
    return Object.freeze({
      kind: 'automatic_compaction',
      contextMetrics: metrics,
      terminal,
    });
  }
  if (
    !input.prepareAgentMail &&
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
  const compile = (
    messages: readonly BaseMessage[],
    estimatedInputTokens: number,
    maxOutputTokens?: number,
  ) =>
    compileModelSurface({
      purpose: 'primary_agent',
      config: input.config,
      model: input.model,
      tools: input.tools,
      messages,
      maxOutputTokens,
      transport: modelCapabilities.streaming ? 'stream' : 'generate',
      estimatedInputTokens,
      providerOptions: primaryModelProviderOptions(input.config),
    });
  const requestedMaxOutputTokens =
    input.resourceAdmission?.maxOutputTokens ??
    configuredMaxOutputTokens ??
    modelCapabilities.maxOutputTokens;
  const compiled = input.prepareAgentMail
    ? undefined
    : compile(
        projection.providerMessages,
        preflight.estimate.totalInputTokens,
        requestedMaxOutputTokens,
      );
  if (
    input.firstAttemptTimeoutMs !== undefined &&
    (!Number.isSafeInteger(input.firstAttemptTimeoutMs) || input.firstAttemptTimeoutMs <= 0)
  )
    throw new Error('Cross-Session first Model attempt requires a finite positive timeout.');
  const pending = await gateway.invoke({
    model: input.model,
    ...(compiled
      ? { compiled }
      : {
          prepareSurface: async (invocationId: string) => {
            const prepared = await input.prepareAgentMail!({
              invocationId,
              existingMessages: projection.providerMessages,
            });
            if (
              !Array.isArray(prepared.frames) ||
              prepared.frames.length > 8 ||
              prepared.frames.some(
                (frame) =>
                  frame.type !== 'human' ||
                  frame.name !== 'agent_message' ||
                  frame.response_metadata?.source !== 'agent_message',
              )
            )
              throw new Error('Prepared Agent mail frames are invalid.');
            if (
              prepared.frames.length === 0 &&
              input.resourceAdmission &&
              input.resourceAdmission.inputTokens !== preflight.estimate.totalInputTokens
            )
              throw new Error(
                'Model request projection changed after resource admission; refusing Provider dispatch.',
              );
            const addition = prepared.frames.length
              ? estimateContextTokens({
                  systemMessages: [],
                  transcriptMessages: [...prepared.frames],
                  dynamicRuntimeMessages: [],
                })
              : undefined;
            const estimate = addition
              ? {
                  ...preflight.estimate,
                  transcriptTokens: preflight.estimate.transcriptTokens + addition.transcriptTokens,
                  framingTokens: preflight.estimate.framingTokens + addition.framingTokens,
                  totalInputTokens: preflight.estimate.totalInputTokens + addition.totalInputTokens,
                }
              : preflight.estimate;
            const exactPreflight = addition
              ? preflightModelContext({
                  estimate,
                  capabilities: modelCapabilities,
                  requestMaxOutputTokens: requestedMaxOutputTokens,
                  providerSafetyRatio: input.config.compaction?.providerSafetyRatio,
                  compactRatio: input.config.compaction?.compactRatio,
                  hardRatio: input.config.compaction?.hardRatio,
                  warningRatio: input.config.compaction?.warningRatio,
                })
              : preflight;
            if (addition && exactPreflight.status === 'hard_limit')
              throw new Error('Prepared Agent mail exceeds the model context limit.');
            effectiveMetrics = contextMetrics(modelCapabilities, exactPreflight);
            const exactOutputTokens = [
              requestedMaxOutputTokens,
              exactPreflight.reservedOutputTokens,
            ]
              .filter((value): value is number => typeof value === 'number' && value > 0)
              .reduce<number | undefined>(
                (least, value) => (least === undefined ? value : Math.min(least, value)),
                undefined,
              );
            return {
              compiled: compile(
                [...projection.providerMessages, ...prepared.frames],
                estimate.totalInputTokens,
                exactOutputTokens,
              ),
              ...(prepared.preparationId
                ? { mailPreparation: { preparationId: prepared.preparationId } }
                : {}),
            };
          },
        }),
    persistence: input.persistence,
    provenance: {
      contextCheckpointId: input.state.context.activeCheckpoint?.sourceDigest ?? null,
      promptContractVersion: projectionEnvironment.promptContractVersion ?? 'current',
      projectionEnvironmentDigest: computeModelInvocationPrivateDigest(
        'kite.model-projection-environment.v1',
        digestProjectionEnvironment(projectionEnvironment),
      ),
      capabilityBindingDigest: computeModelInvocationPrivateDigest(
        'kite.model-capability-bindings.v1',
        input.capabilityBindingFacts,
      ),
    },
    resourceKind: 'model',
    ...(input.firstAttemptTimeoutMs === undefined
      ? {}
      : {
          limits: {
            maxAttempts: 1,
            perAttemptTimeoutMs: input.firstAttemptTimeoutMs,
            totalTimeBudgetMs: input.firstAttemptTimeoutMs,
          },
        }),
    ...(input.firstAttemptTimeoutMs === undefined
      ? {}
      : { hardAttemptTimeoutMs: input.firstAttemptTimeoutMs }),
    ...(input.replaceReservationId ? { replaceReservationId: input.replaceReservationId } : {}),
    signal: input.signal,
    emitEphemeral: input.emitEphemeral,
  });
  const value = await pending.commitWith((normalized) => {
    const response = normalizedModelResponseToAIMessage(normalized);
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
    return input.finalize(completion, effectiveMetrics);
  });
  return Object.freeze({ kind: 'completed', value });
}
