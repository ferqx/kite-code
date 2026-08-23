import {
  MODEL_INVOCATION_ENVELOPE_SCHEMA_,
  MODEL_RESPONSE_RECORD_SCHEMA_,
  type ModelInvocationEnvelope,
  type ModelResponseRecord,
  type Sha256Digest,
} from '@kite/runtime-spi';
import type { ModelArtifactStore } from './artifacts';
import type { SupportedChatModel } from './factory';
import { type AIMessage, aiMessage } from './messages';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_,
  type BuiltinModelOperationExecutionPort,
} from './operation';
import {
  ProviderDataAdmissionError,
  type ProviderDataAdmissionGate,
  type ProviderPayloadPart,
  providerPayloadFromModelPrompt,
} from './provider-data-admission';
import { ModelAttemptFailureError, type ModelResponseSource } from './response-source';
import {
  computeModelSurfaceDigest,
  computeModelSurfaceDigestLayers,
  computePrivateModelEvidenceDigest,
} from './surface-canonicalizer';
import type { CompiledModelSurface } from './surface-compiler';

export type { SingleAttemptTransport } from './response-source';

export type ModelInvocationInterruptReason =
  | 'runtime_restored'
  | 'attempts_exhausted'
  | 'cancelled'
  | 'cancelled_before_dispatch'
  | 'provider_failure'
  | 'surface_identity_changed'
  | 'persistence_unavailable';

export type BuiltinModelEvent = Readonly<{ type: string; [key: string]: any }>;

export interface ModelInvocationStateView {
  readonly revision: number;
  readonly session: { readonly threadId: string; readonly projectId?: string };
  readonly turn: { readonly turnId: string };
  readonly resourceBudget?: { readonly status: string };
}

export interface ModelRuntimeIdSource {
  next(scope: 'model_invocation'): string;
  now(): number;
}

export interface ModelResourcePreparationPlan {
  budget: ModelInvocationEnvelope['resource']['budget'];
  preparationEvents: BuiltinModelEvent[];
  maxOutputTokens?: number;
}

export type ModelResourcePlanner = (
  state: Readonly<ModelInvocationStateView>,
  input: {
    invocationId: string;
    inputTokens: number;
    requestedMaxOutputTokens?: number;
    resourceKind: 'model' | 'compaction' | 'verification';
    parentReservationId?: string;
  },
) => ModelResourcePreparationPlan;

const DEFAULT_LIMITS = Object.freeze({
  maxAttempts: 5,
  perAttemptTimeoutMs: 30_000,
  totalTimeBudgetMs: 60_000,
});

function createLiveModelRuntimeIdSource(): ModelRuntimeIdSource {
  return Object.freeze({
    next: (_scope: 'model_invocation') => crypto.randomUUID(),
    now: () => Date.now(),
  });
}

function planUnconfiguredModelResource(
  state: Readonly<ModelInvocationStateView>,
  input: Parameters<ModelResourcePlanner>[1],
): ModelResourcePreparationPlan {
  if (state.resourceBudget?.status && state.resourceBudget.status !== 'unconfigured') {
    throw new Error('Active resource budgets require a Host-owned Model resource planner.');
  }
  return {
    budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
    preparationEvents: [],
    ...(input.requestedMaxOutputTokens ? { maxOutputTokens: input.requestedMaxOutputTokens } : {}),
  };
}

function createZeroModelResourceUsage() {
  return {
    counters: {
      turns: 0,
      modelRequests: 0,
      toolInvocations: 0,
      inputTokens: 0,
      outputTokens: 0,
      artifactBytes: 0,
    },
    gauges: {
      elapsedRunMs: 0,
      activeSubagents: 0,
      activeWriters: 0,
      activeToolInvocations: 0,
      activeShellInvocations: 0,
    },
    source: 'actual' as const,
  };
}

export interface ModelInvocationPersistence<
  State extends ModelInvocationStateView = ModelInvocationStateView,
  Event extends BuiltinModelEvent = BuiltinModelEvent,
> {
  getState(): Readonly<State>;
  persistEvents(events: Event[]): Promise<boolean>;
}

export interface ModelInvocationProvenanceInput {
  parentInvocationId?: string | null;
  parentToolCallId?: string | null;
  contextCheckpointId?: string | null;
  promptContractVersion: string;
  projectionEnvironmentDigest: Sha256Digest;
  capabilityBindingDigest: Sha256Digest;
}

export interface NormalizedModelResponse {
  readonly invocationId: string;
  readonly message: ModelResponseRecord['response']['message'];
  readonly finishReason: ModelResponseRecord['response']['finishReason'];
  readonly usage: ModelResponseRecord['response']['usage'];
  readonly providerMetadata: ModelResponseRecord['response']['providerMetadata'];
}

export interface ModelCompletionFinalization<
  T,
  Event extends BuiltinModelEvent = BuiltinModelEvent,
> {
  events: Event[];
  value: T;
}

export interface PendingModelCompletion<Event extends BuiltinModelEvent = BuiltinModelEvent> {
  readonly invocationId: string;
  commit(): Promise<NormalizedModelResponse>;
  commitWith<T>(
    finalizer: (
      response: Readonly<NormalizedModelResponse>,
    ) => ModelCompletionFinalization<T, Event>,
  ): Promise<T>;
}

export type ModelArtifactWriter = Pick<ModelArtifactStore, 'writeSurface' | 'writeResponse'>;

export class ModelInvocationGateway {
  readonly #artifacts: ModelArtifactWriter;
  readonly #source: ModelResponseSource;
  readonly #now: () => number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly #runtimeIdSource: ModelRuntimeIdSource;
  readonly #planResource: ModelResourcePlanner;
  readonly #operationExecution: BuiltinModelOperationExecutionPort;

  constructor(input: {
    artifacts: ModelArtifactWriter;
    source: ModelResponseSource;
    now?: () => number;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    runtimeIdSource?: ModelRuntimeIdSource;
    planResource?: ModelResourcePlanner;
    operationExecution: BuiltinModelOperationExecutionPort;
  }) {
    this.#artifacts = input.artifacts;
    this.#source = input.source;
    this.#runtimeIdSource = input.runtimeIdSource ?? createLiveModelRuntimeIdSource();
    this.#planResource = input.planResource ?? planUnconfiguredModelResource;
    this.#operationExecution = input.operationExecution;
    this.#now = input.now ?? (() => this.#runtimeIdSource.now());
    this.#sleep = input.sleep ?? abortableSleep;
  }

  async invoke<State extends ModelInvocationStateView, Event extends BuiltinModelEvent>(input: {
    model: SupportedChatModel;
    compiled: CompiledModelSurface;
    persistence: ModelInvocationPersistence<State, Event>;
    provenance: ModelInvocationProvenanceInput;
    providerDataAdmission: ProviderDataAdmissionGate;
    resourceKind: 'model' | 'compaction' | 'verification';
    parentReservationId?: string;
    limits?: Partial<ModelInvocationEnvelope['resource']['limits']>;
    signal?: AbortSignal;
    emitEphemeral?: (event: Event) => void;
  }): Promise<PendingModelCompletion<Event>> {
    const invocationId = this.#runtimeIdSource.next('model_invocation');
    const limits = normalizeLimits(input.limits);
    const initialSurfaceDigest = computeModelSurfaceDigest(input.compiled.surface);
    if (initialSurfaceDigest !== input.compiled.surfaceDigest) {
      throw new Error('Frozen Model Surface identity changed before admission.');
    }

    // Artifact publication precedes both admissions. A later local failure can
    // only leave an immutable orphan eligible for reachability-based GC.
    const surfaceArtifact = this.#artifacts.writeSurface(input.compiled.surface);
    const payload = providerPayloadFromSurface(input.compiled);
    if (typeof input.providerDataAdmission !== 'function') {
      throw new ProviderDataAdmissionError({
        admitted: false,
        reason: 'mandatory_policy_unavailable',
        routeAlias: 'unresolved',
      });
    }
    const admissionDecision = input.providerDataAdmission(
      payload,
      input.compiled.providerDispatchPurpose,
    );
    if (!admissionDecision.admitted) throw new ProviderDataAdmissionError(admissionDecision);
    const state = input.persistence.getState();

    const resource = this.#planResource(state, {
      invocationId,
      inputTokens: input.compiled.estimatedInputTokens,
      ...(input.compiled.surface.request.maxOutputTokens
        ? { requestedMaxOutputTokens: input.compiled.surface.request.maxOutputTokens }
        : {}),
      resourceKind: input.resourceKind,
      ...(input.parentReservationId ? { parentReservationId: input.parentReservationId } : {}),
    });
    assertResourceMatchesSurface(resource, input.compiled);
    const layers = computeModelSurfaceDigestLayers(input.compiled.surface);
    const envelope: ModelInvocationEnvelope = {
      schema: MODEL_INVOCATION_ENVELOPE_SCHEMA_,
      surface: {
        artifact: surfaceArtifact,
        surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
      },
      admission: {
        providerAdmissionRevision: admissionDecision.admissionRevision ?? null,
        routeIdentityDigest: layers.routeIdentityDigest,
        payloadClassificationDigest: classificationDigest(payload),
        admitted: true,
      },
      provenance: {
        invocationId,
        threadId: state.session.threadId,
        turnId: state.turn.turnId,
        parentInvocationId: input.provenance.parentInvocationId ?? null,
        parentToolCallId: input.provenance.parentToolCallId ?? null,
        stateRevision: state.revision,
        contextCheckpointId: input.provenance.contextCheckpointId ?? null,
        promptContractVersion: input.provenance.promptContractVersion,
        projectionEnvironmentDigest: input.provenance.projectionEnvironmentDigest,
        capabilityBindingDigest: input.provenance.capabilityBindingDigest,
      },
      resource: { budget: resource.budget, limits },
    };
    const prepared: BuiltinModelEvent = {
      type: 'model.invocation_prepared',
      invocationId,
      purpose: input.compiled.surface.purpose,
      surfaceArtifact,
      surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
      routeFingerprint: input.compiled.surface.route.routeFingerprint,
      admission: envelope.admission,
      budget: envelope.resource.budget,
      limits,
      preparedStateRevision: state.revision,
      parentInvocationId: envelope.provenance.parentInvocationId,
      parentToolCallId: envelope.provenance.parentToolCallId,
    };
    await persistAck(
      input.persistence,
      asModelEvents<Event>([...resource.preparationEvents, prepared]),
    );

    let retryBudgetStartedAt: number | undefined;
    let priorError: unknown;
    let retryDelayMs = 0;
    let retryBaselineText = '';
    let retryBaselineReasoning = '';
    let attemptText = '';
    let attemptReasoning = '';
    let interruptionReason: ModelInvocationInterruptReason = 'attempts_exhausted';
    for (let attempt = 1; attempt <= limits.maxAttempts; attempt += 1) {
      if (input.signal?.aborted) {
        await this.#interrupt(input.persistence, envelope, 'cancelled_before_dispatch', 'none');
        throw abortReason(input.signal);
      }
      if (attempt > 1) {
        const remainingMs = remainingRetryBudgetMs(
          retryBudgetStartedAt,
          limits.totalTimeBudgetMs,
          this.#now(),
        );
        if (remainingMs <= 0) break;
        try {
          await this.#sleep(Math.min(retryDelayMs, remainingMs), input.signal);
        } catch (error) {
          await this.#interrupt(input.persistence, envelope, 'cancelled', 'attempted');
          throw error;
        }
      }
      const remainingMs = remainingRetryBudgetMs(
        retryBudgetStartedAt,
        limits.totalTimeBudgetMs,
        this.#now(),
      );
      if (attempt > 1 && remainingMs <= 0) break;
      const attemptEvents: BuiltinModelEvent[] = [];
      if (attempt === 1 && resource.budget.kind === 'reservation') {
        attemptEvents.push({
          type: 'resource_budget.dispatch_started',
          reservationId: resource.budget.reservationId,
        });
      }
      attemptEvents.push({
        type: 'model.invocation_attempt_started',
        invocationId,
        attempt,
        maxAttempts: limits.maxAttempts,
      });
      if (attempt === 1 && input.compiled.surface.purpose === 'primary_agent') {
        attemptEvents.push({ type: 'model.requested', requestId: invocationId, invocationId });
      }
      await persistAck(input.persistence, asModelEvents<Event>(attemptEvents));
      if (computeModelSurfaceDigest(input.compiled.surface) !== initialSurfaceDigest) {
        await this.#interrupt(input.persistence, envelope, 'surface_identity_changed', 'none');
        throw new Error('Frozen Model Surface changed after attempt acknowledgement.');
      }

      attemptText = '';
      attemptReasoning = '';
      let visibleReasoningLength = 0;
      const visibleReasoningSegments = new Map<string, string>();
      const attemptAbort = boundedAttemptSignal(
        input.signal,
        attempt === 1
          ? limits.perAttemptTimeoutMs
          : Math.min(limits.perAttemptTimeoutMs, remainingMs),
      );
      let outcome: Awaited<ReturnType<ModelResponseSource['attempt']>>;
      try {
        outcome = await this.#operationExecution.execute({
          operationId: BUILTIN_MODEL_OPERATION_BY_PURPOSE_[input.compiled.surface.purpose],
          purpose: input.compiled.surface.purpose,
          invocationId,
          attemptOrdinal: attempt,
          threadId: envelope.provenance.threadId,
          turnId: envelope.provenance.turnId,
          stateRevision: envelope.provenance.stateRevision,
          surfaceDigest: initialSurfaceDigest,
          input: Object.freeze({
            purpose: input.compiled.surface.purpose,
            invocation_id: invocationId,
            attempt_ordinal: attempt,
            thread_id: envelope.provenance.threadId,
            turn_id: envelope.provenance.turnId,
            state_revision: envelope.provenance.stateRevision,
            surface_digest: initialSurfaceDigest,
          }),
          signal: attemptAbort.signal,
          attempt: () =>
            this.#source.attempt({
              model: input.model,
              surface: input.compiled.surface,
              attemptOrdinal: attempt,
              signal: attemptAbort.signal,
              onActivity: attemptAbort.refresh,
              onTextCumulative: (text) => {
                attemptText = text;
                const visible = visibleRetryPrefix(text, attempt, retryBaselineText);
                if (visible) {
                  input.emitEphemeral?.(
                    asModelEvent<Event>({ type: 'model.text_delta', text: visible }),
                  );
                }
              },
              onReasoningCumulative: (text, segmentId) => {
                attemptReasoning = text;
                const visible = visibleRetryPrefix(text, attempt, retryBaselineReasoning);
                const delta = visible.slice(visibleReasoningLength);
                visibleReasoningLength = visible.length;
                if (!delta) return;
                const segment = `${visibleReasoningSegments.get(segmentId) ?? ''}${delta}`;
                visibleReasoningSegments.set(segmentId, segment);
                input.emitEphemeral?.(
                  asModelEvent<Event>({ type: 'model.reasoning_delta', segmentId, text: segment }),
                );
              },
              onReasoningCompleted: (_text, segmentId) => {
                const segment = visibleReasoningSegments.get(segmentId);
                visibleReasoningSegments.delete(segmentId);
                if (!segment) return;
                input.emitEphemeral?.(
                  asModelEvent<Event>({
                    type: 'model.reasoning_completed',
                    segmentId,
                    text: segment,
                  }),
                );
              },
            }),
        });
      } catch (error) {
        attemptAbort.dispose();
        const dispatchCertainty = responseSourceDispatchCertainty(error);
        await this.#interrupt(input.persistence, envelope, 'provider_failure', dispatchCertainty);
        throw error;
      }
      attemptAbort.dispose();
      if (outcome.kind === 'success') {
        const responseRecord: ModelResponseRecord = {
          schema: MODEL_RESPONSE_RECORD_SCHEMA_,
          invocationId,
          surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
          route: input.compiled.surface.route,
          response: outcome.response,
          nativeReplayState: outcome.nativeReplayState,
        };
        const responseArtifact = this.#artifacts.writeResponse(responseRecord);
        const normalized = deepFreeze({ invocationId, ...outcome.response });
        return this.#pendingCompletion(input.persistence, envelope, responseArtifact, normalized);
      }
      priorError = new ModelAttemptFailureError(outcome, this.#source.failureError?.(outcome));
      retryBaselineText = attemptText;
      retryBaselineReasoning = attemptReasoning;
      const transient = outcome.kind === 'retryable_failure';
      if (transient && retryBudgetStartedAt == null) retryBudgetStartedAt = this.#now();
      const retryBudgetRemaining = remainingRetryBudgetMs(
        retryBudgetStartedAt,
        limits.totalTimeBudgetMs,
        this.#now(),
      );
      if (
        input.signal?.aborted ||
        (outcome.kind === 'aborted' && outcome.classification === 'cancelled')
      ) {
        interruptionReason = 'cancelled';
      } else if (!transient) interruptionReason = 'provider_failure';
      if (attempt >= limits.maxAttempts || !transient || retryBudgetRemaining <= 0) break;
      retryDelayMs = retryDelay(attempt, retryBudgetRemaining);
      // The Source owns one outcome only. Gateway persists retry state and the
      // next attempt receives a separate acknowledgement immediately before it.
      await persistAck(
        input.persistence,
        asModelEvents<Event>([
          {
            type: 'model.retry',
            attempt,
            maxAttempts: limits.maxAttempts,
            error: 'transient_model_connection_error',
            delayMs: retryDelayMs,
          },
        ]),
      );
    }
    await this.#interrupt(input.persistence, envelope, interruptionReason, 'attempted');
    throw priorError ?? new Error('Model invocation attempt budget was exhausted.');
  }

  #pendingCompletion<Event extends BuiltinModelEvent>(
    persistence: ModelInvocationPersistence<ModelInvocationStateView, Event>,
    envelope: ModelInvocationEnvelope,
    responseArtifact: ReturnType<ModelArtifactWriter['writeResponse']>,
    response: Readonly<NormalizedModelResponse>,
  ): PendingModelCompletion<Event> {
    let committed = false;
    const commitWith = async <T>(
      finalizer: (
        value: Readonly<NormalizedModelResponse>,
      ) => ModelCompletionFinalization<T, Event>,
    ): Promise<T> => {
      if (committed) throw new Error('Model completion handle is single-use.');
      committed = true;
      let finalized: ModelCompletionFinalization<T, Event>;
      try {
        finalized = finalizer(response);
        if (finalized && typeof (finalized as { then?: unknown }).then === 'function') {
          throw new Error('Model completion finalizer must be pure and synchronous.');
        }
      } catch (error) {
        // The Source has already produced an attempted outcome. A private
        // publication/finalization fault must terminalize that attempt before
        // control returns; the single-use handle can never retry the Source.
        await this.#interrupt(persistence, envelope, 'persistence_unavailable', 'attempted');
        throw error;
      }
      const events: BuiltinModelEvent[] = [
        {
          type: 'model.invocation_completed',
          invocationId: envelope.provenance.invocationId,
          responseArtifact,
          finishReason: response.finishReason,
        },
        ...finalized.events,
      ];
      if (envelope.resource.budget.kind === 'reservation') {
        const usage = createZeroModelResourceUsage();
        usage.counters.modelRequests = 1;
        usage.counters.inputTokens = response.usage.inputTokens ?? 0;
        usage.counters.outputTokens = response.usage.outputTokens ?? 0;
        events.push({
          type: 'resource_budget.reconciled',
          reservationId: envelope.resource.budget.reservationId,
          actual: usage,
        });
      }
      await persistAck(persistence, asModelEvents<Event>(events));
      return finalized.value;
    };
    return Object.freeze({
      invocationId: envelope.provenance.invocationId,
      commit: () => commitWith((value) => ({ events: [], value })),
      commitWith,
    });
  }

  async #interrupt<Event extends BuiltinModelEvent>(
    persistence: ModelInvocationPersistence<ModelInvocationStateView, Event>,
    envelope: ModelInvocationEnvelope,
    reasonCode: ModelInvocationInterruptReason,
    dispatchCertainty: 'none' | 'attempted' | 'unknown',
  ): Promise<void> {
    const events: BuiltinModelEvent[] = [
      {
        type: 'model.invocation_interrupted',
        invocationId: envelope.provenance.invocationId,
        dispatchCertainty,
        reasonCode,
      },
    ];
    if (envelope.resource.budget.kind === 'reservation') {
      events.push(
        dispatchCertainty === 'none'
          ? {
              type: 'resource_budget.released',
              reservationId: envelope.resource.budget.reservationId,
              proof: 'local_provider_admission_denied',
            }
          : {
              type: 'resource_budget.unknown',
              reservationId: envelope.resource.budget.reservationId,
            },
      );
    }
    await persistAck(persistence, asModelEvents<Event>(events));
  }
}

export function normalizedModelResponseToAIMessage(
  response: Readonly<NormalizedModelResponse>,
): AIMessage {
  const text = response.message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const reasoning = response.message.content
    .filter(
      (part): part is Extract<typeof part, { type: 'reasoning' }> => part.type === 'reasoning',
    )
    .map((part) => part.text)
    .join('');
  const responseId = response.providerMetadata.responseId;
  return aiMessage({
    id: typeof responseId === 'string' ? responseId : undefined,
    content: text,
    tool_calls: response.message.content.flatMap((part) =>
      part.type === 'tool_call'
        ? [
            {
              id: part.toolCallId,
              name: part.toolName,
              args: part.input as Record<string, unknown>,
              type: 'tool_call' as const,
            },
          ]
        : [],
    ),
    additional_kwargs: { reasoning_content: reasoning },
    response_metadata: {
      finishReason: response.finishReason,
      usage: {
        prompt_tokens: response.usage.inputTokens ?? undefined,
        input_tokens: response.usage.inputTokens ?? undefined,
        completion_tokens: response.usage.outputTokens ?? undefined,
        total_tokens: response.usage.totalTokens ?? undefined,
        prompt_cache_hit_tokens: response.usage.cacheReadTokens ?? undefined,
      },
    },
  });
}

export function computeModelInvocationPrivateDigest(domain: string, value: unknown): Sha256Digest {
  return computePrivateModelEvidenceDigest(domain, value);
}

function providerPayloadFromSurface(compiled: CompiledModelSurface): ProviderPayloadPart[] {
  const prompt = [
    ...(compiled.surface.request.system
      ? [{ role: 'system', content: compiled.surface.request.system }]
      : []),
    ...compiled.surface.request.messages.map((message) => ({
      role: message.role,
      content: message.content.map((part) => {
        if (part.type === 'text' || part.type === 'reasoning') return { text: part.text };
        if (part.type === 'tool_call') return part.input;
        return { output: part.output.value };
      }),
    })),
  ];
  return providerPayloadFromModelPrompt(prompt);
}

function classificationDigest(payload: readonly ProviderPayloadPart[]): Sha256Digest {
  return computeModelInvocationPrivateDigest(
    'kite.model-payload-classification.v1',
    payload.map((part) => ({ kind: part.kind, label: part.label })),
  );
}

function assertResourceMatchesSurface(
  resource: ModelResourcePreparationPlan,
  compiled: CompiledModelSurface,
): void {
  const requested = compiled.surface.request.maxOutputTokens;
  if (
    requested != null &&
    resource.maxOutputTokens != null &&
    requested > resource.maxOutputTokens
  ) {
    throw new Error('Frozen Model Surface exceeds its admitted output reservation.');
  }
}

function normalizeLimits(
  input: Partial<ModelInvocationEnvelope['resource']['limits']> | undefined,
): ModelInvocationEnvelope['resource']['limits'] {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Model invocation ${key} must be a positive safe integer.`);
    }
  }
  if (limits.perAttemptTimeoutMs > limits.totalTimeBudgetMs) {
    throw new Error('Model per-attempt timeout exceeds its total time budget.');
  }
  return limits;
}

function asModelEvent<Event extends BuiltinModelEvent>(event: BuiltinModelEvent): Event {
  return event as Event;
}

function asModelEvents<Event extends BuiltinModelEvent>(
  events: readonly BuiltinModelEvent[],
): Event[] {
  return events as Event[];
}

async function persistAck<State extends ModelInvocationStateView, Event extends BuiltinModelEvent>(
  persistence: ModelInvocationPersistence<State, Event>,
  events: Event[],
): Promise<void> {
  if (events.length === 0) return;
  let applied: boolean;
  try {
    applied = await persistence.persistEvents(events);
  } catch (error) {
    throw new Error('Model invocation evidence persistence failed.', { cause: error });
  }
  if (!applied) throw new Error('Model invocation evidence acknowledgement was rejected.');
}

function retryDelay(attempt: number, remainingMs: number): number {
  return Math.max(0, Math.min(4_000, 500 * 2 ** (attempt - 1), remainingMs));
}

function remainingRetryBudgetMs(
  startedAt: number | undefined,
  totalTimeBudgetMs: number,
  now: number,
): number {
  return startedAt == null ? totalTimeBudgetMs : totalTimeBudgetMs - (now - startedAt);
}

function responseSourceDispatchCertainty(error: unknown): 'none' | 'attempted' {
  if (
    error &&
    typeof error === 'object' &&
    (error as { dispatchCertainty?: unknown }).dispatchCertainty === 'none'
  ) {
    return 'none';
  }
  return 'attempted';
}

function visibleRetryPrefix(value: string, attempt: number, baseline: string): string {
  if (attempt === 1) return value;
  if (baseline.startsWith(value)) return '';
  if (value.startsWith(baseline)) return value.slice(baseline.length);
  return value;
}

function boundedAttemptSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; refresh(): void; dispose(): void } {
  const controller = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = () => {
    if (disposed || controller.signal.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('Model attempt timed out.')), timeoutMs);
  };
  const onAbort = () => controller.abort(abortReason(parent!));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  refresh();
  return {
    signal: controller.signal,
    refresh,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Model invocation aborted.',
  );
  error.name = 'AbortError';
  return error;
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? abortReason(signal) : new Error('Model retry sleep aborted.'));
    };
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
